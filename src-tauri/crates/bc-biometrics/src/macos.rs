//! macOS biometric authentication via Security.framework (Touch ID).
//!
//! Uses the macOS Keychain with biometric access control
//! (`kSecAccessControlBiometryAny`) to store and retrieve secrets. The OS
//! automatically prompts for Touch ID when accessing biometric-protected
//! keychain items.
//!
//! # How it works
//!
//! - **Store**: Creates a generic-password keychain item with an
//!   `SecAccessControl` requiring biometric authentication for data access.
//! - **Retrieve**: Calls `SecItemCopyMatching` which triggers the Touch ID
//!   dialog. On success the decrypted data is returned.
//! - **Authenticate**: Stores a small marker value and immediately reads it
//!   back, triggering Touch ID. The marker is cleaned up afterwards.
//! - **Status**: Attempts to create a `SecAccessControl` with biometric flags;
//!   success indicates Touch ID hardware is available.

use crate::{BiometricError, BiometricStatus, BiometricType};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::string::CFString;
use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef, OSStatus};
use core_foundation_sys::dictionary::{
    CFDictionaryCreateMutable, CFDictionarySetValue, CFMutableDictionaryRef,
    kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks,
};
use core_foundation_sys::error::CFErrorRef;
use core_foundation_sys::string::CFStringRef;
use security_framework_sys::access_control::{
    kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, SecAccessControlCreateWithFlags,
};
use security_framework_sys::base::{errSecSuccess, SecAccessControlRef};
use security_framework_sys::item::{
    kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass,
    kSecClassGenericPassword, kSecMatchLimit, kSecReturnAttributes, kSecReturnData, kSecValueData,
};
use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};

// Constants not exported by security-framework-sys 2.15 but present in
// Security.framework headers — we link against the framework directly.
extern "C" {
    static kSecMatchLimitOne: CFStringRef;
    static kSecUseOperationPrompt: CFStringRef;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/// `kSecAccessControlBiometryAny` (macOS 10.13.4+ / iOS 11.3+).
/// Requires any enrolled biometric (Touch ID / Face ID) for access.
const BIOMETRY_ANY: usize = 1 << 1;

/// Service name for the internal authentication marker item.
const AUTH_MARKER_SERVICE: &str = "com.bettercloudflare.biometric.marker";

/// Well-known Security.framework `OSStatus` error codes.
const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
const ERR_SEC_AUTH_FAILED: OSStatus = -25293;
const ERR_SEC_USER_CANCELED: OSStatus = -128;
const ERR_SEC_INTERACTION_NOT_ALLOWED: OSStatus = -25308;

// ─── Public interface ───────────────────────────────────────────────────────

/// Check whether Touch ID / Face ID is available.
pub fn status() -> BiometricStatus {
    let mut error: CFErrorRef = std::ptr::null_mut();
    let acl = unsafe {
        SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as CFTypeRef,
            BIOMETRY_ANY,
            &mut error,
        )
    };
    if acl.is_null() {
        let reason = if !error.is_null() {
            // Safety: wrap_under_create_rule takes ownership and releases on drop
            let desc = format!("{:?}", unsafe {
                core_foundation::base::CFType::wrap_under_create_rule(error as CFTypeRef)
            });
            desc
        } else {
            "Biometric access control not supported".to_string()
        };
        return BiometricStatus {
            available: false,
            biometric_type: BiometricType::None,
            reason: Some(reason),
        };
    }
    unsafe { CFRelease(acl as CFTypeRef) };

    BiometricStatus {
        available: true,
        biometric_type: BiometricType::TouchId,
        reason: None,
    }
}

/// Prompt the user for Touch ID authentication by storing and retrieving a
/// small marker in the biometric-protected keychain.
pub fn authenticate(reason: &str) -> Result<(), BiometricError> {
    // Clean up any stale marker
    let _ = delete_protected_secret(AUTH_MARKER_SERVICE, "auth_check");

    // Store a throwaway marker with biometric protection
    store_protected_secret(AUTH_MARKER_SERVICE, "auth_check", b"ok")?;

    // Reading triggers the Touch ID prompt
    let result = get_protected_secret(AUTH_MARKER_SERVICE, "auth_check", reason);

    // Always clean up
    let _ = delete_protected_secret(AUTH_MARKER_SERVICE, "auth_check");

    result.map(|_| ())
}

/// Store a secret in the macOS Keychain with biometric protection.
///
/// Any existing item with the same `service`/`account` is deleted first.
pub fn store_protected_secret(
    service: &str,
    account: &str,
    secret: &[u8],
) -> Result<(), BiometricError> {
    // Remove any existing item to avoid errSecDuplicateItem
    let _ = delete_protected_secret(service, account);

    let acl = create_biometric_acl()?;

    let status = unsafe {
        let dict = create_mutable_dict();

        let cf_service = CFString::new(service);
        let cf_account = CFString::new(account);
        let cf_data = CFData::from_buffer(secret);

        CFDictionarySetValue(dict, kSecClass as _, kSecClassGenericPassword as _);
        CFDictionarySetValue(dict, kSecAttrService as _, cf_service.as_CFTypeRef());
        CFDictionarySetValue(dict, kSecAttrAccount as _, cf_account.as_CFTypeRef());
        CFDictionarySetValue(dict, kSecValueData as _, cf_data.as_CFTypeRef());
        CFDictionarySetValue(dict, kSecAttrAccessControl as _, acl as _);

        let os_status = SecItemAdd(dict, std::ptr::null_mut());

        CFRelease(dict as CFTypeRef);
        CFRelease(acl as CFTypeRef);

        os_status
    };

    if status != errSecSuccess {
        return Err(BiometricError::StoreError(format!(
            "SecItemAdd failed (OSStatus {})",
            status
        )));
    }

    Ok(())
}

/// Retrieve a biometric-protected secret from the macOS Keychain.
///
/// This triggers the Touch ID dialog with the provided `reason` string.
pub fn get_protected_secret(
    service: &str,
    account: &str,
    reason: &str,
) -> Result<Vec<u8>, BiometricError> {
    unsafe {
        let dict = create_mutable_dict();

        let cf_service = CFString::new(service);
        let cf_account = CFString::new(account);
        let cf_reason = CFString::new(reason);

        CFDictionarySetValue(dict, kSecClass as _, kSecClassGenericPassword as _);
        CFDictionarySetValue(dict, kSecAttrService as _, cf_service.as_CFTypeRef());
        CFDictionarySetValue(dict, kSecAttrAccount as _, cf_account.as_CFTypeRef());
        CFDictionarySetValue(
            dict,
            kSecReturnData as _,
            CFBoolean::true_value().as_CFTypeRef(),
        );
        CFDictionarySetValue(dict, kSecMatchLimit as _, kSecMatchLimitOne as _);
        CFDictionarySetValue(dict, kSecUseOperationPrompt as _, cf_reason.as_CFTypeRef());

        let mut result: CFTypeRef = std::ptr::null_mut();
        let status = SecItemCopyMatching(dict, &mut result);
        CFRelease(dict as CFTypeRef);

        match status {
            s if s == errSecSuccess => {
                if result.is_null() {
                    return Err(BiometricError::NotFound);
                }
                // Safety: SecItemCopyMatching returns a CFDataRef when kSecReturnData is set
                let data = CFData::wrap_under_create_rule(result as _);
                Ok(data.bytes().to_vec())
            }
            ERR_SEC_USER_CANCELED => Err(BiometricError::UserCancelled),
            ERR_SEC_AUTH_FAILED => Err(BiometricError::AuthenticationFailed(
                "Touch ID authentication failed".into(),
            )),
            ERR_SEC_ITEM_NOT_FOUND => Err(BiometricError::NotFound),
            other => Err(BiometricError::StoreError(format!(
                "SecItemCopyMatching failed (OSStatus {})",
                other
            ))),
        }
    }
}

/// Delete a keychain item by service + account.
pub fn delete_protected_secret(service: &str, account: &str) -> Result<(), BiometricError> {
    unsafe {
        let dict = create_mutable_dict();

        let cf_service = CFString::new(service);
        let cf_account = CFString::new(account);

        CFDictionarySetValue(dict, kSecClass as _, kSecClassGenericPassword as _);
        CFDictionarySetValue(dict, kSecAttrService as _, cf_service.as_CFTypeRef());
        CFDictionarySetValue(dict, kSecAttrAccount as _, cf_account.as_CFTypeRef());

        let status = SecItemDelete(dict);
        CFRelease(dict as CFTypeRef);

        match status {
            s if s == errSecSuccess => Ok(()),
            ERR_SEC_ITEM_NOT_FOUND => Ok(()), // already gone
            other => Err(BiometricError::StoreError(format!(
                "SecItemDelete failed (OSStatus {})",
                other
            ))),
        }
    }
}

/// Check if a biometric-protected secret exists **without** triggering the
/// Touch ID prompt. Queries keychain attributes only (no data retrieval).
pub fn has_protected_secret(service: &str, account: &str) -> Result<bool, BiometricError> {
    unsafe {
        let dict = create_mutable_dict();

        let cf_service = CFString::new(service);
        let cf_account = CFString::new(account);

        CFDictionarySetValue(dict, kSecClass as _, kSecClassGenericPassword as _);
        CFDictionarySetValue(dict, kSecAttrService as _, cf_service.as_CFTypeRef());
        CFDictionarySetValue(dict, kSecAttrAccount as _, cf_account.as_CFTypeRef());
        // Request attributes only — does NOT trigger biometric since we're not
        // requesting kSecReturnData
        CFDictionarySetValue(
            dict,
            kSecReturnAttributes as _,
            CFBoolean::true_value().as_CFTypeRef(),
        );
        CFDictionarySetValue(dict, kSecMatchLimit as _, kSecMatchLimitOne as _);

        let mut result: CFTypeRef = std::ptr::null_mut();
        let status = SecItemCopyMatching(dict, &mut result);
        CFRelease(dict as CFTypeRef);
        if !result.is_null() {
            CFRelease(result);
        }

        match status {
            s if s == errSecSuccess => Ok(true),
            ERR_SEC_INTERACTION_NOT_ALLOWED => Ok(true), // exists but needs auth
            ERR_SEC_AUTH_FAILED => Ok(true),              // exists but auth denied
            ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            other => Err(BiometricError::StoreError(format!(
                "SecItemCopyMatching failed (OSStatus {})",
                other
            ))),
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Create a `SecAccessControl` requiring biometric authentication.
fn create_biometric_acl() -> Result<SecAccessControlRef, BiometricError> {
    let mut error: CFErrorRef = std::ptr::null_mut();
    let acl = unsafe {
        SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as CFTypeRef,
            BIOMETRY_ANY,
            &mut error,
        )
    };
    if acl.is_null() {
        let msg = if !error.is_null() {
            let desc = format!("{:?}", unsafe {
                core_foundation::base::CFType::wrap_under_create_rule(error as CFTypeRef)
            });
            format!("Cannot create biometric access control: {}", desc)
        } else {
            "Cannot create biometric access control".to_string()
        };
        return Err(BiometricError::NotAvailable(msg));
    }
    Ok(acl)
}

/// Create an empty `CFMutableDictionary` with standard CF callbacks.
unsafe fn create_mutable_dict() -> CFMutableDictionaryRef {
    CFDictionaryCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks,
    )
}
