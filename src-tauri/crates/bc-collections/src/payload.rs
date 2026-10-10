//! The collection envelope's plaintext, and the member secrets in it.
//!
//! # What is in here, and what deliberately is not
//!
//! [`CollectionPayload`] is the *plaintext* shape — what the envelope holds
//! once a passphrase has opened it. It carries one `{id, secret}` per member
//! and nothing else.
//!
//! A member's label, email and KDF parameters are **not** here. They are
//! already cleartext in `bc_storage`'s `ApiKey` record and stay there: sealing
//! them a second time would grow the payload against a hard 64 KiB cap and buy
//! nothing, because the cleartext copy is still on disk either way. See the
//! header of `src/lib/collections/types.ts`, which is the contract this module
//! implements.
//!
//! # Parsing is a strict projection
//!
//! [`CollectionPayload::parse`] builds a fresh value out of the fields it
//! recognises rather than returning the parsed JSON. The same rule, and the
//! same reasoning, as `bc_sync::payload`: this plaintext's destination is the
//! API key list, so an unknown field carried through the parse is a value
//! somebody else chose arriving in storage.
//!
//! # Why there is no member-count bound on parse
//!
//! [`MAX_COLLECTION_MEMBERS`] is enforced when a member is *added*, and not
//! when a payload is *read*. That asymmetry is deliberate. A bound on the read
//! would mean a collection that somehow holds more than the cap can never be
//! opened — and therefore never be trimmed back under the cap, which is the
//! one operation its owner needs. `bc_sync::payload` bounds its entry count on
//! parse because it is parsing a blob fetched from someone else's server; this
//! payload comes out of an envelope that only the holder's passphrase opens,
//! and the allocation is already bounded by `bc_crypto::MAX_PLAINTEXT_BYTES`,
//! since a 64 KiB plaintext cannot describe an unbounded number of members.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::CollectionError;

/// Marks a plaintext as a collection's.
///
/// Checked before anything else, and deliberately distinct from
/// `bc_sync::PAYLOAD_FORMAT`. Two different documents sealed by the same
/// primitives must be refused for one another rather than coerced: a sync
/// vault opened as a collection would be read as having no members, which
/// looks like an empty collection rather than like a mistake.
pub const COLLECTION_PAYLOAD_FORMAT: &str = "better-cloudflare/collection";

/// Payload version of the collection envelope's plaintext document.
///
/// Bumped only for a change an older build would read *incorrectly*. Pinned
/// against `COLLECTION_PAYLOAD_VERSION` in the contract.
pub const COLLECTION_PAYLOAD_VERSION: u32 = 1;

/// The most keys one collection may hold.
///
/// Bounded by `bc_crypto::MAX_PLAINTEXT_BYTES` rather than by taste: the whole
/// collection seals into one envelope, so the member count is what the cap
/// actually constrains. At roughly 120 bytes of JSON per member this uses
/// under a third of the envelope, leaving room for the payload's framing and
/// for secrets much longer than a Cloudflare token.
///
/// Checked before the seal so that the refusal names this limit, instead of
/// surfacing as a crypto error the user would have to read as `corrupt`.
pub const MAX_COLLECTION_MEMBERS: usize = 128;

/// One member's secret, as it sits inside the envelope.
///
/// `secret` is the API key *plaintext* — the only thing in this crate that is
/// not safe to print, serialise outside an envelope, or hand to a log.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionMember {
    /// The `ApiKey` id this secret belongs to.
    pub id: String,
    /// The decrypted API key.
    pub secret: String,
}

impl CollectionMember {
    pub fn new(id: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            secret: secret.into(),
        }
    }
}

/// Hand-written, following `bc_ai_provider::ProviderProfile`, so a member
/// cannot carry an API key into a log line or a panic message. The id is
/// cleartext in the collection record already and is safe to show.
impl std::fmt::Debug for CollectionMember {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CollectionMember")
            .field("id", &self.id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

/// Best-effort wipe of the secret when a member goes out of scope.
///
/// Honest about its limits: `parse` builds members out of a
/// `serde_json::Value`, and that intermediate holds its own copy of every
/// secret which this cannot reach. So this narrows the window in which a
/// secret is readable from freed memory, and does not close it. The guarantee
/// that does hold is the one in [`crate::SealedCollection`]: the serialised
/// plaintext is a `Zeroizing<String>` for its whole life.
impl Drop for CollectionMember {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

/// The plaintext bundle, before sealing and after opening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionPayload {
    pub format: String,
    pub version: u32,
    pub members: Vec<CollectionMember>,
}

impl CollectionPayload {
    /// A payload at this build's format and version.
    pub fn new(members: Vec<CollectionMember>) -> Self {
        Self {
            format: COLLECTION_PAYLOAD_FORMAT.to_string(),
            version: COLLECTION_PAYLOAD_VERSION,
            members,
        }
    }

    /// Parse a decrypted payload, refusing anything this build cannot read
    /// correctly.
    ///
    /// The checks run in a deliberate order — JSON, marker, version, members —
    /// because each makes the next meaningful: an unrelated document is
    /// refused as "not ours" before its `version` is consulted, and a version
    /// this build would misread is refused before its member list is walked.
    pub fn parse(json: &str) -> Result<Self, CollectionError> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| CollectionError::Corrupt)?;

        if value.get("format").and_then(|v| v.as_str()) != Some(COLLECTION_PAYLOAD_FORMAT) {
            return Err(CollectionError::Corrupt);
        }

        let version = value
            .get("version")
            .and_then(|v| v.as_u64())
            .ok_or(CollectionError::Corrupt)?;
        // A newer payload is refused rather than read with its unknown fields
        // dropped, because the dropped field might be the one that made the
        // rest correct. `Corrupt` would send the user to the wrong place.
        if version > u64::from(COLLECTION_PAYLOAD_VERSION) {
            return Err(CollectionError::PayloadTooNew);
        }

        let raw_members = value
            .get("members")
            .and_then(|v| v.as_array())
            .ok_or(CollectionError::Corrupt)?;

        let mut members = Vec::with_capacity(raw_members.len());
        let mut seen = HashSet::with_capacity(raw_members.len());
        for raw in raw_members {
            let member = parse_member(raw)?;
            // Two entries for one key id makes "this key's secret" an
            // ambiguous question, and silently keeping the first would leave
            // the second behind on a remove — a secret still in the envelope
            // after the UI says it was taken out.
            if !seen.insert(member.id.clone()) {
                return Err(CollectionError::Corrupt);
            }
            members.push(member);
        }

        Ok(Self {
            format: COLLECTION_PAYLOAD_FORMAT.to_string(),
            version: COLLECTION_PAYLOAD_VERSION,
            members,
        })
    }

    /// The member with this key id, if the collection holds it.
    pub fn member(&self, key_id: &str) -> Option<&CollectionMember> {
        self.members.iter().find(|member| member.id == key_id)
    }

    /// Whether this key is in the collection.
    pub fn contains(&self, key_id: &str) -> bool {
        self.member(key_id).is_some()
    }

    /// The member key ids, in the order the envelope holds them.
    pub fn member_ids(&self) -> Vec<String> {
        self.members
            .iter()
            .map(|member| member.id.clone())
            .collect()
    }
}

/// A projection, field by field. See the module header.
///
/// Both fields are structurally required and may not be empty. An entry with
/// no id cannot be addressed, and an entry with no secret is a member whose
/// key the collection cannot open — which is the only thing membership is for,
/// so an empty secret is a broken entry and not a sparse one. This is the
/// opposite call from `bc_sync::payload`'s `label`, where an empty value is
/// legitimate stored data; here there is no field that may be blank.
fn parse_member(raw: &serde_json::Value) -> Result<CollectionMember, CollectionError> {
    Ok(CollectionMember {
        id: text(raw, "id").ok_or(CollectionError::Corrupt)?,
        secret: text(raw, "secret").ok_or(CollectionError::Corrupt)?,
    })
}

/// A string field that must be present, of type string, and non-empty.
fn text(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload_json(members: serde_json::Value) -> String {
        serde_json::json!({
            "format": COLLECTION_PAYLOAD_FORMAT,
            "version": COLLECTION_PAYLOAD_VERSION,
            "members": members,
        })
        .to_string()
    }

    fn member_json() -> serde_json::Value {
        serde_json::json!({ "id": "key-1", "secret": "cf-token-1" })
    }

    #[test]
    fn a_well_formed_payload_round_trips() {
        let parsed = CollectionPayload::parse(&payload_json(serde_json::json!([member_json()])))
            .expect("parses");
        assert_eq!(parsed.members.len(), 1);
        assert_eq!(parsed.members[0].id, "key-1");
        assert_eq!(parsed.members[0].secret, "cf-token-1");
        assert!(parsed.contains("key-1"));
        assert!(!parsed.contains("key-2"));
        assert_eq!(parsed.member_ids(), vec!["key-1".to_string()]);
    }

    #[test]
    fn what_this_crate_writes_is_what_it_reads() {
        // Serialise and parse through the real functions, so a rename of a
        // wire field breaks here rather than at the first unlock after a
        // release.
        let written = serde_json::to_string(&CollectionPayload::new(vec![CollectionMember::new(
            "key-1",
            "cf-token-1",
        )]))
        .expect("serialises");
        let parsed = CollectionPayload::parse(&written).expect("its own output must parse");
        assert_eq!(parsed.members[0].secret, "cf-token-1");
    }

    #[test]
    fn a_sync_vault_is_not_a_collection() {
        let foreign = serde_json::json!({
            "format": "better-cloudflare/sync-vault",
            "version": 1,
            "members": [],
        })
        .to_string();
        assert!(matches!(
            CollectionPayload::parse(&foreign),
            Err(CollectionError::Corrupt)
        ));
    }

    #[test]
    fn a_newer_payload_is_too_new_rather_than_corrupt() {
        let newer = serde_json::json!({
            "format": COLLECTION_PAYLOAD_FORMAT,
            "version": COLLECTION_PAYLOAD_VERSION + 1,
            "members": [],
        })
        .to_string();
        assert!(matches!(
            CollectionPayload::parse(&newer),
            Err(CollectionError::PayloadTooNew)
        ));
    }

    #[test]
    fn a_member_without_a_secret_is_corrupt() {
        let mut missing = member_json();
        missing.as_object_mut().unwrap().remove("secret").unwrap();
        assert!(matches!(
            CollectionPayload::parse(&payload_json(serde_json::json!([missing]))),
            Err(CollectionError::Corrupt)
        ));

        // An empty secret is refused exactly as a missing one is: a member
        // whose key cannot be opened is not a member.
        let mut blank = member_json();
        blank["secret"] = serde_json::json!("");
        assert!(matches!(
            CollectionPayload::parse(&payload_json(serde_json::json!([blank]))),
            Err(CollectionError::Corrupt)
        ));

        let mut wrong_type = member_json();
        wrong_type["secret"] = serde_json::json!(42);
        assert!(matches!(
            CollectionPayload::parse(&payload_json(serde_json::json!([wrong_type]))),
            Err(CollectionError::Corrupt)
        ));
    }

    #[test]
    fn a_member_without_an_id_is_corrupt() {
        let mut missing = member_json();
        missing.as_object_mut().unwrap().remove("id").unwrap();
        assert!(matches!(
            CollectionPayload::parse(&payload_json(serde_json::json!([missing]))),
            Err(CollectionError::Corrupt)
        ));
    }

    #[test]
    fn two_entries_for_one_key_are_corrupt() {
        let duplicate = serde_json::json!([
            { "id": "key-1", "secret": "first" },
            { "id": "key-1", "secret": "second" },
        ]);
        assert!(matches!(
            CollectionPayload::parse(&payload_json(duplicate)),
            Err(CollectionError::Corrupt)
        ));
    }

    #[test]
    fn unknown_fields_do_not_survive_the_projection() {
        let mut smuggled = member_json();
        smuggled["collection_id"] = serde_json::json!("somebody-elses");
        smuggled["is_admin"] = serde_json::json!(true);
        let parsed =
            CollectionPayload::parse(&payload_json(serde_json::json!([smuggled]))).expect("parses");
        let reserialised = serde_json::to_value(&parsed.members[0]).expect("serialises");
        for field in ["collection_id", "is_admin"] {
            assert!(
                reserialised.get(field).is_none(),
                "a projection that keeps {field} is not a projection"
            );
        }
    }

    #[test]
    fn a_missing_member_list_is_corrupt() {
        let no_members = serde_json::json!({
            "format": COLLECTION_PAYLOAD_FORMAT,
            "version": COLLECTION_PAYLOAD_VERSION,
        })
        .to_string();
        assert!(matches!(
            CollectionPayload::parse(&no_members),
            Err(CollectionError::Corrupt)
        ));
    }

    #[test]
    fn not_json_at_all_is_corrupt() {
        assert!(matches!(
            CollectionPayload::parse("this is not json"),
            Err(CollectionError::Corrupt)
        ));
    }

    /// A secret reaches a log line through `Debug` as easily as through serde.
    #[test]
    fn a_member_secret_never_reaches_a_debug_line() {
        let member = CollectionMember::new("key-1", "cf-token-TOPSECRET");
        let rendered = format!("{member:?}");
        assert!(!rendered.contains("TOPSECRET"), "{rendered}");
        assert!(rendered.contains("<redacted>"));
        assert!(rendered.contains("key-1"), "the id is cleartext and useful");

        // And through the payload that holds it, which derives `Debug`.
        let payload = CollectionPayload::new(vec![CollectionMember::new("key-1", "TOPSECRET")]);
        assert!(!format!("{payload:?}").contains("TOPSECRET"));
    }
}
