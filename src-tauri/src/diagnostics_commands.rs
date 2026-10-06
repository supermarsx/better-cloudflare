//! Host-side facts the diagnostics and About screens cannot see from the
//! webview: what this build is, what it is running on, and whether the OS
//! keyring is answering.
//!
//! # What is deliberately not here
//!
//! No credential, and nothing derived from one. The keyring probe reads a key
//! that is never written ([`KEYRING_PROBE_KEY`]) precisely so it can report
//! *reachability* without touching a stored secret: the answer is which error
//! came back, not any value. Nothing in [`HostFacts`] is read from secure
//! storage, from the MCP server's token, or from a provider profile.
//!
//! No user data either. There is no zone, record, domain or account field in
//! this payload, and there is no parameter that could ask for one.
//!
//! # Where the version comes from
//!
//! [`bc_update::embedded_release_tag`] and nowhere else. That is the `YY.N`
//! tag the release workflow stamps into the binary, and `None` means an
//! unstamped local build rather than "unknown, assume old". `tauri.conf.json`
//! says `0.0.0` and always will; it is reported as [`HostFacts::bundle_version`]
//! so a reader can see the placeholder for what it is, never as the version.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::storage::Storage;

/// A logical key the application never writes.
///
/// The probe needs to distinguish "the keyring answered, and there is no such
/// entry" from "the keyring could not be reached at all", and reading a key
/// that cannot exist is the only way to ask that question without either
/// writing to the user's keyring or reading one of their secrets.
const KEYRING_PROBE_KEY: &str = "diagnostics-reachability-probe";

/// What the keyring probe concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyringAvailability {
    /// The keyring answered. Secrets can be stored and read.
    Available,
    /// The keyring refused or could not be reached. On Linux this is usually a
    /// missing or locked Secret Service; elsewhere it is a denied prompt.
    Unavailable,
    /// The probe failed in a way that says nothing about the keyring itself.
    Unknown,
}

/// The keyring probe's verdict, with the refusal text when there was one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyringProbe {
    pub status: KeyringAvailability,
    /// The backend's own message, or `None`. Carries no secret: it is produced
    /// by a read of [`KEYRING_PROBE_KEY`], which holds nothing.
    pub detail: Option<String>,
}

/// Facts about the running build and its host.
///
/// Every field is either a compile-time constant, a Tauri-provided version
/// string, or the keyring probe's verdict. None of it varies with what the
/// user has stored or which zones they manage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFacts {
    /// The `YY.N` release tag stamped at build time, or `None` for an
    /// unstamped local build. From [`bc_update::embedded_release_tag`].
    pub release_tag: Option<String>,
    /// `tauri.conf.json`'s version — the placeholder `0.0.0`, not a release.
    pub bundle_version: String,
    pub app_name: String,
    /// `"debug"` or `"release"`, from `cfg!(debug_assertions)`.
    pub build_profile: &'static str,
    /// The target this binary was compiled for: `std::env::consts::OS`.
    pub os: &'static str,
    pub arch: &'static str,
    pub family: &'static str,
    /// The Tauri runtime's own version.
    pub tauri_version: &'static str,
    /// The platform webview's version (WebView2, WebKitGTK, WKWebView), or
    /// `None` when it cannot be determined.
    pub webview_version: Option<String>,
    pub keyring: KeyringProbe,
}

/// Probe the keyring by reading a key that was never written.
///
/// `NotFound` is the good answer: the backend was reached and said there is no
/// such entry. A `KeyringError` means the backend itself refused. Any other
/// variant is a fault in the probe rather than a statement about the keyring,
/// so it reports [`KeyringAvailability::Unknown`] instead of claiming either.
async fn probe_keyring(storage: &Storage) -> KeyringProbe {
    use bc_storage::StorageError;

    match storage.get_secret(KEYRING_PROBE_KEY).await {
        // Nothing is ever stored here, so a value coming back still proves the
        // backend is reachable, which is all this probe claims.
        Ok(_) => KeyringProbe {
            status: KeyringAvailability::Available,
            detail: None,
        },
        Err(StorageError::NotFound) => KeyringProbe {
            status: KeyringAvailability::Available,
            detail: None,
        },
        Err(StorageError::KeyringError(message)) => KeyringProbe {
            status: KeyringAvailability::Unavailable,
            detail: Some(message),
        },
        Err(error) => KeyringProbe {
            status: KeyringAvailability::Unknown,
            detail: Some(error.to_string()),
        },
    }
}

/// Collect the host-side facts for the About and Diagnostics screens.
///
/// Takes no parameters: there is nothing a caller could ask to widen this, and
/// nothing returned that depends on the caller. Infallible in practice — the
/// `Result` exists so a future fact that can fail has somewhere to go, and so
/// the signature matches every other command on this surface.
#[tauri::command]
pub async fn app_host_facts(
    app: tauri::AppHandle,
    storage: State<'_, Storage>,
) -> Result<HostFacts, String> {
    let package = app.package_info();
    Ok(HostFacts {
        release_tag: bc_update::embedded_release_tag().map(str::to_string),
        bundle_version: package.version.to_string(),
        app_name: package.name.clone(),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        family: std::env::consts::FAMILY,
        tauri_version: tauri::VERSION,
        webview_version: tauri::webview_version().ok(),
        keyring: probe_keyring(&storage).await,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probe must never name a key the application actually stores under.
    ///
    /// A probe key that collided with a real logical key would turn a
    /// diagnostics read into a read of the user's secret, and the `Ok(_)` arm
    /// would then be reporting on a value rather than on reachability.
    #[test]
    fn the_probe_key_is_not_one_the_application_writes() {
        for stored in [
            "api_keys",
            "vault",
            "passkeys",
            "audit_log",
            "preferences",
            "encryption_settings",
            "registrar_credentials",
        ] {
            assert_ne!(
                KEYRING_PROBE_KEY, stored,
                "the keyring probe would read real stored data"
            );
        }
    }

    #[test]
    fn the_probe_reports_reachable_when_the_backend_answers_not_found() {
        // Memory mode stands in for a reachable backend: it answers
        // `NotFound` for an absent key exactly as the keyring does.
        let storage = Storage::new(false);
        let probe = tauri::async_runtime::block_on(probe_keyring(&storage));
        assert_eq!(probe.status, KeyringAvailability::Available);
        assert_eq!(
            probe.detail, None,
            "a reachable backend has no refusal to report"
        );
    }

    /// The payload is serialised into a blob users paste into public issues.
    /// Nothing in it may be a credential, a zone, or a record.
    #[test]
    fn no_field_name_invites_a_secret_or_user_data() {
        let probe = KeyringProbe {
            status: KeyringAvailability::Unavailable,
            detail: Some("the collection is locked".to_string()),
        };
        let facts = HostFacts {
            release_tag: Some("26.14".to_string()),
            bundle_version: "0.0.0".to_string(),
            app_name: "Better Cloudflare".to_string(),
            build_profile: "release",
            os: "windows",
            arch: "x86_64",
            family: "windows",
            tauri_version: "2.11.5",
            webview_version: Some("131.0.2903.70".to_string()),
            keyring: probe,
        };
        let serialized = serde_json::to_string(&facts).expect("serialise facts");

        for forbidden in [
            "apiKey",
            "api_key",
            "token",
            "authToken",
            "secret",
            "password",
            "email",
            "zone",
            "record",
            "domain",
            "account",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} appears in the host facts payload: {serialized}"
            );
        }
    }
}
