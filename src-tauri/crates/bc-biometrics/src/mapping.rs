//! Pure translations between OS result codes and [`BiometricError`].
//!
//! These tables sit outside the platform modules on purpose. They are the part
//! of each backend that needs no hardware, no enrolment, and no prompt to test —
//! so they are compiled on *every* target, and the tests at the bottom of this
//! file run the Windows Hello tables on Linux and the fprintd tables on Windows.
//! The platform modules do nothing but hand over a raw code and forward what
//! comes back.
//!
//! The numeric constants below duplicate WinRT enum values rather than importing
//! them, which is what lets the table compile away from Windows. That duplication
//! is checked against the real SDK values by a test in the `windows` module — if
//! Microsoft ever renumbers the enums, that test fails rather than this table
//! silently mapping "cancelled" onto "device busy".

// Each table is used by exactly one platform module and is dead code on the
// others, which is the price of being testable everywhere. Silencing it here is
// narrower than making these functions `pub` just to keep the lint quiet.
#![allow(dead_code)]

use crate::{BiometricError, BiometricStatus, BiometricType};

// ─── Windows: UserConsentVerifierAvailability ───────────────────────────────

pub(crate) const AVAILABILITY_AVAILABLE: i32 = 0;
pub(crate) const AVAILABILITY_DEVICE_NOT_PRESENT: i32 = 1;
pub(crate) const AVAILABILITY_NOT_CONFIGURED_FOR_USER: i32 = 2;
pub(crate) const AVAILABILITY_DISABLED_BY_POLICY: i32 = 3;
pub(crate) const AVAILABILITY_DEVICE_BUSY: i32 = 4;

/// Translate a `UserConsentVerifierAvailability` value into a status report.
///
/// Only `Available` yields `available: true`. Note what that does *not* say:
/// Windows counts the PIN as a Hello verifier, so `Available` can mean "this
/// user has a PIN" on a machine with no biometric sensor at all. The
/// [`BiometricType::WindowsHello`] label is accurate for what will be prompted;
/// it is not a promise that a fingerprint reader or camera exists.
pub(crate) fn windows_availability(code: i32) -> BiometricStatus {
    let (available, biometric_type, reason) = match code {
        AVAILABILITY_AVAILABLE => (true, BiometricType::WindowsHello, None),
        AVAILABILITY_DEVICE_NOT_PRESENT => (
            false,
            BiometricType::None,
            Some("This device has no Windows Hello verifier: no fingerprint reader, no Hello-capable camera, and no PIN".to_string()),
        ),
        AVAILABILITY_NOT_CONFIGURED_FOR_USER => (
            false,
            BiometricType::None,
            Some("Windows Hello is not set up for this user. Configure it under Settings > Accounts > Sign-in options".to_string()),
        ),
        AVAILABILITY_DISABLED_BY_POLICY => (
            false,
            BiometricType::None,
            Some("Windows Hello has been disabled by system policy on this machine".to_string()),
        ),
        AVAILABILITY_DEVICE_BUSY => (
            false,
            BiometricType::None,
            Some("The Windows Hello device is busy with another request. Try again in a moment".to_string()),
        ),
        unknown => (
            false,
            BiometricType::None,
            Some(format!(
                "Windows reported an unrecognised Hello availability code ({unknown})"
            )),
        ),
    };
    BiometricStatus {
        available,
        biometric_type,
        reason,
    }
}

// ─── Windows: UserConsentVerificationResult ─────────────────────────────────

pub(crate) const CONSENT_VERIFIED: i32 = 0;
pub(crate) const CONSENT_DEVICE_NOT_PRESENT: i32 = 1;
pub(crate) const CONSENT_NOT_CONFIGURED_FOR_USER: i32 = 2;
pub(crate) const CONSENT_DISABLED_BY_POLICY: i32 = 3;
pub(crate) const CONSENT_DEVICE_BUSY: i32 = 4;
pub(crate) const CONSENT_RETRIES_EXHAUSTED: i32 = 5;
pub(crate) const CONSENT_CANCELED: i32 = 6;

/// Translate a `UserConsentVerificationResult` value into an outcome.
///
/// `DeviceNotPresent` and `NotConfiguredForUser` both become
/// [`BiometricError::NotEnrolled`]: from the caller's side they are the same
/// answer — there is nothing on this machine for this user to verify with — and
/// the remedy in both cases is to enrol, not to retry.
pub(crate) fn windows_consent(code: i32) -> Result<(), BiometricError> {
    match code {
        CONSENT_VERIFIED => Ok(()),
        CONSENT_CANCELED => Err(BiometricError::UserCancelled),
        CONSENT_DEVICE_NOT_PRESENT | CONSENT_NOT_CONFIGURED_FOR_USER => {
            Err(BiometricError::NotEnrolled)
        }
        CONSENT_DISABLED_BY_POLICY => Err(BiometricError::NotAvailable(
            "Windows Hello has been disabled by system policy on this machine".to_string(),
        )),
        CONSENT_DEVICE_BUSY => Err(BiometricError::NotAvailable(
            "The Windows Hello device is busy with another request. Try again in a moment"
                .to_string(),
        )),
        CONSENT_RETRIES_EXHAUSTED => Err(BiometricError::AuthenticationFailed(
            "Too many failed attempts; Windows Hello stopped accepting them".to_string(),
        )),
        unknown => Err(BiometricError::AuthenticationFailed(format!(
            "Windows reported an unrecognised Hello verification result ({unknown})"
        ))),
    }
}

// ─── Windows: Credential Manager target names ──────────────────────────────

/// `CRED_MAX_GENERIC_TARGET_NAME_LENGTH`, in UTF-16 code units.
///
/// Spelled out rather than imported from `windows` so that the length check is
/// testable on every target. `CredWriteW` rejects anything longer.
const CRED_MAX_TARGET_NAME: usize = 32767;

/// The separator between the service and the account in a target name.
const TARGET_SEPARATOR: char = ':';

/// Derive the Credential Manager target name for one `service`/`account` pair.
///
/// Credential Manager has no notion of a service *and* an account the way the
/// macOS keychain does — a generic credential is found by a single target string
/// — so the two are joined into one. `service` may not contain
/// [`TARGET_SEPARATOR`], because `("a:b", "c")` and `("a", "b:c")` would
/// otherwise name the same credential and one enrolment would silently overwrite
/// the other.
///
/// Rejecting an interior NUL matters for a different reason: the target is
/// handed to a `W` API as a NUL-terminated string, so a NUL would truncate the
/// name and address a *different*, shorter credential than the caller asked for.
pub(crate) fn credential_target_name(
    service: &str,
    account: &str,
) -> Result<String, BiometricError> {
    if service.is_empty() {
        return Err(BiometricError::StoreError(
            "Credential service name must not be empty".to_string(),
        ));
    }
    if account.is_empty() {
        return Err(BiometricError::StoreError(
            "Credential account name must not be empty".to_string(),
        ));
    }
    if service.contains('\0') || account.contains('\0') {
        return Err(BiometricError::StoreError(
            "Credential service and account names must not contain NUL".to_string(),
        ));
    }
    if service.contains(TARGET_SEPARATOR) {
        return Err(BiometricError::StoreError(format!(
            "Credential service name must not contain '{TARGET_SEPARATOR}'"
        )));
    }

    let target = format!("{service}{TARGET_SEPARATOR}{account}");
    let units = target.encode_utf16().count();
    if units > CRED_MAX_TARGET_NAME {
        return Err(BiometricError::StoreError(format!(
            "Credential target name is {units} UTF-16 units, over the {CRED_MAX_TARGET_NAME} Windows allows"
        )));
    }
    Ok(target)
}

// ─── Linux: net.reactivated.Fprint ─────────────────────────────────────────

/// What to do about one `VerifyStatus` signal from fprintd.
///
/// Deliberately not `PartialEq`: that would need [`BiometricError`] to be
/// comparable, and widening a public error type to suit an internal enum is the
/// wrong trade. Callers and tests match on the variant.
#[derive(Debug)]
pub(crate) enum VerifyOutcome {
    /// The finger matched an enrolled print.
    Verified,
    /// A bad read, not a rejection — fprintd keeps the scanner armed and will
    /// send another `VerifyStatus`, so the caller must keep listening.
    Retry,
    /// Verification is over and it did not succeed.
    Failed(BiometricError),
}

/// Translate one fprintd `VerifyStatus` result string.
///
/// The strings are fprintd's public D-Bus vocabulary (`net.reactivated.Fprint`),
/// not libfprint internals. Anything unrecognised is treated as a failure rather
/// than a retry: a future fprintd adding a new terminal code must not put this
/// crate into a loop waiting for a signal that will never come.
pub(crate) fn fprintd_verify(result: &str) -> VerifyOutcome {
    match result {
        "verify-match" => VerifyOutcome::Verified,
        "verify-retry-scan"
        | "verify-swipe-too-short"
        | "verify-finger-not-centered"
        | "verify-remove-and-retry" => VerifyOutcome::Retry,
        "verify-no-match" => VerifyOutcome::Failed(BiometricError::AuthenticationFailed(
            "The fingerprint did not match any enrolled finger".to_string(),
        )),
        "verify-disconnected" => VerifyOutcome::Failed(BiometricError::NotAvailable(
            "The fingerprint reader was disconnected during verification".to_string(),
        )),
        "verify-unknown-error" => VerifyOutcome::Failed(BiometricError::AuthenticationFailed(
            "fprintd reported an unknown error while verifying".to_string(),
        )),
        unknown => VerifyOutcome::Failed(BiometricError::AuthenticationFailed(format!(
            "fprintd reported an unrecognised verification result ({unknown})"
        ))),
    }
}

/// Translate a D-Bus error name raised by fprintd, or by the bus on its behalf.
///
/// `detail` is fprintd's own message; it is only forwarded for errors this table
/// has nothing better to say about, so a caller never sees two descriptions of
/// the same condition.
pub(crate) fn fprintd_error(name: &str, detail: &str) -> BiometricError {
    match name {
        "net.reactivated.Fprint.Error.NoSuchDevice" => BiometricError::NotAvailable(
            "fprintd found no fingerprint reader on this system".to_string(),
        ),
        "net.reactivated.Fprint.Error.NoEnrolledPrints" => BiometricError::NotEnrolled,
        "net.reactivated.Fprint.Error.AlreadyInUse" => BiometricError::NotAvailable(
            "The fingerprint reader is already claimed by another application".to_string(),
        ),
        "net.reactivated.Fprint.Error.ClaimDevice" => BiometricError::NotAvailable(
            "The fingerprint reader could not be claimed for this request".to_string(),
        ),
        "net.reactivated.Fprint.Error.PermissionDenied" => BiometricError::NotAvailable(
            "polkit refused this application access to the fingerprint reader".to_string(),
        ),
        "net.reactivated.Fprint.Error.InvalidFingername" => BiometricError::AuthenticationFailed(
            "fprintd rejected the requested finger name".to_string(),
        ),
        "net.reactivated.Fprint.Error.Internal" => {
            BiometricError::AuthenticationFailed("fprintd reported an internal error".to_string())
        }
        // The bus, not fprintd: nothing is listening on net.reactivated.Fprint.
        "org.freedesktop.DBus.Error.ServiceUnknown"
        | "org.freedesktop.DBus.Error.NameHasNoOwner" => BiometricError::NotAvailable(
            "fprintd is not installed or not running on this system".to_string(),
        ),
        "org.freedesktop.DBus.Error.AccessDenied" => BiometricError::NotAvailable(
            "The D-Bus policy on this system denies access to fprintd".to_string(),
        ),
        other if detail.is_empty() => {
            BiometricError::NotAvailable(format!("fprintd returned {other}"))
        }
        other => BiometricError::NotAvailable(format!("fprintd returned {other}: {detail}")),
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Windows availability ────────────────────────────────────────────────

    #[test]
    fn only_available_reports_hello() {
        let status = windows_availability(AVAILABILITY_AVAILABLE);
        assert!(status.available);
        assert_eq!(status.biometric_type, BiometricType::WindowsHello);
        assert!(status.reason.is_none());
    }

    #[test]
    fn every_unavailable_code_explains_itself_differently() {
        let codes = [
            AVAILABILITY_DEVICE_NOT_PRESENT,
            AVAILABILITY_NOT_CONFIGURED_FOR_USER,
            AVAILABILITY_DISABLED_BY_POLICY,
            AVAILABILITY_DEVICE_BUSY,
        ];
        let mut reasons = Vec::new();
        for code in codes {
            let status = windows_availability(code);
            assert!(!status.available, "code {code} claimed to be available");
            assert_eq!(status.biometric_type, BiometricType::None);
            let reason = status.reason.expect("unavailable status must say why");
            assert!(!reason.is_empty());
            reasons.push(reason);
        }
        reasons.sort();
        let distinct = reasons.len();
        reasons.dedup();
        assert_eq!(reasons.len(), distinct, "two codes share one reason string");
    }

    #[test]
    fn unknown_availability_code_is_unavailable_and_names_the_code() {
        let status = windows_availability(99);
        assert!(!status.available);
        assert_eq!(status.biometric_type, BiometricType::None);
        assert!(status.reason.unwrap().contains("99"));
    }

    // ── Windows consent ─────────────────────────────────────────────────────

    #[test]
    fn verified_is_the_only_success() {
        assert!(windows_consent(CONSENT_VERIFIED).is_ok());
        for code in [
            CONSENT_DEVICE_NOT_PRESENT,
            CONSENT_NOT_CONFIGURED_FOR_USER,
            CONSENT_DISABLED_BY_POLICY,
            CONSENT_DEVICE_BUSY,
            CONSENT_RETRIES_EXHAUSTED,
            CONSENT_CANCELED,
        ] {
            assert!(windows_consent(code).is_err(), "code {code} was accepted");
        }
    }

    #[test]
    fn consent_codes_map_to_their_documented_errors() {
        assert!(matches!(
            windows_consent(CONSENT_CANCELED),
            Err(BiometricError::UserCancelled)
        ));
        assert!(matches!(
            windows_consent(CONSENT_DEVICE_NOT_PRESENT),
            Err(BiometricError::NotEnrolled)
        ));
        assert!(matches!(
            windows_consent(CONSENT_NOT_CONFIGURED_FOR_USER),
            Err(BiometricError::NotEnrolled)
        ));
        assert!(matches!(
            windows_consent(CONSENT_DISABLED_BY_POLICY),
            Err(BiometricError::NotAvailable(_))
        ));
        assert!(matches!(
            windows_consent(CONSENT_DEVICE_BUSY),
            Err(BiometricError::NotAvailable(_))
        ));
        assert!(matches!(
            windows_consent(CONSENT_RETRIES_EXHAUSTED),
            Err(BiometricError::AuthenticationFailed(_))
        ));
    }

    #[test]
    fn cancelled_is_never_confused_with_failed() {
        // The login UI treats these differently: a cancellation is the user
        // changing their mind, a failure is worth surfacing as an error.
        let cancelled = windows_consent(CONSENT_CANCELED).unwrap_err().to_string();
        let exhausted = windows_consent(CONSENT_RETRIES_EXHAUSTED)
            .unwrap_err()
            .to_string();
        assert_ne!(cancelled, exhausted);
    }

    #[test]
    fn unknown_consent_code_fails_and_names_the_code() {
        let err = windows_consent(-7).unwrap_err();
        assert!(matches!(err, BiometricError::AuthenticationFailed(_)));
        assert!(err.to_string().contains("-7"));
    }

    // ── Credential target names ─────────────────────────────────────────────

    #[test]
    fn target_name_joins_service_and_account() {
        assert_eq!(
            credential_target_name("com.bettercloudflare.biometric", "bc_key-1").unwrap(),
            "com.bettercloudflare.biometric:bc_key-1"
        );
    }

    #[test]
    fn distinct_accounts_get_distinct_target_names() {
        let one = credential_target_name("svc", "a").unwrap();
        let two = credential_target_name("svc", "b").unwrap();
        assert_ne!(one, two);
    }

    #[test]
    fn target_name_rejects_an_empty_half() {
        assert!(matches!(
            credential_target_name("", "account"),
            Err(BiometricError::StoreError(_))
        ));
        assert!(matches!(
            credential_target_name("service", ""),
            Err(BiometricError::StoreError(_))
        ));
    }

    #[test]
    fn target_name_rejects_a_separator_in_the_service() {
        // Without this, ("a:b", "c") and ("a", "b:c") would collide.
        assert!(credential_target_name("a:b", "c").is_err());
        let ambiguous = credential_target_name("a", "b:c").unwrap();
        assert_eq!(ambiguous, "a:b:c");
    }

    #[test]
    fn target_name_rejects_an_interior_nul() {
        assert!(credential_target_name("svc\0evil", "account").is_err());
        assert!(credential_target_name("svc", "acc\0ount").is_err());
    }

    #[test]
    fn target_name_rejects_an_overlong_name() {
        let long = "a".repeat(CRED_MAX_TARGET_NAME);
        assert!(credential_target_name("svc", &long).is_err());
        // One unit under the limit, counting the separator, still fits.
        let fits = "a".repeat(CRED_MAX_TARGET_NAME - "svc".len() - 1);
        assert!(credential_target_name("svc", &fits).is_ok());
    }

    #[test]
    fn target_name_length_is_counted_in_utf16_units() {
        // An astral-plane char is one `char` but two UTF-16 units, and it is the
        // UTF-16 count that CredWriteW measures.
        let emoji = "\u{1F600}".repeat(CRED_MAX_TARGET_NAME / 2);
        assert!(credential_target_name("s", &emoji).is_err());
    }

    // ── fprintd verify results ──────────────────────────────────────────────

    #[test]
    fn only_verify_match_succeeds() {
        assert!(matches!(
            fprintd_verify("verify-match"),
            VerifyOutcome::Verified
        ));
        for other in [
            "verify-no-match",
            "verify-disconnected",
            "verify-unknown-error",
        ] {
            assert!(
                matches!(fprintd_verify(other), VerifyOutcome::Failed(_)),
                "{other} should be terminal failure"
            );
        }
    }

    #[test]
    fn transient_scan_problems_ask_for_a_retry() {
        for retry in [
            "verify-retry-scan",
            "verify-swipe-too-short",
            "verify-finger-not-centered",
            "verify-remove-and-retry",
        ] {
            assert!(
                matches!(fprintd_verify(retry), VerifyOutcome::Retry),
                "{retry}"
            );
        }
    }

    #[test]
    fn an_unknown_verify_result_fails_rather_than_looping() {
        // Treating an unrecognised code as Retry would wait for a signal that a
        // finished verification will never send.
        let outcome = fprintd_verify("verify-brand-new-code");
        match outcome {
            VerifyOutcome::Failed(err) => {
                assert!(err.to_string().contains("verify-brand-new-code"));
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_rejected_finger_is_not_reported_as_hardware_trouble() {
        assert!(matches!(
            fprintd_verify("verify-no-match"),
            VerifyOutcome::Failed(BiometricError::AuthenticationFailed(_))
        ));
        assert!(matches!(
            fprintd_verify("verify-disconnected"),
            VerifyOutcome::Failed(BiometricError::NotAvailable(_))
        ));
    }

    // ── fprintd D-Bus errors ────────────────────────────────────────────────

    #[test]
    fn no_enrolled_prints_is_not_enrolled() {
        assert!(matches!(
            fprintd_error("net.reactivated.Fprint.Error.NoEnrolledPrints", ""),
            BiometricError::NotEnrolled
        ));
    }

    #[test]
    fn a_missing_fprintd_service_says_so() {
        let err = fprintd_error("org.freedesktop.DBus.Error.ServiceUnknown", "no such name");
        assert!(matches!(err, BiometricError::NotAvailable(_)));
        assert!(err.to_string().contains("fprintd is not installed"));
    }

    #[test]
    fn known_fprintd_errors_do_not_echo_the_raw_detail() {
        // The table's own wording is better than fprintd's, and forwarding both
        // would describe one condition twice.
        let err = fprintd_error(
            "net.reactivated.Fprint.Error.NoSuchDevice",
            "No devices available",
        );
        assert!(!err.to_string().contains("No devices available"));
    }

    #[test]
    fn an_unknown_fprintd_error_forwards_what_it_knows() {
        let named = fprintd_error("net.reactivated.Fprint.Error.Future", "something odd");
        assert!(named
            .to_string()
            .contains("net.reactivated.Fprint.Error.Future"));
        assert!(named.to_string().contains("something odd"));

        let bare = fprintd_error("net.reactivated.Fprint.Error.Future", "");
        assert!(bare
            .to_string()
            .contains("net.reactivated.Fprint.Error.Future"));
    }

    #[test]
    fn every_fprintd_error_name_maps_to_a_nonempty_message() {
        for name in [
            "net.reactivated.Fprint.Error.NoSuchDevice",
            "net.reactivated.Fprint.Error.NoEnrolledPrints",
            "net.reactivated.Fprint.Error.AlreadyInUse",
            "net.reactivated.Fprint.Error.ClaimDevice",
            "net.reactivated.Fprint.Error.PermissionDenied",
            "net.reactivated.Fprint.Error.InvalidFingername",
            "net.reactivated.Fprint.Error.Internal",
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "org.freedesktop.DBus.Error.AccessDenied",
        ] {
            assert!(
                !fprintd_error(name, "").to_string().is_empty(),
                "{name} produced an empty message"
            );
        }
    }
}
