//! Linux fingerprint verification via fprintd, and secret storage via Secret
//! Service.
//!
//! # Compile-verified, not run
//!
//! This module has never been executed. It was written and checked on a Windows
//! machine with `cargo check --target x86_64-unknown-linux-gnu`, which proves it
//! typechecks against real `zbus` and `secret-service` APIs and nothing more. No
//! fingerprint has been scanned through it, no D-Bus reply has been parsed by it.
//! Treat every branch below as unproven until someone runs it on a machine with
//! a reader. The pure parts — the `VerifyStatus` vocabulary and the D-Bus error
//! names — live in [`crate::mapping`] precisely so that they *are* tested.
//!
//! # What this protects, and what it does not
//!
//! Neither half of this backend enforces the other:
//!
//! - **The prompt.** fprintd's `net.reactivated.Fprint.Device` claims the reader,
//!   verifies one finger, and releases it. There is no dialog: fprintd has no UI,
//!   so `reason` cannot be shown to the user, and the scan is silent. The calling
//!   window is the only place to say why the sensor is waiting.
//! - **The storage.** Secret Service (`org.freedesktop.secrets` — gnome-keyring,
//!   KWallet) holds the secret in the user's default collection. Once that
//!   collection is unlocked, any process running as the user can read the item
//!   back without touching the sensor.
//!
//! So, exactly as on Windows, the gate in [`get_protected_secret`] is enforced by
//! *this* process rather than by the store. See the crate docs for what that is
//! and is not worth.
//!
//! # Deadlines
//!
//! Every entry point runs its D-Bus work under a deadline. Two of the six —
//! `status` and `has_protected_secret` — are reachable from a *synchronous* Tauri
//! command, which runs on the window's own thread, so a wedged fprintd or a
//! keyring daemon that never answers must not be able to freeze the UI. The
//! verification deadline is long because a person has to react to it, but it is
//! finite: a user who walks away must not pin a worker thread for ever.

use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;

use futures_lite::StreamExt;
use secret_service::{EncryptionType, SecretService};
use zbus::zvariant::OwnedObjectPath;
use zbus::Connection;

use crate::mapping::{self, VerifyOutcome};
use crate::{BiometricError, BiometricStatus, BiometricType};

// ─── Budgets ────────────────────────────────────────────────────────────────

/// Probing availability talks to fprintd twice and should be instant. This is
/// short because [`status`] can land on the UI thread.
const STATUS_BUDGET: Duration = Duration::from_secs(5);

/// How long the sensor stays armed waiting for a finger. Generous — there is a
/// person in the loop, and fprintd re-arms after every bad read.
const VERIFY_BUDGET: Duration = Duration::from_secs(90);

/// Secret Service calls can involve an unlock prompt from the keyring daemon,
/// which the user also has to answer.
const STORE_BUDGET: Duration = Duration::from_secs(60);

// ─── Secret Service item identity ───────────────────────────────────────────

/// Attribute keys used to find this crate's items. Secret Service has no
/// service/account concept of its own; a search is an exact match on attributes,
/// so the three below are what make an item ours and addressable.
const ATTR_APPLICATION: &str = "application";
const ATTR_SERVICE: &str = "service";
const ATTR_ACCOUNT: &str = "account";

/// Value of [`ATTR_APPLICATION`], so an item of ours is distinguishable in
/// Seahorse or KWalletManager from every other app's.
const APPLICATION: &str = "better-cloudflare";

/// MIME type recorded with the secret. The bytes are opaque to this crate, but
/// Secret Service requires a content type and keyring UIs display it.
const CONTENT_TYPE: &str = "application/octet-stream";

// ─── fprintd D-Bus interfaces ───────────────────────────────────────────────

/// `net.reactivated.Fprint.Manager` — finds the reader.
#[zbus::proxy(
    interface = "net.reactivated.Fprint.Manager",
    default_service = "net.reactivated.Fprint",
    default_path = "/net/reactivated/Fprint/Manager",
    gen_blocking = false
)]
trait FprintManager {
    /// Raises `net.reactivated.Fprint.Error.NoSuchDevice` when the machine has
    /// no reader.
    fn get_default_device(&self) -> zbus::Result<OwnedObjectPath>;
}

/// `net.reactivated.Fprint.Device` — one reader.
///
/// Every `username` argument here is passed as `""`, which fprintd reads as "the
/// caller". Naming another user needs a polkit authorisation this app has no
/// business asking for.
#[zbus::proxy(
    interface = "net.reactivated.Fprint.Device",
    default_service = "net.reactivated.Fprint",
    gen_blocking = false
)]
trait FprintDevice {
    /// Takes exclusive use of the reader. fprintd hands it to one client at a
    /// time, so this must always be paired with [`FprintDeviceProxy::release`].
    fn claim(&self, username: &str) -> zbus::Result<()>;

    fn release(&self) -> zbus::Result<()>;

    /// Arms the sensor. `finger_name` of `"any"` accepts any enrolled finger.
    fn verify_start(&self, finger_name: &str) -> zbus::Result<()>;

    fn verify_stop(&self) -> zbus::Result<()>;

    /// May raise `net.reactivated.Fprint.Error.NoEnrolledPrints` rather than
    /// returning an empty list, depending on the fprintd version — both are
    /// handled.
    fn list_enrolled_fingers(&self, username: &str) -> zbus::Result<Vec<String>>;

    /// Emitted for every scan attempt. `done` is false for a bad read that
    /// fprintd will retry, true when verification is over.
    #[zbus(signal)]
    fn verify_status(&self, result: String, done: bool) -> zbus::Result<()>;
}

// ─── Public interface ───────────────────────────────────────────────────────

/// Ask fprintd whether this user has a usable enrolled fingerprint.
///
/// Never panics and never arms the sensor. `available` is true only when a reader
/// exists *and* at least one finger is enrolled for the calling user; a reader
/// with nothing enrolled reports [`BiometricType::Fingerprint`] with a reason,
/// because the device is real and the remedy is enrolment.
pub fn status() -> BiometricStatus {
    let probed = run(
        STATUS_BUDGET,
        BiometricError::NotAvailable(format!(
            "fprintd did not answer within {}s",
            STATUS_BUDGET.as_secs()
        )),
        probe(),
    );

    probed.unwrap_or_else(|err| BiometricStatus {
        available: false,
        biometric_type: BiometricType::None,
        reason: Some(err.to_string()),
    })
}

/// Arm the sensor and wait for the user to present a finger.
///
/// `reason` is accepted for interface parity and cannot be used: fprintd has no
/// prompt of its own to put it in.
pub fn authenticate(reason: &str) -> Result<(), BiometricError> {
    let _ = reason;
    run(
        VERIFY_BUDGET,
        BiometricError::AuthenticationFailed(format!(
            "No fingerprint was presented within {}s",
            VERIFY_BUDGET.as_secs()
        )),
        verify(),
    )
}

/// Write `secret` to the user's default Secret Service collection, replacing any
/// item already stored for this `service`/`account`.
///
/// Does not scan: enrolling a secret is not a release of one.
pub fn store_protected_secret(
    service: &str,
    account: &str,
    secret: &[u8],
) -> Result<(), BiometricError> {
    run(
        STORE_BUDGET,
        store_timeout(),
        store(service, account, secret),
    )
}

/// Scan a fingerprint, then read the stored secret.
///
/// The ordering is the whole security property this function has, and it is
/// enforced here rather than by the keyring — see the module docs.
pub fn get_protected_secret(
    service: &str,
    account: &str,
    reason: &str,
) -> Result<Vec<u8>, BiometricError> {
    authenticate(reason)?;
    run(STORE_BUDGET, store_timeout(), read(service, account))?.ok_or(BiometricError::NotFound)
}

/// Remove the stored item for this `service`/`account`.
///
/// An item that is already gone is success: the caller asked for it to not exist,
/// and it does not.
pub fn delete_protected_secret(service: &str, account: &str) -> Result<(), BiometricError> {
    run(STORE_BUDGET, store_timeout(), remove(service, account))
}

/// Report whether a secret is stored, without scanning.
///
/// Unlike the Windows backend, this never touches the plaintext: Secret Service
/// answers a search with object paths, and the secret is only transferred when
/// asked for explicitly.
pub fn has_protected_secret(service: &str, account: &str) -> Result<bool, BiometricError> {
    run(STORE_BUDGET, store_timeout(), exists(service, account))
}

// ─── fprintd ────────────────────────────────────────────────────────────────

async fn probe() -> Result<BiometricStatus, BiometricError> {
    let connection = system_bus().await?;
    let device = default_device(&connection).await?;

    match device.list_enrolled_fingers("").await {
        Ok(fingers) if !fingers.is_empty() => Ok(BiometricStatus {
            available: true,
            biometric_type: BiometricType::Fingerprint,
            reason: None,
        }),
        // A reader with nothing enrolled: the hardware is real, so keep reporting
        // `Fingerprint` and let the caller tell the user what to do about it.
        Ok(_) => Ok(BiometricStatus {
            available: false,
            biometric_type: BiometricType::Fingerprint,
            reason: Some(
                "A fingerprint reader is present, but no fingerprints are enrolled for this user"
                    .to_string(),
            ),
        }),
        Err(err) => {
            let mapped = from_zbus(err);
            let enrolment_is_the_only_problem = matches!(mapped, BiometricError::NotEnrolled);
            Ok(BiometricStatus {
                available: false,
                biometric_type: if enrolment_is_the_only_problem {
                    BiometricType::Fingerprint
                } else {
                    BiometricType::None
                },
                reason: Some(if enrolment_is_the_only_problem {
                    "A fingerprint reader is present, but no fingerprints are enrolled for this user"
                        .to_string()
                } else {
                    mapped.to_string()
                }),
            })
        }
    }
}

async fn verify() -> Result<(), BiometricError> {
    let connection = system_bus().await?;
    let device = default_device(&connection).await?;

    // Checked before claiming: claiming a reader with nothing enrolled would arm
    // a sensor that cannot possibly match, and lock every other consumer out of
    // it while it waits.
    match device.list_enrolled_fingers("").await {
        Ok(fingers) if fingers.is_empty() => return Err(BiometricError::NotEnrolled),
        Ok(_) => {}
        Err(err) => return Err(from_zbus(err)),
    }

    device.claim("").await.map_err(from_zbus)?;
    let outcome = verify_claimed(&device).await;

    // Released however verification ended, including on the error paths. fprintd
    // gives the reader to one client at a time, and a leaked claim locks out
    // every other consumer on the machine — the lock screen included. Failures
    // here are swallowed deliberately: they would replace the outcome the user
    // actually cares about with a cleanup detail.
    let _ = device.verify_stop().await;
    let _ = device.release().await;

    outcome
}

/// Run one verification on an already-claimed device.
async fn verify_claimed(device: &FprintDeviceProxy<'_>) -> Result<(), BiometricError> {
    // Subscribed before arming, deliberately: fprintd can emit `VerifyStatus`
    // before the `VerifyStart` reply reaches us, and a signal sent before anyone
    // is listening is simply dropped.
    let mut updates = device.receive_verify_status().await.map_err(from_zbus)?;
    device.verify_start("any").await.map_err(from_zbus)?;

    while let Some(update) = updates.next().await {
        let args = update.args().map_err(|err| {
            BiometricError::AuthenticationFailed(format!(
                "Could not read an fprintd VerifyStatus signal: {err}"
            ))
        })?;

        match mapping::fprintd_verify(&args.result) {
            VerifyOutcome::Verified => return Ok(()),
            VerifyOutcome::Failed(err) => return Err(err),
            VerifyOutcome::Retry if args.done => {
                // fprintd says verification is over but gave a code that means
                // "try again". Waiting for another signal would hang.
                return Err(BiometricError::AuthenticationFailed(format!(
                    "fprintd ended verification on a retry result ({})",
                    args.result
                )));
            }
            VerifyOutcome::Retry => continue,
        }
    }

    Err(BiometricError::AuthenticationFailed(
        "The fprintd signal stream ended before verification finished".to_string(),
    ))
}

async fn system_bus() -> Result<Connection, BiometricError> {
    Connection::system().await.map_err(|err| {
        BiometricError::NotAvailable(format!("Could not reach the D-Bus system bus: {err}"))
    })
}

async fn default_device(
    connection: &Connection,
) -> Result<FprintDeviceProxy<'static>, BiometricError> {
    let manager = FprintManagerProxy::new(connection)
        .await
        .map_err(from_zbus)?;
    let path = manager.get_default_device().await.map_err(from_zbus)?;

    FprintDeviceProxy::builder(connection)
        .path(path)
        .map_err(|err| {
            BiometricError::NotAvailable(format!("fprintd named an unusable device path: {err}"))
        })?
        .build()
        .await
        .map_err(from_zbus)
}

/// Translate a zbus failure, preferring the D-Bus error name when there is one.
///
/// The name is what carries the meaning — `NoEnrolledPrints` and `NoSuchDevice`
/// need different answers — so it goes through [`mapping::fprintd_error`], which
/// is the tested half of this module.
fn from_zbus(err: zbus::Error) -> BiometricError {
    match &err {
        zbus::Error::MethodError(name, detail, _) => {
            mapping::fprintd_error(name.as_str(), detail.as_deref().unwrap_or_default())
        }
        other => BiometricError::NotAvailable(format!("D-Bus call to fprintd failed: {other}")),
    }
}

// ─── Secret Service ─────────────────────────────────────────────────────────

async fn store(service: &str, account: &str, secret: &[u8]) -> Result<(), BiometricError> {
    let keyring = connect().await?;
    let collection = keyring.get_default_collection().await.map_err(from_ss)?;
    collection.ensure_unlocked().await.map_err(from_ss)?;
    collection
        .create_item(
            &label(service, account),
            attributes(service, account),
            secret,
            // Replace, so a re-enrolment updates the item rather than leaving two
            // items with identical attributes that a search cannot choose between.
            true,
            CONTENT_TYPE,
        )
        .await
        .map_err(from_ss)?;
    Ok(())
}

async fn read(service: &str, account: &str) -> Result<Option<Vec<u8>>, BiometricError> {
    let keyring = connect().await?;
    let found = keyring
        .search_items(attributes(service, account))
        .await
        .map_err(from_ss)?;

    if let Some(item) = found.unlocked.first() {
        return item.get_secret().await.map(Some).map_err(from_ss);
    }
    let Some(item) = found.locked.first() else {
        return Ok(None);
    };
    // Prompts the keyring daemon's own unlock dialog. Dismissing it surfaces as
    // `Error::Prompt`, which `from_ss` reports as a cancellation.
    item.unlock().await.map_err(from_ss)?;
    item.get_secret().await.map(Some).map_err(from_ss)
}

async fn remove(service: &str, account: &str) -> Result<(), BiometricError> {
    let keyring = connect().await?;
    let found = keyring
        .search_items(attributes(service, account))
        .await
        .map_err(from_ss)?;

    // Both lists, because a locked item is still an item that must go.
    for item in found.unlocked.iter().chain(found.locked.iter()) {
        item.delete().await.map_err(from_ss)?;
    }
    Ok(())
}

async fn exists(service: &str, account: &str) -> Result<bool, BiometricError> {
    let keyring = connect().await?;
    let found = keyring
        .search_items(attributes(service, account))
        .await
        .map_err(from_ss)?;
    Ok(!found.unlocked.is_empty() || !found.locked.is_empty())
}

async fn connect() -> Result<SecretService<'static>, BiometricError> {
    // `Dh` negotiates a session key, so the secret is encrypted on the bus rather
    // than travelling as plaintext to any process that can watch it.
    SecretService::connect(EncryptionType::Dh)
        .await
        .map_err(from_ss)
}

/// The exact attribute set identifying one item. Used for both writing and
/// searching, so the two cannot drift apart.
fn attributes<'a>(service: &'a str, account: &'a str) -> HashMap<&'a str, &'a str> {
    HashMap::from([
        (ATTR_APPLICATION, APPLICATION),
        (ATTR_SERVICE, service),
        (ATTR_ACCOUNT, account),
    ])
}

/// Human-readable name shown in keyring UIs. Not an identifier — nothing is ever
/// looked up by it.
fn label(service: &str, account: &str) -> String {
    format!("Better Cloudflare biometric secret ({service}/{account})")
}

fn from_ss(err: secret_service::Error) -> BiometricError {
    match err {
        secret_service::Error::Unavailable => BiometricError::NotAvailable(
            "No Secret Service provider is running (install and start gnome-keyring or KWallet)"
                .to_string(),
        ),
        secret_service::Error::NoResult => BiometricError::NotFound,
        // The daemon asked the user to unlock and they declined. That is a
        // cancellation, not a broken keyring.
        secret_service::Error::Prompt => BiometricError::UserCancelled,
        secret_service::Error::Locked => BiometricError::StoreError(
            "The keyring collection is locked and could not be unlocked".to_string(),
        ),
        // `PromptDisconnected`, added in secret-service 5.2, lands here on
        // purpose. It means the connection closed before the prompt finished
        // and the outcome is unknown, which is not the same fact as the arm
        // above: reporting it as `UserCancelled` would tell the caller the user
        // declined when the secret may well have been stored.
        other => BiometricError::StoreError(format!("Secret Service call failed: {other}")),
    }
}

// ─── Async boundary ─────────────────────────────────────────────────────────

/// Drive `work` to completion on the calling thread, giving up after `budget`.
///
/// `on_timeout` is built by the caller rather than here so each operation can say
/// what it was waiting for, and choose whether running out of time is a
/// [`BiometricError::NotAvailable`] (the service never answered) or an
/// [`BiometricError::AuthenticationFailed`] (the user never answered).
///
/// `futures_lite::future::or` is biased towards its first argument, so a result
/// that arrives in the same poll as the deadline wins.
fn run<T>(
    budget: Duration,
    on_timeout: BiometricError,
    work: impl Future<Output = Result<T, BiometricError>>,
) -> Result<T, BiometricError> {
    futures_lite::future::block_on(futures_lite::future::or(work, async move {
        async_io::Timer::after(budget).await;
        Err(on_timeout)
    }))
}

/// The deadline message shared by the four storage operations.
fn store_timeout() -> BiometricError {
    BiometricError::StoreError(format!(
        "The keyring did not answer within {}s",
        STORE_BUDGET.as_secs()
    ))
}

// ─── Tests ──────────────────────────────────────────────────────────────────
//
// These only run on a Linux `cargo test`; from Windows they are typechecked by
// `cargo check --target x86_64-unknown-linux-gnu --all-targets` and no more. They
// are deliberately confined to what needs no bus: the attribute set, the label,
// the error translation, and the deadline. Everything else here is D-Bus plumbing
// that only a real system can exercise, which is why the decisions worth testing
// were moved out to `crate::mapping` — the `VerifyStatus` vocabulary, the fprintd
// error names, and the retry-versus-terminal choice are all covered there, on
// every platform.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_are_the_same_set_for_writing_and_searching() {
        let written = attributes("svc", "acct");
        assert_eq!(written.len(), 3);
        assert_eq!(written[ATTR_APPLICATION], APPLICATION);
        assert_eq!(written[ATTR_SERVICE], "svc");
        assert_eq!(written[ATTR_ACCOUNT], "acct");
    }

    #[test]
    fn distinct_accounts_get_distinct_attribute_sets() {
        assert_ne!(attributes("svc", "a"), attributes("svc", "b"));
        assert_ne!(attributes("a", "acct"), attributes("b", "acct"));
    }

    #[test]
    fn the_label_names_both_halves() {
        let label = label("com.bettercloudflare.biometric", "bc_key-1");
        assert!(label.contains("com.bettercloudflare.biometric"));
        assert!(label.contains("bc_key-1"));
    }

    #[test]
    fn a_dismissed_unlock_prompt_is_a_cancellation() {
        assert!(matches!(
            from_ss(secret_service::Error::Prompt),
            BiometricError::UserCancelled
        ));
        assert!(matches!(
            from_ss(secret_service::Error::NoResult),
            BiometricError::NotFound
        ));
        assert!(matches!(
            from_ss(secret_service::Error::Unavailable),
            BiometricError::NotAvailable(_)
        ));
    }

    #[test]
    fn the_deadline_fires_rather_than_hanging() {
        let never = std::future::pending::<Result<(), BiometricError>>();
        let outcome = run(
            Duration::from_millis(1),
            BiometricError::NotAvailable("deadline".to_string()),
            never,
        );
        assert!(matches!(outcome, Err(BiometricError::NotAvailable(_))));
    }

    #[test]
    fn a_result_that_arrives_in_time_beats_the_deadline() {
        let outcome = run(
            Duration::from_secs(30),
            BiometricError::NotAvailable("deadline".to_string()),
            async { Ok(7) },
        );
        assert_eq!(outcome.unwrap(), 7);
    }
}
