//! # bc-collections
//!
//! A **collection** is a named set of API keys sealed under one passphrase, so
//! that unlocking it once makes every member key usable without a per-key
//! prompt.
//!
//! The renderer's half of this is `src/lib/collections/types.ts`, and **that
//! file is the contract**: every shape here is one of its types, spelled the
//! way it spells them. Read its header before this one — it explains why a key
//! keeps its own per-key envelope as well as being in a collection, why
//! membership is exclusive, why adding a key is inherently a two-passphrase
//! operation, and why the KDF parameters have to travel in cleartext. Those
//! are the four decisions this crate exists to implement and none of them is
//! obvious from the code alone.
//!
//! # What this crate holds, and what it does not
//!
//! It holds the model and the crypto: the record, the envelope, the membership
//! invariants and the bounds. It has **no Tauri dependency** and **persists
//! nothing** — it takes values and returns values, and the command layer owns
//! storage. The same division as `bc-sync`, and for the same reason: a crate
//! that cannot reach a keyring or a database can be tested exhaustively
//! without either.
//!
//! It therefore cannot answer two of the contract's failure codes on its own.
//! [`CollectionError::NotFound`] and [`CollectionError::KeyLocked`] are never
//! constructed here; they exist so that the command layer has one error type
//! for the whole feature and so that [`CollectionError::code`] covers the
//! contract exhaustively. `key-locked` in particular is the command layer's to
//! raise, because "can this key's secret be read right now" is a question
//! about the keyring and the OS vault.
//!
//! # A rotation cannot half-apply
//!
//! Re-sealing under a new passphrase and recording the new KDF parameters are
//! two facts that must move together: a record that says 100,000 iterations
//! beside an envelope sealed at 200,000 describes an envelope it cannot open,
//! and the user's keys are gone with no error to read. This crate makes that
//! state unconstructible at its own boundary — every operation that re-seals
//! returns a [`SealedCollection`], which is the record *and* the envelope as
//! one value, and the record's parameters are built from the very
//! `EncryptionConfig` the seal used rather than copied from the caller's.
//! There is no API here that hands back a new envelope without the record that
//! describes it, and none that hands back a record without its envelope.
//!
//! What this crate cannot guarantee is the *write*. The command layer must
//! store both halves of a `SealedCollection` in one operation; if it writes
//! the record and then fails to write the envelope, the hazard is back. That
//! is the one line of the storage code worth reviewing twice.
//!
//! # Secrets
//!
//! [`CollectionMember`] holds an API key in plaintext and has a hand-written
//! `Debug` that redacts it, following `bc_ai_provider::ProviderProfile`. The
//! serialised plaintext of an envelope is a `Zeroizing<String>` for its whole
//! life, and [`vault::CollectionVault`] holds its session passphrases the same
//! way.
//!
//! Note that `bc_session::SessionCredential` is **not** a model to follow
//! here: it derives `Debug` over a plaintext `api_key`, so a decrypted
//! Cloudflare token is one `{:?}` away from a log line. That is a defect in
//! that crate, not a house style.

pub mod payload;
pub mod vault;

pub use payload::{
    CollectionMember, CollectionPayload, COLLECTION_PAYLOAD_FORMAT, COLLECTION_PAYLOAD_VERSION,
    MAX_COLLECTION_MEMBERS,
};
pub use vault::CollectionVault;

/// Re-exported so the command layer names the sealing parameters with the same
/// type this crate validates them with.
pub use bc_crypto::EncryptionConfig;

use bc_crypto::{CryptoError, CryptoManager, MAX_PLAINTEXT_BYTES};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The longest a collection label may be, in Unicode code points.
///
/// Counted in `chars()` rather than bytes, so that a label in a non-Latin
/// script is not refused at a third of the length of an ASCII one. Note that
/// this is **not** the unit JavaScript's `String.prototype.length` uses (UTF-16
/// code units), so a UI validating at the same number can disagree with this
/// for astral-plane characters; the UI should count code points too.
pub const MAX_COLLECTION_LABEL_LENGTH: usize = 120;

// ── Error type ──────────────────────────────────────────────────────────────

/// Why a collection operation did not happen.
///
/// Each variant maps to exactly one `CollectionFailureCode` in
/// `src/lib/collections/types.ts` through [`CollectionError::code`], and
/// `tests::failure_codes_match_the_contract` pins that mapping against the
/// TypeScript file itself. Prose never crosses the boundary: this process has
/// no locale, so a translated sentence built here is a sentence that can only
/// be English.
#[derive(Debug, thiserror::Error)]
pub enum CollectionError {
    /// Never constructed here — the store is the command layer's. See the
    /// module header.
    #[error("no collection with that id")]
    NotFound,
    #[error("the collection is locked")]
    Locked,
    #[error("the passphrase did not open the collection")]
    WrongPassphrase,
    #[error("no passphrase was supplied")]
    NoPassphrase,
    #[error("the key is already in a collection")]
    AlreadyMember,
    #[error("the key is not in this collection")]
    NotAMember,
    /// Never constructed here — reading a key's secret is the command layer's.
    /// See the module header.
    #[error("the key's own secret could not be read")]
    KeyLocked,
    /// The member-count bound. Distinct from [`Self::EnvelopeTooLarge`] on
    /// purpose, even though both answer `too-large`: see
    /// [`SealedCollection::add_member`].
    #[error("a collection may hold at most {limit} keys")]
    TooManyMembers { limit: usize },
    /// The envelope-size bound.
    #[error("the sealed collection would be {bytes} bytes, over the {max_bytes}-byte limit")]
    EnvelopeTooLarge { bytes: usize, max_bytes: usize },
    #[error("a collection with that label already exists")]
    DuplicateLabel,
    #[error("a collection label must be between 1 and {max} characters")]
    InvalidLabel { max: usize },
    #[error("the collection could not be read")]
    Corrupt,
    #[error("the collection was written by a newer version of this app")]
    PayloadTooNew,
    #[error("{0}")]
    Backend(String),
}

impl CollectionError {
    /// The `CollectionFailureCode` the renderer words.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not-found",
            Self::Locked => "locked",
            Self::WrongPassphrase => "wrong-passphrase",
            Self::NoPassphrase => "no-passphrase",
            Self::AlreadyMember => "already-member",
            Self::NotAMember => "not-a-member",
            Self::KeyLocked => "key-locked",
            Self::TooManyMembers { .. } | Self::EnvelopeTooLarge { .. } => "too-large",
            Self::DuplicateLabel => "duplicate-label",
            Self::InvalidLabel { .. } => "invalid-label",
            Self::Corrupt => "corrupt",
            Self::PayloadTooNew => "payload-too-new",
            Self::Backend(_) => "backend-error",
        }
    }

    /// The backend's own words, for the `message` field of a failed
    /// `CollectionOutcome`, or `None`.
    ///
    /// `None` for every variant whose cause the code already states in full.
    /// The contract is explicit about this and it is not a style preference: a
    /// detail line under a `locked` refusal adds nothing, and because it can
    /// only ever be English it puts untranslatable text beside translated
    /// text. What does earn a message is a refusal that has to **name a
    /// number** — the two bounds and the label length — because "too large" on
    /// its own does not tell the user what to do next.
    pub fn message(&self) -> Option<String> {
        match self {
            Self::TooManyMembers { .. }
            | Self::EnvelopeTooLarge { .. }
            | Self::InvalidLabel { .. } => Some(self.to_string()),
            Self::Backend(message) => Some(message.clone()),
            _ => None,
        }
    }

    /// This error as the `CollectionFailure` the IPC layer returns.
    pub fn failure(&self) -> CollectionFailure {
        CollectionFailure {
            code: self.code().to_string(),
            message: self.message(),
        }
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/// A refusal, with the verbatim backend message where there is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionFailure {
    pub code: String,
    /// Deliberately **not** `skip_serializing_if`: the contract types this as
    /// `string | null`, and a field omitted from the JSON arrives in
    /// TypeScript as `undefined`, which is a different value from `null` to
    /// anything that checks it.
    pub message: Option<String>,
}

/// The result of a collection command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum CollectionOutcome {
    Ok,
    Failed(CollectionFailure),
}

impl From<&CollectionError> for CollectionOutcome {
    fn from(error: &CollectionError) -> Self {
        Self::Failed(error.failure())
    }
}

/// One collection, as the backend stores it. Everything here is cleartext.
///
/// The member *secrets* are in the envelope; `member_ids` is the cleartext
/// index of who is in it, which the UI needs in order to render a list while
/// the collection is still locked — otherwise the user cannot tell which
/// passphrase to type.
///
/// The index is never written by hand. Every re-seal rebuilds it from the
/// member list that was actually sealed, so it cannot drift away from the
/// envelope it describes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecord {
    pub id: String,
    pub label: String,
    /// RFC 3339. Display only — nothing orders on it.
    pub created_at: String,
    /// RFC 3339, updated on every re-seal. Display only.
    pub updated_at: String,
    pub member_ids: Vec<String>,
    /// PBKDF2 iterations the envelope was sealed with.
    pub iterations: u32,
    /// Derived key length in **bytes**, as `bc_crypto` and
    /// `bc_storage::ApiKey` both mean it. The contract's comment says bits;
    /// the code wins, and 32 here means AES-256.
    pub key_length: usize,
    /// KDF/cipher identifier, canonicalised by `bc_crypto` to `"AES-GCM"`.
    pub algorithm: String,
}

/// Whether a collection's passphrase is held in memory right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStatus {
    pub id: String,
    /// In-memory only, session-scoped, never persisted. False after a
    /// relaunch, always.
    pub unlocked: bool,
}

/// What the settings UI needs to render the collections list.
///
/// Declared here rather than in the command layer so that the camelCase of the
/// wire is pinned in one place by a test, instead of being re-spelled next to
/// every command that returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionsOverview {
    pub collections: Vec<CollectionRecord>,
    pub statuses: Vec<CollectionStatus>,
    /// Keys that are in no collection. They still work exactly as they always
    /// have; collections are additive and nothing is forced into one.
    pub unassigned_key_ids: Vec<String>,
}

/// A record and the envelope it describes, which exist only together.
///
/// See the module header: this type is how a half-applied re-seal is made
/// unconstructible. Store both halves in one write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedCollection {
    pub record: CollectionRecord,
    /// The `bc_crypto` envelope holding the member secrets. Ciphertext, so
    /// safe to print and safe to store.
    pub envelope: String,
}

impl SealedCollection {
    /// Create a new, empty collection sealed under `passphrase`.
    ///
    /// `other_labels` is every existing collection's label, for the
    /// duplicate check. `seal_config` is validated for *encryption*, so an
    /// iteration count below `bc_crypto::MIN_PBKDF2_ITERATIONS` is refused as
    /// `backend-error` rather than quietly accepted.
    pub fn create(
        id: impl Into<String>,
        label: &str,
        passphrase: &str,
        other_labels: &[String],
        seal_config: EncryptionConfig,
        now: DateTime<Utc>,
    ) -> Result<Self, CollectionError> {
        let label = validate_label(label, other_labels)?;
        let (envelope, config) = seal_members(&[], passphrase, seal_config)?;
        let timestamp = rfc3339(now);
        Ok(Self {
            record: CollectionRecord {
                id: id.into(),
                label,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                member_ids: Vec::new(),
                iterations: config.iterations,
                key_length: config.key_length,
                algorithm: config.algorithm,
            },
            envelope,
        })
    }

    /// Open the envelope and return the member secrets.
    ///
    /// The parse is strict; see [`CollectionPayload::parse`].
    pub fn open(&self, passphrase: &str) -> Result<CollectionPayload, CollectionError> {
        CollectionPayload::parse(self.open_json(passphrase)?.as_str())
    }

    /// Whether `passphrase` opens this collection.
    ///
    /// A full open rather than a bare decrypt: an envelope whose plaintext
    /// this build cannot read is not a collection that should be reported as
    /// unlocked, because the next operation on it would fail anyway and the
    /// user would have been told the passphrase was right.
    pub fn verify_passphrase(&self, passphrase: &str) -> Result<(), CollectionError> {
        self.open(passphrase).map(|_| ())
    }

    /// Rename the collection. Does not touch the envelope.
    ///
    /// `other_labels` is every **other** collection's label; use
    /// [`labels_excluding`] to build it, so that renaming a collection to the
    /// label it already has is not reported as a duplicate of itself.
    ///
    /// `updated_at` does not move: the contract defines it as the time of the
    /// last re-seal, and a rename re-seals nothing.
    pub fn rename(
        &self,
        label: &str,
        other_labels: &[String],
    ) -> Result<CollectionRecord, CollectionError> {
        let label = validate_label(label, other_labels)?;
        Ok(CollectionRecord {
            label,
            ..self.record.clone()
        })
    }

    /// Seal one more key's secret into the collection.
    ///
    /// `current_collection` is the collection the key is in **according to the
    /// caller's key store**, or `None` if it is in none. Any `Some` refuses
    /// with `already-member`, this collection's own id included: membership is
    /// exclusive, so "already in another collection" is a refusal and not a
    /// move. It is a parameter rather than something derived because this
    /// crate holds no store, and making the caller state it is what stops the
    /// cross-collection case from being the one nobody checks.
    ///
    /// # Two refusals, two bounds, none of them doubled
    ///
    /// There are exactly two `already-member` checks and they are reachable
    /// independently: the caller's assignment above, and the envelope's own
    /// contents after it is opened. A third check against `member_ids` was
    /// deliberately left out — it would be a redundant guard on the same
    /// claim, so a mutation to either of the real checks would be caught by it
    /// and neither would be proven. The index needs no guarding anyway, since
    /// every re-seal rebuilds it from what was sealed.
    ///
    /// The same rule applies to the bounds. [`MAX_COLLECTION_MEMBERS`] is
    /// checked here, once, against the opened member list; the envelope byte
    /// cap is checked once in [`seal_members`]. They are separate limits that
    /// fail in separate situations — 129 small keys against one enormous one —
    /// and each has its own variant so that a test can tell which fired.
    pub fn add_member(
        &self,
        passphrase: &str,
        member: CollectionMember,
        current_collection: Option<&str>,
        seal_config: EncryptionConfig,
        now: DateTime<Utc>,
    ) -> Result<Self, CollectionError> {
        // Before the key derivation, and safe to answer without one:
        // membership is cleartext on the record by design, so refusing here
        // discloses nothing `member_ids` does not already say.
        if current_collection.is_some() {
            return Err(CollectionError::AlreadyMember);
        }

        let mut payload = self.open(passphrase)?;
        if payload.contains(&member.id) {
            return Err(CollectionError::AlreadyMember);
        }
        payload.members.push(member);

        if payload.members.len() > MAX_COLLECTION_MEMBERS {
            return Err(CollectionError::TooManyMembers {
                limit: MAX_COLLECTION_MEMBERS,
            });
        }

        self.reseal(&payload.members, passphrase, seal_config, now)
    }

    /// Take a key's secret out of the collection.
    ///
    /// The key is not harmed: it still has its own envelope under its own
    /// password. That is what the contract's recoverability argument buys.
    pub fn remove_member(
        &self,
        passphrase: &str,
        key_id: &str,
        seal_config: EncryptionConfig,
        now: DateTime<Utc>,
    ) -> Result<Self, CollectionError> {
        let mut payload = self.open(passphrase)?;
        let before = payload.members.len();
        payload.members.retain(|member| member.id != key_id);
        if payload.members.len() == before {
            return Err(CollectionError::NotAMember);
        }
        self.reseal(&payload.members, passphrase, seal_config, now)
    }

    /// Re-seal the envelope under a new passphrase.
    ///
    /// Takes the current passphrase and verifies it by opening the envelope,
    /// rather than trusting an unlocked state: an unlocked collection would
    /// otherwise let someone who walked up to an open app change the
    /// passphrase without knowing it.
    ///
    /// This rotates the collection only. Each member key's own password is
    /// untouched and still opens that key — so rotating a collection is not
    /// rotating access to its keys, and the UI has to say so.
    ///
    /// Nothing is mutated: a refused rotation leaves `self` exactly as it was,
    /// and a successful one returns a new value. The caller must replace any
    /// held passphrase for this collection;
    /// [`vault::CollectionVault::rotate`] does both together so that a vault
    /// entry cannot be left reporting `unlocked` while holding a passphrase
    /// that no longer opens anything.
    pub fn rotate(
        &self,
        current_passphrase: &str,
        new_passphrase: &str,
        seal_config: EncryptionConfig,
        now: DateTime<Utc>,
    ) -> Result<Self, CollectionError> {
        let payload = self.open(current_passphrase)?;
        self.reseal(&payload.members, new_passphrase, seal_config, now)
    }

    /// Seal `members` and build the record that describes the result.
    ///
    /// The record's KDF fields come from the config the seal actually used —
    /// `bc_crypto` canonicalises the algorithm name, so reading them back off
    /// the manager rather than off the caller's input is what keeps the record
    /// an accurate description of the envelope beside it.
    fn reseal(
        &self,
        members: &[CollectionMember],
        passphrase: &str,
        seal_config: EncryptionConfig,
        now: DateTime<Utc>,
    ) -> Result<Self, CollectionError> {
        let (envelope, config) = seal_members(members, passphrase, seal_config)?;
        Ok(Self {
            record: CollectionRecord {
                id: self.record.id.clone(),
                label: self.record.label.clone(),
                created_at: self.record.created_at.clone(),
                updated_at: rfc3339(now),
                member_ids: members.iter().map(|member| member.id.clone()).collect(),
                iterations: config.iterations,
                key_length: config.key_length,
                algorithm: config.algorithm,
            },
            envelope,
        })
    }

    /// The decrypted plaintext, before the projection.
    ///
    /// Private, and a `Zeroizing<String>` because this is the one place every
    /// member secret exists in one contiguous allocation.
    fn open_json(&self, passphrase: &str) -> Result<Zeroizing<String>, CollectionError> {
        require_passphrase(passphrase)?;
        // `new`, not `new_for_encryption`: an envelope sealed by an older
        // build at a lower iteration count must still open, or the keys in it
        // are unreachable. Writes are held to the current floor by
        // `seal_members`.
        let crypto = CryptoManager::new(EncryptionConfig {
            iterations: self.record.iterations,
            key_length: self.record.key_length,
            algorithm: self.record.algorithm.clone(),
        })
        .map_err(backend_error)?;
        crypto
            .decrypt(&self.envelope, passphrase)
            .map(Zeroizing::new)
            .map_err(decrypt_error)
    }
}

// ── Labels ──────────────────────────────────────────────────────────────────

/// Validate a label and return the form to store.
///
/// Trimmed, because a trailing space is invisible in a list and would make two
/// collections indistinguishable on screen while being distinct in storage.
///
/// The duplicate check folds case. The contract says only "a collection with
/// that label already exists", so this is a decision rather than a reading of
/// it: the label is the only handle the user has when choosing which
/// collection to put a key into, and two entries that look identical to a
/// human in that picker are a wrong-collection mistake with a passphrase
/// attached. If the project wants `prod` and `PROD` to be different
/// collections, this is the one line to change.
pub fn validate_label(label: &str, other_labels: &[String]) -> Result<String, CollectionError> {
    let label = label.trim();
    if label.is_empty() {
        return Err(CollectionError::InvalidLabel {
            max: MAX_COLLECTION_LABEL_LENGTH,
        });
    }
    if label.chars().count() > MAX_COLLECTION_LABEL_LENGTH {
        return Err(CollectionError::InvalidLabel {
            max: MAX_COLLECTION_LABEL_LENGTH,
        });
    }
    let folded = label.to_lowercase();
    if other_labels
        .iter()
        .any(|other| other.trim().to_lowercase() == folded)
    {
        return Err(CollectionError::DuplicateLabel);
    }
    Ok(label.to_string())
}

/// Every collection's label except the one with this id.
///
/// The argument [`SealedCollection::rename`] wants. A helper rather than a
/// note in a doc comment, because "remember to leave your own label out" is
/// the kind of instruction that gets followed at three call sites and missed
/// at the fourth, where it shows up as a rename that refuses itself.
pub fn labels_excluding(records: &[CollectionRecord], id: &str) -> Vec<String> {
    records
        .iter()
        .filter(|record| record.id != id)
        .map(|record| record.label.clone())
        .collect()
}

// ── Sealing ─────────────────────────────────────────────────────────────────

/// Serialise and seal a member list, returning the envelope and the config the
/// seal actually used.
///
/// The order is deliberate: validate the parameters, *then* serialise the
/// secrets, *then* bound the result, *then* seal. A caller that asked for
/// impossible parameters is told so before any secret is copied into a buffer,
/// and the size refusal names the limit instead of arriving as a crypto error
/// the UI would have to word as `corrupt`.
fn seal_members(
    members: &[CollectionMember],
    passphrase: &str,
    seal_config: EncryptionConfig,
) -> Result<(String, EncryptionConfig), CollectionError> {
    require_passphrase(passphrase)?;

    let crypto = CryptoManager::new_for_encryption(seal_config).map_err(backend_error)?;
    let config = crypto.get_config();

    let json = Zeroizing::new(
        serde_json::to_string(&CollectionPayload::new(members.to_vec()))
            .map_err(|error| CollectionError::Backend(error.to_string()))?,
    );

    // The envelope byte cap, checked once, here. `bc_crypto::encrypt` would
    // also refuse an oversized plaintext, and that refusal is deliberately
    // *not* mapped to this variant: two checks answering one limit with one
    // error means a mutation to either is caught by the other and neither is
    // proven. The crypto layer's own `InputTooLarge` goes to `backend-error`,
    // which is the right diagnosis for a branch this check makes unreachable —
    // and the right one for the case it still covers, an oversized passphrase.
    if json.len() > MAX_PLAINTEXT_BYTES {
        return Err(CollectionError::EnvelopeTooLarge {
            bytes: json.len(),
            max_bytes: MAX_PLAINTEXT_BYTES,
        });
    }

    let envelope = crypto
        .encrypt(json.as_str(), passphrase)
        .map_err(backend_error)?;
    Ok((envelope, config))
}

/// Empty only.
///
/// A passphrase of spaces is a weak passphrase, not an absent one, and
/// trimming it would silently change the secret that opens the envelope — so
/// the collection would seal under `" x "` and refuse to open under `"x"`.
fn require_passphrase(passphrase: &str) -> Result<(), CollectionError> {
    if passphrase.is_empty() {
        return Err(CollectionError::NoPassphrase);
    }
    Ok(())
}

fn backend_error(error: CryptoError) -> CollectionError {
    CollectionError::Backend(error.to_string())
}

/// Classify a failure to open an envelope.
fn decrypt_error(error: CryptoError) -> CollectionError {
    match error {
        // AES-GCM cannot tell a wrong key from altered bytes: both fail the
        // same tag check. The overwhelmingly likely cause is a mistyped
        // passphrase, and telling someone their collection is corrupt when
        // they fat-fingered one character sends them to a recovery flow they
        // do not need. So a tampered envelope surfaces as `wrong-passphrase`.
        // That is the honest limit of what the primitive can distinguish, not
        // a guess being dressed up as a diagnosis.
        CryptoError::DecryptionFailed(_) => CollectionError::WrongPassphrase,
        // Not an envelope this crate wrote at all: bad base64, a length that
        // cannot hold a salt and a nonce, a truncated record.
        CryptoError::InvalidFormat | CryptoError::InputTooLarge { .. } => CollectionError::Corrupt,
        CryptoError::InvalidConfig(message) | CryptoError::EncryptionFailed(message) => {
            CollectionError::Backend(message)
        }
    }
}

fn rfc3339(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Secs, true)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT: &str = include_str!("../../../../src/lib/collections/types.ts");

    fn at(rfc3339_text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339_text)
            .expect("test timestamp must be RFC 3339")
            .with_timezone(&Utc)
    }

    fn created() -> DateTime<Utc> {
        at("2026-01-01T00:00:00Z")
    }

    fn later() -> DateTime<Utc> {
        at("2026-02-02T03:04:05Z")
    }

    /// The default config is the cheapest one `bc_crypto` will seal with
    /// (`MIN_PBKDF2_ITERATIONS`), which keeps a suite that derives a key a few
    /// dozen times to a few seconds.
    fn config() -> EncryptionConfig {
        EncryptionConfig::default()
    }

    fn empty_collection() -> SealedCollection {
        SealedCollection::create("col-1", "Work", "collection-pass", &[], config(), created())
            .expect("a fresh collection must seal")
    }

    /// A sealed collection holding `members`, built through the same sealing
    /// path the production code uses.
    ///
    /// This is a fixture, not an assertion: every test that uses it is making
    /// a claim about an operation on an already-populated collection, and the
    /// alternative — calling `add_member` 128 times — is 256 key derivations.
    fn sealed_with(members: Vec<CollectionMember>) -> SealedCollection {
        let member_ids = members.iter().map(|member| member.id.clone()).collect();
        let (envelope, sealed_config) =
            seal_members(&members, "collection-pass", config()).expect("fixture must seal");
        SealedCollection {
            record: CollectionRecord {
                id: "col-1".to_string(),
                label: "Work".to_string(),
                created_at: rfc3339(created()),
                updated_at: rfc3339(created()),
                member_ids,
                iterations: sealed_config.iterations,
                key_length: sealed_config.key_length,
                algorithm: sealed_config.algorithm,
            },
            envelope,
        }
    }

    /// Read a number out of an `export const` in the contract.
    fn contract_number(name: &str) -> u64 {
        let needle = format!("export const {name} = ");
        let start = CONTRACT
            .find(&needle)
            .unwrap_or_else(|| panic!("{name} is missing from src/lib/collections/types.ts"));
        let tail = &CONTRACT[start + needle.len()..];
        let end = tail
            .find(';')
            .expect("a const declaration ends in a semicolon");
        tail[..end]
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("{name} is not a plain number in the contract"))
    }

    // ── The contract ────────────────────────────────────────────────────

    /// The failure codes are a cross-boundary contract, so they are pinned
    /// against the file that declares them rather than against a second list
    /// here. A code renamed on one side and not the other is the kind of
    /// defect that typechecks on both and only shows up as an untranslated
    /// error on someone's screen.
    #[test]
    fn failure_codes_match_the_contract() {
        for error in [
            CollectionError::NotFound,
            CollectionError::Locked,
            CollectionError::WrongPassphrase,
            CollectionError::NoPassphrase,
            CollectionError::AlreadyMember,
            CollectionError::NotAMember,
            CollectionError::KeyLocked,
            CollectionError::TooManyMembers { limit: 0 },
            CollectionError::EnvelopeTooLarge {
                bytes: 0,
                max_bytes: 0,
            },
            CollectionError::DuplicateLabel,
            CollectionError::InvalidLabel { max: 0 },
            CollectionError::Corrupt,
            CollectionError::PayloadTooNew,
            CollectionError::Backend(String::new()),
        ] {
            let code = error.code();
            assert!(
                CONTRACT.contains(&format!("\"{code}\"")),
                "CollectionFailureCode {code} is missing from src/lib/collections/types.ts"
            );
        }
    }

    /// The bounds are the other half of the contract, and drifting them is
    /// worse than drifting a code: the UI would validate at one number and the
    /// backend refuse at another, with no type error anywhere.
    #[test]
    fn the_bounds_match_the_contract() {
        assert_eq!(
            contract_number("MAX_COLLECTION_MEMBERS"),
            MAX_COLLECTION_MEMBERS as u64
        );
        assert_eq!(
            contract_number("MAX_COLLECTION_LABEL_LENGTH"),
            MAX_COLLECTION_LABEL_LENGTH as u64
        );
        assert_eq!(
            contract_number("COLLECTION_PAYLOAD_VERSION"),
            u64::from(COLLECTION_PAYLOAD_VERSION)
        );
    }

    #[test]
    fn only_the_refusals_that_name_a_number_carry_a_message() {
        let too_many = CollectionError::TooManyMembers { limit: 128 };
        assert_eq!(too_many.code(), "too-large");
        assert!(too_many.message().expect("names the limit").contains("128"));

        let too_large = CollectionError::EnvelopeTooLarge {
            bytes: 70_000,
            max_bytes: 65_536,
        };
        assert_eq!(too_large.code(), "too-large");
        assert!(too_large
            .message()
            .expect("names the limit")
            .contains("65536"));

        assert_eq!(
            CollectionError::Backend("keyring unavailable".into())
                .message()
                .as_deref(),
            Some("keyring unavailable")
        );
        assert!(CollectionError::InvalidLabel { max: 120 }
            .message()
            .expect("names the limit")
            .contains("120"));

        // The codes whose meaning is complete on its own carry nothing.
        for error in [
            CollectionError::Locked,
            CollectionError::WrongPassphrase,
            CollectionError::NoPassphrase,
            CollectionError::AlreadyMember,
            CollectionError::NotAMember,
            CollectionError::KeyLocked,
            CollectionError::NotFound,
            CollectionError::DuplicateLabel,
            CollectionError::Corrupt,
            CollectionError::PayloadTooNew,
        ] {
            assert!(
                error.message().is_none(),
                "{} must not carry an English sentence",
                error.code()
            );
        }
    }

    #[test]
    fn a_failure_serialises_a_null_message_rather_than_omitting_it() {
        let json = serde_json::to_value(CollectionError::Locked.failure()).expect("serialises");
        assert_eq!(json["code"], "locked");
        assert!(
            json.get("message").is_some(),
            "an omitted field arrives as undefined, not null"
        );
        assert!(json["message"].is_null());
    }

    #[test]
    fn an_outcome_is_tagged_by_its_state() {
        let ok = serde_json::to_value(CollectionOutcome::Ok).expect("serialises");
        assert_eq!(ok["state"], "ok");

        let failed =
            serde_json::to_value(CollectionOutcome::from(&CollectionError::WrongPassphrase))
                .expect("serialises");
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["code"], "wrong-passphrase");
        assert!(failed["message"].is_null());
    }

    #[test]
    fn the_wire_shapes_are_camel_case() {
        let record = empty_collection().record;
        let json = serde_json::to_value(&record).expect("serialises");
        for field in ["createdAt", "updatedAt", "memberIds", "keyLength"] {
            assert!(json.get(field).is_some(), "{field} is missing");
        }
        for field in ["created_at", "member_ids", "key_length"] {
            assert!(json.get(field).is_none(), "snake_case {field} leaked");
        }

        let overview = serde_json::to_value(CollectionsOverview {
            collections: vec![record],
            statuses: vec![CollectionStatus {
                id: "col-1".into(),
                unlocked: false,
            }],
            unassigned_key_ids: vec!["key-9".into()],
        })
        .expect("serialises");
        assert!(overview.get("unassignedKeyIds").is_some());
        assert!(overview.get("unassigned_key_ids").is_none());
    }

    // ── Creating and opening ────────────────────────────────────────────

    #[test]
    fn a_new_collection_is_empty_and_opens_under_its_passphrase() {
        let sealed = empty_collection();
        assert_eq!(sealed.record.member_ids, Vec::<String>::new());
        assert_eq!(sealed.record.created_at, "2026-01-01T00:00:00Z");
        assert_eq!(sealed.record.updated_at, sealed.record.created_at);
        assert_eq!(sealed.record.iterations, config().iterations);

        let payload = sealed.open("collection-pass").expect("opens");
        assert!(payload.members.is_empty());
        assert!(sealed.verify_passphrase("collection-pass").is_ok());
    }

    #[test]
    fn the_wrong_passphrase_does_not_open_a_collection() {
        let sealed = empty_collection();
        assert!(matches!(
            sealed.open("not-the-passphrase"),
            Err(CollectionError::WrongPassphrase)
        ));
    }

    #[test]
    fn a_blank_passphrase_is_no_passphrase_rather_than_a_wrong_one() {
        // Sealing: the only path where `seal_members`' own check is the one
        // that fires, since there is no envelope to open first.
        assert!(matches!(
            SealedCollection::create("col-1", "Work", "", &[], config(), created()),
            Err(CollectionError::NoPassphrase)
        ));

        // Opening.
        assert!(matches!(
            empty_collection().open(""),
            Err(CollectionError::NoPassphrase)
        ));

        // Whitespace is a passphrase. Trimming it would seal under one secret
        // and refuse to open under the other.
        let spaced = SealedCollection::create("col-1", "Work", "   ", &[], config(), created())
            .expect("a whitespace passphrase is weak, not absent");
        assert!(spaced.open("   ").is_ok());
        assert!(matches!(
            spaced.open(""),
            Err(CollectionError::NoPassphrase)
        ));
    }

    #[test]
    fn a_tampered_envelope_reports_a_wrong_passphrase() {
        // Documents the limit of the primitive rather than asserting a wish:
        // AES-GCM fails the tag the same way for a wrong key and for altered
        // bytes, so these two causes cannot be told apart.
        let mut sealed = empty_collection();
        // Well inside the base64 body, so the byte lands in the salt or the
        // nonce and the envelope stays a structurally valid one. Flipping a
        // trailing character could hit the padding and shorten the decoded
        // length, which is a different refusal — `corrupt` — and would make
        // this assertion mean two things at once.
        let mut bytes = sealed.envelope.clone().into_bytes();
        let target = "bc1:".len() + 4;
        bytes[target] = if bytes[target] == b'A' { b'B' } else { b'A' };
        sealed.envelope = String::from_utf8(bytes).expect("still ascii");
        assert!(matches!(
            sealed.open("collection-pass"),
            Err(CollectionError::WrongPassphrase)
        ));
    }

    #[test]
    fn an_envelope_that_is_not_one_is_corrupt() {
        let mut sealed = empty_collection();
        sealed.envelope = "not-an-envelope".to_string();
        assert!(matches!(
            sealed.open("collection-pass"),
            Err(CollectionError::Corrupt)
        ));
    }

    #[test]
    fn the_record_stores_the_canonical_algorithm_the_seal_used() {
        // `bc_crypto` accepts "AES-256-GCM" as an alias and canonicalises it.
        // Storing the caller's spelling would leave the record describing an
        // algorithm name the manager never used.
        let sealed = SealedCollection::create(
            "col-1",
            "Work",
            "collection-pass",
            &[],
            EncryptionConfig {
                algorithm: "AES-256-GCM".to_string(),
                ..config()
            },
            created(),
        )
        .expect("the alias must be accepted");
        assert_eq!(sealed.record.algorithm, "AES-GCM");
        assert!(sealed.open("collection-pass").is_ok());
    }

    #[test]
    fn parameters_below_the_write_floor_are_a_backend_error() {
        let error = SealedCollection::create(
            "col-1",
            "Work",
            "collection-pass",
            &[],
            EncryptionConfig {
                iterations: 1,
                ..config()
            },
            created(),
        )
        .expect_err("a legacy iteration count must not be written");
        assert_eq!(error.code(), "backend-error");
    }

    // ── Labels ──────────────────────────────────────────────────────────

    #[test]
    fn an_empty_label_is_invalid() {
        for label in ["", "   ", "\t\n"] {
            let error = SealedCollection::create(
                "col-1",
                label,
                "collection-pass",
                &[],
                config(),
                created(),
            )
            .expect_err("an empty label must be refused");
            assert_eq!(error.code(), "invalid-label");
        }
    }

    #[test]
    fn a_label_is_bounded_in_code_points_not_bytes() {
        let at_limit = "a".repeat(MAX_COLLECTION_LABEL_LENGTH);
        assert_eq!(
            validate_label(&at_limit, &[]).expect("the exact limit is allowed"),
            at_limit
        );

        let over_limit = "a".repeat(MAX_COLLECTION_LABEL_LENGTH + 1);
        assert!(matches!(
            validate_label(&over_limit, &[]),
            Err(CollectionError::InvalidLabel { .. })
        ));

        // Three bytes per character: a byte count would refuse this at 40
        // characters. A label in Japanese is not a third of a label.
        let multibyte = "鍵".repeat(MAX_COLLECTION_LABEL_LENGTH);
        assert!(multibyte.len() > MAX_COLLECTION_LABEL_LENGTH);
        assert!(validate_label(&multibyte, &[]).is_ok());
    }

    #[test]
    fn a_label_is_stored_trimmed() {
        assert_eq!(validate_label("  Work  ", &[]).expect("trims"), "Work");
    }

    #[test]
    fn a_duplicate_label_is_refused_whatever_its_case_or_padding() {
        let taken = vec!["Work".to_string()];
        for attempt in ["Work", "work", "WORK", "  work  "] {
            assert!(
                matches!(
                    validate_label(attempt, &taken),
                    Err(CollectionError::DuplicateLabel)
                ),
                "{attempt} must collide with an existing 'Work'"
            );
        }
        assert!(validate_label("Personal", &taken).is_ok());
    }

    #[test]
    fn renaming_leaves_the_envelope_and_the_timestamps_alone() {
        let sealed = empty_collection();
        let renamed = sealed
            .rename("Production", &[])
            .expect("a free label is accepted");
        assert_eq!(renamed.label, "Production");
        assert_eq!(renamed.member_ids, sealed.record.member_ids);
        // The contract defines `updatedAt` as the time of the last re-seal,
        // and a rename re-seals nothing.
        assert_eq!(renamed.updated_at, sealed.record.updated_at);
    }

    #[test]
    fn a_collection_may_be_renamed_to_the_label_it_already_has() {
        let sealed = empty_collection();
        let other = CollectionRecord {
            id: "col-2".to_string(),
            label: "Personal".to_string(),
            ..sealed.record.clone()
        };
        let all = [sealed.record.clone(), other];

        let excluded = labels_excluding(&all, &sealed.record.id);
        assert_eq!(excluded, vec!["Personal".to_string()]);
        assert!(
            sealed.rename("Work", &excluded).is_ok(),
            "a collection must not collide with itself"
        );
        assert!(matches!(
            sealed.rename("Personal", &excluded),
            Err(CollectionError::DuplicateLabel)
        ));
    }

    // ── Membership ──────────────────────────────────────────────────────

    #[test]
    fn adding_a_member_seals_its_secret_and_indexes_it() {
        let sealed = empty_collection();
        let after = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-1", "cf-token-1"),
                None,
                config(),
                later(),
            )
            .expect("adds");

        assert_eq!(after.record.member_ids, vec!["key-1".to_string()]);
        assert_eq!(after.record.updated_at, "2026-02-02T03:04:05Z");
        assert_eq!(after.record.created_at, sealed.record.created_at);
        assert_ne!(after.envelope, sealed.envelope);

        let payload = after.open("collection-pass").expect("opens");
        assert_eq!(payload.members.len(), 1);
        assert_eq!(
            payload.member("key-1").expect("present").secret,
            "cf-token-1"
        );
    }

    #[test]
    fn a_key_already_in_this_collection_is_already_a_member() {
        let sealed = empty_collection();
        let error = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-1", "cf-token-1"),
                Some("col-1"),
                config(),
                later(),
            )
            .expect_err("its own collection must refuse too");
        assert_eq!(error.code(), "already-member");
    }

    /// The case a naive implementation misses: membership is exclusive, so a
    /// key in *another* collection is a refusal and not a move.
    #[test]
    fn a_key_in_another_collection_is_already_a_member() {
        let sealed = empty_collection();
        let error = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-1", "cf-token-1"),
                Some("some-other-collection"),
                config(),
                later(),
            )
            .expect_err("exclusive membership must refuse a key held elsewhere");
        assert_eq!(error.code(), "already-member");

        // And nothing was sealed: the refusal is before the key derivation.
        assert!(sealed
            .open("collection-pass")
            .expect("opens")
            .members
            .is_empty());
    }

    /// The envelope's own contents are checked too, independently of what the
    /// caller's store claims — a store that reports a key as unassigned while
    /// the envelope already holds it must not get a second copy sealed in,
    /// because two entries for one id make the collection unopenable.
    #[test]
    fn the_envelope_refuses_a_second_copy_even_if_the_store_disagrees() {
        let sealed = sealed_with(vec![CollectionMember::new("key-1", "cf-token-1")]);
        let error = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-1", "cf-token-1-again"),
                None,
                config(),
                later(),
            )
            .expect_err("the envelope is authoritative about its own members");
        assert_eq!(error.code(), "already-member");
    }

    #[test]
    fn the_cleartext_index_is_rebuilt_from_what_was_sealed() {
        // A record whose index has drifted away from its envelope. Every
        // re-seal rebuilds the index from the member list it sealed, so the
        // drift heals rather than propagating.
        let mut sealed = sealed_with(vec![CollectionMember::new("key-1", "cf-token-1")]);
        sealed.record.member_ids = vec!["a-key-that-was-never-in-here".to_string()];

        let after = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-2", "cf-token-2"),
                None,
                config(),
                later(),
            )
            .expect("adds");

        assert_eq!(
            after.record.member_ids,
            vec!["key-1".to_string(), "key-2".to_string()]
        );
        assert_eq!(
            after.record.member_ids,
            after.open("collection-pass").expect("opens").member_ids(),
            "the index must describe the envelope beside it"
        );
    }

    #[test]
    fn the_member_cap_is_a_ceiling_and_not_a_fence() {
        let members = (0..MAX_COLLECTION_MEMBERS - 1)
            .map(|index| CollectionMember::new(format!("key-{index}"), format!("cf-token-{index}")))
            .collect();
        let sealed = sealed_with(members);
        let after = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-last", "cf-token-last"),
                None,
                config(),
                later(),
            )
            .expect("the exact cap must be reachable");
        assert_eq!(after.record.member_ids.len(), MAX_COLLECTION_MEMBERS);
    }

    #[test]
    fn adding_past_the_member_cap_names_the_limit() {
        let members = (0..MAX_COLLECTION_MEMBERS)
            .map(|index| CollectionMember::new(format!("key-{index}"), format!("cf-token-{index}")))
            .collect();
        let sealed = sealed_with(members);
        let error = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-extra", "cf-token-extra"),
                None,
                config(),
                later(),
            )
            .expect_err("the cap must refuse");

        assert!(matches!(
            error,
            CollectionError::TooManyMembers { limit } if limit == MAX_COLLECTION_MEMBERS
        ));
        assert_eq!(error.code(), "too-large");
        assert!(error
            .message()
            .expect("the refusal must name the limit")
            .contains("128"));
    }

    /// The other bound, reachable in a situation the member cap never sees: a
    /// single member whose secret is larger than the whole envelope may be.
    /// The two limits are tested apart because one mutation must not be able
    /// to kill both.
    #[test]
    fn a_secret_too_large_to_seal_names_the_byte_limit() {
        let sealed = empty_collection();
        let error = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-1", "s".repeat(MAX_PLAINTEXT_BYTES)),
                None,
                config(),
                later(),
            )
            .expect_err("an oversized plaintext must refuse before the seal");

        assert!(matches!(
            error,
            CollectionError::EnvelopeTooLarge { max_bytes, .. } if max_bytes == MAX_PLAINTEXT_BYTES
        ));
        assert_eq!(error.code(), "too-large");
        assert!(error
            .message()
            .expect("the refusal must name the limit")
            .contains("65536"));
    }

    /// The claim that matters on a removal, made against the **plaintext** of
    /// the re-sealed envelope rather than against the parsed projection or the
    /// shrunken index. Those are different claims: a projection that dropped
    /// the member, or an index written by hand, would both let this pass while
    /// the secret was still sealed inside.
    #[test]
    fn a_removed_members_secret_leaves_the_envelope() {
        let sealed = sealed_with(vec![
            CollectionMember::new("key-1", "cf-token-keep-me"),
            CollectionMember::new("key-2", "cf-token-remove-me"),
        ]);

        let after = sealed
            .remove_member("collection-pass", "key-2", config(), later())
            .expect("removes");

        let plaintext = after.open_json("collection-pass").expect("opens");
        assert!(
            !plaintext.contains("cf-token-remove-me"),
            "the removed secret is still sealed in the envelope"
        );
        assert!(
            plaintext.contains("cf-token-keep-me"),
            "the other member's secret must survive the re-seal"
        );
        assert_eq!(after.record.member_ids, vec!["key-1".to_string()]);
    }

    #[test]
    fn removing_a_key_that_is_not_in_the_collection_is_not_a_member() {
        let sealed = sealed_with(vec![CollectionMember::new("key-1", "cf-token-1")]);
        assert!(matches!(
            sealed.remove_member("collection-pass", "key-9", config(), later()),
            Err(CollectionError::NotAMember)
        ));
    }

    #[test]
    fn removing_a_member_needs_the_passphrase() {
        let sealed = sealed_with(vec![CollectionMember::new("key-1", "cf-token-1")]);
        assert!(matches!(
            sealed.remove_member("wrong", "key-1", config(), later()),
            Err(CollectionError::WrongPassphrase)
        ));
    }

    // ── Rotation ────────────────────────────────────────────────────────

    #[test]
    fn rotation_re_seals_under_the_new_passphrase_and_keeps_the_members() {
        let sealed = sealed_with(vec![CollectionMember::new("key-1", "cf-token-1")]);
        let rotated = sealed
            .rotate("collection-pass", "a-new-passphrase", config(), later())
            .expect("rotates");

        assert!(matches!(
            rotated.open("collection-pass"),
            Err(CollectionError::WrongPassphrase)
        ));
        let payload = rotated.open("a-new-passphrase").expect("the new one opens");
        assert_eq!(
            payload.member("key-1").expect("present").secret,
            "cf-token-1"
        );
        assert_eq!(rotated.record.member_ids, vec!["key-1".to_string()]);
        assert_eq!(rotated.record.updated_at, "2026-02-02T03:04:05Z");
    }

    #[test]
    fn rotation_refuses_the_wrong_current_passphrase_and_leaves_nothing_behind() {
        let sealed = empty_collection();
        assert!(matches!(
            sealed.rotate("not-the-passphrase", "a-new-passphrase", config(), later()),
            Err(CollectionError::WrongPassphrase)
        ));
        // `rotate` mutates nothing, so there is no half-applied state to find:
        // the original still opens under the original passphrase.
        assert!(sealed.open("collection-pass").is_ok());
    }

    #[test]
    fn rotation_refuses_a_blank_new_passphrase() {
        let sealed = empty_collection();
        assert!(matches!(
            sealed.rotate("collection-pass", "", config(), later()),
            Err(CollectionError::NoPassphrase)
        ));
    }

    /// Why the record and the envelope have to move together, demonstrated
    /// rather than asserted: the *old* record's parameters cannot open the
    /// *new* envelope even with the right passphrase. A rotation that wrote
    /// one and not the other would produce exactly this pairing, and the user
    /// would be told their passphrase was wrong.
    #[test]
    fn the_new_parameters_travel_with_the_new_envelope() {
        let sealed = empty_collection();
        let stronger = EncryptionConfig {
            iterations: config().iterations * 2,
            ..config()
        };
        let rotated = sealed
            .rotate("collection-pass", "a-new-passphrase", stronger, later())
            .expect("rotates");

        assert_eq!(rotated.record.iterations, config().iterations * 2);
        assert!(rotated.open("a-new-passphrase").is_ok());

        let half_applied = SealedCollection {
            record: sealed.record.clone(),
            envelope: rotated.envelope.clone(),
        };
        assert!(
            matches!(
                half_applied.open("a-new-passphrase"),
                Err(CollectionError::WrongPassphrase)
            ),
            "a record that lost its envelope's parameters cannot open it"
        );
    }

    /// An envelope sealed at the floor still opens after the app's default has
    /// moved on, and re-seals at the new one.
    ///
    /// `bc_crypto` refuses to *write* below `MIN_PBKDF2_ITERATIONS`, so a
    /// genuinely legacy count cannot be produced here to test against; the
    /// floor standing in for it is enough to prove the open path reads the
    /// record's parameters rather than a current default.
    #[test]
    fn an_envelope_sealed_at_older_parameters_still_opens() {
        let sealed = empty_collection();
        let upgraded = sealed
            .add_member(
                "collection-pass",
                CollectionMember::new("key-1", "cf-token-1"),
                None,
                EncryptionConfig {
                    iterations: config().iterations * 2,
                    ..config()
                },
                later(),
            )
            .expect("adds and re-seals at the newer parameters");

        assert_eq!(upgraded.record.iterations, config().iterations * 2);
        assert!(upgraded.open("collection-pass").is_ok());
        // And the original, at the older count, is still readable.
        assert!(sealed.open("collection-pass").is_ok());
    }

    // ── Secrets ─────────────────────────────────────────────────────────

    #[test]
    fn a_sealed_collection_debug_line_holds_no_secret() {
        let sealed = sealed_with(vec![CollectionMember::new("key-1", "cf-token-TOPSECRET")]);
        let rendered = format!("{sealed:?}");
        assert!(!rendered.contains("TOPSECRET"), "{rendered}");
        assert!(rendered.contains("key-1"));
    }
}
