//! Platform biometric authentication for Better Cloudflare.
//!
//! Native biometric prompts and secret storage. Three platforms have a backend;
//! everything else gets a fallback that refuses every operation:
//!
//! | Platform | Prompt | Secret store |
//! |----------|--------|--------------|
//! | macOS    | Touch ID / Face ID via Security.framework | Keychain, item bound to the biometric by a `SecAccessControl` ACL |
//! | Windows  | Windows Hello via `UserConsentVerifier` | Credential Manager generic credential |
//! | Linux    | Fingerprint via `fprintd` over D-Bus | Secret Service (`org.freedesktop.secrets`) |
//! | other    | unsupported — every operation returns [`BiometricError::PlatformNotSupported`] | — |
//!
//! # The guarantee is not the same on every platform
//!
//! Only macOS binds the secret to the biometric *in the OS*: the keychain will
//! not decrypt the item until Touch ID succeeds, no matter which process asks.
//!
//! On Windows and Linux there is no equivalent for an ordinary desktop app, so
//! [`BiometricAuth::get_protected_secret`] composes two separate things: it
//! raises the platform prompt, and only on success reads from a store that would
//! have answered anyway. The gate is enforced by **this process**. It stops
//! someone at an unlocked, unattended machine using this app; it does not stop
//! code already running as the user, which can read the credential directly. The
//! per-platform module docs spell out exactly what each store does and does not
//! protect.
//!
//! Two smaller honesty notes, because the UI reports these:
//!
//! - On Windows, `available: true` means a Hello verifier is configured, and
//!   Windows counts the **PIN** as one. It is not proof of biometric hardware.
//! - On Linux, `reason` cannot be shown to the user: fprintd has no prompt UI of
//!   its own, so the scan is silent and the calling window is the only place the
//!   reason can appear.
//!
//! This crate is **separate** from `bc-passkey` (WebAuthn) — it handles
//! OS-level biometric prompts for local app security (quick unlock, protecting
//! stored API keys) rather than web-standard FIDO2 authentication.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Default service name used by the Tauri commands.
///
/// Namespaces this app's secrets inside whichever store the platform uses: a
/// keychain service attribute on macOS, half of the credential target name on
/// Windows, an item attribute on Linux.
pub const DEFAULT_SERVICE: &str = "com.bettercloudflare.biometric";

// ─── Public types ───────────────────────────────────────────────────────────

/// The type of biometric authentication available on this device.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BiometricType {
    TouchId,
    FaceId,
    WindowsHello,
    Fingerprint,
    None,
}

/// Biometric availability status returned by [`BiometricAuth::status`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    /// Whether biometric authentication is available and enrolled.
    pub available: bool,
    /// The specific biometric type detected.
    pub biometric_type: BiometricType,
    /// Human-readable reason when unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Errors from biometric operations.
#[derive(Error, Debug)]
pub enum BiometricError {
    #[error("Biometrics not available: {0}")]
    NotAvailable(String),
    #[error("Biometric authentication failed: {0}")]
    AuthenticationFailed(String),
    #[error("User cancelled biometric authentication")]
    UserCancelled,
    #[error("No biometrics enrolled on this device")]
    NotEnrolled,
    #[error("Keychain/credential store error: {0}")]
    StoreError(String),
    #[error("Secret not found")]
    NotFound,
    #[error("Platform not supported for biometric authentication")]
    PlatformNotSupported,
}

// ─── Public API ─────────────────────────────────────────────────────────────

/// Main entry point for platform biometric operations.
///
/// All methods are synchronous because they call blocking OS APIs (e.g.
/// Security.framework on macOS). [`Self::authenticate`] and
/// [`Self::get_protected_secret`] block for as long as the user leaves the
/// prompt unanswered, so call those from a blocking worker rather than an async
/// task — which is what `commands::auth` does.
pub struct BiometricAuth;

impl BiometricAuth {
    /// Check whether biometric authentication is available on this device.
    pub fn status() -> BiometricStatus {
        platform::status()
    }

    /// Prompt the user for biometric authentication.
    ///
    /// `reason` is displayed to the user (e.g. "Unlock Better Cloudflare").
    /// Returns `Ok(())` on successful authentication, or an error if cancelled
    /// or failed.
    pub fn authenticate(reason: &str) -> Result<(), BiometricError> {
        platform::authenticate(reason)
    }

    /// Store a secret for later biometric-gated retrieval.
    ///
    /// Does not prompt: enrolling a secret is not a release of one. Any existing
    /// secret with the same `service`/`account` is replaced.
    ///
    /// On macOS the item is written with an access-control policy that makes the
    /// OS require biometric authentication before it will decrypt. On Windows and
    /// Linux no such policy exists for a desktop app, and the gate is the
    /// [`Self::get_protected_secret`] call path instead — see the crate docs.
    pub fn store_protected_secret(
        service: &str,
        account: &str,
        secret: &[u8],
    ) -> Result<(), BiometricError> {
        platform::store_protected_secret(service, account, secret)
    }

    /// Retrieve a biometric-protected secret.
    ///
    /// Triggers the platform prompt — Touch ID, Windows Hello, or an fprintd
    /// fingerprint scan — and reads the secret only if it succeeds. `reason` is
    /// shown in the system dialog on macOS and Windows; Linux has no dialog to
    /// show it in.
    pub fn get_protected_secret(
        service: &str,
        account: &str,
        reason: &str,
    ) -> Result<Vec<u8>, BiometricError> {
        platform::get_protected_secret(service, account, reason)
    }

    /// Delete a stored secret from the platform's secret store.
    ///
    /// A secret that is already absent is success, not an error: the caller asked
    /// for it to not exist, and it does not.
    pub fn delete_protected_secret(service: &str, account: &str) -> Result<(), BiometricError> {
        platform::delete_protected_secret(service, account)
    }

    /// Check whether a secret is stored, without prompting.
    ///
    /// Every backend answers this without a biometric gesture. On Windows that
    /// costs a plaintext read inside the process, because Credential Manager has
    /// no existence query — the `windows` module says what is done about it.
    pub fn has_protected_secret(service: &str, account: &str) -> Result<bool, BiometricError> {
        platform::has_protected_secret(service, account)
    }
}

// ─── Platform modules ───────────────────────────────────────────────────────

/// Raw-code translations shared by the backends, compiled everywhere so its
/// tests run everywhere. See [`mapping`] for why that is worth the `dead_code`
/// allowance it costs.
mod mapping;

// The four predicates below are mutually exclusive and exhaustive: exactly one
// `platform` alias exists on any target. `self::` on each alias is not optional
// — `use windows as platform` would be ambiguous between this module and the
// `windows` crate in the extern prelude.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use self::macos as platform;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use self::windows as platform;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use self::linux as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod fallback;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use self::fallback as platform;

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_returns_valid() {
        let status = BiometricAuth::status();
        // Should return without panicking regardless of platform
        assert!(matches!(
            status.biometric_type,
            BiometricType::TouchId
                | BiometricType::FaceId
                | BiometricType::WindowsHello
                | BiometricType::Fingerprint
                | BiometricType::None
        ));
    }

    #[test]
    fn status_serializes_to_camel_case() {
        let status = BiometricStatus {
            available: true,
            biometric_type: BiometricType::TouchId,
            reason: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["biometricType"], "touchId");
        // reason: None should be skipped
        assert!(json.get("reason").is_none());
    }

    #[test]
    fn biometric_type_equality() {
        assert_eq!(BiometricType::TouchId, BiometricType::TouchId);
        assert_ne!(BiometricType::TouchId, BiometricType::None);
    }

    #[test]
    fn error_display() {
        assert_eq!(
            BiometricError::UserCancelled.to_string(),
            "User cancelled biometric authentication"
        );
        assert_eq!(
            BiometricError::PlatformNotSupported.to_string(),
            "Platform not supported for biometric authentication"
        );
        assert_eq!(BiometricError::NotFound.to_string(), "Secret not found");
    }

    #[test]
    fn default_service_is_set() {
        assert!(!DEFAULT_SERVICE.is_empty());
        assert!(DEFAULT_SERVICE.starts_with("com.bettercloudflare"));
    }
}
