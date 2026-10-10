//! Cloud sync for the API key vault, and the eight commands the screen drives.
//!
//! The renderer's half of this is `src/lib/sync/types.ts`, and **that file is
//! the contract**: every shape returned here is one of its types, spelled the
//! way it spells them. Read its header before this one, and `bc_sync`'s after
//! it. The three decisions they state — the bundle is sealed a second time
//! under a passphrase of its own, provider credentials never reach
//! `Preferences`, and a divergent remote is refused rather than merged — are
//! the ones this module exists to carry out.
//!
//! # Where each half lives
//!
//! `bc_sync` holds the wire: the two engines behind [`SyncEngine`], the payload
//! format and the generation guard. It deliberately holds **no secrets and no
//! keyring access**. This module is the other half: it reads the credential and
//! the passphrase out of the keyring, seals and opens the payload with
//! `bc_crypto`, and writes what happened back to `Preferences`. An engine that
//! cannot see plaintext cannot leak it, and a reader asking "where do the
//! secrets come from" has one file to read rather than three.
//!
//! # Three things are persisted, and each is persisted for a reason
//!
//! [`Preferences::sync`] is the settings object the screen edits.
//! [`Preferences::sync_last_manifest`] is what a push guards against — a
//! device that forgot the generation it last saw would either refuse every
//! write or clobber another device's. [`Preferences::sync_vault_fingerprint`]
//! is what makes "this device has unsynced changes" answerable, and it exists
//! because the manifest's checksum cannot answer it: that checksum is of a
//! *sealed* envelope, and sealing is salted, so one unchanged vault seals to a
//! different checksum every time.
//!
//! None of the three is secret. Both secrets are in the keyring under `sync:`,
//! and the two `*Present` booleans the screen reads are computed from the
//! keyring on every [`get_sync_status`] call rather than stored, so they
//! cannot end up saying "connected" about a credential that is gone.
//!
//! # One provider authenticates and one does not
//!
//! `SyncProvider::credential_slot` is an `Option`, and that `None` is load
//! bearing all the way through this module. Nextcloud signs in with a URL, a
//! username and an app password, which is exactly how Nextcloud expects a
//! third-party client to connect. A folder does not sign in at all — its
//! access check is the directory's own permissions — so there is no credential
//! to store, to read or to clear, and nothing here invents a slot name to put
//! one in.
//!
//! The consequence worth stating is that `credential_present` is **false** for
//! a folder, permanently, and that is the honest answer rather than a gap:
//! nothing is stored because nothing is wanted. The screen must not read it as
//! "not set up yet", which is why the contract exports `providerNeedsCredential`
//! beside it — see `src/lib/sync/types.ts`. Reporting `true` to make the screen
//! look right would make the flag mean "configured" for one provider and
//! "a secret is in the keyring" for the other, and then neither.
//!
//! The *passphrase* is unaffected by any of this. It seals the payload rather
//! than the connection, so it is shared across providers and
//! `passphrase_present` means the same thing for both: a folder sync still
//! needs one, and someone who switches provider must still be able to open the
//! blob they pushed from the other.
//!
//! The folder's own setting, `folder_path`, is not a credential and does not go
//! near the keyring. It is an ordinary non-secret preference beside
//! `webdav_url`, and it is shown back to the user on purpose — a sync target
//! they cannot read back is one they cannot verify. It arrives through
//! [`pick_sync_folder`], which only answers "which folder" and stores nothing.
//!
//! # What the KDF parameters in the manifest are for
//!
//! `bc_crypto`'s envelope is `salt || nonce || ciphertext || tag`: it carries
//! the salt and the nonce but **not** the iteration count, which `decrypt`
//! takes from its own `EncryptionConfig`. The iteration count this build seals
//! with is the user's own encryption setting, which they can raise — so the
//! parameters a blob was sealed with travel in its manifest, and
//! [`open_remote`] derives its key from **the manifest it downloaded**, never
//! from this build's current default. `bc_storage::ApiKey` keeps the same
//! three fields per key for the same reason. Get this wrong and sync keeps
//! working right up until somebody changes their iteration count.
//!
//! # The ciphertext inside stays ciphertext
//!
//! `get_api_keys` hands back `encrypted_key` values already sealed under each
//! key's *own* password, and nothing here opens one. [`vault_entry`] and
//! [`api_key`] map the two shapes field for field in each direction. The sync
//! passphrase seals the bundle so that the provider cannot read the labels and
//! email addresses around those envelopes; it is never enough to *use* a key,
//! and nothing in this layer should make it so.
//!
//! # Why a pull takes two commands
//!
//! A pull replaces this device's entire key list, which makes it the most
//! destructive thing here — and it opens the envelope *and* installs it, so it
//! can never be the thing that shows a preview. The manifest cannot stand in
//! for one either: it deliberately carries no key count, because a count of
//! API keys is a count of the Cloudflare accounts someone administers and the
//! provider does not get to read it for free. So [`preview_sync_pull`] opens
//! the envelope and **writes nothing** — no key list change, no
//! `last_synced_at`, no remembered manifest — and it is where a wrong
//! passphrase is normally discovered, which is the right place for it: before
//! the user's keys have been touched rather than after.
//!
//! # Conflicts, and the copy that makes them survivable
//!
//! A push carries the generation it believed it was replacing and a remote
//! that has moved produces a `conflict` rather than a write. A pull refuses
//! for the mirror-image reason: this device's vault may hold keys that the
//! remote blob does not. Either way the user picks a side through
//! [`resolve_sync_conflict`], and **the side they discard is copied to the
//! provider first**, under the suffix `<timestamp>-local` or
//! `<timestamp>-remote`. [`SyncEngine::archive`] puts the manifest beside
//! those bytes, which is not decoration: a sealed envelope does not record
//! the iteration count that opens it, so bytes archived alone would be a file
//! nobody could ever open. A failed archive refuses the whole resolution,
//! because "I picked wrong" must not be the end of someone's keys.

use std::path::Path;
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;
use zeroize::Zeroizing;

use bc_crypto::{CryptoError, MAX_PLAINTEXT_BYTES};
use bc_storage::StorageError;
use bc_sync::settings::{MAX_AUTO_PUSH_MINUTES, MIN_AUTO_PUSH_MINUTES};
use bc_sync::{
    build_engine, checksum_hex, GenerationGuard, PutOutcome, SyncEngine, SyncError, SyncManifest,
    SyncPayload, SyncSettings, SyncSettingsView, VaultEntry, MAX_SYNC_ENVELOPE_BYTES,
    PASSPHRASE_SLOT, PAYLOAD_FORMAT, PAYLOAD_VERSION, SETTINGS_VERSION,
};

use crate::app_config::AppConfigStore;
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::storage::{ApiKey, Preferences, Storage};

// ── Bounds ──────────────────────────────────────────────────────────────────

/// Longest device label this will put in a manifest.
///
/// The label sits unencrypted in someone else's storage, so it is bounded here
/// rather than trusted to be short: `os_info` reads the registry and
/// `/etc/os-release`, and neither is this process's to assume anything about.
const MAX_DEVICE_LABEL_BYTES: usize = 64;

// ── Wire shapes ─────────────────────────────────────────────────────────────
//
// Every type below is one of `src/lib/sync/types.ts`'s, field for field. The
// container-level `rename_all` is camelCase because that is what the contract
// spells; the `state` tag values are pinned against the contract by
// `every_state_the_contract_names_is_serialised_under_that_name`.

/// What the settings screen shows without touching the network.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub settings: SyncSettingsView,
    pub last_known: Option<SyncManifest>,
    pub device_id: String,
    pub device_label: String,
    pub auto_push_minutes_range: AutoPushRange,
}

/// The bounds `SyncSettings::normalize` clamps the cadence to.
///
/// Carried to the renderer rather than restated there, so that
/// `bc_sync::settings`'s two constants stay the single source: they are where
/// the reasoning for the numbers lives, and a duplicated pair is a pair that
/// disagrees after the first change to one of them.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoPushRange {
    pub min: u32,
    pub max: u32,
}

impl Default for AutoPushRange {
    fn default() -> Self {
        Self {
            min: MIN_AUTO_PUSH_MINUTES,
            max: MAX_AUTO_PUSH_MINUTES,
        }
    }
}

/// The remote moved since this device last saw it. Nothing was written.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    /// This device's view. `None` when the divergence is in the key list of a
    /// device that has never pushed, which is the case the contract documents
    /// as "pulling onto a device with no local blob".
    pub local: Option<SyncManifest>,
    pub remote: SyncManifest,
    /// The generation this device believed it was replacing; `0` when it
    /// believed there was nothing there at all.
    pub expected_generation: u64,
}

/// The outcome of a push or a pull. Exactly one of these shapes.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncOutcome {
    Ok {
        manifest: SyncManifest,
    },
    /// Both sides already agree; nothing was transferred.
    ///
    /// A pull's answer, never a push's: sealing is salted, so a push cannot
    /// tell an unchanged vault from a changed one by comparing envelopes, and
    /// the fingerprint it could compare against is this device's own.
    Unchanged {
        manifest: SyncManifest,
    },
    Conflict {
        conflict: SyncConflict,
    },
    Failed {
        code: &'static str,
        /// The provider's own words, when it gave any. Not translated.
        message: Option<String>,
    },
}

/// What a pull would do, before it does any of it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullPreview {
    pub manifest: SyncManifest,
    /// Keys inside the envelope, which is only knowable once it is open.
    pub key_count: usize,
    /// Keys on this device now, so the screen can say "3 become 5".
    pub local_key_count: usize,
}

/// The outcome of a preview.
///
/// Shares the failure and conflict shapes with [`SyncOutcome`] deliberately: a
/// preview fails for exactly the reasons a pull fails, and a second vocabulary
/// for the same conditions would mean the screen wording them twice. There is
/// no `unchanged` arm — a preview that finds both sides in step reports the
/// two equal counts, because "nothing would change" is a thing to show rather
/// than a thing to assume.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncPreviewOutcome {
    Ok {
        preview: SyncPullPreview,
    },
    Conflict {
        conflict: SyncConflict,
    },
    Failed {
        code: &'static str,
        message: Option<String>,
    },
}

/// What [`test_sync_connection`] answers.
///
/// Deliberately **not** a `SyncOutcome`, and this is the one place the shapes
/// diverge from the contract: `SyncOutcome`'s `ok` carries a non-optional
/// manifest, and a successful probe of a configured-but-never-pushed account
/// has no manifest to carry — `SyncEngine::probe` documents an absent blob as
/// a successful probe. Reporting that as `failed`/`no-remote-blob` would tell
/// the user their credential does not work, which is the opposite of what the
/// probe just established.
///
/// The `state` tag and the `failed` arm are identical to `SyncOutcome`'s, so a
/// renderer that switches on `state` reads both the same way.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncProbeOutcome {
    Ok {
        /// What the remote already holds, absent when nothing is stored yet.
        #[serde(skip_serializing_if = "Option::is_none")]
        manifest: Option<SyncManifest>,
    },
    Failed {
        code: &'static str,
        message: Option<String>,
    },
}

/// Settings as they arrive from the renderer, with the secrets to store.
///
/// Both secret fields are write-only and distinguish three cases, because
/// "leave it alone" and "clear it" are different intents and one nullable
/// string cannot carry both: absent leaves what is stored, `""` clears it, and
/// any other value replaces it. Neither is ever read back out — the renderer
/// learns only the `*Present` booleans.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncSettingsInput {
    pub enabled: bool,
    pub provider: Option<bc_sync::SyncProvider>,
    pub webdav_url: Option<String>,
    pub webdav_username: Option<String>,
    /// The folder to sync through. Not a credential, not secret, and not
    /// stored by [`pick_sync_folder`] — it arrives here like any other field.
    pub folder_path: Option<String>,
    pub auto_push_minutes: Option<u32>,
    /// The Nextcloud app password. Never read back out to the renderer, and
    /// ignored for a provider that authenticates with nothing — see
    /// [`configure_with`].
    pub credential: Option<String>,
    /// The sync passphrase. Never read back out to the renderer.
    pub passphrase: Option<String>,
}

impl SyncSettingsInput {
    /// The persisted half, normalized.
    ///
    /// `last_synced_at` is carried over from what is stored rather than taken
    /// from the input, which does not carry it: a save that reset it would
    /// make the next automatic push believe this device had never synced and
    /// fire immediately.
    fn to_settings(&self, stored: &SyncSettings) -> SyncSettings {
        SyncSettings {
            version: SETTINGS_VERSION,
            enabled: self.enabled,
            provider: self.provider,
            webdav_url: self.webdav_url.clone(),
            webdav_username: self.webdav_username.clone(),
            folder_path: self.folder_path.clone(),
            auto_push_minutes: self.auto_push_minutes,
            last_synced_at: stored.last_synced_at.clone(),
        }
        .normalize()
    }
}

/// Which side of a conflict to keep. Both keep a copy of the other.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictResolution {
    KeepLocal,
    KeepRemote,
}

impl ConflictResolution {
    /// The half of the archive suffix that says which side was discarded.
    fn discarded(self) -> &'static str {
        match self {
            Self::KeepLocal => "remote",
            Self::KeepRemote => "local",
        }
    }
}

// ── Failures ────────────────────────────────────────────────────────────────

/// Why a command could not finish.
///
/// The split is the whole error handling of this module. `Refused` is a sync
/// that did not happen for a reason the user can act on, and it reaches the
/// renderer as a `failed` [`SyncOutcome`] carrying a `SyncFailureCode`.
/// `Broken` is this application failing at something that is not about sync —
/// an unreadable keyring, an unwritable preference file — and it reaches the
/// renderer as a rejected promise, the way every other command's `Err(String)`
/// does. Folding the second kind into the first would put "check your
/// Nextcloud" in front of someone whose disk is full.
#[derive(Debug)]
enum Failure {
    Refused(SyncError),
    Broken(String),
}

impl From<SyncError> for Failure {
    fn from(error: SyncError) -> Self {
        Self::Refused(error)
    }
}

impl From<StorageError> for Failure {
    fn from(error: StorageError) -> Self {
        Self::Broken(error.to_string())
    }
}

impl From<crate::app_config::AppConfigError> for Failure {
    fn from(error: crate::app_config::AppConfigError) -> Self {
        Self::Broken(error.to_string())
    }
}

/// Hand a command's result to the renderer.
fn settle(result: Result<SyncOutcome, Failure>) -> Result<SyncOutcome, String> {
    match result {
        Ok(outcome) => Ok(outcome),
        Err(Failure::Refused(error)) => Ok(SyncOutcome::Failed {
            code: error.code(),
            message: error.provider_message(),
        }),
        Err(Failure::Broken(message)) => Err(message),
    }
}

/// Why a seal failed.
///
/// Only the size limit is a sync failure the user can do something about. An
/// invalid configuration or a failed RNG is this build being broken, and there
/// is no `SyncFailureCode` for it — inventing one would send the user to look
/// at their provider for something that never involved it.
fn seal_failure(error: CryptoError) -> Failure {
    match error {
        CryptoError::InputTooLarge { .. } => Failure::Refused(SyncError::TooLarge),
        other => Failure::Broken(other.to_string()),
    }
}

/// Why opening a downloaded blob failed.
///
/// `wrong-passphrase` and `corrupt` send the user to entirely different
/// places — the passphrase field, or another device to push again — so the
/// split matters more than it looks. By the time this runs the blob's checksum
/// has already been verified against its manifest, so the bytes are the bytes
/// the writer wrote; an authentication failure is therefore a statement about
/// the passphrase. A blob that is not an envelope at all, or a manifest whose
/// KDF parameters this build cannot use, has not tested the passphrase, so
/// blaming it would be a guess.
fn open_failure(error: CryptoError) -> SyncError {
    match error {
        CryptoError::DecryptionFailed(_) => SyncError::WrongPassphrase,
        CryptoError::InputTooLarge { .. } => SyncError::TooLarge,
        CryptoError::InvalidFormat
        | CryptoError::InvalidConfig(_)
        | CryptoError::EncryptionFailed(_) => SyncError::Corrupt,
    }
}

// ── The vault, in both directions ───────────────────────────────────────────

/// One stored key as it travels. Field for field, and nothing is opened.
fn vault_entry(key: ApiKey) -> VaultEntry {
    VaultEntry {
        id: key.id,
        label: key.label,
        email: key.email,
        encrypted_key: key.encrypted_key,
        iterations: key.iterations,
        key_length: key.key_length,
        algorithm: key.algorithm,
    }
}

/// The same mapping on the way back in.
///
/// The id travels with the entry and is written back as it arrived: a restored
/// key under a freshly minted id is a key that every `vault:<id>` secret,
/// audit entry and saved session on this machine no longer points at.
fn api_key(entry: VaultEntry) -> ApiKey {
    ApiKey {
        id: entry.id,
        label: entry.label,
        email: entry.email,
        encrypted_key: entry.encrypted_key,
        iterations: entry.iterations,
        key_length: entry.key_length,
        algorithm: entry.algorithm,
    }
}

/// A fingerprint of the vault, over exactly the fields that travel.
///
/// Compared against [`Preferences::sync_vault_fingerprint`] to answer "has
/// this device changed its keys since the last sync", which is the question a
/// pull must ask before replacing them.
///
/// A serialisation failure here is not possible — these are plain structs —
/// but if it were, the hash of nothing is still a definite value and is not
/// the hash of an empty vault (`[]`), so a fingerprint can never be mistaken
/// for a match it is not. That is the safe direction: the comparison fails and
/// the pull refuses.
fn vault_fingerprint(entries: &[VaultEntry]) -> String {
    checksum_hex(&serde_json::to_vec(entries).unwrap_or_default())
}

async fn vault_entries(storage: &Storage) -> Result<Vec<VaultEntry>, Failure> {
    Ok(storage
        .get_api_keys()
        .await?
        .into_iter()
        .map(vault_entry)
        .collect())
}

// ── This device ─────────────────────────────────────────────────────────────

/// A coarse description of this machine, for the manifest.
///
/// Deliberately not a hostname: this sits unencrypted in someone else's
/// storage and a hostname is frequently a person's name. The OS edition where
/// there is one (`Windows 11 Pro`), otherwise the family and its version
/// (`Ubuntu 24.04`) — Windows reports its version as a build number, which is
/// both uglier and narrower than the edition string. What actually
/// distinguishes two installs is `device_id`, which this sits next to.
fn device_label() -> String {
    static LABEL: OnceLock<String> = OnceLock::new();
    LABEL
        .get_or_init(|| {
            let info = os_info::get();
            let known = |value: String| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty() && trimmed != "Unknown").then_some(trimmed)
            };
            let label = info
                .edition()
                .map(str::to_string)
                .and_then(known)
                .or_else(|| {
                    let family = info.os_type().to_string();
                    match known(info.version().to_string()) {
                        Some(version) => Some(format!("{family} {version}")),
                        None => known(family),
                    }
                })
                .unwrap_or_else(|| "Unknown".to_string());
            match label.char_indices().nth(MAX_DEVICE_LABEL_BYTES) {
                Some((at, _)) => label[..at].to_string(),
                None => label,
            }
        })
        .clone()
}

/// Everything the commands read out of the preference file, in one pass.
struct Persisted {
    settings: SyncSettings,
    device_id: String,
    device_label: String,
    last_known: Option<SyncManifest>,
    vault_fingerprint: Option<String>,
}

impl Persisted {
    /// The generation a write from this device believes it is replacing.
    fn expected_generation(&self) -> u64 {
        self.last_known.as_ref().map_or(0, |known| known.generation)
    }

    fn conflict_with(&self, remote: SyncManifest) -> SyncConflict {
        SyncConflict {
            local: self.last_known.clone(),
            remote,
            expected_generation: self.expected_generation(),
        }
    }

    fn conflict(&self, remote: SyncManifest) -> SyncOutcome {
        SyncOutcome::Conflict {
            conflict: self.conflict_with(remote),
        }
    }

    /// A conflict against a generation the *user* was shown, rather than
    /// against the one this device last synced. See [`pull_with`]'s
    /// `expected_generation`.
    fn conflict_expecting(&self, remote: SyncManifest, expected: u64) -> SyncOutcome {
        SyncOutcome::Conflict {
            conflict: SyncConflict {
                local: self.last_known.clone(),
                remote,
                expected_generation: expected,
            },
        }
    }
}

async fn read_preferences(
    config: &AppConfigStore,
    storage: &Storage,
) -> Result<Preferences, Failure> {
    Ok(config
        .get_preferences(
            || storage.get_legacy_preferences(),
            || storage.delete_legacy_preferences(),
        )
        .await?)
}

async fn write_preferences(
    config: &AppConfigStore,
    storage: &Storage,
    fields: Map<String, Value>,
) -> Result<(), Failure> {
    Ok(config
        .update_preferences(
            fields,
            || storage.get_legacy_preferences(),
            || storage.delete_legacy_preferences(),
        )
        .await?)
}

/// Read the persisted half, minting this install's device id if it has none.
///
/// Minted on first read rather than at install time, because this is the first
/// moment anything needs one, and persisted immediately: an id that changed
/// between two pushes would make every manifest's `deviceId` describe a device
/// that does not exist, and "which of my machines wrote this" is the one
/// question the field is there to answer.
async fn persisted(config: &AppConfigStore, storage: &Storage) -> Result<Persisted, Failure> {
    let preferences = read_preferences(config, storage).await?;
    let settings = preferences.sync.unwrap_or_default().normalize();
    let device_id = match preferences
        .sync_device_id
        .filter(|id| !id.trim().is_empty())
    {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let mut fields = Map::new();
            fields.insert("sync_device_id".to_string(), Value::String(id.clone()));
            write_preferences(config, storage, fields).await?;
            id
        }
    };
    Ok(Persisted {
        settings,
        device_id,
        device_label: device_label(),
        last_known: preferences.sync_last_manifest,
        vault_fingerprint: preferences.sync_vault_fingerprint,
    })
}

/// Record a completed sync: when it happened, what was transferred, and what
/// the vault looked like afterwards.
///
/// One write for all three, so they cannot disagree: a `last_synced_at` that
/// landed without its manifest would leave the next push guarding against a
/// generation it no longer knows.
async fn remember(
    config: &AppConfigStore,
    storage: &Storage,
    state: &Persisted,
    manifest: &SyncManifest,
    fingerprint: &str,
    now: DateTime<Utc>,
) -> Result<(), Failure> {
    let settings = SyncSettings {
        last_synced_at: Some(now.to_rfc3339()),
        ..state.settings.clone()
    };
    let mut fields = Map::new();
    fields.insert(
        "sync".to_string(),
        serde_json::to_value(&settings).map_err(|error| Failure::Broken(error.to_string()))?,
    );
    fields.insert(
        "sync_last_manifest".to_string(),
        serde_json::to_value(manifest).map_err(|error| Failure::Broken(error.to_string()))?,
    );
    fields.insert(
        "sync_vault_fingerprint".to_string(),
        Value::String(fingerprint.to_string()),
    );
    write_preferences(config, storage, fields).await
}

// ── The two secrets ─────────────────────────────────────────────────────────

/// Read one `sync:` secret, with `absent` for "the keyring has not got it".
///
/// A blank value counts as absent everywhere it is read, which is what keeps
/// the presence booleans and the commands agreeing: a credential of spaces
/// would be refused by `build_engine` but reported as present, so the screen
/// would say "connected" about something that cannot authenticate anything.
async fn secret(
    storage: &Storage,
    slot: &str,
    absent: SyncError,
) -> Result<Zeroizing<String>, Failure> {
    match storage.get_sync_secret(slot).await {
        Ok(value) if value.trim().is_empty() => Err(Failure::Refused(absent)),
        Ok(value) => Ok(Zeroizing::new(value)),
        Err(StorageError::NotFound) => Err(Failure::Refused(absent)),
        Err(error) => Err(Failure::Broken(error.to_string())),
    }
}

/// The credential for the configured provider, or nothing where there is none.
///
/// Per provider, not one shared slot: switching provider must not hand a
/// Nextcloud app password to something else, and switching back must find the
/// old credential still there. See `SyncProvider::credential_slot`.
///
/// A provider with no slot yields an empty string rather than
/// `not-configured`, and the distinction is the whole point of the `Option`:
/// `build_engine` ignores the credential for a folder, so demanding one would
/// refuse every push to a folder for a secret nothing would ever read. What is
/// *not* done here is substituting a placeholder for a missing Nextcloud
/// password — that stays a refusal, because a Nextcloud that cannot
/// authenticate is a sync that cannot happen.
async fn credential(
    storage: &Storage,
    settings: &SyncSettings,
) -> Result<Zeroizing<String>, Failure> {
    match settings
        .provider
        .ok_or(SyncError::NotConfigured)?
        .credential_slot()
    {
        Some(slot) => secret(storage, slot, SyncError::NotConfigured).await,
        None => Ok(Zeroizing::new(String::new())),
    }
}

async fn sync_passphrase(storage: &Storage) -> Result<Zeroizing<String>, Failure> {
    secret(storage, PASSPHRASE_SLOT, SyncError::NoPassphrase).await
}

/// Whether the keyring holds a usable value in `slot`, right now.
///
/// Probed per call and never persisted — see the module header.
async fn present(storage: &Storage, slot: &str) -> bool {
    storage
        .get_sync_secret(slot)
        .await
        .is_ok_and(|value| !value.trim().is_empty())
}

/// Apply one write-only secret field. Three states; see
/// [`SyncSettingsInput`].
///
/// A value that is blank rather than empty is treated as the clear it plainly
/// is, rather than stored as a credential that cannot work. Anything else is
/// stored verbatim, untrimmed: leading and trailing spaces are part of a
/// passphrase, and silently trimming one would lock the user out of their own
/// blob from the other device.
async fn apply_secret(storage: &Storage, slot: &str, value: Option<&str>) -> Result<(), Failure> {
    match value {
        None => Ok(()),
        Some(blank) if blank.trim().is_empty() => match storage.delete_sync_secret(slot).await {
            // Deleting what was never there is the state the caller asked for.
            Ok(()) | Err(StorageError::NotFound) => Ok(()),
            Err(error) => Err(Failure::Broken(error.to_string())),
        },
        Some(secret) => Ok(storage.store_sync_secret(slot, secret).await?),
    }
}

// ── Sealing and opening ─────────────────────────────────────────────────────

/// The parameters this build seals with.
///
/// The user's own encryption setting, not a constant: they can benchmark and
/// raise it, and `add_api_key` already honours the same setting. This is
/// exactly why the manifest carries the parameters — two devices can disagree
/// about the iteration count and still open each other's blobs.
async fn seal_config(storage: &Storage) -> Result<EncryptionConfig, Failure> {
    let config = match storage.get_encryption_settings().await {
        Ok(config) => config,
        Err(StorageError::NotFound) => CryptoManager::default().get_config(),
        Err(error) => return Err(Failure::Broken(error.to_string())),
    };
    config
        .validated_for_encryption()
        .map_err(|error| Failure::Broken(error.to_string()))
}

/// What came out of a seal.
struct Sealed {
    blob: Vec<u8>,
    config: EncryptionConfig,
    fingerprint: String,
}

/// Serialise the vault, seal it, and bound what came out.
///
/// The plaintext bound is checked before the seal because it is free and the
/// seal is not, and both are reported as `too-large` rather than chunked: a
/// credential store split across provider objects multiplies the ways a
/// partial restore can happen, and a partially restored key vault is worse
/// than a refused one.
async fn seal_vault(
    storage: &Storage,
    state: &Persisted,
    entries: Vec<VaultEntry>,
    passphrase: &Zeroizing<String>,
    now: DateTime<Utc>,
) -> Result<Sealed, Failure> {
    let fingerprint = vault_fingerprint(&entries);
    let payload = SyncPayload {
        format: PAYLOAD_FORMAT.to_string(),
        version: PAYLOAD_VERSION,
        written_at: now.to_rfc3339(),
        device_id: state.device_id.clone(),
        device_label: state.device_label.clone(),
        keys: entries,
    };
    let plaintext = Zeroizing::new(
        serde_json::to_string(&payload).map_err(|error| Failure::Broken(error.to_string()))?,
    );
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(Failure::Refused(SyncError::TooLarge));
    }

    let config = seal_config(storage).await?;
    let envelope = seal_off_task(plaintext, passphrase.clone(), config.clone()).await?;
    let blob = envelope.as_bytes().to_vec();
    if blob.len() > MAX_SYNC_ENVELOPE_BYTES {
        return Err(Failure::Refused(SyncError::TooLarge));
    }
    Ok(Sealed {
        blob,
        config,
        fingerprint,
    })
}

/// Run a PBKDF2 seal off the command's own task.
///
/// A derivation at this build's iteration count takes a few hundred
/// milliseconds, and `commands::auth` already decided that belongs on a
/// blocking thread rather than on the runtime serving the rest of the UI. No
/// concurrency cap here, unlike its `run_crypto_job`: two pushes at once are
/// made safe by the generation guard rather than by a lock, and refusing the
/// second one with "encryption is busy" would refuse a sync for a reason that
/// has nothing to do with sync.
async fn seal_off_task(
    plaintext: Zeroizing<String>,
    passphrase: Zeroizing<String>,
    config: EncryptionConfig,
) -> Result<Zeroizing<String>, Failure> {
    tauri::async_runtime::spawn_blocking(move || {
        let crypto = CryptoManager::new_for_encryption(config)?;
        crypto.encrypt(&plaintext, &passphrase).map(Zeroizing::new)
    })
    .await
    .map_err(|error| Failure::Broken(format!("the encryption worker failed: {error}")))?
    .map_err(seal_failure)
}

/// The mirror image, with the parameters the manifest recorded.
async fn open_off_task(
    envelope: String,
    passphrase: Zeroizing<String>,
    config: EncryptionConfig,
) -> Result<Zeroizing<String>, Failure> {
    tauri::async_runtime::spawn_blocking(move || {
        let crypto = CryptoManager::new(config)?;
        crypto.decrypt(&envelope, &passphrase).map(Zeroizing::new)
    })
    .await
    .map_err(|error| Failure::Broken(format!("the decryption worker failed: {error}")))?
    .map_err(|error| Failure::Refused(open_failure(error)))
}

/// Verify, open and parse a blob a provider handed back.
///
/// The order is deliberate. The checksum first, because a truncated upload is
/// not a wrong passphrase and must not be reported as one. Then the KDF
/// parameters **from this manifest**, which is the whole reason the manifest
/// carries them: this build's own default is irrelevant to a blob somebody
/// else sealed. Then the payload's own strict projection, which is what keeps
/// a hostile field out of the key list.
async fn open_remote(
    manifest: &SyncManifest,
    blob: Vec<u8>,
    passphrase: &Zeroizing<String>,
) -> Result<SyncPayload, Failure> {
    if !manifest.describes(&blob) {
        return Err(Failure::Refused(SyncError::Corrupt));
    }
    let envelope = String::from_utf8(blob).map_err(|_| Failure::Refused(SyncError::Corrupt))?;
    let config = EncryptionConfig {
        iterations: manifest.iterations,
        key_length: manifest.key_length,
        algorithm: manifest.algorithm.clone(),
    };
    let plaintext = open_off_task(envelope, passphrase.clone(), config).await?;
    SyncPayload::parse(&plaintext).map_err(Failure::Refused)
}

/// Install an opened payload over this device's key list, and record it.
async fn install(
    config: &AppConfigStore,
    storage: &Storage,
    state: &Persisted,
    payload: SyncPayload,
    manifest: SyncManifest,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let fingerprint = vault_fingerprint(&payload.keys);
    let keys = payload.keys.into_iter().map(api_key).collect();
    storage.replace_api_keys(keys).await?;
    remember(config, storage, state, &manifest, &fingerprint, now).await?;
    Ok(SyncOutcome::Ok { manifest })
}

// ── get_sync_status ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_sync_status(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
) -> Result<SyncStatus, String> {
    match status(&config, &storage).await {
        Ok(status) => Ok(status),
        Err(Failure::Broken(message)) => Err(message),
        // Nothing in a status read refuses: it reaches no provider and needs
        // no secret. A `Refused` here would be a bug in this module rather
        // than anything the user can act on, so it is reported as one.
        Err(Failure::Refused(error)) => Err(error.to_string()),
    }
}

async fn status(config: &AppConfigStore, storage: &Storage) -> Result<SyncStatus, Failure> {
    let state = persisted(config, storage).await?;
    Ok(status_of(storage, &state).await)
}

async fn status_of(storage: &Storage, state: &Persisted) -> SyncStatus {
    // `None` covers two different situations that have the same answer. With
    // no provider chosen there is no credential in question — a slot left over
    // from a provider the user has switched away from is not a credential this
    // configuration has. With a folder there is no credential at all, and
    // `false` is the honest reading of "nothing is stored" rather than a gap to
    // paper over: the screen tells the two apart through
    // `providerNeedsCredential`, not through this flag. See the module header.
    let credential_present = match state
        .settings
        .provider
        .and_then(|provider| provider.credential_slot())
    {
        Some(slot) => present(storage, slot).await,
        None => false,
    };
    SyncStatus {
        settings: SyncSettingsView {
            settings: state.settings.clone(),
            credential_present,
            passphrase_present: present(storage, PASSPHRASE_SLOT).await,
        },
        last_known: state.last_known.clone(),
        device_id: state.device_id.clone(),
        device_label: state.device_label.clone(),
        auto_push_minutes_range: AutoPushRange::default(),
    }
}

// ── configure_sync ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn configure_sync(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
    settings: SyncSettingsInput,
) -> Result<SyncStatus, String> {
    match configure_with(&config, &storage, settings).await {
        Ok(status) => Ok(status),
        Err(Failure::Broken(message)) => Err(message),
        Err(Failure::Refused(error)) => Err(error.to_string()),
    }
}

/// Write the non-secret settings, then store or clear the two secrets.
///
/// Returns the fresh status so the screen does not have to ask twice — and so
/// that what it shows about the two secrets comes from the keyring after the
/// write rather than from what the renderer believes it just sent.
async fn configure_with(
    config: &AppConfigStore,
    storage: &Storage,
    input: SyncSettingsInput,
) -> Result<SyncStatus, Failure> {
    let state = persisted(config, storage).await?;
    let settings = input.to_settings(&state.settings);

    // Where a credential goes, and whether one arriving is a problem.
    //
    // Three cases, and the two `None`s are deliberately not treated alike. A
    // credential with **no provider at all** is refused before anything is
    // written: the user is mid-configuration, there is no slot to put it in,
    // and reporting success would leave the screen claiming to hold something
    // this dropped. A credential for a provider that **authenticates with
    // nothing** is ignored instead, because the save itself is perfectly
    // valid — the renderer keeps one credential field for the provider that
    // has one, and a stale value in it must not refuse a legitimate switch to
    // a folder. Nothing is written to a slot nothing reads, which is what
    // makes ignoring it safe rather than lossy.
    let credential_slot = match settings.provider {
        Some(provider) => provider.credential_slot(),
        None => {
            if input
                .credential
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(Failure::Refused(SyncError::NotConfigured));
            }
            None
        }
    };

    // Settings first, secrets second. The reverse order would put a
    // credential in the keyring for a provider the preference file then failed
    // to record; this way a failed secret write leaves the settings saved and
    // the keyring untouched, which is a state the next status read describes
    // accurately and the user can simply retry.
    let mut fields = Map::new();
    fields.insert(
        "sync".to_string(),
        serde_json::to_value(&settings).map_err(|error| Failure::Broken(error.to_string()))?,
    );
    write_preferences(config, storage, fields).await?;

    if let Some(slot) = credential_slot {
        apply_secret(storage, slot, input.credential.as_deref()).await?;
    }
    apply_secret(storage, PASSPHRASE_SLOT, input.passphrase.as_deref()).await?;

    let state = Persisted { settings, ..state };
    Ok(status_of(storage, &state).await)
}

// ── test_sync_connection ────────────────────────────────────────────────────

#[tauri::command]
pub async fn test_sync_connection(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
) -> Result<SyncProbeOutcome, String> {
    match probe(&config, &storage).await {
        Ok(outcome) => Ok(outcome),
        Err(Failure::Refused(error)) => Ok(SyncProbeOutcome::Failed {
            code: error.code(),
            message: error.provider_message(),
        }),
        Err(Failure::Broken(message)) => Err(message),
    }
}

async fn probe(config: &AppConfigStore, storage: &Storage) -> Result<SyncProbeOutcome, Failure> {
    let state = persisted(config, storage).await?;
    let credential = credential(storage, &state.settings).await?;
    let engine = build_engine(&state.settings, &credential)?;
    engine.probe().await?;
    // The probe has already succeeded by here, so a manifest read that fails
    // must not turn a working connection into a failed one. Its only job is to
    // tell the screen whether there is anything to pull.
    Ok(SyncProbeOutcome::Ok {
        manifest: engine.fetch_manifest().await.ok().flatten(),
    })
}

// ── pick_sync_folder ────────────────────────────────────────────────────────

/// Ask the user which folder to sync through, and answer only that.
///
/// A picker rather than a text box, because an absolute path typed by hand is
/// the one setting here that fails silently: a typo names a folder that does
/// not exist, which this feature reports as `unreachable` and the user reads as
/// "my drive is offline" rather than "I mistyped it". Picking it proves it
/// existed at the moment it was chosen.
///
/// **This stores nothing.** The path goes back to the renderer and returns
/// through [`configure_sync`] like any other field, so a folder is persisted in
/// one place and validated in one place. A picker that saved the setting itself
/// would commit a provider change the user had not pressed Save on, and would
/// do it from a command the screen calls while the user is still deciding.
///
/// `None` is a cancelled dialog, which is not a failure and must not read as
/// one: the screen leaves the field as it was.
#[tauri::command]
pub async fn pick_sync_folder() -> Result<Option<String>, String> {
    // A modal dialog sits there for as long as the user browses, so it goes on
    // a blocking thread rather than on the runtime serving the rest of the UI —
    // the same reason and the same mechanism as [`seal_off_task`].
    // `commands::audit` calls the synchronous `rfd` dialogs straight from its
    // own commands, which holds a runtime worker for the life of the dialog;
    // that is worth not spreading further.
    let picked = tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|error| format!("the folder picker failed: {error}"))?;
    match picked {
        Some(path) => picked_path(&path).map(Some),
        None => Ok(None),
    }
}

/// The chosen path, as a settings object can carry it.
///
/// A path that is not valid UTF-8 is an error rather than a cancellation.
/// `Preferences` is JSON and `build_engine` takes a `&str`, so there is no
/// honest way to persist one — and answering `None` would tell the renderer the
/// user pressed Cancel when they did not. A lossy conversion would be worse
/// again: it would store a path that names nothing, and every operation
/// afterwards would report `unreachable` for a folder sitting right there.
fn picked_path(path: &Path) -> Result<String, String> {
    path.to_str().map(str::to_string).ok_or_else(|| {
        format!(
            "{} cannot be stored as a sync folder: the path is not valid UTF-8",
            path.display()
        )
    })
}

// ── push_sync ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn push_sync(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
) -> Result<SyncOutcome, String> {
    settle(push(&config, &storage, Utc::now()).await)
}

async fn push(
    config: &AppConfigStore,
    storage: &Storage,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let state = persisted(config, storage).await?;
    let credential = credential(storage, &state.settings).await?;
    let passphrase = sync_passphrase(storage).await?;
    let engine = build_engine(&state.settings, &credential)?;
    push_with(&*engine, config, storage, &state, &passphrase, now).await
}

async fn push_with(
    engine: &dyn SyncEngine,
    config: &AppConfigStore,
    storage: &Storage,
    state: &Persisted,
    passphrase: &Zeroizing<String>,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let entries = vault_entries(storage).await?;
    let sealed = seal_vault(storage, state, entries, passphrase, now).await?;
    let manifest = manifest_for(
        state,
        &sealed,
        state.expected_generation().saturating_add(1),
        now,
    );
    // The guard, not a lock, is what makes two devices pushing at once safe:
    // `None` means "there must be nothing there", which is the only honest
    // claim a device that has never synced can make.
    let guard = GenerationGuard(state.last_known.as_ref().map(|known| known.generation));
    match engine.put(&sealed.blob, &manifest, guard).await? {
        PutOutcome::Written => {
            remember(config, storage, state, &manifest, &sealed.fingerprint, now).await?;
            Ok(SyncOutcome::Ok { manifest })
        }
        PutOutcome::Refused(refused) => Ok(state.conflict(refused.remote)),
    }
}

/// Describe a sealed blob.
///
/// The KDF fields are the parameters this envelope was **actually** sealed
/// with, read back off the seal rather than from this build's configuration a
/// second time. They are the only thing that lets a build whose default has
/// moved on open what today's build wrote.
fn manifest_for(
    state: &Persisted,
    sealed: &Sealed,
    generation: u64,
    now: DateTime<Utc>,
) -> SyncManifest {
    SyncManifest {
        generation,
        checksum: checksum_hex(&sealed.blob),
        bytes: sealed.blob.len() as u64,
        written_at: now.to_rfc3339(),
        device_id: state.device_id.clone(),
        device_label: state.device_label.clone(),
        payload_version: PAYLOAD_VERSION,
        iterations: sealed.config.iterations,
        key_length: sealed.config.key_length,
        algorithm: sealed.config.algorithm.clone(),
    }
}

// ── pull_sync ───────────────────────────────────────────────────────────────

/// Install the remote vault over this device's.
///
/// `expected_generation` is the generation [`preview_sync_pull`] showed the
/// user, and passing it is what makes the two-step flow a guarded one — see
/// [`pull_with`]. Optional, so a renderer that offers no preview can invoke
/// this with no arguments at all and get the unconditional pull the contract's
/// argument table describes.
#[tauri::command]
pub async fn pull_sync(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
    expected_generation: Option<u64>,
) -> Result<SyncOutcome, String> {
    settle(pull(&config, &storage, expected_generation, Utc::now()).await)
}

async fn pull(
    config: &AppConfigStore,
    storage: &Storage,
    expected_generation: Option<u64>,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let state = persisted(config, storage).await?;
    let credential = credential(storage, &state.settings).await?;
    let passphrase = sync_passphrase(storage).await?;
    let engine = build_engine(&state.settings, &credential)?;
    pull_with(
        &*engine,
        config,
        storage,
        &state,
        &passphrase,
        expected_generation,
        now,
    )
    .await
}

/// What a pull would do, decided before anything is downloaded.
#[derive(Debug, Eq, PartialEq)]
enum PullVerdict {
    /// Both sides already agree. A pull stops here; a preview goes on to open
    /// the envelope anyway, because it has two counts to report.
    Unchanged,
    /// Installing would drop something. The user picks a side.
    Conflict,
    Proceed,
}

struct PullPlan {
    remote: SyncManifest,
    verdict: PullVerdict,
    local_keys: usize,
}

/// Read the remote manifest and decide what a pull would do with it.
///
/// Shared by [`pull_with`] and [`preview_with`] so that the preview cannot
/// drift from the thing it is previewing: a screen that offers a pull the pull
/// then refuses, or previews one it would not refuse, is worse than no preview.
async fn plan_pull(
    engine: &dyn SyncEngine,
    storage: &Storage,
    state: &Persisted,
) -> Result<PullPlan, Failure> {
    let Some(remote) = engine.fetch_manifest().await? else {
        return Err(Failure::Refused(SyncError::NoRemoteBlob));
    };
    // Refused from the manifest, before the download: the manifest exists so
    // that a blob a newer build wrote can be refused without spending the
    // bandwidth, and `SyncPayload::parse` would only reach the same verdict
    // after opening it.
    if remote.payload_version > PAYLOAD_VERSION {
        return Err(Failure::Refused(SyncError::PayloadTooNew));
    }

    let entries = vault_entries(storage).await?;
    let fingerprint = vault_fingerprint(&entries);
    let unsynced_changes = match state.vault_fingerprint.as_deref() {
        Some(stored) => stored != fingerprint,
        // Never synced. An empty vault has nothing to lose, so a first pull
        // onto a fresh install is the ordinary case rather than a conflict;
        // a vault with keys in it does have something to lose.
        None => !entries.is_empty(),
    };

    let in_step = state.last_known.as_ref().is_some_and(|local| {
        local.generation == remote.generation && local.checksum == remote.checksum
    });
    // The remote being behind what this device already pushed is a conflict
    // for the mirror-image reason: installing it would undo this device's own
    // last push.
    let remote_behind = state
        .last_known
        .as_ref()
        .is_some_and(|local| local.generation > remote.generation);

    // Refused, not merged. Installing over a vault this device has changed
    // since its last sync would silently drop whatever it changed, and there
    // is no field-level reconciliation that means anything for an opaque
    // sealed envelope — so the user picks a side, and keeps a copy of the
    // other. See `resolve_sync_conflict`.
    let verdict = if unsynced_changes || remote_behind {
        PullVerdict::Conflict
    } else if in_step {
        PullVerdict::Unchanged
    } else {
        PullVerdict::Proceed
    };
    Ok(PullPlan {
        remote,
        verdict,
        local_keys: entries.len(),
    })
}

/// Install the remote vault, refusing what the user did not agree to.
///
/// # The read-side half of the guard
///
/// A push carries the generation it believed it was replacing. A pull needs
/// the same thing for the opposite reason, and this is where the two-step
/// flow is actually made safe: between the moment
/// [`preview_sync_pull`] said "5 keys will replace your 3" and the moment the
/// user presses Confirm, another device can push. Nothing this device persists
/// can detect that — the preview deliberately writes nothing, and a device
/// with no local blob has no generation of its own to compare — so the
/// previewed generation has to arrive as an argument. Without it, "install
/// something the user never previewed" is precisely what happens, and that is
/// the one outcome the preview exists to prevent.
///
/// `None` is the unguarded pull: whatever is there now. It is the right
/// answer for a caller that showed no preview, and the wrong one after a
/// preview.
async fn pull_with(
    engine: &dyn SyncEngine,
    config: &AppConfigStore,
    storage: &Storage,
    state: &Persisted,
    passphrase: &Zeroizing<String>,
    expected_generation: Option<u64>,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let plan = plan_pull(engine, storage, state).await?;
    if let Some(previewed) = expected_generation {
        if plan.remote.generation != previewed {
            return Ok(state.conflict_expecting(plan.remote, previewed));
        }
    }
    match plan.verdict {
        PullVerdict::Unchanged => Ok(SyncOutcome::Unchanged {
            manifest: plan.remote,
        }),
        PullVerdict::Conflict => Ok(state.conflict(plan.remote)),
        PullVerdict::Proceed => {
            let blob = engine.fetch_blob().await?;
            let payload = open_remote(&plan.remote, blob, passphrase).await?;
            install(config, storage, state, payload, plan.remote, now).await
        }
    }
}

// ── preview_sync_pull ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn preview_sync_pull(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
) -> Result<SyncPreviewOutcome, String> {
    match preview(&config, &storage).await {
        Ok(outcome) => Ok(outcome),
        Err(Failure::Refused(error)) => Ok(SyncPreviewOutcome::Failed {
            code: error.code(),
            message: error.provider_message(),
        }),
        Err(Failure::Broken(message)) => Err(message),
    }
}

async fn preview(
    config: &AppConfigStore,
    storage: &Storage,
) -> Result<SyncPreviewOutcome, Failure> {
    let state = persisted(config, storage).await?;
    let credential = credential(storage, &state.settings).await?;
    let passphrase = sync_passphrase(storage).await?;
    let engine = build_engine(&state.settings, &credential)?;
    preview_with(&*engine, storage, &state, &passphrase).await
}

/// Everything a pull does up to opening the envelope, and then nothing.
///
/// Takes no `AppConfigStore` and no clock, which is the mechanical half of
/// "writes nothing": without them it cannot record a `last_synced_at` or a
/// manifest even by accident.
async fn preview_with(
    engine: &dyn SyncEngine,
    storage: &Storage,
    state: &Persisted,
    passphrase: &Zeroizing<String>,
) -> Result<SyncPreviewOutcome, Failure> {
    let plan = plan_pull(engine, storage, state).await?;
    if plan.verdict == PullVerdict::Conflict {
        return Ok(SyncPreviewOutcome::Conflict {
            conflict: state.conflict_with(plan.remote),
        });
    }
    let blob = engine.fetch_blob().await?;
    let payload = open_remote(&plan.remote, blob, passphrase).await?;
    Ok(SyncPreviewOutcome::Ok {
        preview: SyncPullPreview {
            manifest: plan.remote,
            key_count: payload.keys.len(),
            local_key_count: plan.local_keys,
        },
    })
}

// ── resolve_sync_conflict ───────────────────────────────────────────────────

#[tauri::command]
pub async fn resolve_sync_conflict(
    config: State<'_, AppConfigStore>,
    storage: State<'_, Storage>,
    resolution: ConflictResolution,
) -> Result<SyncOutcome, String> {
    settle(resolve(&config, &storage, resolution, Utc::now()).await)
}

async fn resolve(
    config: &AppConfigStore,
    storage: &Storage,
    resolution: ConflictResolution,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let state = persisted(config, storage).await?;
    let credential = credential(storage, &state.settings).await?;
    let passphrase = sync_passphrase(storage).await?;
    let engine = build_engine(&state.settings, &credential)?;
    resolve_with(
        &*engine,
        config,
        storage,
        &state,
        &passphrase,
        resolution,
        now,
    )
    .await
}

async fn resolve_with(
    engine: &dyn SyncEngine,
    config: &AppConfigStore,
    storage: &Storage,
    state: &Persisted,
    passphrase: &Zeroizing<String>,
    resolution: ConflictResolution,
    now: DateTime<Utc>,
) -> Result<SyncOutcome, Failure> {
    let Some(remote) = engine.fetch_manifest().await? else {
        // With nothing on the provider there are not two sides to choose
        // between, and a resolution that wrote anyway would write unguarded.
        return Err(Failure::Refused(SyncError::NoRemoteBlob));
    };
    let stamp = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%SZ"),
        resolution.discarded()
    );

    match resolution {
        ConflictResolution::KeepLocal => {
            // Copied first, and the resolution refuses if the copy does not
            // land. `archive` carries the manifest with the bytes, so what is
            // kept is openable rather than merely present.
            let discarded = engine.fetch_blob().await?;
            engine.archive(&stamp, &discarded, &remote).await?;

            let entries = vault_entries(storage).await?;
            let sealed = seal_vault(storage, state, entries, passphrase, now).await?;
            let manifest = manifest_for(state, &sealed, remote.generation.saturating_add(1), now);
            // Guarded against what was just archived, not against what this
            // device last saw: the point of the resolution is to replace
            // *that* remote, and anything newer arrived while the user was
            // deciding and has not been copied anywhere.
            let guard = GenerationGuard(Some(remote.generation));
            match engine.put(&sealed.blob, &manifest, guard).await? {
                PutOutcome::Written => {
                    remember(config, storage, state, &manifest, &sealed.fingerprint, now).await?;
                    Ok(SyncOutcome::Ok { manifest })
                }
                PutOutcome::Refused(refused) => Ok(state.conflict(refused.remote)),
            }
        }
        ConflictResolution::KeepRemote => {
            if remote.payload_version > PAYLOAD_VERSION {
                return Err(Failure::Refused(SyncError::PayloadTooNew));
            }
            // This device's own vault is what is about to be discarded, so it
            // is sealed and copied up before anything replaces it. It has
            // never been uploaded — that is what made this a conflict — so
            // there is no existing copy to fall back on.
            let entries = vault_entries(storage).await?;
            let sealed = seal_vault(storage, state, entries, passphrase, now).await?;
            let manifest = manifest_for(state, &sealed, state.expected_generation(), now);
            engine.archive(&stamp, &sealed.blob, &manifest).await?;

            let blob = engine.fetch_blob().await?;
            let payload = open_remote(&remote, blob, passphrase).await?;
            install(config, storage, state, payload, remote, now).await
        }
    }
}

// ── Registration ────────────────────────────────────────────────────────────

/// The commands this feature adds, as `SYNC_COMMANDS` in
/// `src/lib/sync/types.ts` names them.
///
/// Read by `main`'s `every_sync_command_is_registered` and pinned against the
/// contract in both directions by the two tests below. An unregistered command
/// typechecks on both sides of the boundary and fails at the moment a user
/// reaches it, which has happened in this repository before.
///
/// `cfg(test)` like the other modules' lists: it exists to be asserted on, and
/// a production build that carried it would carry eight unread strings.
#[cfg(test)]
pub const COMMAND_NAMES: [&str; 8] = [
    "get_sync_status",
    "configure_sync",
    "test_sync_connection",
    "pick_sync_folder",
    "push_sync",
    "preview_sync_pull",
    "pull_sync",
    "resolve_sync_conflict",
];

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use bc_sync::{GuardRefused, SyncProvider};

    use super::*;

    /// The renderer's contract, read as text so the command names, the state
    /// tags and the bounds on this side cannot drift from it without a test
    /// failing.
    const CONTRACT: &str = include_str!("../../../src/lib/sync/types.ts");

    // ── A provider that answers from memory ─────────────────────────────

    /// An engine that stores in a `Mutex` instead of over HTTP.
    ///
    /// The layer under test is everything *around* an engine — the guard, the
    /// seal, the refusals, the archive — and none of it should need a socket
    /// to exercise. The two real engines are tested against their own stubs
    /// in `bc-sync`.
    #[derive(Default)]
    struct FakeEngine {
        stored: Mutex<Option<(SyncManifest, Vec<u8>)>>,
        archives: Mutex<Vec<(String, Vec<u8>, SyncManifest)>>,
        refuse_archive: bool,
    }

    impl FakeEngine {
        fn holding(manifest: SyncManifest, blob: Vec<u8>) -> Self {
            Self {
                stored: Mutex::new(Some((manifest, blob))),
                ..Self::default()
            }
        }

        fn manifest(&self) -> Option<SyncManifest> {
            self.stored
                .lock()
                .expect("engine state")
                .as_ref()
                .map(|(manifest, _)| manifest.clone())
        }

        fn blob(&self) -> Option<Vec<u8>> {
            self.stored
                .lock()
                .expect("engine state")
                .as_ref()
                .map(|(_, blob)| blob.clone())
        }

        /// Corrupt the stored bytes without touching the manifest, the way a
        /// truncated upload or a provider that re-encoded the body would.
        fn damage_blob(&self) {
            let mut stored = self.stored.lock().expect("engine state");
            let (_, blob) = stored.as_mut().expect("something is stored");
            let last = blob.len() - 1;
            blob[last] ^= 0b0000_0001;
        }

        fn archive_suffixes(&self) -> Vec<String> {
            self.archives
                .lock()
                .expect("engine state")
                .iter()
                .map(|(suffix, _, _)| suffix.clone())
                .collect()
        }

        /// The one archived copy, with the manifest that came with it.
        fn only_archive(&self) -> (Vec<u8>, SyncManifest) {
            let archives = self.archives.lock().expect("engine state");
            let (_, blob, manifest) = archives.first().expect("something was archived");
            (blob.clone(), manifest.clone())
        }
    }

    #[async_trait::async_trait]
    impl SyncEngine for FakeEngine {
        async fn probe(&self) -> Result<(), SyncError> {
            Ok(())
        }

        async fn fetch_manifest(&self) -> Result<Option<SyncManifest>, SyncError> {
            Ok(self.manifest())
        }

        async fn fetch_blob(&self) -> Result<Vec<u8>, SyncError> {
            self.blob().ok_or(SyncError::NoRemoteBlob)
        }

        async fn put(
            &self,
            blob: &[u8],
            manifest: &SyncManifest,
            guard: GenerationGuard,
        ) -> Result<PutOutcome, SyncError> {
            let mut stored = self.stored.lock().expect("engine state");
            let held = stored.as_ref().map(|(held, _)| held.generation);
            if held != guard.0 {
                return match stored.as_ref() {
                    Some((held, _)) => Ok(PutOutcome::Refused(GuardRefused {
                        remote: held.clone(),
                    })),
                    // The guard names a generation and the blob is gone.
                    // `GuardRefused` has no manifest to report, so this is
                    // the one refusal that has to be an error.
                    None => Err(SyncError::NoRemoteBlob),
                };
            }
            *stored = Some((manifest.clone(), blob.to_vec()));
            Ok(PutOutcome::Written)
        }

        async fn archive(
            &self,
            suffix: &str,
            blob: &[u8],
            manifest: &SyncManifest,
        ) -> Result<(), SyncError> {
            if self.refuse_archive {
                return Err(SyncError::Provider("the archive write failed".into()));
            }
            self.archives.lock().expect("engine state").push((
                suffix.to_string(),
                blob.to_vec(),
                manifest.clone(),
            ));
            Ok(())
        }
    }

    // ── Fixtures ────────────────────────────────────────────────────────

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("bc-sync-commands-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// One install: its preference file, its keyring, and nothing shared with
    /// any other. Two of these is two devices.
    struct Device {
        _directory: TestDir,
        config: AppConfigStore,
        storage: Storage,
    }

    impl Device {
        fn new() -> Self {
            let directory = TestDir::new();
            Self {
                config: AppConfigStore::new(directory.0.clone()),
                storage: Storage::new(false),
                _directory: directory,
            }
        }

        /// A configured, passphrase-holding install. The provider is set so
        /// that `credential`/`build_engine` have something to find, though the
        /// tests that drive an engine pass the fake one in directly.
        async fn configured(self, passphrase: &str) -> Self {
            configure_with(
                &self.config,
                &self.storage,
                input(json!({
                    "enabled": true,
                    "provider": "nextcloud",
                    "webdavUrl": "https://cloud.example.test/dav",
                    "webdavUsername": "alice",
                    "credential": "app-password",
                    "passphrase": passphrase,
                })),
            )
            .await
            .expect("configure a device");
            self
        }

        /// The same install configured for a folder: a real directory, a
        /// passphrase, and deliberately nothing in any credential slot. The
        /// path is passed through `configure_sync` rather than written to
        /// preferences directly, because that is the only route a real folder
        /// ever arrives by — [`pick_sync_folder`] stores nothing itself.
        async fn using_folder(self, path: &Path, passphrase: &str) -> Self {
            configure_with(
                &self.config,
                &self.storage,
                input(json!({
                    "enabled": true,
                    "provider": "folder",
                    "folderPath": path.to_str().expect("a utf-8 test path"),
                    "passphrase": passphrase,
                })),
            )
            .await
            .expect("configure a folder device");
            self
        }

        /// Seal keys at `iterations` rather than at this build's default, so
        /// that a manifest's recorded parameters are provably the ones used.
        async fn sealing_at(self, iterations: u32) -> Self {
            self.storage
                .set_encryption_settings(&EncryptionConfig {
                    iterations,
                    ..EncryptionConfig::default()
                })
                .await
                .expect("set this install's encryption parameters");
            self
        }

        async fn with_key(self, label: &str, ciphertext: &str) -> Self {
            self.storage
                .add_api_key(
                    label.to_string(),
                    ciphertext.to_string(),
                    Some(format!("{label}@example.test")),
                    EncryptionConfig::default(),
                )
                .await
                .expect("seed a key");
            self
        }

        async fn state(&self) -> Persisted {
            persisted(&self.config, &self.storage)
                .await
                .expect("read the persisted half")
        }

        async fn keys(&self) -> Vec<ApiKey> {
            self.storage.get_api_keys().await.expect("read the vault")
        }

        async fn stored_settings(&self) -> SyncSettings {
            read_preferences(&self.config, &self.storage)
                .await
                .expect("read preferences")
                .sync
                .unwrap_or_default()
        }

        /// A push, as the renderer sees it: through [`settle`], so that a
        /// refusal reads as the `failed` outcome it becomes on the wire
        /// rather than as an error.
        async fn push(&self, engine: &FakeEngine, passphrase: &str) -> SyncOutcome {
            let state = self.state().await;
            settle(
                push_with(
                    engine,
                    &self.config,
                    &self.storage,
                    &state,
                    &phrase(passphrase),
                    at(0),
                )
                .await,
            )
            .expect("a push's refusals are outcomes, not errors")
        }

        async fn pull(&self, engine: &FakeEngine, passphrase: &str) -> SyncOutcome {
            self.pull_expecting(engine, passphrase, None).await
        }

        async fn pull_expecting(
            &self,
            engine: &FakeEngine,
            passphrase: &str,
            previewed: Option<u64>,
        ) -> SyncOutcome {
            let state = self.state().await;
            settle(
                pull_with(
                    engine,
                    &self.config,
                    &self.storage,
                    &state,
                    &phrase(passphrase),
                    previewed,
                    at(1),
                )
                .await,
            )
            .expect("a pull's refusals are outcomes, not errors")
        }

        async fn preview(&self, engine: &FakeEngine, passphrase: &str) -> SyncPreviewOutcome {
            let state = self.state().await;
            match preview_with(engine, &self.storage, &state, &phrase(passphrase)).await {
                Ok(outcome) => outcome,
                Err(Failure::Refused(error)) => SyncPreviewOutcome::Failed {
                    code: error.code(),
                    message: error.provider_message(),
                },
                Err(Failure::Broken(message)) => panic!("{message}"),
            }
        }

        async fn resolve(
            &self,
            engine: &FakeEngine,
            resolution: ConflictResolution,
            passphrase: &str,
        ) -> Result<SyncOutcome, Failure> {
            let state = self.state().await;
            resolve_with(
                engine,
                &self.config,
                &self.storage,
                &state,
                &phrase(passphrase),
                resolution,
                at(2),
            )
            .await
        }
    }

    fn phrase(passphrase: &str) -> Zeroizing<String> {
        Zeroizing::new(passphrase.to_string())
    }

    /// Settings as the renderer sends them, built from JSON on purpose: the
    /// three secret states are a property of the wire shape, and a Rust
    /// literal would skip the deserialisation that distinguishes them.
    fn input(value: Value) -> SyncSettingsInput {
        serde_json::from_value(value).expect("the renderer's shape")
    }

    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T12:00:00+00:00")
            .expect("a fixed clock")
            .with_timezone(&Utc)
            + chrono::Duration::minutes(minutes)
    }

    fn code_of(outcome: &SyncOutcome) -> &str {
        match outcome {
            SyncOutcome::Failed { code, .. } => code,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    fn manifest_of(outcome: &SyncOutcome) -> SyncManifest {
        match outcome {
            SyncOutcome::Ok { manifest } | SyncOutcome::Unchanged { manifest } => manifest.clone(),
            other => panic!("expected a manifest, got {other:?}"),
        }
    }

    fn conflict_of(outcome: &SyncOutcome) -> SyncConflict {
        match outcome {
            SyncOutcome::Conflict { conflict } => conflict.clone(),
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    // ── The contract ────────────────────────────────────────────────────

    #[test]
    fn every_command_name_is_the_one_the_renderer_invokes() {
        for name in COMMAND_NAMES {
            assert!(
                CONTRACT.contains(&format!("\"{name}\"")),
                "{name} is not in SYNC_COMMANDS, so the renderer cannot reach it"
            );
        }
    }

    /// The other direction, which is the one that catches the real defect: a
    /// name in that table is a name something will eventually invoke, and
    /// invoking a command Tauri does not have fails at the moment a user
    /// clicks.
    #[test]
    fn the_contract_names_no_command_this_module_does_not_have() {
        let (_, after) = CONTRACT
            .split_once("SYNC_COMMANDS = {")
            .expect("the contract declares SYNC_COMMANDS");
        let (block, _) = after
            .split_once("} as const")
            .expect("SYNC_COMMANDS is a const object");
        let mut found = 0;
        for line in block.lines() {
            // Each entry is `name: "the_command",`, and the doc comment above
            // one may quote anything — the folder picker's explains that a
            // mistyped path reads to the user as "my drive is offline" — so
            // comment lines are skipped rather than read for a command name.
            let trimmed = line.trim_start();
            if trimmed.starts_with('*') || trimmed.starts_with("/*") || trimmed.starts_with("//") {
                continue;
            }
            let Some(name) = line.split('"').nth(1) else {
                continue;
            };
            found += 1;
            assert!(
                COMMAND_NAMES.contains(&name),
                "SYNC_COMMANDS names {name}, which this module does not register"
            );
        }
        assert_eq!(
            found,
            COMMAND_NAMES.len(),
            "the table and the module disagree about how many commands there are"
        );
    }

    #[test]
    fn every_state_the_contract_names_is_serialised_under_that_name() {
        let manifest = SyncManifest {
            generation: 1,
            checksum: checksum_hex(b"x"),
            bytes: 1,
            written_at: at(0).to_rfc3339(),
            device_id: "device-1".to_string(),
            device_label: "Windows 11".to_string(),
            payload_version: PAYLOAD_VERSION,
            iterations: 120_000,
            key_length: 32,
            algorithm: "AES-GCM".to_string(),
        };
        let outcomes = [
            SyncOutcome::Ok {
                manifest: manifest.clone(),
            },
            SyncOutcome::Unchanged {
                manifest: manifest.clone(),
            },
            SyncOutcome::Conflict {
                conflict: SyncConflict {
                    local: None,
                    remote: manifest.clone(),
                    expected_generation: 0,
                },
            },
            SyncOutcome::Failed {
                code: "unreachable",
                message: Some("dns".to_string()),
            },
        ];
        for outcome in outcomes {
            let value = serde_json::to_value(&outcome).expect("serialise");
            let state = value["state"].as_str().expect("a tagged state").to_string();
            assert!(
                CONTRACT.contains(&format!("\"{state}\"")),
                "{state:?} is not a state the renderer knows"
            );
        }

        let previews = [
            SyncPreviewOutcome::Ok {
                preview: SyncPullPreview {
                    manifest: manifest.clone(),
                    key_count: 5,
                    local_key_count: 3,
                },
            },
            SyncPreviewOutcome::Conflict {
                conflict: SyncConflict {
                    local: None,
                    remote: manifest.clone(),
                    expected_generation: 0,
                },
            },
            SyncPreviewOutcome::Failed {
                code: "wrong-passphrase",
                message: None,
            },
        ];
        for outcome in previews {
            let value = serde_json::to_value(&outcome).expect("serialise");
            let state = value["state"].as_str().expect("a tagged state").to_string();
            assert!(
                CONTRACT.contains(&format!("\"{state}\"")),
                "{state:?} is not a preview state the renderer knows"
            );
        }

        let preview = serde_json::to_value(SyncPullPreview {
            manifest: manifest.clone(),
            key_count: 5,
            local_key_count: 3,
        })
        .expect("serialise");
        assert_eq!(preview["keyCount"], json!(5));
        assert_eq!(
            preview["localKeyCount"],
            json!(3),
            "the screen says '3 become 5' out of these two"
        );

        // The conflict's own field names, which the renderer reads by name.
        let conflict = serde_json::to_value(SyncConflict {
            local: Some(manifest.clone()),
            remote: manifest,
            expected_generation: 7,
        })
        .expect("serialise");
        assert_eq!(conflict["expectedGeneration"], json!(7));
        assert!(conflict.get("expected_generation").is_none());
    }

    /// Tauri arguments are **named**, so a handler whose parameter is
    /// `config` and a renderer sending `settings` typecheck on both sides and
    /// fail only at runtime. The contract pins the names; this pins the
    /// contract against the two handlers that take one.
    #[test]
    fn the_commands_that_take_an_argument_name_it_the_way_the_contract_does() {
        for declaration in [
            "readonly configure_sync: { readonly settings: SyncSettingsInput };",
            "readonly resolve_sync_conflict: { readonly resolution: ConflictResolution };",
        ] {
            assert!(
                CONTRACT.contains(declaration),
                "{declaration} is how `configure_sync(settings)` and \
                 `resolve_sync_conflict(resolution)` are reached"
            );
        }
        // And the rest take nothing, which is a decision rather than an
        // omission: both secrets come from the keyring, never the renderer.
        for name in [
            "get_sync_status",
            "test_sync_connection",
            // The picker included: it answers "which folder" and the answer
            // comes back through `configure_sync`, so it takes nothing and
            // stores nothing.
            "pick_sync_folder",
            "push_sync",
            "preview_sync_pull",
            "pull_sync",
        ] {
            assert!(
                CONTRACT.contains(&format!("readonly {name}: Record<string, never>;")),
                "{name} takes no argument on this side"
            );
        }
    }

    #[test]
    fn the_envelope_bound_is_the_one_the_contract_publishes() {
        assert!(
            CONTRACT.contains("MAX_SYNC_ENVELOPE_BYTES = 96 * 1024"),
            "two bounds is two answers to how large a vault may be"
        );
        assert_eq!(MAX_SYNC_ENVELOPE_BYTES, 96 * 1024);
        assert!(CONTRACT.contains(&format!("SYNC_PAYLOAD_FORMAT = \"{PAYLOAD_FORMAT}\"")));
        assert!(CONTRACT.contains(&format!("SYNC_PAYLOAD_VERSION = {PAYLOAD_VERSION}")));
    }

    #[tokio::test]
    async fn a_status_is_camel_case_and_flattens_the_keyring_flags_into_the_settings() {
        let device = Device::new().configured("correct-horse").await;
        let status = status(&device.config, &device.storage)
            .await
            .expect("read the status");
        let value = serde_json::to_value(&status).expect("serialise");

        assert_eq!(value["settings"]["credentialPresent"], json!(true));
        assert_eq!(value["settings"]["passphrasePresent"], json!(true));
        assert_eq!(
            value["settings"]["webdavUrl"],
            json!("https://cloud.example.test/dav")
        );
        assert_eq!(value["lastKnown"], json!(null));
        assert_eq!(
            value["autoPushMinutesRange"],
            json!({ "min": MIN_AUTO_PUSH_MINUTES, "max": MAX_AUTO_PUSH_MINUTES }),
            "the cadence field cannot advertise a range the backend will not accept"
        );
        assert!(
            CONTRACT
                .contains("autoPushMinutesRange: { readonly min: number; readonly max: number }"),
            "and the renderer reads it by that name"
        );
        assert!(
            value["deviceId"].as_str().is_some_and(|id| !id.is_empty()),
            "the screen cannot say 'this device' without one: {value}"
        );
        assert!(value
            .get("settings")
            .and_then(|s| s.get("settings"))
            .is_none());
    }

    // ── The three secret states ─────────────────────────────────────────

    #[tokio::test]
    async fn a_secret_the_renderer_does_not_send_is_left_alone() {
        let device = Device::new().configured("correct-horse").await;
        // A save of the ordinary settings, with neither secret field present.
        let status = configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "nextcloud",
                "webdavUrl": "https://cloud.example.test/dav",
                "webdavUsername": "bob",
            })),
        )
        .await
        .expect("save the settings");

        assert!(
            status.settings.credential_present && status.settings.passphrase_present,
            "a settings save must not clear the secrets it did not mention"
        );
        assert_eq!(
            device
                .storage
                .get_sync_secret("nextcloud")
                .await
                .expect("the credential is still there"),
            "app-password"
        );
        assert_eq!(
            status.settings.settings.webdav_username.as_deref(),
            Some("bob")
        );
    }

    #[tokio::test]
    async fn an_empty_secret_deletes_the_stored_one() {
        let device = Device::new().configured("correct-horse").await;
        let status = configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "nextcloud",
                "webdavUrl": "https://cloud.example.test/dav",
                "webdavUsername": "alice",
                "credential": "",
                "passphrase": "",
            })),
        )
        .await
        .expect("clear both secrets");

        assert!(!status.settings.credential_present);
        assert!(!status.settings.passphrase_present);
        assert!(matches!(
            device.storage.get_sync_secret("nextcloud").await,
            Err(StorageError::NotFound)
        ));
        assert!(matches!(
            device.storage.get_sync_secret(PASSPHRASE_SLOT).await,
            Err(StorageError::NotFound)
        ));
    }

    #[tokio::test]
    async fn any_other_value_replaces_the_stored_one_verbatim() {
        let device = Device::new().configured("correct-horse").await;
        configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "nextcloud",
                "webdavUrl": "https://cloud.example.test/dav",
                "webdavUsername": "alice",
                "credential": "second-app-password",
                "passphrase": " a passphrase with edges ",
            })),
        )
        .await
        .expect("replace both secrets");

        assert_eq!(
            device
                .storage
                .get_sync_secret("nextcloud")
                .await
                .expect("read it back"),
            "second-app-password"
        );
        assert_eq!(
            device
                .storage
                .get_sync_secret(PASSPHRASE_SLOT)
                .await
                .expect("read it back"),
            " a passphrase with edges ",
            "trimming a passphrase would lock the user out of their own blob"
        );
    }

    #[tokio::test]
    async fn a_credential_with_no_provider_is_refused_rather_than_dropped() {
        let device = Device::new();
        let refusal = configure_with(
            &device.config,
            &device.storage,
            input(json!({ "enabled": true, "credential": "app-password" })),
        )
        .await;
        assert!(
            matches!(refusal, Err(Failure::Refused(SyncError::NotConfigured))),
            "a credential with no slot to go in must not be reported as saved"
        );
        assert_eq!(
            device.stored_settings().await,
            SyncSettings::default(),
            "and the refusal happens before anything is written"
        );
    }

    #[tokio::test]
    async fn the_presence_flags_come_from_the_keyring_and_not_from_a_stored_boolean() {
        let device = Device::new().configured("correct-horse").await;
        assert!(
            status(&device.config, &device.storage)
                .await
                .expect("status")
                .settings
                .credential_present
        );

        // Revoked behind the application's back, which is what the OS keyring
        // being a separate store means in practice.
        device
            .storage
            .delete_sync_secret("nextcloud")
            .await
            .expect("delete the credential");

        let revoked = status(&device.config, &device.storage)
            .await
            .expect("status");
        assert!(
            !revoked.settings.credential_present,
            "a persisted flag is a flag that says 'connected' about a credential that is gone"
        );
        assert!(
            revoked.settings.passphrase_present,
            "and only that one changed"
        );

        // A blank value is not a credential either: `build_engine` refuses it,
        // so reporting it as present would make the screen disagree with
        // every operation.
        device
            .storage
            .store_sync_secret("nextcloud", "   ")
            .await
            .expect("store a blank credential");
        assert!(
            !status(&device.config, &device.storage)
                .await
                .expect("status")
                .settings
                .credential_present
        );
    }

    // ── The KDF parameters in the manifest ──────────────────────────────

    /// The test this feature exists for.
    ///
    /// Device A seals at an iteration count that is **not** this build's
    /// default; device B's own default is. If the pull derived its key from
    /// its own configuration rather than from the manifest it downloaded, the
    /// authentication would fail and this would come back as
    /// `wrong-passphrase` — which is exactly how this breaks in the field,
    /// silently, the first time somebody raises their iteration count.
    #[tokio::test]
    async fn a_pull_derives_its_key_from_the_manifest_and_not_from_this_build() {
        let sealed_at = EncryptionConfig::default().iterations + 20_000;
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .sealing_at(sealed_at)
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbi1jaXBoZXJ0ZXh0")
            .await;

        let pushed = manifest_of(&writer.push(&engine, "correct-horse").await);
        assert_eq!(pushed.generation, 1, "a first push starts the count");
        assert_eq!(
            pushed.iterations, sealed_at,
            "the manifest records what the envelope was actually sealed with"
        );
        assert_ne!(
            pushed.iterations,
            EncryptionConfig::default().iterations,
            "a manifest that only ever holds the default proves nothing"
        );

        let reader = Device::new().configured("correct-horse").await;
        assert!(
            reader.storage.get_encryption_settings().await.is_err(),
            "the reading device has no setting of its own, so it would use the default"
        );

        let installed = manifest_of(&reader.pull(&engine, "correct-horse").await);
        assert_eq!(installed.iterations, sealed_at);

        let keys = reader.keys().await;
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].label, "Production");
        assert_eq!(
            keys[0].encrypted_key, "bc1:cHJvZHVjdGlvbi1jaXBoZXJ0ZXh0",
            "the per-key ciphertext travels verbatim; nothing here opens one"
        );
        assert_eq!(
            keys[0].email.as_deref(),
            Some("Production@example.test"),
            "and the fields around it arrive too"
        );

        // The second pull has nothing to do, and says so rather than
        // reinstalling what is already there.
        assert!(matches!(
            reader.pull(&engine, "correct-horse").await,
            SyncOutcome::Unchanged { .. }
        ));
    }

    #[tokio::test]
    async fn a_wrong_passphrase_is_not_reported_as_corruption() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbg==")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new().configured("stable-door").await;
        let outcome = reader.pull(&engine, "stable-door").await;
        assert_eq!(
            code_of(&outcome),
            "wrong-passphrase",
            "sending the user to re-push from the other device would be the wrong advice"
        );
        assert!(
            reader.keys().await.is_empty(),
            "and a refused pull installs nothing"
        );
    }

    #[tokio::test]
    async fn bytes_that_do_not_match_the_manifest_are_corrupt_and_not_a_wrong_passphrase() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbg==")
            .await;
        writer.push(&engine, "correct-horse").await;
        engine.damage_blob();

        let reader = Device::new().configured("correct-horse").await;
        let outcome = reader.pull(&engine, "correct-horse").await;
        assert_eq!(
            code_of(&outcome),
            "corrupt",
            "the passphrase was never tested, so blaming it would be a guess"
        );
    }

    #[tokio::test]
    async fn a_blob_a_newer_build_wrote_is_refused_before_it_is_downloaded() {
        let engine = FakeEngine::default();
        let writer = Device::new().configured("correct-horse").await;
        writer.push(&engine, "correct-horse").await;
        {
            let mut stored = engine.stored.lock().expect("engine state");
            let (manifest, _) = stored.as_mut().expect("something is stored");
            manifest.payload_version = PAYLOAD_VERSION + 1;
        }

        let reader = Device::new().configured("correct-horse").await;
        assert_eq!(
            code_of(&reader.pull(&engine, "correct-horse").await),
            "payload-too-new"
        );
    }

    // ── Bounds ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_vault_too_large_to_seal_is_refused_rather_than_chunked() {
        let engine = FakeEngine::default();
        let mut device = Device::new().configured("correct-horse").await;
        // Each entry carries a keyring-sized ciphertext; forty of them is past
        // the 64 KiB one plaintext may be.
        for index in 0..40 {
            device = device
                .with_key(&format!("key-{index}"), &"A".repeat(1_800))
                .await;
        }

        let outcome = device.push(&engine, "correct-horse").await;
        assert_eq!(code_of(&outcome), "too-large");
        assert!(
            engine.manifest().is_none(),
            "a refused push must not have written half a vault"
        );
        assert_eq!(
            device.stored_settings().await.last_synced_at,
            None,
            "nor claimed a sync it did not do"
        );
    }

    // ── Conflicts ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_push_onto_a_moved_remote_is_refused_with_both_manifests() {
        let other_device = SyncManifest {
            generation: 5,
            checksum: checksum_hex(b"somebody else's envelope"),
            bytes: 24,
            written_at: at(0).to_rfc3339(),
            device_id: "device-2".to_string(),
            device_label: "Ubuntu 24.04".to_string(),
            payload_version: PAYLOAD_VERSION,
            iterations: 100_000,
            key_length: 32,
            algorithm: "AES-GCM".to_string(),
        };
        let engine =
            FakeEngine::holding(other_device.clone(), b"somebody else's envelope".to_vec());
        let device = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbg==")
            .await;

        let conflict = conflict_of(&device.push(&engine, "correct-horse").await);
        assert_eq!(conflict.remote.generation, 5);
        assert_eq!(conflict.local, None, "this device has never pushed");
        assert_eq!(conflict.expected_generation, 0);
        assert_eq!(
            engine.blob().as_deref(),
            Some(b"somebody else's envelope".as_slice()),
            "and the other device's keys are still there"
        );
    }

    #[tokio::test]
    async fn a_pull_refuses_rather_than_overwrite_keys_this_device_has_not_pushed() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Mine", "bc1:bWluZQ==")
            .await;
        let conflict = conflict_of(&reader.pull(&engine, "correct-horse").await);
        assert_eq!(
            conflict.local, None,
            "the contract's 'pulling onto a device with no local blob'"
        );
        assert_eq!(conflict.remote.generation, 1);
        let keys = reader.keys().await;
        assert_eq!(keys.len(), 1);
        assert_eq!(
            keys[0].label, "Mine",
            "a pull that silently replaced these keys is the loss this refusal exists to stop"
        );
    }

    #[tokio::test]
    async fn a_first_pull_onto_an_empty_vault_is_not_a_conflict() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new().configured("correct-horse").await;
        assert!(matches!(
            reader.pull(&engine, "correct-horse").await,
            SyncOutcome::Ok { .. }
        ));
        assert_eq!(reader.keys().await.len(), 1);
    }

    // ── The preview ─────────────────────────────────────────────────────

    /// The preview is the step that exists so that the destructive one is
    /// never the first thing a user learns from: it reports both counts, it
    /// is where a wrong passphrase surfaces, and it leaves the device exactly
    /// as it found it.
    #[tokio::test]
    async fn a_preview_reports_both_counts_and_installs_nothing() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbg==")
            .await
            .with_key("Staging", "bc1:c3RhZ2luZw==")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new().configured("stable-door").await;
        // A wrong passphrase is found here, before anything has been touched.
        let refused = reader.preview(&engine, "stable-door").await;
        match refused {
            SyncPreviewOutcome::Failed { code, .. } => assert_eq!(code, "wrong-passphrase"),
            other => panic!("expected a failed preview, got {other:?}"),
        }

        match reader.preview(&engine, "correct-horse").await {
            SyncPreviewOutcome::Ok { preview } => {
                assert_eq!(preview.key_count, 2, "what the envelope holds");
                assert_eq!(preview.local_key_count, 0, "and what it would replace");
                assert_eq!(preview.manifest.generation, 1);
            }
            other => panic!("expected a preview, got {other:?}"),
        }

        assert!(
            reader.keys().await.is_empty(),
            "a preview that installed anything is not a preview"
        );
        let preferences = read_preferences(&reader.config, &reader.storage)
            .await
            .expect("read preferences");
        assert_eq!(
            preferences.sync.unwrap_or_default().last_synced_at,
            None,
            "nor one that claims a sync happened"
        );
        assert_eq!(preferences.sync_last_manifest, None);
        assert_eq!(preferences.sync_vault_fingerprint, None);
    }

    /// Preview, then another device pushes, then confirm.
    ///
    /// The window between the two steps is real, and nothing this device
    /// stores can close it: the preview writes nothing by design, and a device
    /// with no local blob has no generation of its own to compare the remote
    /// against. So the generation the user was *shown* has to travel with the
    /// confirmation. Passed, the pull refuses; omitted, it installs a vault
    /// nobody previewed — which is what this pins, in both directions.
    #[tokio::test]
    async fn a_pull_refuses_a_remote_that_moved_since_the_preview() {
        let engine = FakeEngine::default();
        let first = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        first.push(&engine, "correct-horse").await;

        let reader = Device::new().configured("correct-horse").await;
        let previewed = match reader.preview(&engine, "correct-horse").await {
            SyncPreviewOutcome::Ok { preview } => preview,
            other => panic!("expected a preview, got {other:?}"),
        };
        assert_eq!(previewed.key_count, 1);

        // The other device adds a key and pushes again while the user is
        // still reading that preview.
        let first = first.with_key("Newer", "bc1:bmV3ZXI=").await;
        let moved = manifest_of(&first.push(&engine, "correct-horse").await);
        assert_eq!(
            moved.generation, 2,
            "the remote has moved under the preview"
        );

        let refused = reader
            .pull_expecting(
                &engine,
                "correct-horse",
                Some(previewed.manifest.generation),
            )
            .await;
        let conflict = conflict_of(&refused);
        assert_eq!(conflict.remote.generation, 2);
        assert_eq!(
            conflict.expected_generation, 1,
            "the conflict names the generation the user agreed to, not one this \
             device never saw"
        );
        assert!(
            reader.keys().await.is_empty(),
            "and the key list the user was shown a preview of is untouched"
        );

        // Without the previewed generation there is nothing to refuse against,
        // which is the gap the argument closes rather than a second opinion
        // about it.
        assert!(matches!(
            reader.pull(&engine, "correct-horse").await,
            SyncOutcome::Ok { .. }
        ));
        assert_eq!(
            reader.keys().await.len(),
            2,
            "an unguarded pull installs whatever is there now"
        );
    }

    #[tokio::test]
    async fn a_pull_that_matches_the_preview_installs_exactly_it() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new().configured("correct-horse").await;
        let previewed = match reader.preview(&engine, "correct-horse").await {
            SyncPreviewOutcome::Ok { preview } => preview,
            other => panic!("expected a preview, got {other:?}"),
        };
        let installed = manifest_of(
            &reader
                .pull_expecting(
                    &engine,
                    "correct-horse",
                    Some(previewed.manifest.generation),
                )
                .await,
        );
        assert_eq!(installed.generation, previewed.manifest.generation);
        assert_eq!(reader.keys().await.len(), previewed.key_count);
    }

    #[tokio::test]
    async fn a_preview_refuses_exactly_the_conflict_a_pull_would() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Mine", "bc1:bWluZQ==")
            .await;
        let previewed = match reader.preview(&engine, "correct-horse").await {
            SyncPreviewOutcome::Conflict { conflict } => conflict,
            other => panic!("expected a conflict, got {other:?}"),
        };
        let pulled = conflict_of(&reader.pull(&engine, "correct-horse").await);
        assert_eq!(
            serde_json::to_value(&previewed).expect("serialise"),
            serde_json::to_value(&pulled).expect("serialise"),
            "a screen that previews one conflict and then reports another is \
             worse than no preview at all"
        );
    }

    #[tokio::test]
    async fn keeping_the_remote_copies_this_devices_vault_up_before_replacing_it() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        writer.push(&engine, "correct-horse").await;

        let reader = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Mine", "bc1:bWluZQ==")
            .await;
        let outcome = reader
            .resolve(&engine, ConflictResolution::KeepRemote, "correct-horse")
            .await
            .expect("resolve");
        assert!(matches!(outcome, SyncOutcome::Ok { .. }));

        assert_eq!(
            engine.archive_suffixes(),
            vec!["20260101T120200Z-local".to_string()],
            "the discarded side is named for when it was kept and which side it was"
        );
        let (archived, described) = engine.only_archive();
        assert!(
            described.describes(&archived),
            "an archive whose manifest does not describe it is an archive nobody can open"
        );
        assert_eq!(
            described.iterations,
            EncryptionConfig::default().iterations,
            "and it records the parameters it was sealed under, which is the \
             only thing that can open it later"
        );

        let keys = reader.keys().await;
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].label, "Theirs", "and the chosen side is installed");
    }

    #[tokio::test]
    async fn keeping_local_copies_the_remote_up_before_overwriting_it() {
        let engine = FakeEngine::default();
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        writer.push(&engine, "correct-horse").await;
        let overwritten = engine.blob().expect("the remote blob");

        let reader = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Mine", "bc1:bWluZQ==")
            .await;
        let outcome = reader
            .resolve(&engine, ConflictResolution::KeepLocal, "correct-horse")
            .await
            .expect("resolve");
        let manifest = manifest_of(&outcome);
        assert_eq!(
            manifest.generation, 2,
            "the kept side lands on top of the generation it replaced"
        );

        assert_eq!(
            engine.archive_suffixes(),
            vec!["20260101T120200Z-remote".to_string()]
        );
        let (archived, described) = engine.only_archive();
        assert_eq!(
            archived, overwritten,
            "the bytes that were replaced, kept verbatim"
        );
        assert_eq!(
            described.generation, 1,
            "under the manifest the remote actually had, so the copy is openable"
        );
        assert_ne!(
            engine.blob().expect("the new remote blob"),
            overwritten,
            "and this device's vault is what is stored now"
        );
    }

    #[tokio::test]
    async fn a_resolution_that_cannot_copy_the_discarded_side_discards_nothing() {
        let writer = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Theirs", "bc1:dGhlaXJz")
            .await;
        let mut engine = FakeEngine::default();
        writer.push(&engine, "correct-horse").await;
        let before = engine.blob().expect("the remote blob");
        engine.refuse_archive = true;

        let reader = Device::new()
            .configured("correct-horse")
            .await
            .with_key("Mine", "bc1:bWluZQ==")
            .await;
        let refusal = reader
            .resolve(&engine, ConflictResolution::KeepLocal, "correct-horse")
            .await;
        assert!(matches!(
            refusal,
            Err(Failure::Refused(SyncError::Provider(_)))
        ));
        assert_eq!(
            engine.blob().expect("the remote blob"),
            before,
            "'I picked wrong' must not be the end of someone's keys, so a side \
             that could not be copied is a side that is not discarded"
        );

        let reader_keys = reader.keys().await;
        assert_eq!(reader_keys.len(), 1);
        assert_eq!(reader_keys[0].label, "Mine");
    }

    // ── What is not configured ──────────────────────────────────────────

    #[tokio::test]
    async fn an_unconfigured_device_refuses_every_network_command_by_code() {
        let device = Device::new();
        assert_eq!(
            code_of(&settle(push(&device.config, &device.storage, at(0)).await).expect("outcome")),
            "not-configured"
        );
        assert_eq!(
            code_of(
                &settle(pull(&device.config, &device.storage, None, at(0)).await).expect("outcome")
            ),
            "not-configured"
        );

        // Configured, with a credential, and no passphrase: a different
        // refusal, because it sends the user to a different field.
        let device = Device::new();
        configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "nextcloud",
                "webdavUrl": "https://cloud.example.test/dav",
                "webdavUsername": "alice",
                "credential": "app-password",
            })),
        )
        .await
        .expect("configure without a passphrase");
        assert_eq!(
            code_of(&settle(push(&device.config, &device.storage, at(0)).await).expect("outcome")),
            "no-passphrase"
        );
    }

    #[tokio::test]
    async fn a_pull_with_nothing_stored_says_so_rather_than_failing_obscurely() {
        let engine = FakeEngine::default();
        let device = Device::new().configured("correct-horse").await;
        assert_eq!(
            code_of(&device.pull(&engine, "correct-horse").await),
            "no-remote-blob"
        );
    }

    // ── This device ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn the_device_id_is_minted_once_and_then_reused() {
        let device = Device::new();
        let first = device.state().await.device_id;
        assert!(!first.is_empty());
        assert_eq!(
            device.state().await.device_id,
            first,
            "an id that changed between two pushes would make every manifest's \
             deviceId describe a device that does not exist"
        );
        assert_eq!(
            read_preferences(&device.config, &device.storage)
                .await
                .expect("read preferences")
                .sync_device_id
                .as_deref(),
            Some(first.as_str()),
            "and it is persisted rather than held in memory"
        );
    }

    #[test]
    fn the_device_label_is_coarse_and_bounded() {
        let label = device_label();
        assert!(!label.is_empty());
        assert!(label.len() <= MAX_DEVICE_LABEL_BYTES);
        for identifying in ["/home/", "/Users/", ":\\Users\\"] {
            assert!(
                !label.contains(identifying),
                "{identifying:?} reached a field that sits unencrypted in \
                 someone else's storage: {label}"
            );
        }
    }

    #[test]
    fn a_key_survives_the_round_trip_through_the_payload_field_for_field() {
        let key = ApiKey {
            id: "key_1".to_string(),
            label: "Production".to_string(),
            email: Some("ops@example.test".to_string()),
            encrypted_key: "bc1:c2VhbGVk".to_string(),
            iterations: 320_000,
            key_length: 32,
            algorithm: "AES-GCM".to_string(),
        };
        let back = api_key(vault_entry(key.clone()));
        assert_eq!(
            serde_json::to_value(&back).expect("serialise"),
            serde_json::to_value(&key).expect("serialise"),
            "a field that swaps places here is a key that comes back wrong"
        );
    }

    #[test]
    fn a_fingerprint_tells_an_empty_vault_from_a_changed_one() {
        let entry = |label: &str| VaultEntry {
            id: "key_1".to_string(),
            label: label.to_string(),
            email: None,
            encrypted_key: "bc1:c2VhbGVk".to_string(),
            iterations: 100_000,
            key_length: 32,
            algorithm: "AES-GCM".to_string(),
        };
        assert_ne!(vault_fingerprint(&[]), vault_fingerprint(&[entry("a")]));
        assert_ne!(
            vault_fingerprint(&[entry("a")]),
            vault_fingerprint(&[entry("b")]),
            "a relabelled key is a changed vault"
        );
        assert_eq!(
            vault_fingerprint(&[entry("a")]),
            vault_fingerprint(&[entry("a")])
        );
        assert_ne!(
            vault_fingerprint(&[]),
            checksum_hex(b""),
            "the hash of nothing must not be the hash of an empty vault"
        );
    }

    #[test]
    fn only_the_provider_that_authenticates_has_a_slot_to_store_one_in() {
        assert_eq!(SyncProvider::Nextcloud.credential_slot(), Some("nextcloud"));
        assert!(SyncProvider::Nextcloud.needs_credential());
        // The `None` every call site in this module branches on. A slot name
        // for a folder would be a slot nothing ever reads, and
        // `credential_present` would become a question with no meaning.
        assert_eq!(SyncProvider::Folder.credential_slot(), None);
        assert!(!SyncProvider::Folder.needs_credential());
    }

    // ── A folder authenticates with nothing ─────────────────────────────

    #[tokio::test]
    async fn configuring_a_folder_stores_its_path_and_no_credential() {
        let folder = TestDir::new();
        let device = Device::new().using_folder(&folder.0, "correct-horse").await;

        let status = status(&device.config, &device.storage)
            .await
            .expect("read the status");
        assert_eq!(
            status.settings.settings.folder_path.as_deref(),
            folder.0.to_str(),
            "a sync target the user cannot read back is one they cannot verify"
        );
        assert_eq!(
            device.stored_settings().await.folder_path.as_deref(),
            folder.0.to_str(),
            "and it is a plain preference, so it survives a re-read"
        );
        assert!(
            !status.settings.credential_present,
            "nothing is stored, because nothing is wanted: the screen tells \
             that apart from 'not set up' through providerNeedsCredential"
        );
        assert!(
            status.settings.passphrase_present,
            "the passphrase seals the payload rather than the connection, so a \
             folder needs one exactly as much as Nextcloud does"
        );
        assert_eq!(
            device
                .storage
                .get_sync_secret(PASSPHRASE_SLOT)
                .await
                .expect("read it back"),
            "correct-horse"
        );
    }

    /// A credential arriving for a folder is dropped, not filed somewhere.
    ///
    /// The renderer keeps one credential field, for the provider that has one,
    /// and a stale value in it must not refuse a legitimate save. What must not
    /// happen is the value landing in *some* slot: a secret written where
    /// nothing reads it is a secret in the keyring that the screen cannot show,
    /// cannot clear and will not use.
    #[tokio::test]
    async fn a_credential_sent_for_a_folder_is_ignored_rather_than_stored() {
        let folder = TestDir::new();
        let device = Device::new();
        let status = configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "folder",
                "folderPath": folder.0.to_str().expect("a utf-8 test path"),
                "credential": "an app password the folder has no use for",
                "passphrase": "correct-horse",
            })),
        )
        .await
        .expect("a folder save is valid even with a credential in the input");

        assert!(!status.settings.credential_present);
        // There is only one credential slot in existence, and the two names a
        // `None` slot could plausibly have been spelled as.
        for slot in ["nextcloud", "folder", "local-folder"] {
            assert!(
                matches!(
                    device.storage.get_sync_secret(slot).await,
                    Err(StorageError::NotFound)
                ),
                "a credential reached the {slot:?} slot, which nothing reads"
            );
        }
        assert!(
            status.settings.passphrase_present,
            "and the shared secret is"
        );
    }

    #[tokio::test]
    async fn switching_to_a_folder_leaves_the_nextcloud_credential_where_it_was() {
        let folder = TestDir::new();
        let device = Device::new().configured("correct-horse").await;
        let status = configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "folder",
                "folderPath": folder.0.to_str().expect("a utf-8 test path"),
            })),
        )
        .await
        .expect("switch provider");

        assert!(!status.settings.credential_present, "for this provider");
        assert_eq!(
            device
                .storage
                .get_sync_secret("nextcloud")
                .await
                .expect("the Nextcloud credential is untouched"),
            "app-password",
            "switching back must find it there rather than ask for it again"
        );
    }

    /// The test that proves the `Option` reaches the operations.
    ///
    /// This drives the real [`build_engine`] and the real `FolderEngine`
    /// through one directory, with **nothing in any credential slot**. A
    /// `credential` that still demanded one would refuse both halves with
    /// `not-configured`, which is precisely the defect that cannot be seen from
    /// a `credential_slot()` unit test.
    #[tokio::test]
    async fn a_folder_pushes_and_pulls_with_no_credential_in_the_keyring() {
        let shared = TestDir::new();
        let writer = Device::new()
            .using_folder(&shared.0, "correct-horse")
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbg==")
            .await;
        assert!(
            matches!(
                writer.storage.get_sync_secret("nextcloud").await,
                Err(StorageError::NotFound)
            ),
            "the premise: this device has no credential anywhere"
        );

        let pushed = manifest_of(
            &settle(push(&writer.config, &writer.storage, at(0)).await).expect("outcome"),
        );
        assert_eq!(pushed.generation, 1);
        assert!(
            shared.0.join(bc_sync::SYNC_BLOB_NAME).exists()
                && shared.0.join(bc_sync::SYNC_MANIFEST_NAME).exists(),
            "both objects land in the folder the user chose"
        );

        let reader = Device::new().using_folder(&shared.0, "correct-horse").await;
        let installed = manifest_of(
            &settle(pull(&reader.config, &reader.storage, None, at(1)).await).expect("outcome"),
        );
        assert_eq!(installed.generation, 1);
        let keys = reader.keys().await;
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].label, "Production");
        assert_eq!(keys[0].encrypted_key, "bc1:cHJvZHVjdGlvbg==");
    }

    /// The engine's rule, asserted from the layer that must not soften it.
    ///
    /// A missing folder is almost always an unmounted share or an unplugged
    /// disk. Creating it would write the vault into a directory shadowing the
    /// mount point: the push would report success, the user's sync client would
    /// never see the bytes, and the mount returning would hide them again. So
    /// the answer is `unreachable`, and nothing in this layer calls
    /// `create_dir_all` to be helpful.
    #[tokio::test]
    async fn a_folder_that_has_vanished_is_unreachable_and_is_not_created() {
        let parent = TestDir::new();
        let unmounted = parent.0.join("unmounted-share");
        let device = Device::new()
            .using_folder(&unmounted, "correct-horse")
            .await
            .with_key("Production", "bc1:cHJvZHVjdGlvbg==")
            .await;

        let outcome = settle(push(&device.config, &device.storage, at(0)).await).expect("outcome");
        assert_eq!(code_of(&outcome), "unreachable");
        assert!(
            !unmounted.exists(),
            "recreating a vanished mount writes the vault where the sync \
             client will never look"
        );
        assert_eq!(
            device.stored_settings().await.last_synced_at,
            None,
            "and nothing claims a sync that did not happen"
        );
    }

    /// A folder provider with nothing usable to point at is `not-configured`,
    /// not `unreachable`: there is no target to have been unreachable. The
    /// relative path is the engine's own refusal, surfacing unsoftened — it
    /// would otherwise resolve against whatever directory the launcher started
    /// the app in.
    #[tokio::test]
    async fn a_folder_with_no_usable_path_is_not_configured() {
        let device = Device::new();
        configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "folder",
                "passphrase": "correct-horse",
            })),
        )
        .await
        .expect("save a half-configured folder");
        assert_eq!(
            code_of(&settle(push(&device.config, &device.storage, at(0)).await).expect("outcome")),
            "not-configured"
        );

        configure_with(
            &device.config,
            &device.storage,
            input(json!({
                "enabled": true,
                "provider": "folder",
                "folderPath": "vault",
                "passphrase": "correct-horse",
            })),
        )
        .await
        .expect("save a relative path");
        assert_eq!(
            code_of(&settle(push(&device.config, &device.storage, at(0)).await).expect("outcome")),
            "not-configured"
        );
    }

    // ── pick_sync_folder ────────────────────────────────────────────────

    #[test]
    fn a_picked_path_travels_as_text_and_one_that_cannot_is_an_error() {
        #[cfg(windows)]
        let chosen = Path::new(r"C:\Users\alice\Nextcloud\better-cloudflare");
        #[cfg(not(windows))]
        let chosen = Path::new("/home/alice/Nextcloud/better-cloudflare");
        assert_eq!(
            picked_path(chosen).expect("a path the settings object can carry"),
            chosen.to_str().expect("utf-8"),
            "verbatim: the user reads this back to check where their vault goes"
        );

        // A path `Preferences` could not carry. An error rather than `None`,
        // which would tell the renderer the user pressed Cancel, and rather
        // than a lossy conversion, which would store a path naming nothing and
        // report `unreachable` for a folder sitting right there.
        #[cfg(windows)]
        let unstorable = {
            use std::os::windows::ffi::OsStringExt;
            // An unpaired surrogate: a legal Windows filename, not UTF-8.
            std::path::PathBuf::from(std::ffi::OsString::from_wide(&[
                0x0043, 0x003A, 0x005C, 0xD800,
            ]))
        };
        #[cfg(not(windows))]
        let unstorable = {
            use std::os::unix::ffi::OsStringExt;
            std::path::PathBuf::from(std::ffi::OsString::from_vec(vec![b'/', 0xFF]))
        };
        assert!(picked_path(&unstorable).is_err());
    }
}
