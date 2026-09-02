//! Persistence schema for verified WebAuthn credentials.
//!
//! # Why this is a separate store
//!
//! `passkeys:{id}` holds the records the pre-`d05fe59` implementation wrote:
//! whatever JSON the browser handed it, stored verbatim and never verified. No
//! public key was ever captured, so no assertion can be checked against those
//! records. They are readable and deletable, and that is all they will ever be.
//!
//! Verified credentials therefore live under a *different* key,
//! `webauthn_credentials:{id}`. Keeping the two apart is not tidiness: it makes
//! it structurally impossible for a legacy record to be mistaken for a verified
//! one, because the deserialiser for one cannot produce the other. Mixing them
//! into a single list would put that guarantee in a runtime check that a future
//! edit could weaken.
//!
//! # What is stored
//!
//! [`StoredCredential`] wraps `webauthn-rs`'s own [`Passkey`] rather than
//! re-deriving its contents field by field. `Passkey` encapsulates the COSE
//! public key, the credential id, the signature counter, the AAGUID, the
//! algorithm, and the user-verification and backup state, and upstream
//! documents it as safe to serialise and persist. Copying those out into our
//! own fields would create two representations that drift, and the one the
//! library actually enforces against would not be the one we stored.
//!
//! Two things `Passkey` does *not* carry are stored alongside it: the RP ID and
//! the origin the credential was created under. WebAuthn scopes a credential to
//! its RP ID, so a credential enrolled under `localhost` (development) can
//! never be asserted under `tauri.localhost` (production on Windows). Without
//! the RP ID on the record there is no way to tell that apart from a broken
//! credential, and the user would be shown an opaque failure instead of
//! "this passkey was enrolled in a different build; re-enroll".
//!
//! # Serialisation stability
//!
//! Upstream publishes no cross-version JSON stability guarantee for `Passkey`.
//! Three things bound that risk, and all three are load-bearing:
//!
//! 1. the [`StoredCredentialSchema`] discriminator, which is checked on read
//!    and rejects any value other than `bc-webauthn-v1`;
//! 2. a record that fails to read back is skipped and reported as needing
//!    re-enrolment — never repaired, never silently dropped, never deleted
//!    automatically, and never a panic;
//! 3. a committed golden fixture (see `tests/`), so a `webauthn-rs` upgrade
//!    that changes the format fails CI loudly instead of quietly stranding
//!    every credential a user has enrolled.

use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::{alphabet, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use webauthn_rs::prelude::Passkey;

use crate::{PasskeyError, Storage};

/// The only schema value this build will read.
pub const CREDENTIAL_SCHEMA_V1: &str = "bc-webauthn-v1";

/// Verified credentials for `id`.
///
/// Deliberately *not* `passkeys:{id}`: see the module documentation.
pub fn credential_storage_key(id: &str) -> String {
    format!("webauthn_credentials:{id}")
}

/// Credential ids are written in one spelling — URL-safe Base64, unpadded,
/// exactly as `webauthn-rs` emits them — so a lookup only has to tolerate
/// padding, never a different alphabet.
///
/// This is narrower than the legacy comparison in `lib.rs` on purpose.
/// `94d74d1` fixed a collision there: two spellings that no single encoder
/// could have produced (`ab-c` and `ab+c`) decoded to the same octets through
/// *different* alphabets, so deleting one deleted the other. Legacy records
/// need that leniency bounded because older builds stored whatever the browser
/// supplied. This store has one writer and one spelling, so it needs no
/// cross-alphabet leniency at all and must not acquire any.
const URL_SAFE_ANY_PAD: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Schema discriminator for [`StoredCredential`].
///
/// A single-variant enum rather than a `String`, so "reject any other value" is
/// enforced by the deserialiser instead of by a check someone can forget to
/// call. It serialises as the bare string `bc-webauthn-v1`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StoredCredentialSchema {
    #[serde(rename = "bc-webauthn-v1")]
    V1,
}

/// One verified WebAuthn credential, as persisted.
///
/// Note the absence of shadow copies of the AAGUID and the signature counter.
/// Both live inside `passkey`, which is what the library enforces against; a
/// second copy could disagree with it, and the copy is the one a reader would
/// trust.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    /// Checked on read. Any other value makes the record unreadable rather
    /// than partially trusted.
    pub schema: StoredCredentialSchema,
    /// URL-safe unpadded Base64 of the raw credential id: the handle the UI
    /// lists and deletes by. Must agree with `passkey.cred_id()`; a record
    /// where it does not is unreadable, not a credential with a nickname.
    pub credential_id: String,
    /// The RP ID this credential was created under. An assertion must be
    /// refused when this differs from the runtime RP ID.
    pub rp_id: String,
    /// The origin observed at registration. Diagnostics only — it is recorded
    /// so the "enrolled in a different context" message can name the context.
    /// It is not a trust anchor: the trust anchor is the origin configured on
    /// the `Webauthn` instance, which the library checks for itself.
    pub origin: String,
    /// The library's own credential representation.
    pub passkey: Passkey,
    /// RFC 3339 wall clock. Display only; nothing decides anything on it.
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// Reserved for a user-facing name. Not settable yet.
    #[serde(default)]
    pub label: Option<String>,
}

impl StoredCredential {
    /// Build a record around a `Passkey` that `finish_passkey_registration`
    /// just returned.
    ///
    /// The credential id is taken from the `Passkey` rather than accepted from
    /// the caller, so the handle and the key material cannot disagree.
    pub fn new(passkey: Passkey, rp_id: &str, origin: &str, created_at: String) -> Self {
        let credential_id = encode_credential_id(passkey.cred_id().as_ref());
        Self {
            schema: StoredCredentialSchema::V1,
            credential_id,
            rp_id: rp_id.to_string(),
            origin: origin.to_string(),
            passkey,
            created_at,
            last_used_at: None,
            label: None,
        }
    }

    /// The raw credential id, from the `Passkey` itself.
    pub fn raw_credential_id(&self) -> &[u8] {
        self.passkey.cred_id().as_ref()
    }

    /// The signature counter the library is holding for this credential.
    ///
    /// Read back out of `Passkey`'s serialised form because `webauthn-rs` 0.5
    /// exposes no counter accessor on `Passkey` and the field is reachable only
    /// through `danger-credential-internals`, which this crate must not enable.
    /// Reporting `0` when the shape is not what we expect is safe: this value
    /// is displayed, never enforced. Counter policy belongs entirely to
    /// `Passkey::update_credential`.
    pub fn counter(&self) -> u64 {
        serde_json::to_value(&self.passkey)
            .ok()
            .and_then(|value| value.get("cred")?.get("counter")?.as_u64())
            .unwrap_or(0)
    }

    /// Was this credential enrolled under `runtime_rp_id`?
    ///
    /// A credential whose RP ID does not match the one this process is running
    /// under can never produce a valid assertion, so it must be filtered out
    /// before a ceremony rather than allowed to fail opaquely inside one.
    pub fn matches_rp_id(&self, runtime_rp_id: &str) -> bool {
        self.rp_id == runtime_rp_id
    }

    /// Does `requested` address this credential?
    pub fn matches_credential_id(&self, requested: &str) -> bool {
        credential_ids_match(&self.credential_id, requested)
    }

    /// Is the record internally consistent? The stored handle must be the
    /// credential id inside the `Passkey`, in the canonical spelling.
    fn is_self_consistent(&self) -> bool {
        credential_ids_match(
            &self.credential_id,
            &encode_credential_id(self.raw_credential_id()),
        )
    }
}

/// The canonical spelling of a raw credential id: URL-safe Base64, unpadded —
/// the same encoding `webauthn-rs` uses when it serialises one.
pub fn encode_credential_id(raw: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

/// Compare two verified-store credential ids.
///
/// Exact string equality is the normal path; decoding is a fallback that
/// tolerates padding and surrounding whitespace only. Decoding happens under
/// the URL-safe alphabet alone, so a standard-alphabet spelling of the same
/// octets does not match — see [`URL_SAFE_ANY_PAD`].
fn credential_ids_match(stored: &str, requested: &str) -> bool {
    let stored = stored.trim();
    let requested = requested.trim();
    if stored.is_empty() || requested.is_empty() {
        return false;
    }
    if stored == requested {
        return true;
    }
    match (
        URL_SAFE_ANY_PAD.decode(stored),
        URL_SAFE_ANY_PAD.decode(requested),
    ) {
        (Ok(stored), Ok(requested)) => !stored.is_empty() && stored == requested,
        _ => false,
    }
}

/// Why a stored record cannot be used to verify an assertion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeadCredentialReason {
    /// Browser JSON from before verified registration existed. It carries no
    /// public key, so nothing can be verified against it and nothing can
    /// upgrade it. Delete and re-enroll is the only path.
    Legacy,
    /// It claims to be a versioned record but this build cannot read it back:
    /// an unrecognised `schema`, a `passkey` that does not deserialise, or a
    /// `credentialId` that disagrees with the `Passkey` beside it.
    Unreadable(&'static str),
}

impl DeadCredentialReason {
    /// A short, user-facing explanation. Deliberately says what the user has to
    /// do, because in every case they have to do the same thing.
    pub fn explanation(self) -> &'static str {
        match self {
            Self::Legacy => {
                "This passkey was enrolled by an older version that never captured a public key. \
                 It cannot sign in and must be removed and re-enrolled."
            }
            Self::Unreadable(_) => {
                "This passkey's stored registration could not be read by this version. \
                 It cannot sign in and must be removed and re-enrolled."
            }
        }
    }
}

/// What one raw stored record turned out to be.
#[derive(Clone, Debug)]
pub enum RecordClass {
    /// A readable, self-consistent verified credential.
    Verified(Box<StoredCredential>),
    /// Present, addressable, and unusable.
    Dead(DeadCredentialReason),
}

impl RecordClass {
    pub fn is_verified(&self) -> bool {
        matches!(self, Self::Verified(_))
    }

    pub fn dead_reason(&self) -> Option<DeadCredentialReason> {
        match self {
            Self::Verified(_) => None,
            Self::Dead(reason) => Some(*reason),
        }
    }
}

/// Classify one raw stored record.
///
/// The distinction that matters is "can an assertion be verified against this",
/// and the answer is yes only for [`RecordClass::Verified`]. Everything else is
/// dead material the user has to re-enroll, and the two dead reasons exist so
/// the UI can say *why* rather than showing one undifferentiated failure.
///
/// A record with no `schema` key predates the discriminator, so it is legacy
/// browser JSON — as is any non-object, which is what a corrupt or hand-edited
/// record looks like. A record that *has* a `schema` key is claiming to be a
/// versioned record, so failing to read it back is a schema problem, not a
/// legacy one.
///
/// This never returns `Verified` for a legacy record: legacy records carry no
/// `schema` and no `passkey`, and `StoredCredential` requires both.
pub fn classify_record(value: &Value) -> RecordClass {
    let Some(object) = value.as_object() else {
        return RecordClass::Dead(DeadCredentialReason::Legacy);
    };
    if !object.contains_key("schema") {
        return RecordClass::Dead(DeadCredentialReason::Legacy);
    }
    let credential: StoredCredential = match serde_json::from_value(value.clone()) {
        Ok(credential) => credential,
        // Distinguishing an unknown schema from other shape problems is worth
        // one extra look: it is the signal that this record was written by a
        // *newer* build, which is a different conversation with the user than
        // corruption.
        Err(_) => {
            let recognised = object
                .get("schema")
                .and_then(Value::as_str)
                .is_some_and(|schema| schema == CREDENTIAL_SCHEMA_V1);
            return RecordClass::Dead(DeadCredentialReason::Unreadable(if recognised {
                "stored registration could not be deserialised"
            } else {
                "unrecognised credential schema"
            }));
        }
    };
    if !credential.is_self_consistent() {
        return RecordClass::Dead(DeadCredentialReason::Unreadable(
            "stored credential id disagrees with the stored key material",
        ));
    }
    RecordClass::Verified(Box::new(credential))
}

/// A record in the verified store that this build cannot use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeadCredential {
    /// Position in the stored list, so the record stays addressable even when
    /// nothing about it could be parsed.
    pub index: usize,
    /// The handle it claims, when it claims a readable one.
    pub credential_id: Option<String>,
    pub reason: DeadCredentialReason,
}

/// Everything the verified store holds for one account.
#[derive(Clone, Debug, Default)]
pub struct VerifiedCredentials {
    pub credentials: Vec<StoredCredential>,
    /// Records that are present but unusable. They are reported so the UI can
    /// name them, and left in place: this layer never deletes anything on its
    /// own, because a user who has not been told cannot have decided.
    pub dead: Vec<DeadCredential>,
}

impl VerifiedCredentials {
    pub fn is_empty(&self) -> bool {
        self.credentials.is_empty()
    }

    /// The subset that could actually be asserted under `runtime_rp_id`.
    pub fn for_rp_id(&self, runtime_rp_id: &str) -> Vec<StoredCredential> {
        self.credentials
            .iter()
            .filter(|credential| credential.matches_rp_id(runtime_rp_id))
            .cloned()
            .collect()
    }

    pub fn find(&self, credential_id: &str) -> Option<&StoredCredential> {
        self.credentials
            .iter()
            .find(|credential| credential.matches_credential_id(credential_id))
    }
}

fn storage_error(error: impl std::fmt::Display) -> PasskeyError {
    PasskeyError::Storage(error.to_string())
}

/// Read the verified credentials for `id`.
///
/// Reads the list as raw JSON first, so one unreadable record costs that record
/// and not the whole enrolment. A stored value that is not a JSON list at all
/// is still an error: reporting it as "no passkeys enrolled" would invite the
/// app to overwrite a user's only remaining credential material.
pub async fn load_credentials(
    storage: &Storage,
    id: &str,
) -> Result<VerifiedCredentials, PasskeyError> {
    let key = credential_storage_key(id);
    let raw: Vec<Value> = storage.get_typed_list(&key).await.map_err(storage_error)?;

    let mut loaded = VerifiedCredentials::default();
    for (index, value) in raw.iter().enumerate() {
        match classify_record(value) {
            RecordClass::Verified(credential) => loaded.credentials.push(*credential),
            RecordClass::Dead(reason) => loaded.dead.push(DeadCredential {
                index,
                credential_id: value
                    .get("credentialId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                reason,
            }),
        }
    }
    Ok(loaded)
}

/// Append a verified credential.
///
/// Refuses a credential id already present in the store, readable or not, so a
/// second enrolment of the same authenticator cannot shadow the first.
///
/// The transaction runs over raw JSON so that records this build cannot read
/// are rewritten byte for byte rather than being dropped by a round trip
/// through a type that does not understand them.
pub async fn append_credential(
    storage: &Storage,
    id: &str,
    credential: StoredCredential,
) -> Result<(), PasskeyError> {
    let key = credential_storage_key(id);
    let credential_id = credential.credential_id.clone();
    let encoded = serde_json::to_value(&credential).map_err(storage_error)?;

    let existed = storage
        .mutate_typed_list(&key, false, move |records: &mut Vec<Value>| {
            let duplicate = records.iter().any(|record| {
                record
                    .get("credentialId")
                    .and_then(Value::as_str)
                    .is_some_and(|stored| credential_ids_match(stored, &credential_id))
            });
            if duplicate {
                return Ok(true);
            }
            records.push(encoded);
            Ok(false)
        })
        .await
        .map_err(storage_error)?;

    if existed {
        Err(PasskeyError::CredentialAlreadyEnrolled)
    } else {
        Ok(())
    }
}

/// Replace the stored record for `credential.credential_id` in place.
///
/// This is the counter/`lastUsedAt` update path after a successful assertion.
/// It never inserts: a credential that is not already stored has not been
/// registered, and creating one here would be a write on a path that did not
/// verify a registration.
pub async fn replace_credential(
    storage: &Storage,
    id: &str,
    credential: StoredCredential,
) -> Result<(), PasskeyError> {
    let key = credential_storage_key(id);
    let credential_id = credential.credential_id.clone();
    let encoded = serde_json::to_value(&credential).map_err(storage_error)?;

    let replaced = storage
        .mutate_typed_list(&key, false, move |records: &mut Vec<Value>| {
            let slot = records.iter_mut().find(|record| {
                record
                    .get("credentialId")
                    .and_then(Value::as_str)
                    .is_some_and(|stored| credential_ids_match(stored, &credential_id))
            });
            match slot {
                Some(slot) => {
                    *slot = encoded;
                    Ok(true)
                }
                None => Ok(false),
            }
        })
        .await
        .map_err(storage_error)?;

    if replaced {
        Ok(())
    } else {
        Err(PasskeyError::NotFound)
    }
}

/// Remove a credential from the verified store.
///
/// Returns whether anything matched, so a caller searching both stores can tell
/// the difference between "removed" and "no such credential". Empties the
/// record rather than stranding an empty list, matching `delete_passkey`.
pub async fn delete_credential(
    storage: &Storage,
    id: &str,
    credential_id: &str,
) -> Result<bool, PasskeyError> {
    let key = credential_storage_key(id);
    let credential_id = credential_id.to_string();
    storage
        .mutate_typed_list(&key, true, move |records: &mut Vec<Value>| {
            let before = records.len();
            records.retain(|record| {
                !record
                    .get("credentialId")
                    .and_then(Value::as_str)
                    .is_some_and(|stored| credential_ids_match(stored, &credential_id))
            });
            Ok(before != records.len())
        })
        .await
        .map_err(storage_error)
}

/// Remove an unreadable record by the index [`load_credentials`] reported for
/// it.
///
/// A record whose `credentialId` cannot be read has no handle to delete by, so
/// without this it would be permanently stuck in the user's list — the same
/// dead end `94d74d1` fixed for legacy records with a blank id. The index is
/// matched against a record that is *still* unreadable, so a concurrent write
/// cannot turn this into a delete of a working credential.
pub async fn delete_dead_credential_at(
    storage: &Storage,
    id: &str,
    index: usize,
) -> Result<bool, PasskeyError> {
    let key = credential_storage_key(id);
    storage
        .mutate_typed_list(&key, true, move |records: &mut Vec<Value>| {
            let is_dead = records
                .get(index)
                .is_some_and(|record| !classify_record(record).is_verified());
            if is_dead {
                records.remove(index);
            }
            Ok(is_dead)
        })
        .await
        .map_err(storage_error)
}
