//! What travels, and the manifest that describes it.
//!
//! # The payload is sealed before it gets here
//!
//! [`SyncPayload`] is the *plaintext* shape. The command layer serialises it,
//! hands it to `bc_crypto::CryptoManager::encrypt` under the sync passphrase,
//! and only the resulting base64 envelope reaches an engine. So the provider
//! holds no key count, no label and no email address — see `src/lib/sync/
//! types.ts` for why that mattered enough to justify a second passphrase.
//!
//! The per-key `encrypted_key` values inside are *already* ciphertext, sealed
//! under each key's own password. The outer envelope protects the metadata
//! around them; it is not what protects the keys.
//!
//! # Parsing is a strict projection
//!
//! [`SyncPayload::parse`] builds a fresh value out of the fields it
//! recognises rather than casting the parsed JSON. The payload is decrypted
//! material from a remote store, so an extra field in it is an extra field
//! someone put there — and this payload's destination is the API key list in
//! the OS keyring. Returning the parsed object with unknown keys intact is how
//! a hostile blob smuggles a value into storage. The same rule, and the same
//! reasoning, as `src/lib/portable/envelope.ts`.

use serde::{Deserialize, Serialize};
use sha2::Digest;

use crate::SyncError;

/// Marks a blob as this feature's.
///
/// Checked before anything else, and deliberately different from
/// `PORTABLE_FORMAT`: a portable settings export carries no credentials by
/// construction, so the two formats must be refused for each other rather
/// than coerced into one another's shape.
pub const PAYLOAD_FORMAT: &str = "better-cloudflare/sync-vault";

/// Bumped only for a change an older build would read *incorrectly*.
pub const PAYLOAD_VERSION: u32 = 1;

/// The largest sealed envelope this will move. See `src/lib/sync/types.ts`.
pub const MAX_SYNC_ENVELOPE_BYTES: usize = 96 * 1024;

/// How many keys one payload may carry.
///
/// A bound on a value from a remote store, so that a blob claiming a hundred
/// thousand keys is refused before it is allocated rather than after.
pub const MAX_VAULT_ENTRIES: usize = 512;

pub const SYNC_BLOB_NAME: &str = "better-cloudflare-vault.enc";
pub const SYNC_MANIFEST_NAME: &str = "better-cloudflare-vault.json";

/// One API key as it travels. Mirrors `bc_storage::ApiKey` field for field.
///
/// `encrypted_key` is ciphertext under that key's own password, and nothing in
/// this crate can open it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub encrypted_key: String,
    pub iterations: u32,
    pub key_length: usize,
    pub algorithm: String,
}

/// The plaintext bundle, before sealing and after opening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncPayload {
    pub format: String,
    pub version: u32,
    /// RFC 3339. For the reader; nothing branches on it.
    pub written_at: String,
    pub device_id: String,
    pub device_label: String,
    pub keys: Vec<VaultEntry>,
}

impl SyncPayload {
    /// Parse a decrypted payload, refusing anything this build cannot read
    /// correctly.
    ///
    /// The checks run in a deliberate order — JSON, marker, version, bounds —
    /// because each makes the next meaningful: an unrelated JSON document is
    /// refused as "not ours" before its `version` is consulted, and a version
    /// this build would misread is refused before its key list is walked.
    pub fn parse(json: &str) -> Result<Self, SyncError> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| SyncError::Corrupt)?;

        if value.get("format").and_then(|v| v.as_str()) != Some(PAYLOAD_FORMAT) {
            return Err(SyncError::Corrupt);
        }

        let version = value
            .get("version")
            .and_then(|v| v.as_u64())
            .ok_or(SyncError::Corrupt)?;
        // A newer payload is refused rather than read with its unknown fields
        // dropped, because the dropped field might be the one that made the
        // rest correct. `Corrupt` would send the user to the wrong place.
        if version > u64::from(PAYLOAD_VERSION) {
            return Err(SyncError::PayloadTooNew);
        }

        let raw_keys = value
            .get("keys")
            .and_then(|v| v.as_array())
            .ok_or(SyncError::Corrupt)?;
        if raw_keys.len() > MAX_VAULT_ENTRIES {
            return Err(SyncError::TooLarge);
        }

        let mut keys = Vec::with_capacity(raw_keys.len());
        for raw in raw_keys {
            keys.push(parse_entry(raw)?);
        }

        Ok(Self {
            format: PAYLOAD_FORMAT.to_string(),
            version: PAYLOAD_VERSION,
            written_at: text(&value, "written_at").unwrap_or_default(),
            device_id: text(&value, "device_id").unwrap_or_default(),
            device_label: text(&value, "device_label").unwrap_or_default(),
            keys,
        })
    }
}

/// A projection, field by field. See the module header.
///
/// # Which fields may be empty, and why it matters
///
/// The distinction below is not pedantry — getting it wrong is silent data
/// loss. A field read with [`text`] must be a non-empty string or the entry is
/// refused; a field read with [`text_or_empty`] may be `""`.
///
/// `id`, `encrypted_key` and `algorithm` are structurally required: an entry
/// without them cannot be stored, decrypted, or addressed, so refusing it is
/// the only honest option.
///
/// **`label` may legitimately be empty**, because `commands::auth::add_api_key`
/// has never validated it — an empty label is storable today, and plenty of
/// vaults will contain one. This originally used [`text`], which meant such a
/// key could be *pushed* and then never *pulled*: it sealed fine and came back
/// as `corrupt`, taking the whole payload — every other key in it — with it.
/// A restore that refuses the entire vault because one label is blank is worse
/// than any amount of strictness is worth.
fn parse_entry(raw: &serde_json::Value) -> Result<VaultEntry, SyncError> {
    Ok(VaultEntry {
        id: text(raw, "id").ok_or(SyncError::Corrupt)?,
        label: text_or_empty(raw, "label").ok_or(SyncError::Corrupt)?,
        email: text(raw, "email"),
        encrypted_key: text(raw, "encrypted_key").ok_or(SyncError::Corrupt)?,
        iterations: raw
            .get("iterations")
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok())
            .ok_or(SyncError::Corrupt)?,
        key_length: raw
            .get("key_length")
            .and_then(|v| v.as_u64())
            .and_then(|v| usize::try_from(v).ok())
            .ok_or(SyncError::Corrupt)?,
        algorithm: text(raw, "algorithm").ok_or(SyncError::Corrupt)?,
    })
}

/// A string field that must be present and non-empty. `None` otherwise.
fn text(value: &serde_json::Value, field: &str) -> Option<String> {
    text_or_empty(value, field).filter(|text| !text.is_empty())
}

/// A string field that must be present and of type string, but may be `""`.
///
/// `None` still means "absent or not a string", so a missing field is refused
/// where it is required — the two accessors differ only on the empty case.
fn text_or_empty(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// What identifies a stored blob, so two devices can tell whether they agree.
///
/// `generation` is a monotonic counter rather than a timestamp: two machines'
/// clocks disagree by more than the interval between two syncs, so a
/// last-write-wins rule keyed on a wrong clock silently drops the other
/// device's keys. `written_at` is for the user to read.
///
/// # This is the part the provider can read
///
/// The manifest is stored **unencrypted** beside the blob, because every field
/// in it is needed to decide what to do *before* a passphrase is available: to
/// answer "has the remote moved?" without downloading, to refuse a blob a
/// newer build wrote, and to derive the key that would open the blob at all.
/// So it is deliberately the smallest set that makes coordination possible:
///
/// - **What it exposes**: that this app is in use, how big the vault is, when
///   it was last written, how many times, from how many devices, and the KDF
///   parameters — which are public inputs by design, exactly as they are in
///   `bc_storage::ApiKey`.
/// - **What it does not expose**: how many keys there are, what they are
///   labelled, which Cloudflare accounts or email addresses they belong to,
///   and the keys themselves. All of that is inside the envelope.
///
/// There is no `key_count` here for that reason, though it would have been
/// convenient: a count of API keys is a count of the Cloudflare accounts
/// someone administers, and the screen can ask for it after opening the
/// envelope — which a pull needs to do anyway — rather than letting the
/// provider read it for free.
///
/// # Why the KDF parameters travel in the clear
///
/// `bc_crypto`'s envelope is `salt || nonce || ciphertext || tag`: it carries
/// the salt and the nonce but **not** the iteration count, which `decrypt`
/// takes from its own `EncryptionConfig`. So a build whose default iteration
/// count has moved on cannot open an older blob unless the parameters travel
/// beside it. `bc_storage::ApiKey` stores the same three fields per key for
/// the same reason, and this follows it rather than inventing a second answer.
/// PBKDF2 parameters are not secret — an attacker who has the blob can only
/// use them to do the work the legitimate holder does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifest {
    pub generation: u64,
    /// SHA-256 of the sealed envelope, lowercase hex.
    pub checksum: String,
    pub bytes: u64,
    pub written_at: String,
    pub device_id: String,
    /// A coarse description of the writing device, e.g. `Windows 11`.
    ///
    /// Deliberately not a hostname. This field sits unencrypted in someone
    /// else's storage, and a hostname is frequently a person's name; the OS
    /// family is enough for "which of my machines wrote this last" when read
    /// next to `device_id`, which is the thing that actually distinguishes
    /// two installs.
    pub device_label: String,
    pub payload_version: u32,
    /// PBKDF2 iteration count the envelope was sealed with. See above.
    pub iterations: u32,
    pub key_length: usize,
    pub algorithm: String,
}

impl SyncManifest {
    /// Parse a manifest a provider handed back.
    ///
    /// Lenient about unknown fields and strict about the ones it reads, the
    /// same split as [`SyncPayload::parse`]. A manifest that cannot be read is
    /// `Corrupt` rather than "no remote blob": the difference decides whether
    /// the UI offers a pull or a repair.
    pub fn parse(json: &str) -> Result<Self, SyncError> {
        serde_json::from_str(json).map_err(|_| SyncError::Corrupt)
    }

    /// Whether this manifest describes exactly `blob`.
    pub fn describes(&self, blob: &[u8]) -> bool {
        self.bytes == blob.len() as u64 && self.checksum == checksum_hex(blob)
    }
}

/// Lowercase hex SHA-256, for the manifest checksum.
pub fn checksum_hex(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        // `write!` to a String cannot fail; the result is consumed to satisfy
        // the lint rather than because it can be anything but `Ok`.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> serde_json::Value {
        serde_json::json!({
            "id": "key-1",
            "label": "Production",
            "email": "ops@example.test",
            "encrypted_key": "c2VhbGVk",
            "iterations": 600_000,
            "key_length": 32,
            "algorithm": "AES-GCM",
        })
    }

    fn payload(keys: serde_json::Value) -> String {
        serde_json::json!({
            "format": PAYLOAD_FORMAT,
            "version": PAYLOAD_VERSION,
            "written_at": "2026-01-01T00:00:00Z",
            "device_id": "device-1",
            "device_label": "Desktop",
            "keys": keys,
        })
        .to_string()
    }

    #[test]
    fn a_well_formed_payload_round_trips() {
        let parsed = SyncPayload::parse(&payload(serde_json::json!([entry()]))).unwrap();
        assert_eq!(parsed.keys.len(), 1);
        assert_eq!(parsed.keys[0].label, "Production");
        assert_eq!(parsed.keys[0].email.as_deref(), Some("ops@example.test"));
        assert_eq!(parsed.device_label, "Desktop");
    }

    #[test]
    fn an_unrelated_json_file_is_refused_as_not_ours() {
        let foreign = serde_json::json!({
            "format": "better-cloudflare/portable-config",
            "version": 1,
            "keys": [],
        })
        .to_string();
        assert!(matches!(
            SyncPayload::parse(&foreign),
            Err(SyncError::Corrupt)
        ));
    }

    #[test]
    fn a_newer_payload_is_too_new_rather_than_corrupt() {
        let newer = serde_json::json!({
            "format": PAYLOAD_FORMAT,
            "version": PAYLOAD_VERSION + 1,
            "keys": [],
        })
        .to_string();
        assert!(matches!(
            SyncPayload::parse(&newer),
            Err(SyncError::PayloadTooNew)
        ));
    }

    #[test]
    fn unknown_fields_do_not_survive_the_projection() {
        let mut smuggled = entry();
        smuggled["is_admin"] = serde_json::json!(true);
        smuggled["encrypted_key"] = serde_json::json!("c2VhbGVk");
        let parsed = SyncPayload::parse(&payload(serde_json::json!([smuggled]))).unwrap();
        // Round-tripping the parsed entry must not carry the extra field, or
        // it reaches the API key list in the keyring.
        let reserialised = serde_json::to_value(&parsed.keys[0]).unwrap();
        assert!(
            reserialised.get("is_admin").is_none(),
            "a projection that keeps unknown fields is not a projection"
        );
    }

    #[test]
    fn an_entry_missing_its_ciphertext_is_corrupt() {
        let mut broken = entry();
        broken
            .as_object_mut()
            .unwrap()
            .remove("encrypted_key")
            .unwrap();
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!([broken]))),
            Err(SyncError::Corrupt)
        ));
    }

    #[test]
    fn an_empty_string_is_not_a_present_field_where_one_is_required() {
        // An entry with no ciphertext is unusable, so an empty one is refused
        // exactly as a missing one is.
        let mut blank = entry();
        blank["encrypted_key"] = serde_json::json!("");
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!([blank]))),
            Err(SyncError::Corrupt)
        ));

        let mut no_algorithm = entry();
        no_algorithm["algorithm"] = serde_json::json!("");
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!([no_algorithm]))),
            Err(SyncError::Corrupt)
        ));
    }

    /// The counterpart, and the one that was a live defect.
    ///
    /// This test previously asserted the *opposite* — that an empty label was
    /// `Corrupt` — and so it was encoding the bug rather than catching it.
    /// `add_api_key` never validated the label, so an empty one is storable
    /// today; refusing it on parse meant such a key could be pushed and then
    /// never pulled, and because the refusal rejects the whole payload it took
    /// every other key in the vault down with it.
    #[test]
    fn an_empty_label_is_legitimate_data_and_survives_a_round_trip() {
        let mut blank = entry();
        blank["label"] = serde_json::json!("");
        let parsed = SyncPayload::parse(&payload(serde_json::json!([blank, entry()])))
            .expect("an empty label must not refuse the payload");
        assert_eq!(parsed.keys.len(), 2, "the other key must survive too");
        assert_eq!(parsed.keys[0].label, "");
        assert_eq!(parsed.keys[0].encrypted_key, "c2VhbGVk");
    }

    /// A label that is absent, or is not a string at all, is still refused:
    /// the two accessors differ only on the empty case.
    #[test]
    fn a_missing_or_non_string_label_is_still_corrupt() {
        let mut missing = entry();
        missing.as_object_mut().unwrap().remove("label").unwrap();
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!([missing]))),
            Err(SyncError::Corrupt)
        ));

        let mut wrong_type = entry();
        wrong_type["label"] = serde_json::json!(42);
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!([wrong_type]))),
            Err(SyncError::Corrupt)
        ));
    }

    #[test]
    fn too_many_entries_is_refused_before_allocation() {
        let many: Vec<serde_json::Value> = (0..=MAX_VAULT_ENTRIES).map(|_| entry()).collect();
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!(many))),
            Err(SyncError::TooLarge)
        ));
    }

    #[test]
    fn a_negative_iteration_count_is_corrupt_not_a_panic() {
        let mut hostile = entry();
        hostile["iterations"] = serde_json::json!(-1);
        assert!(matches!(
            SyncPayload::parse(&payload(serde_json::json!([hostile]))),
            Err(SyncError::Corrupt)
        ));
    }

    #[test]
    fn checksum_is_lowercase_hex_sha256() {
        // The SHA-256 of the empty string, which is a published value.
        assert_eq!(
            checksum_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(checksum_hex(b"").len(), 64);
    }

    #[test]
    fn a_manifest_detects_a_truncated_blob() {
        let blob = b"sealed-envelope-bytes";
        let manifest = SyncManifest {
            generation: 3,
            checksum: checksum_hex(blob),
            bytes: blob.len() as u64,
            written_at: "2026-01-01T00:00:00Z".into(),
            device_id: "device-1".into(),
            device_label: "Windows 11".into(),
            payload_version: PAYLOAD_VERSION,
            iterations: 600_000,
            key_length: 32,
            algorithm: "AES-GCM".into(),
        };
        assert!(manifest.describes(blob));
        assert!(!manifest.describes(&blob[..blob.len() - 1]));
        // Same length, different bytes: the length check alone would pass.
        let mut swapped = blob.to_vec();
        swapped[0] = b'S';
        assert!(!manifest.describes(&swapped));
    }

    #[test]
    fn a_manifest_is_camel_case_on_the_wire() {
        let manifest = SyncManifest {
            generation: 1,
            checksum: checksum_hex(b"x"),
            bytes: 1,
            written_at: "2026-01-01T00:00:00Z".into(),
            device_id: "device-1".into(),
            device_label: "Windows 11".into(),
            payload_version: PAYLOAD_VERSION,
            iterations: 600_000,
            key_length: 32,
            algorithm: "AES-GCM".into(),
        };
        let json = serde_json::to_value(&manifest).unwrap();
        assert!(json.get("writtenAt").is_some());
        assert!(json.get("payloadVersion").is_some());
        assert!(json.get("keyLength").is_some());
        assert!(json.get("written_at").is_none());
    }

    /// The manifest sits unencrypted in someone else's storage, so what it
    /// does *not* say is a security property and not an oversight. A
    /// `keyCount` added for a convenient UI label would tell the provider how
    /// many Cloudflare accounts this person administers.
    #[test]
    fn the_manifest_does_not_leak_the_contents_of_the_vault() {
        let manifest = SyncManifest {
            generation: 1,
            checksum: checksum_hex(b"x"),
            bytes: 1,
            written_at: "2026-01-01T00:00:00Z".into(),
            device_id: "device-1".into(),
            device_label: "Windows 11".into(),
            payload_version: PAYLOAD_VERSION,
            iterations: 600_000,
            key_length: 32,
            algorithm: "AES-GCM".into(),
        };
        let json = serde_json::to_value(&manifest).unwrap();
        for leaked in ["keyCount", "key_count", "keys", "labels", "emails"] {
            assert!(
                json.get(leaked).is_none(),
                "{leaked} must stay inside the sealed envelope"
            );
        }
    }
}
