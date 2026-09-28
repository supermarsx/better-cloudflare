//! Windows Hello verification, and secret storage in Credential Manager.
//!
//! # What the OS enforces here, and what this process enforces
//!
//! The macOS backend gets one guarantee from the platform that this one
//! cannot: the keychain item carries a `SecAccessControl` ACL, and the
//! OS refuses to decrypt it until Touch ID succeeds — for *any* process that
//! asks, including a future attacker's. There, the biometric is part of the
//! storage.
//!
//! Windows offers unpackaged desktop apps no equivalent, so this module composes
//! two independent services that know nothing about each other:
//!
//! - **The prompt.** `UserConsentVerifier` raises the genuine Windows Hello
//!   dialog and reports whether the user satisfied it.
//! - **The storage.** The secret is a generic credential in Windows Credential
//!   Manager, encrypted at rest under the user's logon credentials.
//!
//! [`get_protected_secret`] calls [`authenticate`] first and refuses to read on
//! failure — but that gate lives in *this* binary, not in the credential store.
//! Any process already running as this user can call `CredReadW` on the same
//! target name and get the plaintext with no prompt of any kind. The gate stops
//! someone at an unlocked, unattended machine using *this app*; it does not stop
//! code that is already running as the user. That is a weaker property than the
//! macOS backend's, and it is a platform limit rather than an oversight.
//!
//! One more thing worth not overstating: Windows counts the **PIN** as a Hello
//! verifier. On a machine with Hello configured but no fingerprint reader and no
//! camera, [`status`] reports `available: true` and the prompt asks for a PIN. So
//! "Windows Hello is available" is a claim about what will be prompted, not
//! evidence that any biometric hardware exists.
//!
//! # Threading
//!
//! Every WinRT call below runs on a private thread this module spawns and joins,
//! initialised into the multithreaded apartment. That is not defensive
//! boilerplate. `IAsyncOperation::get()` blocks on an event without pumping
//! messages, and `biometric_status` is a *synchronous* Tauri command, so it
//! arrives on the window's own thread — an STA with a live message loop.
//! Blocking there would deadlock the wait against the pump it depends on. Owning
//! the apartment we run in makes the caller's apartment irrelevant.

use std::ffi::c_void;
use std::ptr;
use std::sync::{Mutex, MutexGuard};

use ::windows::core::{HSTRING, PCWSTR, PWSTR};
use ::windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
use ::windows::Win32::Foundation::{ERROR_NOT_FOUND, HWND, RPC_E_CHANGED_MODE};
use ::windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE,
    CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use ::windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use ::windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use ::windows::Win32::UI::Input::KeyboardAndMouse::GetActiveWindow;
use ::windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use ::windows_future::IAsyncOperation;
use zeroize::Zeroize;

use crate::mapping;
use crate::{BiometricError, BiometricStatus, BiometricType};

// ─── Public interface ───────────────────────────────────────────────────────

/// Ask Windows whether this user has a Hello verifier configured.
///
/// Never panics and never prompts. Anything that goes wrong reaching WinRT — a
/// COM apartment we could not enter, a missing runtime class, a worker thread
/// that died — is reported as unavailable with the failure as the reason, which
/// is what a caller deciding whether to offer a biometric button needs.
pub fn status() -> BiometricStatus {
    let availability = on_mta_thread(|| {
        let operation = UserConsentVerifier::CheckAvailabilityAsync()
            .map_err(|err| winrt_error("UserConsentVerifier.CheckAvailabilityAsync", &err))?;
        let availability = operation
            .get()
            .map_err(|err| winrt_error("UserConsentVerifier.CheckAvailabilityAsync", &err))?;
        Ok(availability.0)
    });

    match availability {
        Ok(code) => mapping::windows_availability(code),
        Err(err) => BiometricStatus {
            available: false,
            biometric_type: BiometricType::None,
            reason: Some(err.to_string()),
        },
    }
}

/// Raise the Windows Hello prompt and wait for the user to answer it.
///
/// `reason` becomes the message in the system dialog.
///
/// A desktop process cannot call `UserConsentVerifier::RequestVerificationAsync`
/// — that entry point assumes a packaged app with an implicit window, and here it
/// fails at runtime. The prompt has to be requested through
/// `IUserConsentVerifierInterop`, which takes the `HWND` it should appear over.
pub fn authenticate(reason: &str) -> Result<(), BiometricError> {
    // Resolved on the *calling* thread, deliberately. `GetActiveWindow` reads the
    // calling thread's message queue, so it can only answer on a thread that owns
    // a window — which is exactly the synchronous-command case. Asking from the
    // worker would throw that answer away and always fall through to null.
    let owner = owner_window()?;
    let message = HSTRING::from(reason);

    on_mta_thread(move || {
        let interop =
            ::windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|err| winrt_error("IUserConsentVerifierInterop activation", &err))?;

        // SAFETY: `owner` was a live top-level window handle a moment ago and is
        // only read by the consent broker; a window closed in between yields an
        // E_HANDLE-class failure from the call, which is handled below rather
        // than being undefined. `message` outlives the call.
        let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(HWND(owner as *mut c_void), &message)
        }
        .map_err(|err| winrt_error("RequestVerificationForWindowAsync", &err))?;

        // Blocks for as long as the user leaves the dialog open. That is the
        // contract the macOS backend already has, and the reason the Tauri
        // command wrapping this runs on a blocking worker.
        let result = operation
            .get()
            .map_err(|err| winrt_error("RequestVerificationForWindowAsync", &err))?;

        mapping::windows_consent(result.0)
    })
}

/// Write `secret` to Credential Manager, replacing any credential already stored
/// for this `service`/`account`.
///
/// This does **not** prompt: enrolling a secret is not a release of one. The
/// credential is written with `CRED_PERSIST_LOCAL_MACHINE`, so it survives logoff
/// and reboot but never roams to another machine.
pub fn store_protected_secret(
    service: &str,
    account: &str,
    secret: &[u8],
) -> Result<(), BiometricError> {
    let target = mapping::credential_target_name(service, account)?;

    if secret.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(BiometricError::StoreError(format!(
            "Secret is {} bytes, over the {CRED_MAX_CREDENTIAL_BLOB_SIZE} that Credential Manager accepts",
            secret.len()
        )));
    }

    let mut target_w = wide(&target);
    // `credential_target_name` already rejected a NUL in either half, so neither
    // wide string can be truncated short of what the caller asked for.
    let mut user_w = wide(account);

    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_w.as_mut_ptr()),
        CredentialBlobSize: secret.len() as u32,
        // `CREDENTIALW` is the same struct `CredReadW` fills in, which is why
        // this field is `*mut`; `CredWriteW` only reads through it. Casting away
        // the shared reference avoids a second copy of the plaintext on the heap
        // — nothing writes through this pointer.
        CredentialBlob: secret.as_ptr().cast_mut(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(user_w.as_mut_ptr()),
        ..Default::default()
    };

    let _credential_set = credential_set();
    // SAFETY: every pointer in `credential` borrows a local that outlives this
    // call, and `CredWriteW` retains nothing after it returns.
    unsafe { CredWriteW(&credential, 0) }
        .map_err(|err| BiometricError::StoreError(format!("CredWriteW failed: {}", describe(&err))))
}

/// Prompt for Windows Hello, then read the stored secret.
///
/// The ordering is the whole security property this function has, and it is
/// enforced here rather than by the credential store — see the module docs. A
/// failed or cancelled prompt returns before `CredReadW` is ever called.
pub fn get_protected_secret(
    service: &str,
    account: &str,
    reason: &str,
) -> Result<Vec<u8>, BiometricError> {
    // Ahead of the prompt on purpose: a name this crate will not store must not
    // cost the user a Hello gesture first.
    let target = mapping::credential_target_name(service, account)?;
    authenticate(reason)?;
    read_credential(&target)?.ok_or(BiometricError::NotFound)
}

/// Remove the credential for this `service`/`account`.
///
/// A credential that is already gone is success: the caller asked for it to not
/// exist, and it does not. The macOS backend treats `errSecItemNotFound` the same
/// way.
pub fn delete_protected_secret(service: &str, account: &str) -> Result<(), BiometricError> {
    let target = mapping::credential_target_name(service, account)?;
    let target_w = wide(&target);

    let _credential_set = credential_set();
    // SAFETY: `target_w` is NUL-terminated and outlives the call.
    match unsafe { CredDeleteW(PCWSTR(target_w.as_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(err) if is_not_found(&err) => Ok(()),
        Err(err) => Err(BiometricError::StoreError(format!(
            "CredDeleteW failed: {}",
            describe(&err)
        ))),
    }
}

/// Report whether a secret is stored, without prompting.
///
/// Credential Manager has no existence query — `CredReadW` is the only way to ask
/// — so this does read the plaintext. It is scrubbed from this process's heap
/// before returning and never crosses the function boundary. The absence of a
/// prompt here opens nothing: as the module docs explain, reading the credential
/// never needed one.
pub fn has_protected_secret(service: &str, account: &str) -> Result<bool, BiometricError> {
    let target = mapping::credential_target_name(service, account)?;
    match read_credential(&target)? {
        Some(mut secret) => {
            secret.zeroize();
            Ok(true)
        }
        None => Ok(false),
    }
}

// ─── Credential Manager ─────────────────────────────────────────────────────

/// Serialises this process's Credential Manager calls.
///
/// Measured, not theoretical. Running this module's storage tests in parallel
/// loses deletes: a credential the test had deleted — and that `CredReadW` then
/// agreed was gone — was still listed by `cmdkey /list` afterwards, on roughly
/// half the runs. The same suite run with `--test-threads=1` never reproduced it.
/// The `Cred*W` functions read, modify and write back the logon session's whole
/// credential set, and nothing documents them as safe to interleave, so this
/// process at least does not race against itself.
///
/// The lock covers only the credential call, never the Hello prompt.
/// [`has_protected_secret`] is reachable from a synchronous Tauri command running
/// on the window thread, and must not be made to wait behind a dialog the user
/// has not answered yet.
static CREDENTIAL_SET: Mutex<()> = Mutex::new(());

/// Take [`CREDENTIAL_SET`], ignoring poisoning: the guarded value is `()`, so a
/// panic elsewhere leaves no invalid state for this lock to protect.
fn credential_set() -> MutexGuard<'static, ()> {
    CREDENTIAL_SET
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Read the credential blob for `target`, or `None` if there is no such
/// credential.
///
/// The `CREDENTIALW` that `CredReadW` allocates is released on every path, and
/// the store's copy of the plaintext is zeroed before the block goes back to the
/// heap. The `Vec` handed back is the caller's to zeroize if it will not be
/// returned onwards.
fn read_credential(target: &str) -> Result<Option<Vec<u8>>, BiometricError> {
    let target_w = wide(target);
    let mut credential: *mut CREDENTIALW = ptr::null_mut();

    // Held until this function returns. The `CREDENTIALW` block belongs to us
    // alone once `CredReadW` has handed it over, so the copy and the `CredFree`
    // do not need protecting — keeping one scope is simply the version with
    // nothing to get wrong.
    let _credential_set = credential_set();

    // SAFETY: `target_w` is NUL-terminated and outlives the call. On success
    // `credential` receives one allocation, which is freed below.
    let read = unsafe {
        CredReadW(
            PCWSTR(target_w.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut credential,
        )
    };
    if let Err(err) = read {
        return if is_not_found(&err) {
            Ok(None)
        } else {
            Err(BiometricError::StoreError(format!(
                "CredReadW failed: {}",
                describe(&err)
            )))
        };
    }
    if credential.is_null() {
        // Documented as impossible after success; treated as "no credential"
        // rather than dereferenced on the strength of that.
        return Ok(None);
    }

    // SAFETY: `CredReadW` succeeded and handed back a non-null pointer, so this
    // is the single `CREDENTIALW` it allocated and `CredentialBlob` is valid for
    // `CredentialBlobSize` bytes. Nothing between here and `CredFree` can unwind
    // — the only fallible step is a `Vec` allocation, and that aborts.
    let secret = unsafe {
        let len = (*credential).CredentialBlobSize as usize;
        let blob = (*credential).CredentialBlob;

        let secret = if len == 0 || blob.is_null() {
            Vec::new()
        } else {
            let copy = std::slice::from_raw_parts(blob, len).to_vec();
            // Scrub the store's copy before the block is recycled. The shared
            // borrow above has ended, so this is the only live reference.
            std::slice::from_raw_parts_mut(blob, len).zeroize();
            copy
        };

        CredFree(credential as *const c_void);
        secret
    };

    Ok(Some(secret))
}

/// Whether a credential API failed because the credential does not exist.
///
/// The `Cred*W` functions report this as `ERROR_NOT_FOUND` through
/// `GetLastError`, which `windows` has already folded into an `HRESULT` by the
/// time it reaches here.
fn is_not_found(err: &::windows::core::Error) -> bool {
    err.code() == ::windows::core::HRESULT::from_win32(ERROR_NOT_FOUND.0)
}

/// NUL-terminated UTF-16 copy of `value` for the `W` credential APIs.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

// ─── WinRT plumbing ─────────────────────────────────────────────────────────

/// Run `job` on a private thread inside the multithreaded apartment.
///
/// See the module docs for why the apartment cannot be inherited from the
/// caller. A panic in `job` is caught by the join and turned into an error: a
/// biometric backend must not be able to take the app down through a WinRT
/// surprise.
fn on_mta_thread<T, F>(job: F) -> Result<T, BiometricError>
where
    F: FnOnce() -> Result<T, BiometricError> + Send + 'static,
    T: Send + 'static,
{
    std::thread::Builder::new()
        .name("bc-biometrics-hello".to_string())
        .spawn(move || {
            let _apartment = Mta::enter()?;
            job()
        })
        .map_err(|err| {
            BiometricError::NotAvailable(format!(
                "Could not start the Windows Hello worker thread: {err}"
            ))
        })?
        .join()
        .map_err(|_| {
            BiometricError::AuthenticationFailed(
                "The Windows Hello worker thread panicked".to_string(),
            )
        })?
}

/// This thread's COM apartment, uninitialised again on drop.
struct Mta {
    /// Whether this guard is the one that initialised the apartment and so owes
    /// the matching `CoUninitialize`. `RPC_E_CHANGED_MODE` means someone else
    /// owns it and there is nothing to balance.
    owned: bool,
}

impl Mta {
    fn enter() -> Result<Self, BiometricError> {
        // SAFETY: called once at the top of a thread this module just created, so
        // there is no prior COM state on it to disturb.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };

        if hr == RPC_E_CHANGED_MODE {
            // Cannot happen on a thread we own; handled rather than asserted so
            // the refcount stays balanced if it ever does.
            return Ok(Self { owned: false });
        }
        if hr.is_err() {
            return Err(BiometricError::NotAvailable(format!(
                "Could not enter a COM apartment for Windows Hello: {} (0x{:08X})",
                hr.message(),
                hr.0
            )));
        }
        // S_OK and S_FALSE both count: both increment the refcount.
        Ok(Self { owned: true })
    }
}

impl Drop for Mta {
    fn drop(&mut self) {
        if self.owned {
            // SAFETY: balances exactly one successful `CoInitializeEx` in
            // `enter`, on the same thread.
            unsafe { CoUninitialize() };
        }
    }
}

/// The window the Hello dialog should appear over.
///
/// Returns the raw handle as an `isize` because `HWND` is not `Send` and this
/// value has to cross into the worker thread.
///
/// `GetForegroundWindow` is the desktop-wide foreground window, so if the user
/// switched away between clicking Unlock and this call, the prompt parents to
/// whatever they switched to. It still appears and still verifies; it is placed
/// oddly. `GetActiveWindow` is the fallback, and only answers on a thread that
/// owns a window.
fn owner_window() -> Result<isize, BiometricError> {
    // SAFETY: both are reads of window-manager state with no preconditions; they
    // return a null handle rather than failing.
    let window = unsafe { GetForegroundWindow() };
    let window = if window.is_invalid() {
        // SAFETY: as above.
        unsafe { GetActiveWindow() }
    } else {
        window
    };

    if window.is_invalid() {
        return Err(BiometricError::NotAvailable(
            "No window is available to host the Windows Hello prompt".to_string(),
        ));
    }
    Ok(window.0 as isize)
}

/// Describe a failure reaching WinRT, naming the call that failed.
fn winrt_error(call: &str, err: &::windows::core::Error) -> BiometricError {
    BiometricError::NotAvailable(format!("{call} failed: {}", describe(err)))
}

/// Render a Windows error as its message plus the raw `HRESULT`.
///
/// The code is kept because the message for an unusual `HRESULT` is often
/// generic, and this string ends up in the audit entry that
/// `commands::auth::biometric_audit_entry` writes.
fn describe(err: &::windows::core::Error) -> String {
    format!("{} (0x{:08X})", err.message(), err.code().0)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ::windows::Security::Credentials::UI::UserConsentVerifierAvailability;

    /// Target name used by the storage tests. Distinct from
    /// [`crate::DEFAULT_SERVICE`] so a test run cannot disturb a real enrolment.
    const TEST_SERVICE: &str = "com.bettercloudflare.biometric.test";

    /// [`crate::mapping`] hard-codes these numbers so its tables can be tested
    /// away from Windows. This is the test that notices if a future Windows SDK
    /// renumbers the enums — without it, the tables would keep passing their own
    /// tests while mapping "cancelled" onto something else entirely.
    #[test]
    fn availability_constants_match_the_windows_sdk() {
        assert_eq!(
            UserConsentVerifierAvailability::Available.0,
            mapping::AVAILABILITY_AVAILABLE
        );
        assert_eq!(
            UserConsentVerifierAvailability::DeviceNotPresent.0,
            mapping::AVAILABILITY_DEVICE_NOT_PRESENT
        );
        assert_eq!(
            UserConsentVerifierAvailability::NotConfiguredForUser.0,
            mapping::AVAILABILITY_NOT_CONFIGURED_FOR_USER
        );
        assert_eq!(
            UserConsentVerifierAvailability::DisabledByPolicy.0,
            mapping::AVAILABILITY_DISABLED_BY_POLICY
        );
        assert_eq!(
            UserConsentVerifierAvailability::DeviceBusy.0,
            mapping::AVAILABILITY_DEVICE_BUSY
        );
    }

    #[test]
    fn consent_constants_match_the_windows_sdk() {
        assert_eq!(
            UserConsentVerificationResult::Verified.0,
            mapping::CONSENT_VERIFIED
        );
        assert_eq!(
            UserConsentVerificationResult::DeviceNotPresent.0,
            mapping::CONSENT_DEVICE_NOT_PRESENT
        );
        assert_eq!(
            UserConsentVerificationResult::NotConfiguredForUser.0,
            mapping::CONSENT_NOT_CONFIGURED_FOR_USER
        );
        assert_eq!(
            UserConsentVerificationResult::DisabledByPolicy.0,
            mapping::CONSENT_DISABLED_BY_POLICY
        );
        assert_eq!(
            UserConsentVerificationResult::DeviceBusy.0,
            mapping::CONSENT_DEVICE_BUSY
        );
        assert_eq!(
            UserConsentVerificationResult::RetriesExhausted.0,
            mapping::CONSENT_RETRIES_EXHAUSTED
        );
        assert_eq!(
            UserConsentVerificationResult::Canceled.0,
            mapping::CONSENT_CANCELED
        );
    }

    #[test]
    fn wide_is_nul_terminated() {
        assert_eq!(wide("ab"), vec![0x61, 0x62, 0x00]);
        assert_eq!(wide(""), vec![0x00]);
    }

    #[test]
    fn wide_splits_astral_characters_into_a_surrogate_pair() {
        // Two UTF-16 units plus the terminator, not one `char` plus a terminator.
        assert_eq!(wide("\u{1F600}").len(), 3);
    }

    /// Exercises the real COM apartment, the thread hand-off, and the
    /// `CheckAvailability` round trip. What this machine answers depends on
    /// whether Hello is set up, so the assertion is about shape rather than
    /// verdict — but it does prove the WinRT path runs, which no mapping test
    /// can.
    #[test]
    fn status_round_trips_through_winrt() {
        let status = status();
        if status.available {
            assert_eq!(status.biometric_type, BiometricType::WindowsHello);
        } else {
            assert!(
                status.reason.is_some_and(|reason| !reason.is_empty()),
                "an unavailable status must explain itself"
            );
        }
    }

    #[test]
    fn a_worker_panic_becomes_an_error_not_a_crash() {
        let outcome: Result<(), _> = on_mta_thread(|| panic!("boom"));
        assert!(matches!(
            outcome,
            Err(BiometricError::AuthenticationFailed(_))
        ));
    }

    #[test]
    fn the_worker_enters_and_leaves_an_apartment_repeatedly() {
        // An unbalanced `CoUninitialize` would show up on a later pass.
        for _ in 0..4 {
            assert_eq!(on_mta_thread(|| Ok(7)).unwrap(), 7);
        }
    }

    /// The malformed-name guard has to hold on every operation that reaches the
    /// credential store, and on `get_protected_secret` it has to hold before any
    /// prompt is raised.
    #[test]
    fn a_rejected_target_name_fails_before_prompting() {
        assert!(matches!(
            store_protected_secret("", "account", b"secret"),
            Err(BiometricError::StoreError(_))
        ));
        assert!(matches!(
            get_protected_secret("svc:bad", "account", "Unlock"),
            Err(BiometricError::StoreError(_))
        ));
        assert!(matches!(
            delete_protected_secret("svc", ""),
            Err(BiometricError::StoreError(_))
        ));
        assert!(matches!(
            has_protected_secret("svc\0", "account"),
            Err(BiometricError::StoreError(_))
        ));
    }

    #[test]
    fn an_oversized_secret_is_refused_rather_than_truncated() {
        let secret = vec![0u8; CRED_MAX_CREDENTIAL_BLOB_SIZE as usize + 1];
        assert!(matches!(
            store_protected_secret(TEST_SERVICE, "oversize", &secret),
            Err(BiometricError::StoreError(_))
        ));
    }

    /// A full write / read-back / delete cycle against the real Credential
    /// Manager, skipping the prompt: `read_credential` is the half of
    /// `get_protected_secret` that runs *after* Hello succeeds, so this covers
    /// the storage path — `CredWriteW`, `CredReadW`, the blob scrub, `CredFree` —
    /// without needing a gesture.
    #[test]
    fn credentials_round_trip_through_credential_manager() {
        let scratch = Scratch::new("roundtrip");

        // Leave nothing behind from an earlier interrupted run.
        delete_protected_secret(TEST_SERVICE, &scratch.account).unwrap();
        assert!(!has_protected_secret(TEST_SERVICE, &scratch.account).unwrap());
        assert!(read_credential(&scratch.target).unwrap().is_none());

        store_protected_secret(TEST_SERVICE, &scratch.account, b"first value").unwrap();
        assert!(has_protected_secret(TEST_SERVICE, &scratch.account).unwrap());
        assert_eq!(
            read_credential(&scratch.target).unwrap().unwrap(),
            b"first value".to_vec()
        );

        // A second write replaces rather than duplicating or failing.
        store_protected_secret(TEST_SERVICE, &scratch.account, b"second value").unwrap();
        assert_eq!(
            read_credential(&scratch.target).unwrap().unwrap(),
            b"second value".to_vec()
        );

        delete_protected_secret(TEST_SERVICE, &scratch.account).unwrap();
        assert!(!has_protected_secret(TEST_SERVICE, &scratch.account).unwrap());
        // Deleting twice is success, not an error.
        delete_protected_secret(TEST_SERVICE, &scratch.account).unwrap();
    }

    #[test]
    fn a_secret_at_the_size_limit_round_trips_intact() {
        let scratch = Scratch::new("maxsize");
        let secret: Vec<u8> = (0..CRED_MAX_CREDENTIAL_BLOB_SIZE)
            .map(|byte| byte as u8)
            .collect();

        store_protected_secret(TEST_SERVICE, &scratch.account, &secret).unwrap();
        let read_back = read_credential(&scratch.target).unwrap().unwrap();

        assert_eq!(read_back, secret);
    }

    /// Non-ASCII in the account name has to survive the UTF-16 round trip, or a
    /// secret stored under one name would be unreadable under the same name.
    #[test]
    fn a_non_ascii_account_round_trips() {
        let scratch = Scratch::new("café-\u{1F600}");
        store_protected_secret(TEST_SERVICE, &scratch.account, b"unicode").unwrap();
        assert!(has_protected_secret(TEST_SERVICE, &scratch.account).unwrap());
    }

    /// Several threads writing and reading their own credentials at once, which is
    /// what [`CREDENTIAL_SET`] exists to serialise.
    ///
    /// Be clear about what this does and does not prove. It proves each thread
    /// reads back exactly what it wrote, and that the lock does not deadlock. It
    /// cannot prove the lost-delete bug is gone: that one is only visible through
    /// `CredEnumerateW` from *another* process — inside the process that lost the
    /// delete, `CredReadW` cheerfully agrees the credential is gone. The fix was
    /// verified by watching `cmdkey /list` across repeated parallel runs.
    #[test]
    fn concurrent_credential_writes_do_not_corrupt_each_other() {
        let threads: Vec<_> = (0..8)
            .map(|index| {
                std::thread::spawn(move || {
                    let scratch = Scratch::new(&format!("concurrent-{index}"));
                    let secret = format!("value for thread {index}").into_bytes();
                    store_protected_secret(TEST_SERVICE, &scratch.account, &secret).unwrap();
                    let read_back = read_credential(&scratch.target).unwrap().unwrap();
                    assert_eq!(read_back, secret, "thread {index} read another's secret");
                })
            })
            .collect();

        for thread in threads {
            thread.join().expect("a worker thread panicked");
        }
    }

    /// One credential name, removed from Credential Manager when the test ends.
    ///
    /// The cleanup is in `Drop` rather than at the end of the test body because a
    /// failing assertion unwinds past the body: an earlier version of these tests
    /// littered the developer's real Credential Manager every time one of them
    /// went red. The name carries the PID so concurrent `cargo test` runs cannot
    /// collide.
    struct Scratch {
        account: String,
        target: String,
    }

    impl Scratch {
        fn new(prefix: &str) -> Self {
            let account = format!("{prefix}-{}", std::process::id());
            let target = mapping::credential_target_name(TEST_SERVICE, &account).unwrap();
            Self { account, target }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = delete_protected_secret(TEST_SERVICE, &self.account);
        }
    }
}
