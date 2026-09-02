//! The passkey relying party, and the runtime origin it is scoped to.
//!
//! [`bc_passkey::PasskeyManager`] cannot know its origin from a constant: the
//! webview serves `http://localhost:3000` in development, `http://tauri.localhost`
//! in a production Windows build, and `tauri://localhost` on macOS and Linux.
//! WebAuthn scopes every credential to an RP ID derived from that origin, so it
//! is read from the window and recorded on each credential — on first use
//! rather than at startup, for the reason [`PasskeyState`] documents.
//!
//! Every failure path here produces [`PasskeyManager::unavailable`], never a
//! guess. There is no correct RP ID to fall back to — a permissive one would
//! widen the scope of every credential the app issues — and there is no panic,
//! because `panic = "abort"` would take the whole application down over a
//! passkey configuration problem.

use std::sync::OnceLock;

use tauri::Manager;
use url::Url;

pub use bc_passkey::{PasskeyManager, REASON_ORIGIN_UNRESOLVED};

/// The window whose origin the relying party is scoped to.
const MAIN_WINDOW: &str = "main";

/// Split a webview URL into the RP ID and the origin to verify against.
///
/// The origin is rebuilt from scheme, host and port alone, so a path, query or
/// fragment on the window URL cannot reach it. `None` whenever no RP ID can be
/// derived — an IP-address host has no domain, and WebAuthn has no RP ID for
/// one.
fn relying_party(window_url: &Url) -> Option<(String, Url)> {
    // `domain()` is `None` for an IP literal or an opaque host, which is the
    // fail-closed case: there is no registrable domain to scope credentials to.
    let rp_id = window_url.domain()?.to_string();
    let host = window_url.host_str()?;

    let mut origin = format!("{}://{host}", window_url.scheme());
    // `port()` is `None` when the port is the scheme's default, so a default
    // port is never spelled out — `http://localhost:80` is not the origin the
    // webview reports for `http://localhost`.
    if let Some(port) = window_url.port() {
        origin.push_str(&format!(":{port}"));
    }

    // Reparsing is what keeps the spelling honest: `url` leaves a non-special
    // scheme alone, so `tauri://localhost` stays bare, which is the exact
    // string those webviews report.
    let origin = Url::parse(&origin).ok()?;
    Some((rp_id, origin))
}

/// The reported reason is a fixed string, so the detail goes to stderr. A
/// window URL is not secret, and without it an unavailable relying party is
/// indistinguishable from a shut gate at the one moment someone needs to tell
/// them apart.
fn unresolved(detail: &str) {
    eprintln!("passkey relying party unavailable: {detail}");
}

/// Build the relying party from the main window's current origin, or `None`
/// when it cannot be derived yet or at all.
fn manager_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PasskeyManager> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        unresolved("no `main` webview window");
        return None;
    };
    let url = match window.url() {
        Ok(url) => url,
        Err(error) => {
            unresolved(&format!("the window URL could not be read: {error}"));
            return None;
        }
    };
    let Some((rp_id, origin)) = relying_party(&url) else {
        unresolved(&format!("no relying party can be derived from {url}"));
        return None;
    };
    match PasskeyManager::new(&rp_id, &origin) {
        Ok(manager) => Some(manager),
        Err(error) => {
            unresolved(&format!(
                "the relying party {rp_id} at {origin} was refused: {error}"
            ));
            None
        }
    }
}

/// The managed passkey state, and the reason it is not simply a
/// [`PasskeyManager`].
///
/// The relying party is scoped to the webview's own origin, and that origin is
/// not knowable when Tauri's `setup` hook runs: the window exists, but it has
/// not navigated, so `WebviewWindow::url()` reports `about:blank`. Measured in
/// this app, not assumed. Deriving a relying party from `about:blank` would
/// permanently scope the process to nothing.
///
/// So the manager is built on **first use** instead, which is necessarily after
/// navigation — an IPC call can only come from a page that has loaded. Two
/// properties make that safe:
///
/// - **Only a successful derivation is cached.** A failure returns the stored
///   fail-closed manager and leaves the cell empty, so a later call retries.
///   Latching `about:blank` on an unlucky first call would disable passkeys for
///   the life of the process.
/// - **The origin comes from the webview, never from the page.** It is read
///   through the window handle on the Rust side. A compromised renderer cannot
///   nominate its own RP ID, which is the one thing that must not be delegated.
pub struct PasskeyState {
    /// Reads the current window origin. Boxed so this type stays non-generic
    /// and the command signatures stay plain `State<'_, PasskeyState>`.
    resolve: Box<dyn Fn() -> Option<PasskeyManager> + Send + Sync>,
    configured: OnceLock<PasskeyManager>,
    /// Returned until — and if — the origin resolves. Its ceremony and token
    /// stores stay empty because every entry point on it refuses.
    fallback: PasskeyManager,
}

impl PasskeyState {
    pub fn new<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Self {
        Self {
            resolve: Box::new(move || manager_for_app(&app)),
            configured: OnceLock::new(),
            fallback: PasskeyManager::unavailable(REASON_ORIGIN_UNRESOLVED),
        }
    }

    #[cfg(test)]
    fn with_resolver(resolve: impl Fn() -> Option<PasskeyManager> + Send + Sync + 'static) -> Self {
        Self {
            resolve: Box::new(resolve),
            configured: OnceLock::new(),
            fallback: PasskeyManager::unavailable(REASON_ORIGIN_UNRESOLVED),
        }
    }

    /// The relying party, derived on first successful call and reused after.
    pub fn manager(&self) -> &PasskeyManager {
        if let Some(manager) = self.configured.get() {
            return manager;
        }
        match (self.resolve)() {
            // A concurrent caller may have won the race; either way the value
            // in the cell is the one every later call sees.
            Some(manager) => {
                let _ = self.configured.set(manager);
                self.configured.get().unwrap_or(&self.fallback)
            }
            None => &self.fallback,
        }
    }
}

impl std::fmt::Debug for PasskeyState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasskeyState")
            .field("configured", &self.configured.get())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn derive(url: &str) -> Option<(String, String)> {
        let parsed = Url::parse(url).expect("test url");
        relying_party(&parsed).map(|(rp_id, origin)| (rp_id, origin.as_str().to_string()))
    }

    /// The three origins this app actually runs at, measured in the running
    /// webview rather than assumed. Windows production is the one that matters
    /// most: `window.location.origin` is exactly `http://tauri.localhost`.
    #[test]
    fn the_three_runtime_origins_derive_the_relying_parties_the_platforms_need() {
        assert_eq!(
            derive("http://tauri.localhost/"),
            Some((
                "tauri.localhost".to_string(),
                "http://tauri.localhost/".to_string()
            ))
        );
        assert_eq!(
            derive("http://localhost:3000/login"),
            Some((
                "localhost".to_string(),
                "http://localhost:3000/".to_string()
            ))
        );
        assert_eq!(
            derive("tauri://localhost"),
            Some(("localhost".to_string(), "tauri://localhost".to_string()))
        );
    }

    /// A non-special scheme keeps its exact spelling — `url` does not add the
    /// slash an `http` origin gets, and only the spelling the webview reports
    /// can match at ceremony time.
    #[test]
    fn a_tauri_origin_is_not_given_a_trailing_slash() {
        let (_, origin) = derive("tauri://localhost/index.html").expect("tauri origin");
        assert_eq!(origin, "tauri://localhost");
    }

    /// A path, query or fragment on the window URL must not reach the origin.
    #[test]
    fn only_the_scheme_host_and_port_reach_the_origin() {
        assert_eq!(
            derive("http://tauri.localhost/index.html?next=%2Fzones#dns"),
            Some((
                "tauri.localhost".to_string(),
                "http://tauri.localhost/".to_string()
            ))
        );
    }

    /// A default port is not spelled out, because the webview does not spell it
    /// out either and the two strings have to be the same origin.
    #[test]
    fn a_default_port_is_not_written_into_the_origin() {
        assert_eq!(
            derive("http://localhost:80/"),
            Some(("localhost".to_string(), "http://localhost/".to_string()))
        );
        assert_eq!(
            derive("https://localhost:443/"),
            Some(("localhost".to_string(), "https://localhost/".to_string()))
        );
    }

    /// A host with no registrable domain has no RP ID. Failing here is what
    /// makes the manager unavailable rather than scoped to something wrong.
    #[test]
    fn a_host_without_a_domain_derives_nothing() {
        assert_eq!(derive("http://127.0.0.1:3000/"), None);
        assert_eq!(derive("http://[::1]:3000/"), None);
        assert_eq!(derive("file:///C:/app/index.html"), None);
        assert_eq!(derive("data:text/html,<p>hi</p>"), None);
    }

    /// The behaviour the whole lazy design exists for. The webview reports
    /// `about:blank` until it navigates, so the first resolution attempt can
    /// legitimately fail; caching that failure would disable passkeys for the
    /// life of the process.
    #[test]
    fn an_unresolved_origin_is_retried_rather_than_cached() {
        let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&attempts);
        let state = PasskeyState::with_resolver(move || {
            let previous = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // Fails twice, as a webview that has not navigated yet would.
            (previous >= 2).then(|| {
                let origin = Url::parse("http://tauri.localhost").expect("origin");
                PasskeyManager::new("tauri.localhost", &origin).expect("relying party")
            })
        });

        assert!(!state.manager().is_configured());
        assert!(!state.manager().is_configured());
        assert!(
            state.manager().is_configured(),
            "a later call must resolve once the window has navigated"
        );
        assert_eq!(state.manager().rp_id(), Some("tauri.localhost"));

        // ...and once it has resolved, the resolver is not consulted again: the
        // manager holds the ceremony and token stores, so a second instance
        // would silently lose a challenge between two IPC calls.
        let after = attempts.load(std::sync::atomic::Ordering::SeqCst);
        assert!(state.manager().is_configured());
        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::SeqCst),
            after,
            "the resolver ran again after the relying party was already built"
        );
    }

    /// The fail-closed state reports the origin reason, not a shut gate — the
    /// two are different situations and the UI shows the backend's own text.
    #[test]
    fn a_state_that_cannot_resolve_reports_the_origin_reason() {
        let state = PasskeyState::with_resolver(|| None);
        let status = state.manager().status();
        assert!(!status.registration_available);
        assert!(!status.authentication_available);
        assert_eq!(status.unavailable_reason, REASON_ORIGIN_UNRESOLVED);
    }

    /// The derived pair must be one the relying party will actually accept —
    /// deriving a pair the builder then refuses would be a silent downgrade to
    /// unavailable at startup.
    #[test]
    fn every_derived_pair_builds_a_relying_party() {
        for url in [
            "http://tauri.localhost/",
            "http://localhost:3000/",
            "tauri://localhost",
        ] {
            let parsed = Url::parse(url).expect("test url");
            let (rp_id, origin) = relying_party(&parsed).expect("derivation");
            assert!(
                PasskeyManager::new(&rp_id, &origin).is_ok(),
                "the pair derived from {url} was refused by the relying party"
            );
        }
    }
}
