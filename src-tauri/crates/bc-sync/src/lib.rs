//! Cloud sync for the API key vault.
//!
//! The renderer's half of this is `src/lib/sync/types.ts`, and **that file is
//! the contract**: every shape here is one of its types, spelled the way it
//! spells them. Read its header before this one — it explains why the payload
//! is sealed a second time, why there is no Google sign-in button, and why a
//! divergent remote is refused rather than merged. Those are the three
//! decisions this crate exists to implement, and none of them is obvious from
//! the code alone.
//!
//! # What this crate does and does not hold
//!
//! It holds the wire: two engines behind [`SyncEngine`], the payload format,
//! and the generation guard. It holds **no secrets and no keyring access** —
//! both the provider credential and the sync passphrase are fetched by the
//! command layer (`src-tauri/src/commands/sync.rs`) and passed in. That keeps
//! this crate testable against a local socket without a keyring, and it means
//! a reader asking "where do the secrets come from" has one place to look
//! rather than two.
//!
//! It also does no encryption. The command layer seals the payload with
//! `bc_crypto::CryptoManager` before handing it over, so what reaches an
//! engine is already an opaque envelope. An engine that cannot see plaintext
//! cannot leak it.
//!
//! # The generation guard
//!
//! Every write is conditional on the generation the caller believed it was
//! replacing. The two providers offer different machinery for that — WebDAV
//! has `If-Match` against an ETag, Drive has no usable precondition on
//! `appDataFolder` uploads — so [`SyncEngine::put`] takes the expected
//! generation and each engine implements the guard with whatever its provider
//! gives it, re-reading the manifest where it must. The guard is not optional
//! and not best-effort: an unguarded write to a credential store is how one
//! device's keys vanish.

pub mod gdrive;
pub mod payload;
pub mod settings;
pub mod webdav;

pub use gdrive::GoogleDriveEngine;
pub use payload::{
    checksum_hex, SyncManifest, SyncPayload, VaultEntry, MAX_SYNC_ENVELOPE_BYTES, PAYLOAD_FORMAT,
    PAYLOAD_VERSION, SYNC_BLOB_NAME, SYNC_MANIFEST_NAME,
};
pub use settings::{
    SyncProvider, SyncSettings, SyncSettingsView, MAX_AUTO_PUSH_MINUTES, MIN_AUTO_PUSH_MINUTES,
    PASSPHRASE_SLOT, SETTINGS_VERSION,
};
pub use webdav::WebDavEngine;

/// Why an operation did not happen.
///
/// Each variant maps to exactly one `SyncFailureCode` in
/// `src/lib/sync/types.ts` through [`SyncError::code`], and
/// `tests::failure_codes_match_the_contract` pins that mapping against the
/// TypeScript file itself. Prose never crosses the boundary: this process has
/// no locale, so a translated sentence built here is a sentence that can only
/// be English.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("sync is not configured")]
    NotConfigured,
    #[error("no sync passphrase has been set")]
    NoPassphrase,
    #[error("the provider rejected the credential")]
    Unauthorised,
    /// Never reached the endpoint: DNS, TLS, timeout, refused connection.
    #[error("could not reach the provider: {0}")]
    Unreachable(String),
    /// Reached it, and it answered with something unusable.
    #[error("the provider returned an error: {0}")]
    Provider(String),
    #[error("nothing has been pushed yet")]
    NoRemoteBlob,
    #[error("the stored vault was written by a newer version of this app")]
    PayloadTooNew,
    #[error("the stored vault is corrupt")]
    Corrupt,
    #[error("the passphrase did not open the stored vault")]
    WrongPassphrase,
    #[error("the vault is too large to sync")]
    TooLarge,
}

impl SyncError {
    /// The `SyncFailureCode` the renderer words.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "not-configured",
            Self::NoPassphrase => "no-passphrase",
            Self::Unauthorised => "unauthorised",
            Self::Unreachable(_) => "unreachable",
            Self::Provider(_) => "provider-error",
            Self::NoRemoteBlob => "no-remote-blob",
            Self::PayloadTooNew => "payload-too-new",
            Self::Corrupt => "corrupt",
            Self::WrongPassphrase => "wrong-passphrase",
            Self::TooLarge => "too-large",
        }
    }

    /// The provider's own words, where there were any, for the `message`
    /// field of a failed `SyncOutcome`. `None` for the variants whose cause is
    /// fully described by the code: adding an English sentence there would put
    /// untranslatable text on screen next to a translated one.
    pub fn provider_message(&self) -> Option<String> {
        match self {
            Self::Unreachable(detail) | Self::Provider(detail) => Some(detail.clone()),
            _ => None,
        }
    }

    /// Classify a `reqwest` failure.
    ///
    /// Transport failures and HTTP statuses are different things and get
    /// different codes, because "your Nextcloud is unreachable" and "your
    /// Nextcloud said no" send the user to different places.
    pub fn from_request(error: reqwest::Error) -> Self {
        if let Some(status) = error.status() {
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                return Self::Unauthorised;
            }
            return Self::Provider(format!("HTTP {}", status.as_u16()));
        }
        Self::Unreachable(error.to_string())
    }

    /// Classify an HTTP status from a response this crate read itself.
    pub fn from_status(status: reqwest::StatusCode) -> Self {
        match status {
            reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
                Self::Unauthorised
            }
            reqwest::StatusCode::NOT_FOUND => Self::NoRemoteBlob,
            other => Self::Provider(format!("HTTP {}", other.as_u16())),
        }
    }
}

/// What a `put` must prove it is not clobbering.
///
/// `None` means "there must be nothing there" — the first push from a fresh
/// install. `Some(n)` means "the remote must still be at generation `n`".
/// Either way the engine refuses rather than overwrites, and reports the
/// remote's actual manifest so the caller can describe the conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerationGuard(pub Option<u64>);

/// A `put` that the guard refused. Nothing was written.
#[derive(Debug)]
pub struct GuardRefused {
    /// What the remote actually holds now.
    pub remote: SyncManifest,
}

/// The outcome of a guarded write.
#[derive(Debug)]
pub enum PutOutcome {
    Written,
    Refused(GuardRefused),
}

/// One cloud backend.
///
/// Mirrors `bc_registrar::RegistrarClient`: an `async_trait` with a factory
/// that hands back a boxed implementation, so the command layer never matches
/// on the provider and a third engine is one file plus one arm.
#[async_trait::async_trait]
pub trait SyncEngine: Send + Sync {
    /// Reach the endpoint and confirm the credential works, writing nothing.
    ///
    /// Must be safe to call against a configured-but-never-pushed account:
    /// an absent blob is a successful probe, not a failure.
    async fn probe(&self) -> Result<(), SyncError>;

    /// Read the manifest beside the blob. `None` when nothing is stored.
    async fn fetch_manifest(&self) -> Result<Option<SyncManifest>, SyncError>;

    /// Read the sealed blob. [`SyncError::NoRemoteBlob`] when absent.
    async fn fetch_blob(&self) -> Result<Vec<u8>, SyncError>;

    /// Write blob and manifest, but only if `guard` still holds.
    ///
    /// Implementations re-check the guard as close to the write as their
    /// provider allows and report [`PutOutcome::Refused`] rather than
    /// overwriting. A race that slips through the check is a lost API key, so
    /// prefer the provider's own precondition (an ETag, a revision) over a
    /// read-then-write wherever one exists.
    async fn put(
        &self,
        blob: &[u8],
        manifest: &SyncManifest,
        guard: GenerationGuard,
    ) -> Result<PutOutcome, SyncError>;

    /// Keep a timestamped copy of a blob that is about to be replaced.
    ///
    /// Called before a conflict resolution discards a side. Unguarded and
    /// additive by design: the names are new on every call, so there is
    /// nothing for a guard to protect, and an archive write that failed a
    /// precondition would strand the user with neither side kept.
    ///
    /// # The manifest travels with it, and has to
    ///
    /// A sealed envelope does not record its own iteration count — that is the
    /// whole reason [`SyncManifest`] carries `iterations`, `key_length` and
    /// `algorithm`. So archiving the bytes alone produces a file nobody can
    /// ever open, which defeats the entire purpose of keeping it: the archive
    /// exists so that "I picked the wrong side" is recoverable.
    ///
    /// Implementations therefore write **two** objects and write the blob
    /// *first*. A manifest that landed without its blob would describe bytes
    /// that are not there; a blob without its manifest is at least still
    /// openable by hand from a sibling archive's parameters. Either failure
    /// returns `Err`, and the caller must not discard a side until this
    /// returns `Ok`.
    async fn archive(
        &self,
        suffix: &str,
        blob: &[u8],
        manifest: &SyncManifest,
    ) -> Result<(), SyncError>;
}

/// Build the engine a settings object names.
///
/// The credential comes from the keyring and is passed in; see the module
/// header for why this crate never reads it itself.
pub fn build_engine(
    settings: &SyncSettings,
    credential: &str,
) -> Result<Box<dyn SyncEngine>, SyncError> {
    match settings.provider.ok_or(SyncError::NotConfigured)? {
        SyncProvider::Nextcloud => {
            let url = settings
                .webdav_url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or(SyncError::NotConfigured)?;
            let username = settings
                .webdav_username
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or(SyncError::NotConfigured)?;
            Ok(Box::new(WebDavEngine::new(url, username, credential)?))
        }
        SyncProvider::GoogleDrive => Ok(Box::new(GoogleDriveEngine::new(credential)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The failure codes are a cross-boundary contract, so they are pinned
    /// against the file that declares them rather than against a second list
    /// here. A code renamed on one side and not the other is the kind of
    /// defect that typechecks on both and only shows up as an untranslated
    /// error on someone's screen.
    #[test]
    fn failure_codes_match_the_contract() {
        let contract = include_str!("../../../../src/lib/sync/types.ts");
        for error in [
            SyncError::NotConfigured,
            SyncError::NoPassphrase,
            SyncError::Unauthorised,
            SyncError::Unreachable(String::new()),
            SyncError::Provider(String::new()),
            SyncError::NoRemoteBlob,
            SyncError::PayloadTooNew,
            SyncError::Corrupt,
            SyncError::WrongPassphrase,
            SyncError::TooLarge,
        ] {
            let code = error.code();
            assert!(
                contract.contains(&format!("\"{code}\"")),
                "SyncFailureCode {code} is missing from src/lib/sync/types.ts"
            );
        }
    }

    #[test]
    fn only_transport_and_provider_errors_carry_a_message() {
        assert_eq!(
            SyncError::Unreachable("dns".into())
                .provider_message()
                .as_deref(),
            Some("dns")
        );
        assert_eq!(
            SyncError::Provider("HTTP 500".into())
                .provider_message()
                .as_deref(),
            Some("HTTP 500")
        );
        assert!(SyncError::Unauthorised.provider_message().is_none());
        assert!(SyncError::WrongPassphrase.provider_message().is_none());
    }

    #[test]
    fn a_missing_blob_is_not_a_provider_error() {
        assert!(matches!(
            SyncError::from_status(reqwest::StatusCode::NOT_FOUND),
            SyncError::NoRemoteBlob
        ));
        assert!(matches!(
            SyncError::from_status(reqwest::StatusCode::UNAUTHORIZED),
            SyncError::Unauthorised
        ));
        assert!(matches!(
            SyncError::from_status(reqwest::StatusCode::FORBIDDEN),
            SyncError::Unauthorised
        ));
    }

    #[test]
    fn an_engine_needs_a_url_and_a_username() {
        let mut settings = SyncSettings {
            provider: Some(SyncProvider::Nextcloud),
            ..SyncSettings::default()
        };
        assert!(build_engine(&settings, "secret").is_err());

        settings.webdav_url = Some("https://cloud.example.test/dav".into());
        assert!(build_engine(&settings, "secret").is_err());

        // Whitespace is not a username; the filter exists so that a cleared
        // field in the UI cannot arrive as a configured-looking empty string.
        settings.webdav_username = Some("   ".into());
        assert!(build_engine(&settings, "secret").is_err());

        settings.webdav_username = Some("alice".into());
        assert!(build_engine(&settings, "secret").is_ok());
    }

    #[test]
    fn no_provider_is_not_configured() {
        let settings = SyncSettings::default();
        assert!(matches!(
            build_engine(&settings, "secret"),
            Err(SyncError::NotConfigured)
        ));
    }
}
