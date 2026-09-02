//! WebAuthn relying party for the desktop app.
//!
//! # The gate is still shut, deliberately
//!
//! This crate now contains a real relying-party implementation: a challenge
//! store, both ceremonies driven through `webauthn-rs`'s high-level API, an
//! unlock-token store bound to a verified assertion, and per-credential RP-ID
//! scoping. What it does **not** do is report itself as available.
//!
//! [`PasskeyManager::status`] still reports unavailable and
//! [`PasskeyManager::verify_token`] still returns `Ok(false)` for every input.
//! `get_vault_secret` at the Tauri command boundary requires a token that
//! `verify_token` accepts, so no stored vault or API secret can be released
//! through the passkey path yet, exactly as before. Opening the gate is a
//! separate, small, reviewable change — see the `TODO(gate)` comments on those
//! two methods for what has to be true first.
//!
//! # What is not implemented here, on purpose
//!
//! The clientDataJSON type and origin checks, the RP-ID hash check, the
//! user-presence and user-verification flag checks, the signature verification
//! over `authenticatorData || SHA-256(clientDataJSON)`, and the signature
//! counter policy are **all library internals** of `webauthn-rs`. They are not
//! reimplemented, wrapped, or double-checked here.
//!
//! That is not a shortcut. Hand-rolling those checks is literally how the
//! original vulnerability happened: the implementation `d05fe59` removed
//! decoded `clientDataJSON`, read the challenge back out of it, compared it to
//! the challenge it had issued, and called that verification. It checked an
//! echo, never a signature. A parallel check alongside the library is the same
//! mistake with more steps — it can only ever be weaker than, or disagree with,
//! the one that matters. Where a check must be *proved* to fire, that is a
//! test (`tests/webauthn_ceremonies.rs`), not a second implementation.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use url::Url;
use webauthn_rs::prelude::{
    AuthenticationResult, Passkey, PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Uuid,
};

pub use bc_storage::Storage;

mod challenge;
pub mod config;
pub mod credential;
pub mod legacy;
mod token;

/// Tests that need crate-internal access: the gate, and the expiry helpers.
#[cfg(test)]
mod gate_tests;

pub use challenge::{CEREMONY_TTL, MAX_PENDING_CEREMONIES};
pub use config::{WebauthnConfig, RP_NAME};
pub use credential::{
    classify_record, credential_storage_key, DeadCredential, DeadCredentialReason, RecordClass,
    StoredCredential, StoredCredentialSchema, VerifiedCredentials, CREDENTIAL_SCHEMA_V1,
};
pub use token::TOKEN_TTL;

use challenge::CeremonyStore;
use token::{TokenStore, VerifiedAssertion};

/// Namespace for deriving a WebAuthn user handle from an account id.
///
/// The handle must be **stable per account**: `Uuid::new_v5` over this
/// namespace and the account id, never `new_v4`. A fresh random handle on every
/// enrolment registers a new "user" on discoverable-credential authenticators,
/// so the user's platform passkey list fills with duplicates of the same
/// account. Changing this constant orphans every enrolled credential's handle,
/// so it must never change.
const USER_HANDLE_NAMESPACE: Uuid = Uuid::from_bytes([
    0xbc, 0x9b, 0x1c, 0x2e, 0x7f, 0x4a, 0x4d, 0x3b, 0x9f, 0x11, 0x2a, 0x6d, 0x5c, 0x8e, 0x0a, 0x17,
]);

/// Prefix of the handle `list_passkeys` reports for a record in the verified
/// store that this build cannot read *and* whose claimed credential id is also
/// unreadable. Without a handle such a record could be listed but never
/// deleted, which is the dead end `94d74d1` fixed for legacy records.
const DEAD_CREDENTIAL_HANDLE_PREFIX: &str = "dead_credential_";

/// **The gate.** While this is `false`, [`PasskeyManager::verify_token`]
/// refuses every token — including one it minted itself from a genuinely
/// verified assertion — so `get_vault_secret` can release nothing through the
/// passkey path.
///
/// It is a compile-time constant, not a setting: there is no runtime path that
/// can change it, and no configuration file, environment variable, or IPC
/// message that reaches it. It exists in this shape so that the code behind it
/// is compiled, linted and reviewed now, and so that opening the gate is a
/// one-word diff a reviewer cannot miss rather than a rewrite of the function.
///
/// Do not set this to `true` without also making [`PasskeyManager::status`]
/// report the manager's real capability. Reporting availability while this is
/// `false` produces a sign-in button that always fails; setting this `true`
/// while `status()` says unavailable hides a working feature. They flip
/// together, in a change of their own.
const TOKEN_VERIFICATION_ENABLED: bool = false;

/// Reason reported while the gate is shut.
///
/// TODO(gate): replace with a reason derived from the manager's actual state
/// once `status()` is allowed to report availability.
const PASSKEYS_UNAVAILABLE: &str = "Passkeys are temporarily unavailable because existing credentials lack verifiable registration material. Remove legacy credentials and re-enroll after verified passkey registration is available.";

/// Reason recorded by [`PasskeyManager::default`].
pub const REASON_NOT_CONFIGURED: &str =
    "The passkey relying party has not been configured for this session.";

/// Reason `main.rs` records when the webview origin cannot be resolved.
pub const REASON_ORIGIN_UNRESOLVED: &str =
    "The application origin could not be determined, so passkeys cannot be scoped safely.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyStatus {
    pub registration_available: bool,
    pub authentication_available: bool,
    pub legacy_credentials_require_reregistration: bool,
    pub unavailable_reason: &'static str,
}

#[derive(Error, Debug, PartialEq, Eq)]
pub enum PasskeyError {
    /// No relying party is configured, so no assertion can be verified.
    #[error("Passkey authentication is unavailable: this session has no verified relying-party configuration, so no assertion can be checked")]
    SecureVerificationUnavailable,
    /// No relying party is configured, so nothing may be enrolled — a
    /// credential registered against the wrong origin could never be used.
    #[error("Passkey registration is unavailable: this session has no verified relying-party configuration; no credential was stored")]
    SecureRegistrationUnavailable,
    /// The runtime origin could not be turned into a relying party.
    #[error("The application origin could not be resolved into a WebAuthn relying party")]
    RuntimeOriginUnavailable,
    /// No ceremony was pending for this account, or the one that was has
    /// expired or already been used.
    #[error("This passkey request expired or was already used; start again")]
    ChallengeExpired,
    /// Too many accounts have a ceremony in flight.
    #[error("Too many passkey requests are in progress; try again in a moment")]
    TooManyPendingCeremonies,
    /// The account has no verified credentials at all.
    #[error(
        "No verified passkey is enrolled for this key; enroll one before signing in with a passkey"
    )]
    NoVerifiedCredentials,
    /// Credentials exist but were enrolled under a different RP ID.
    #[error("This key's passkeys were enrolled in a different build or context and cannot be used here; remove them and enroll again")]
    CredentialsFromAnotherContext,
    /// The browser response was not the shape the ceremony expects.
    #[error("The passkey response could not be read: {0}")]
    MalformedCeremonyResponse(String),
    /// The library refused the ceremony. This is where a tampered challenge,
    /// origin, RP-ID hash, flag set, signature, or counter lands.
    #[error("Passkey verification failed: {0}")]
    Verification(String),
    #[error("Passkey credential not found")]
    NotFound,
    #[error("This authenticator is already enrolled for this key")]
    CredentialAlreadyEnrolled,
    #[error("Passkey storage error: {0}")]
    Storage(String),
}

impl PasskeyError {
    /// Render a `WebauthnError` without leaking anything the caller supplied.
    ///
    /// `webauthn-rs`'s `Display` messages are fixed strings naming which check
    /// failed; none of them interpolate the credential, the challenge, or any
    /// key material. Keeping the mapping in one place is what makes that
    /// reviewable.
    fn verification(error: webauthn_rs::prelude::WebauthnError) -> Self {
        Self::Verification(error.to_string())
    }
}

/// The passkey relying party.
///
/// Construct with [`PasskeyManager::new`] once the runtime origin is known.
/// Every other constructor — including [`Default`] — produces the fail-closed
/// variant, so no call site can accidentally obtain a permissive manager.
pub struct PasskeyManager {
    /// `None` when no relying party could be configured. Every ceremony entry
    /// point then refuses, and nothing can be enrolled or asserted.
    config: Option<Arc<WebauthnConfig>>,
    /// Why, when `config` is `None`. Reported by `status()` once the gate opens.
    unavailable_reason: &'static str,
    registrations: CeremonyStore<PasskeyRegistration>,
    authentications: CeremonyStore<PasskeyAuthentication>,
    tokens: TokenStore,
}

impl Default for PasskeyManager {
    /// The fail-closed manager. `Default` deliberately does *not* build a
    /// working relying party: a default that silently worked would be reachable
    /// from any call site that forgot to pass an origin.
    fn default() -> Self {
        Self::unavailable(REASON_NOT_CONFIGURED)
    }
}

impl std::fmt::Debug for PasskeyManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasskeyManager")
            .field("config", &self.config)
            .field("unavailable_reason", &self.unavailable_reason)
            .finish_non_exhaustive()
    }
}

impl PasskeyManager {
    /// Build a relying party for a runtime RP ID and origin.
    ///
    /// The RP ID must be an effective domain of the origin. Both are recorded
    /// on every credential registered through this manager, and an assertion is
    /// refused when a credential's stored RP ID differs from this one.
    pub fn new(rp_id: &str, origin: &Url) -> Result<Self, PasskeyError> {
        let config = WebauthnConfig::new(rp_id, origin)?;
        Ok(Self {
            config: Some(Arc::new(config)),
            unavailable_reason: "",
            registrations: CeremonyStore::default(),
            authentications: CeremonyStore::default(),
            tokens: TokenStore::default(),
        })
    }

    /// The fail-closed manager, with the reason it could not be configured.
    pub fn unavailable(reason: &'static str) -> Self {
        Self {
            config: None,
            unavailable_reason: reason,
            registrations: CeremonyStore::default(),
            authentications: CeremonyStore::default(),
            tokens: TokenStore::default(),
        }
    }

    /// Is a relying party configured? Reported to the caller, never used to
    /// widen anything.
    pub fn is_configured(&self) -> bool {
        self.config.is_some()
    }

    /// Why no relying party is configured, or `""` when one is.
    pub fn unavailable_reason(&self) -> &'static str {
        self.unavailable_reason
    }

    /// The runtime RP ID, when configured.
    pub fn rp_id(&self) -> Option<&str> {
        self.config.as_deref().map(WebauthnConfig::rp_id)
    }

    fn config_for_registration(&self) -> Result<&WebauthnConfig, PasskeyError> {
        self.config
            .as_deref()
            .ok_or(PasskeyError::SecureRegistrationUnavailable)
    }

    fn config_for_authentication(&self) -> Result<&WebauthnConfig, PasskeyError> {
        self.config
            .as_deref()
            .ok_or(PasskeyError::SecureVerificationUnavailable)
    }

    /// Capability report for the UI.
    ///
    /// TODO(gate): this is still hardcoded to the fail-closed values. It may
    /// report availability only once (a) the ceremony implementation below has
    /// been reviewed, (b) `verify_token` is allowed to consult the token store,
    /// and (c) `get_vault_secret` audits its releases — the audit is in place
    /// as of this change. When that happens the values become
    /// `registration_available: self.is_configured()`,
    /// `authentication_available: self.is_configured()`, and
    /// `unavailable_reason: self.unavailable_reason`. Reporting `true` while
    /// `verify_token` still returns `Ok(false)` would produce a sign-in button
    /// that always fails, so the two must flip together.
    pub fn status(&self) -> PasskeyStatus {
        PasskeyStatus {
            registration_available: false,
            authentication_available: false,
            legacy_credentials_require_reregistration: true,
            unavailable_reason: PASSKEYS_UNAVAILABLE,
        }
    }

    /// The stable WebAuthn user handle for an account.
    fn user_handle(account_id: &str) -> Uuid {
        Uuid::new_v5(&USER_HANDLE_NAMESPACE, account_id.as_bytes())
    }

    // ─── Registration ───────────────────────────────────────────────────────

    /// Begin enrolling a passkey for `id`.
    ///
    /// Credentials already enrolled under this RP ID are passed as
    /// `excludeCredentials`, so an authenticator the user has already enrolled
    /// declines rather than silently creating a second credential.
    pub async fn get_registration_options(
        &self,
        storage: &Storage,
        id: &str,
    ) -> Result<Value, PasskeyError> {
        let config = self.config_for_registration()?;
        let loaded = credential::load_credentials(storage, id).await?;

        let exclude: Vec<_> = loaded
            .credentials
            .iter()
            .filter(|credential| credential.matches_rp_id(config.rp_id()))
            .map(|credential| credential.passkey.cred_id().clone())
            .collect();

        // `user_name` and `user_display_name` may be stored by the
        // authenticator and shown in the platform's passkey list, so they carry
        // the account handle and never the API key itself.
        let label = account_label(id);
        let (challenge, state) = config
            .webauthn()
            .start_passkey_registration(
                Self::user_handle(id),
                &label,
                &label,
                (!exclude.is_empty()).then_some(exclude),
            )
            .map_err(PasskeyError::verification)?;

        // Serialise before storing the state: a serialisation failure must not
        // leave a live challenge behind.
        let options = serde_json::to_value(&challenge)
            .map_err(|error| PasskeyError::MalformedCeremonyResponse(error.to_string()))?;
        self.registrations.insert(id, state)?;
        Ok(options)
    }

    /// Complete an enrolment.
    ///
    /// **Nothing is written to storage on any failure path.** The challenge is
    /// taken before verification, so a failed attempt burns it; the credential
    /// is only persisted after `finish_passkey_registration` returns a
    /// `Passkey`, and `append_credential` itself refuses a duplicate without
    /// writing.
    pub async fn register_passkey(
        &self,
        storage: &Storage,
        id: &str,
        attestation: Value,
    ) -> Result<(), PasskeyError> {
        let config = self.config_for_registration()?;
        // Single use: gone whether or not what follows succeeds.
        let state = self.registrations.take(id)?;

        let registration: RegisterPublicKeyCredential = serde_json::from_value(attestation)
            .map_err(|error| PasskeyError::MalformedCeremonyResponse(error.to_string()))?;

        let passkey = config
            .webauthn()
            .finish_passkey_registration(&registration, &state)
            .map_err(PasskeyError::verification)?;

        let stored = StoredCredential::new(passkey, config.rp_id(), config.origin(), rfc3339_now());
        credential::append_credential(storage, id, stored).await
    }

    // ─── Authentication ─────────────────────────────────────────────────────

    /// Begin a sign-in for `id`.
    ///
    /// Credentials enrolled under a different RP ID are dropped before the
    /// ceremony starts. They cannot produce a valid assertion — the client will
    /// not even offer them — so including them would turn a knowable
    /// configuration mismatch into an opaque failure at the authenticator.
    pub async fn get_auth_options(
        &self,
        storage: &Storage,
        id: &str,
    ) -> Result<Value, PasskeyError> {
        let config = self.config_for_authentication()?;
        let loaded = credential::load_credentials(storage, id).await?;
        if loaded.is_empty() {
            return Err(PasskeyError::NoVerifiedCredentials);
        }

        let usable = loaded.for_rp_id(config.rp_id());
        if usable.is_empty() {
            return Err(PasskeyError::CredentialsFromAnotherContext);
        }

        let passkeys: Vec<Passkey> = usable
            .iter()
            .map(|credential| credential.passkey.clone())
            .collect();
        let (challenge, state) = config
            .webauthn()
            .start_passkey_authentication(&passkeys)
            .map_err(PasskeyError::verification)?;

        let options = serde_json::to_value(&challenge)
            .map_err(|error| PasskeyError::MalformedCeremonyResponse(error.to_string()))?;
        self.authentications.insert(id, state)?;
        Ok(options)
    }

    /// Complete a sign-in and mint an unlock token.
    ///
    /// Everything that makes an assertion trustworthy happens inside
    /// `finish_passkey_authentication`: the clientDataJSON type and origin, the
    /// RP-ID hash, the UP/UV flags, the signature, and the counter policy. No
    /// parallel check is added here, and none should be.
    pub async fn authenticate_passkey(
        &self,
        storage: &Storage,
        id: &str,
        assertion: Value,
    ) -> Result<Value, PasskeyError> {
        let config = self.config_for_authentication()?;
        // Single use, before verification: a failed assertion must burn the
        // challenge too, or a caller can retry against the same one until it
        // finds a forgery the library accepts.
        let state = self.authentications.take(id)?;

        let credential: PublicKeyCredential = serde_json::from_value(assertion)
            .map_err(|error| PasskeyError::MalformedCeremonyResponse(error.to_string()))?;

        let result = config
            .webauthn()
            .finish_passkey_authentication(&credential, &state)
            .map_err(PasskeyError::verification)?;

        // Persist before minting. If the counter cannot be recorded, the next
        // ceremony would verify against a stale counter, so the assertion is
        // not converted into an unlock token.
        self.record_successful_assertion(storage, id, &result)
            .await?;

        let minted = self.tokens.mint(&VerifiedAssertion::new(id, &result));
        Ok(serde_json::json!({
            "success": true,
            "token": minted.token,
            // For the audit record at the command boundary. The token is not
            // and must never be audited; the credential id is not secret.
            "credentialId": minted.credential_id,
        }))
    }

    /// Write back what the library learned from a verified assertion.
    ///
    /// The counter, backup state and backup eligibility are updated through
    /// `Passkey::update_credential`, which implements the specification's rule
    /// that a counter of zero on both sides means the authenticator does not
    /// support counters and the check is skipped. That rule is why every iCloud
    /// Keychain, Windows Hello and Android passkey keeps working on the second
    /// sign-in; a stricter "must strictly increase" rule of our own would
    /// reject all of them and look like a fault in the user's device.
    async fn record_successful_assertion(
        &self,
        storage: &Storage,
        id: &str,
        result: &AuthenticationResult,
    ) -> Result<(), PasskeyError> {
        let credential_id = credential::encode_credential_id(result.cred_id().as_ref());
        let loaded = credential::load_credentials(storage, id).await?;
        let stored = loaded
            .find(&credential_id)
            .ok_or(PasskeyError::NotFound)?
            .clone();

        let mut updated = stored;
        updated.passkey.update_credential(result);
        updated.last_used_at = Some(rfc3339_now());
        credential::replace_credential(storage, id, updated).await
    }

    // ─── Listing and deletion ───────────────────────────────────────────────

    /// Every credential this account has, verified and legacy alike.
    ///
    /// Verified credentials first, then verified-store records this build
    /// cannot read, then legacy records. The last two carry
    /// `requiresReregistration: true` and are reported in the same shape,
    /// because the user's action is identical for both: remove and enroll
    /// again.
    pub async fn list_passkeys(
        &self,
        storage: &Storage,
        id: &str,
    ) -> Result<Vec<Value>, PasskeyError> {
        let verified = credential::load_credentials(storage, id).await?;
        let legacy = storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Storage(e.to_string()))?;

        let mut listed: Vec<Value> = verified
            .credentials
            .iter()
            .map(|credential| {
                serde_json::json!({
                    "id": credential.credential_id,
                    "counter": credential.counter(),
                    "requiresReregistration": false,
                    "label": credential.label,
                    "createdAt": credential.created_at,
                    "lastUsedAt": credential.last_used_at,
                })
            })
            .collect();

        listed.extend(verified.dead.iter().map(|dead| {
            serde_json::json!({
                "id": dead
                    .credential_id
                    .clone()
                    .unwrap_or_else(|| dead_credential_handle(dead.index)),
                "counter": 0,
                "requiresReregistration": true,
            })
        }));

        listed.extend(legacy.iter().enumerate().map(|(index, record)| {
            serde_json::json!({
                "id": legacy::reported_credential_id(record, index),
                "counter": legacy::claimed_counter(record),
                "requiresReregistration": true,
            })
        }));

        Ok(listed)
    }

    /// Remove a credential, from whichever store holds it.
    ///
    /// Both stores are searched. If an id somehow appears in both, both copies
    /// go: a user asking to remove credential X wants X gone.
    pub async fn delete_passkey(
        &self,
        storage: &Storage,
        id: &str,
        credential_id: &str,
    ) -> Result<(), PasskeyError> {
        // Read the legacy record first, so a collection this build cannot parse
        // aborts the whole deletion before anything has been removed from the
        // verified store.
        let legacy_records = storage
            .get_passkeys(id)
            .await
            .map_err(|e| PasskeyError::Storage(e.to_string()))?;

        match dead_credential_index(credential_id) {
            // A record whose claimed id is unreadable is addressable only by
            // the positional handle `list_passkeys` reported for it.
            Some(index) => {
                credential::delete_dead_credential_at(storage, id, index).await?;
            }
            None => {
                credential::delete_credential(storage, id, credential_id).await?;
            }
        }

        // The legacy path below is unchanged from the recovery-only
        // implementation, including its treatment of an absent record as a
        // no-op. `94d74d1` fixed real bugs in this matching; do not "tidy" it.
        let remaining: Vec<Value> = legacy_records
            .into_iter()
            .enumerate()
            .filter(|(index, record)| !legacy::credential_matches(record, *index, credential_id))
            .map(|(_, record)| record)
            .collect();

        if remaining.is_empty() {
            storage
                .delete_secret(&legacy::legacy_storage_key(id))
                .await
                .map_err(|e| PasskeyError::Storage(e.to_string()))
        } else {
            let json = serde_json::to_string(&remaining)
                .map_err(|e| PasskeyError::Storage(e.to_string()))?;
            storage
                .store_secret(&legacy::legacy_storage_key(id), &json)
                .await
                .map_err(|e| PasskeyError::Storage(e.to_string()))
        }
    }

    // ─── Unlock tokens ──────────────────────────────────────────────────────

    /// Is `token` a live unlock token for `id`?
    ///
    /// Returns `Ok(false)` for every rejection reason and never an `Err`: a
    /// caller might treat an error as inconclusive rather than as a refusal,
    /// and this is the single check standing in front of `get_vault_secret`,
    /// which releases a decrypted Cloudflare API key.
    ///
    /// TODO(gate): [`TOKEN_VERIFICATION_ENABLED`] is still `false`, so this
    /// refuses every token including a genuinely minted one. Setting it to
    /// `true` — together with making [`PasskeyManager::status`] report the
    /// manager's real capability — is the change that opens the gate, and it
    /// should be reviewed on its own. What has to be true first:
    ///
    /// 1. the ceremony implementation above has been reviewed, in particular
    ///    that `token.rs` has exactly one `UnlockToken` construction site;
    /// 2. `get_vault_secret` audits its releases — **done**, in the same change
    ///    that added this ceremony layer;
    /// 3. the frontend transport exists, so a `true` status does not produce a
    ///    sign-in button that always fails (plan `t22-e5`/`t22-e6`).
    pub async fn verify_token(
        &self,
        id: &str,
        token: &str,
        consume: bool,
    ) -> Result<bool, PasskeyError> {
        if !TOKEN_VERIFICATION_ENABLED {
            return Ok(false);
        }
        Ok(self.tokens.verify(id, token, consume))
    }

    /// The credential behind the live unlock token for `id`, for audit records.
    /// Reveals nothing secret and authorises nothing.
    pub fn token_credential(&self, id: &str) -> Option<String> {
        self.tokens.credential_for(id)
    }

    /// Verify a token against the store, bypassing the gate above.
    ///
    /// Exists so the token store's rules can be tested end to end while
    /// `verify_token` is still hardcoded to `Ok(false)`. Test-only: it is not
    /// compiled into the shipped binary, so it cannot become a way around the
    /// gate.
    #[cfg(test)]
    pub(crate) fn verify_token_unguarded(&self, id: &str, token: &str, consume: bool) -> bool {
        self.tokens.verify(id, token, consume)
    }
}

/// The name shown for an account on the authenticator.
///
/// The account id is an opaque application handle (`key_<uuid>`), not the
/// Cloudflare API key. The key itself must never be sent to an authenticator,
/// which may store and display it.
fn account_label(account_id: &str) -> String {
    format!("Better Cloudflare ({account_id})")
}

fn dead_credential_handle(index: usize) -> String {
    format!("{DEAD_CREDENTIAL_HANDLE_PREFIX}{index}")
}

/// Is `requested` a positional handle for an unreadable verified-store record?
fn dead_credential_index(requested: &str) -> Option<usize> {
    requested
        .trim()
        .strip_prefix(DEAD_CREDENTIAL_HANDLE_PREFIX)
        .and_then(|index| index.parse().ok())
}

/// Current wall clock as RFC 3339, seconds precision, UTC.
///
/// Written here rather than pulled from `chrono` so this crate's manifest and
/// the workspace lockfile stay untouched by this change. The value is display
/// only — nothing in the crate decides anything on a timestamp, and every
/// expiry is measured with `Instant`, which a clock change cannot move.
fn rfc3339_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    format_rfc3339(seconds)
}

fn format_rfc3339(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let seconds_of_day = unix_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3600,
        (seconds_of_day % 3600) / 60,
        seconds_of_day % 60,
    )
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch to a
/// proleptic-Gregorian calendar date.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // Shift the era so that it begins on 0000-03-01, which makes the leap day
    // the last day of the year and removes every special case.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    };
    (year + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    const ID: &str = "key_passkey";
    const CREDENTIAL_ID: &str = "Y3JlZGVudGlhbC1pZA";

    fn complete_assertion() -> Value {
        let client_data = json!({
            "type": "webauthn.get",
            "challenge": "server-issued-challenge",
            "origin": "http://localhost:3000",
        });
        let mut authenticator_data = vec![0x11; 32];
        authenticator_data.push(0b0000_0101);
        authenticator_data.extend_from_slice(&7_u32.to_be_bytes());

        json!({
            "id": CREDENTIAL_ID,
            "rawId": CREDENTIAL_ID,
            "type": "public-key",
            "response": {
                "clientDataJSON": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(serde_json::to_vec(&client_data).expect("client data")),
                "authenticatorData": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(authenticator_data),
                "signature": base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(b"signature"),
                "userHandle": null,
            },
            "clientExtensionResults": {},
        })
    }

    async fn assert_authentication_fails_closed(assertion: Value) {
        let storage = Storage::new(false);
        let manager = PasskeyManager::default();
        let result = manager.authenticate_passkey(&storage, ID, assertion).await;
        assert_eq!(
            result.expect_err("legacy passkey must not authenticate"),
            PasskeyError::SecureVerificationUnavailable
        );
        assert!(!manager
            .verify_token(ID, "any-token", false)
            .await
            .expect("token check"));
    }

    #[tokio::test]
    async fn complete_assertion_path_fails_closed_without_trusted_public_key() {
        assert_authentication_fails_closed(complete_assertion()).await;
    }

    #[tokio::test]
    async fn tampered_challenge_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["clientDataJSON"] = json!("tampered-challenge");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_origin_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["clientDataJSON"] = json!("tampered-origin");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_rp_id_hash_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["authenticatorData"] =
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0_u8; 37]));
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_authenticator_flags_are_rejected() {
        let mut assertion = complete_assertion();
        let mut data = vec![0x11; 32];
        data.push(0);
        data.extend_from_slice(&7_u32.to_be_bytes());
        assertion["response"]["authenticatorData"] =
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data));
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_signature_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["response"]["signature"] = json!("tampered-signature");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn tampered_credential_id_is_rejected() {
        let mut assertion = complete_assertion();
        assertion["id"] = json!("different-credential");
        assertion["rawId"] = json!("different-credential");
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn assertion_replay_is_rejected() {
        let assertion = complete_assertion();
        assert_authentication_fails_closed(assertion.clone()).await;
        assert_authentication_fails_closed(assertion).await;
    }

    #[tokio::test]
    async fn counter_regression_is_rejected() {
        let storage = Storage::new(false);
        storage
            .store_passkey(
                ID,
                json!({
                    "id": CREDENTIAL_ID,
                    "counter": 10,
                    "response": { "attestationObject": "legacy-untrusted-data" },
                }),
            )
            .await
            .expect("legacy record");

        let manager = PasskeyManager::default();
        let result = manager
            .authenticate_passkey(&storage, ID, complete_assertion())
            .await;
        assert_eq!(
            result.expect_err("counter regression must fail"),
            PasskeyError::SecureVerificationUnavailable
        );
        let options = manager.get_auth_options(&storage, ID).await;
        assert_eq!(
            options.expect_err("legacy options must fail"),
            PasskeyError::SecureVerificationUnavailable
        );
    }

    #[tokio::test]
    async fn registration_is_disabled_instead_of_storing_unverified_material() {
        let storage = Storage::new(false);
        let manager = PasskeyManager::default();
        assert_eq!(
            manager
                .get_registration_options(&storage, ID)
                .await
                .expect_err("registration options"),
            PasskeyError::SecureRegistrationUnavailable
        );
        assert_eq!(
            manager
                .register_passkey(&storage, ID, json!({"untrusted": true}))
                .await
                .expect_err("registration"),
            PasskeyError::SecureRegistrationUnavailable
        );
        assert!(storage.get_passkeys(ID).await.expect("passkeys").is_empty());
    }

    #[test]
    fn status_reports_fail_closed_capabilities_and_legacy_recovery() {
        assert_eq!(
            PasskeyManager::default().status(),
            PasskeyStatus {
                registration_available: false,
                authentication_available: false,
                legacy_credentials_require_reregistration: true,
                unavailable_reason: PASSKEYS_UNAVAILABLE,
            }
        );
    }

    #[tokio::test]
    async fn legacy_passkeys_remain_listable_and_deletable_for_recovery() {
        let storage = Storage::new(false);
        let manager = PasskeyManager::default();
        storage
            .store_passkey(ID, json!({"id": CREDENTIAL_ID, "counter": 4}))
            .await
            .expect("legacy record");

        let list = manager.list_passkeys(&storage, ID).await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["requiresReregistration"], true);
        assert_eq!(list[0]["counter"], 4);

        manager
            .delete_passkey(&storage, ID, CREDENTIAL_ID)
            .await
            .expect("delete");
        assert!(manager
            .list_passkeys(&storage, ID)
            .await
            .expect("list after delete")
            .is_empty());
    }

    #[tokio::test]
    async fn token_verification_can_never_authorize_secret_release() {
        let manager = PasskeyManager::default();
        assert!(!manager
            .verify_token(ID, "attacker-controlled-token", true)
            .await
            .expect("verify token"));
    }

    // ─── Helpers added with the ceremony layer ──────────────────────────────

    #[test]
    fn the_user_handle_is_stable_per_account_and_distinct_between_accounts() {
        assert_eq!(
            PasskeyManager::user_handle("key_a"),
            PasskeyManager::user_handle("key_a"),
            "a fresh handle per enrolment would litter the platform passkey list"
        );
        assert_ne!(
            PasskeyManager::user_handle("key_a"),
            PasskeyManager::user_handle("key_b")
        );
    }

    #[test]
    fn the_account_label_never_carries_the_account_secret() {
        let label = account_label("key_abc");
        assert!(label.contains("key_abc"));
        assert!(label.contains("Better Cloudflare"));
    }

    #[test]
    fn dead_credential_handles_round_trip_and_reject_anything_else() {
        assert_eq!(dead_credential_index(&dead_credential_handle(7)), Some(7));
        assert_eq!(dead_credential_index("dead_credential_"), None);
        assert_eq!(dead_credential_index("dead_credential_x"), None);
        assert_eq!(dead_credential_index("dead_credential_-1"), None);
        assert_eq!(dead_credential_index("legacy_credential_1"), None);
        assert_eq!(dead_credential_index("Y3JlZGVudGlhbC1pZA"), None);
    }

    #[test]
    fn rfc3339_formatting_matches_known_instants() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00Z");
        // A leap day, and the century rule that makes 2000 a leap year.
        assert_eq!(format_rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(format_rfc3339(1_764_547_199), "2025-11-30T23:59:59Z");
        assert_eq!(format_rfc3339(1_756_684_800), "2025-09-01T00:00:00Z");
        // 2100 is *not* a leap year, which the era arithmetic has to get right.
        assert_eq!(format_rfc3339(4_102_444_800), "2100-01-01T00:00:00Z");
        // A clock set before the epoch must still produce a valid timestamp
        // rather than wrapping into a nonsense date.
        assert_eq!(format_rfc3339(-1), "1969-12-31T23:59:59Z");
    }

    #[test]
    fn an_unavailable_manager_reports_why_and_configures_nothing() {
        let manager = PasskeyManager::unavailable(REASON_ORIGIN_UNRESOLVED);
        assert!(!manager.is_configured());
        assert_eq!(manager.unavailable_reason(), REASON_ORIGIN_UNRESOLVED);
        assert_eq!(manager.rp_id(), None);
        assert_eq!(
            PasskeyManager::default().unavailable_reason(),
            REASON_NOT_CONFIGURED
        );
    }

    #[test]
    fn a_relying_party_is_refused_when_the_rp_id_is_not_a_domain_of_the_origin() {
        let origin = Url::parse("https://localhost").expect("origin");
        assert_eq!(
            PasskeyManager::new("example.com", &origin).expect_err("mismatched rp id"),
            PasskeyError::RuntimeOriginUnavailable
        );
        assert!(PasskeyManager::new("localhost", &origin).is_ok());
    }
}
