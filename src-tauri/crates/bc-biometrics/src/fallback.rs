//! Fallback implementation for platforms with no backend in this crate.
//!
//! Reached only on targets that are neither macOS, Windows, nor Linux — the BSDs,
//! say. Every operation returns [`BiometricError::PlatformNotSupported`] and
//! [`status`] reports biometrics as unavailable, so a caller can offer the feature
//! or not without special-casing the platform.

use crate::{BiometricError, BiometricStatus, BiometricType};

pub fn status() -> BiometricStatus {
    BiometricStatus {
        available: false,
        biometric_type: BiometricType::None,
        reason: Some("Biometric authentication is not available on this platform".to_string()),
    }
}

pub fn authenticate(_reason: &str) -> Result<(), BiometricError> {
    Err(BiometricError::PlatformNotSupported)
}

pub fn store_protected_secret(
    _service: &str,
    _account: &str,
    _secret: &[u8],
) -> Result<(), BiometricError> {
    Err(BiometricError::PlatformNotSupported)
}

pub fn get_protected_secret(
    _service: &str,
    _account: &str,
    _reason: &str,
) -> Result<Vec<u8>, BiometricError> {
    Err(BiometricError::PlatformNotSupported)
}

pub fn delete_protected_secret(_service: &str, _account: &str) -> Result<(), BiometricError> {
    Err(BiometricError::PlatformNotSupported)
}

pub fn has_protected_secret(_service: &str, _account: &str) -> Result<bool, BiometricError> {
    Ok(false)
}
