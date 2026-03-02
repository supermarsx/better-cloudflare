//! Platform biometric authentication for Better Cloudflare.
//!
//! Provides native biometric authentication (Touch ID on macOS, Windows Hello
//! on Windows) and biometric-protected secret storage via the OS keychain.
//!
//! This crate is **separate** from [`bc_passkey`] (WebAuthn) — it handles
//! OS-level biometric prompts for local app security (quick unlock, protecting
//! stored API keys) rather than web-standard FIDO2 authentication.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Default keychain service name used by Tauri commands.
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
/// Security.framework on macOS). Tauri sync commands run on a thread pool,
/// so this is safe to call from command handlers.
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

    /// Store a secret protected by biometric authentication.
    ///
    /// The secret is stored in the OS keychain/credential store with an access
    /// control policy requiring biometric authentication to retrieve it. Any
    /// existing secret with the same `service`/`account` is replaced.
    pub fn store_protected_secret(
        service: &str,
        account: &str,
        secret: &[u8],
    ) -> Result<(), BiometricError> {
        platform::store_protected_secret(service, account, secret)
    }

    /// Retrieve a biometric-protected secret.
    ///
    /// This triggers the OS biometric prompt (Touch ID / Windows Hello).
    /// `reason` is displayed in the system authentication dialog.
    pub fn get_protected_secret(
        service: &str,
        account: &str,
        reason: &str,
    ) -> Result<Vec<u8>, BiometricError> {
        platform::get_protected_secret(service, account, reason)
    }

    /// Delete a biometric-protected secret from the OS keychain.
    pub fn delete_protected_secret(
        service: &str,
        account: &str,
    ) -> Result<(), BiometricError> {
        platform::delete_protected_secret(service, account)
    }

    /// Check if a biometric-protected secret exists without triggering
    /// the biometric prompt.
    pub fn has_protected_secret(
        service: &str,
        account: &str,
    ) -> Result<bool, BiometricError> {
        platform::has_protected_secret(service, account)
    }
}

// ─── Platform modules ───────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(not(target_os = "macos"))]
mod fallback;
#[cfg(not(target_os = "macos"))]
use fallback as platform;

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
        assert_eq!(
            BiometricError::NotFound.to_string(),
            "Secret not found"
        );
    }

    #[test]
    fn default_service_is_set() {
        assert!(!DEFAULT_SERVICE.is_empty());
        assert!(DEFAULT_SERVICE.starts_with("com.bettercloudflare"));
    }
}
