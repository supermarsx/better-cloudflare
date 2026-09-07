//! A native WebAuthn **client**: the ceremony runs in this process, against the
//! operating system's own authenticator broker, instead of in the webview.
//!
//! # Why this exists
//!
//! WebAuthn has two halves. The relying party — challenge issue, verification,
//! credential storage — has always been here, in `bc-passkey`. The *client*
//! half, the part that actually talks to an authenticator, was
//! `navigator.credentials` in the webview, and that placement cost more than it
//! looked like it would:
//!
//! - It inherited WebView2's WebAuthn implementation, including its habit of
//!   reporting no platform authenticator on machines where Windows Hello is
//!   enrolled and working. The login screen believed it and withheld the button.
//! - It inherited the browser's secure-context rule, which is why macOS and
//!   Linux — served at the opaque `tauri://localhost` — get no WebAuthn at all.
//! - It inherited Chromium ignoring its own `timeout` field, worked around on
//!   the frontend with an `AbortSignal` this app drives itself.
//!
//! None of those were security problems: the renderer only ever carried an
//! attestation or assertion that *this* process verified, and it holds no
//! private key. They were availability problems. Moving the client half here
//! removes all three on any platform with a native broker.
//!
//! On Windows that broker is `webauthn.dll`, and it is the whole answer:
//! `WebAuthNAuthenticatorMakeCredential` raises the system credential picker,
//! which offers Windows Hello, a security key, and a passkey on a nearby phone.
//! The three things the webview probe could not see are handled by the OS.
//!
//! # What is deliberately not used
//!
//! `webauthn-authenticator-rs` offers a safe wrapper trait,
//! `WebauthnAuthenticator`, over the raw [`AuthenticatorBackend`]. It is not
//! used here, and [`ensure_native_origin`] is the check it is replaced with —
//! read that function before concluding a check was dropped.

use url::Url;
use webauthn_rs::prelude::{
    CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse,
};

use crate::PasskeyError;

/// How long a native ceremony may wait for the user.
///
/// Long enough to find a security key and touch it, short enough that a
/// forgotten dialog does not pin a blocking thread forever. This is the same
/// budget the frontend's own `AbortSignal` uses, so the two paths give the user
/// the same amount of time.
pub const NATIVE_CEREMONY_TIMEOUT_MS: u32 = 60_000;

/// Clamp whatever the relying party asked for into a range the OS will honour.
///
/// A `0` timeout means "no timeout" to some brokers, which is exactly the hang
/// this budget exists to prevent, so it is treated as absent rather than
/// forwarded.
fn ceremony_timeout_ms(requested: Option<u32>) -> u32 {
    match requested {
        Some(ms) if ms > 0 => ms.min(NATIVE_CEREMONY_TIMEOUT_MS),
        _ => NATIVE_CEREMONY_TIMEOUT_MS,
    }
}

/// A WebAuthn client that runs inside this process.
///
/// `Send + 'static` because every implementation blocks on a modal OS dialog
/// and therefore has to be moved onto a blocking thread.
pub trait NativeAuthenticator: Send + 'static {
    /// Which OS broker this talks to. Reported in the capability status so the
    /// frontend can say *how* a ceremony will run, not just that it can.
    fn label(&self) -> &'static str;

    fn register(
        &mut self,
        origin: &Url,
        challenge: CreationChallengeResponse,
    ) -> Result<RegisterPublicKeyCredential, PasskeyError>;

    fn authenticate(
        &mut self,
        origin: &Url,
        challenge: RequestChallengeResponse,
    ) -> Result<PublicKeyCredential, PasskeyError>;
}

/// Refuse to run a native ceremony for an origin that should not have one.
///
/// **This replaces a check, and the substitution is deliberate.**
/// `WebauthnAuthenticator::do_registration` — the wrapper trait in
/// `webauthn-authenticator-rs` — applies two client-side policy checks before
/// delegating to the backend, and this app cannot use it, because one of them
/// is wrong here:
///
/// > `origin.scheme() != "https" && !(effective_domain == "localhost" && scheme == "http")`
/// > → `WebauthnCError::Security`
///
/// That is the browser secure-context rule transcribed, and it demands the
/// effective domain be *exactly* `localhost`. Every production Windows build of
/// this app runs at `http://tauri.localhost`, whose effective domain is
/// `tauri.localhost`, so the wrapper would refuse the one origin that matters.
/// Chromium itself treats `*.localhost` as potentially trustworthy — which is
/// precisely why the webview path works at that origin today — so the rule is
/// restated below to match what the platform actually trusts.
///
/// The wrapper's other check, that the RP ID is a registrable suffix of the
/// effective domain, is kept and **tightened to equality**. This relying party
/// derives its RP ID from its own origin (see `crate::config`), so a suffix
/// relationship that is not equality means something has gone wrong upstream
/// rather than something that should be permitted.
///
/// What is *not* weakened: the origin recorded in `clientDataJSON` is checked
/// against this relying party's configured origin by `webauthn-rs` on the way
/// back in, along with the RP-ID hash, the UP/UV flags, the signature and the
/// counter. That check is the authoritative one, it happens in this process,
/// and it runs against an origin read from the window handle — never nominated
/// by the page.
pub fn ensure_native_origin(origin: &Url, rp_id: &str) -> Result<(), PasskeyError> {
    let refuse = |reason: &str| {
        Err(PasskeyError::NativeOriginRefused(format!(
            "{origin} cannot be used for a native passkey ceremony: {reason}"
        )))
    };

    // `domain()` is `None` for an IP literal or an opaque host. WebAuthn has no
    // RP ID for either, so there is nothing to scope a credential to.
    let Some(domain) = origin.domain() else {
        return refuse("it has no domain to scope a credential to");
    };

    // Chromium's potentially-trustworthy rule, which is the one the platform
    // and the enrolled credentials already follow.
    let trustworthy = origin.scheme() == "https"
        || (origin.scheme() == "http" && (domain == "localhost" || domain.ends_with(".localhost")));
    if !trustworthy {
        return refuse("it is neither https nor a localhost origin");
    }

    if domain != rp_id {
        return refuse("its domain is not the relying party ID this process registers under");
    }

    Ok(())
}

// ─── Windows ────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod windows_hello {
    use super::{ceremony_timeout_ms, NativeAuthenticator};
    use crate::PasskeyError;
    use url::Url;
    use webauthn_authenticator_rs::{error::WebauthnCError, win10::Win10, AuthenticatorBackend};
    use webauthn_rs::prelude::{
        CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
        RequestChallengeResponse,
    };

    /// The Windows WebAuthn API, `webauthn.dll`.
    ///
    /// Despite the name this is not only Windows Hello: the system credential
    /// picker it raises brokers Hello, USB and NFC security keys, and — on
    /// Windows 11 — a passkey on a nearby phone over hybrid transport. All of
    /// that is the OS's job, which is the entire point of running the ceremony
    /// here rather than in the webview.
    pub struct WindowsHello {
        api_version: u32,
    }

    impl WindowsHello {
        /// `None` when this Windows build has no usable WebAuthn API.
        ///
        /// `webauthn.dll` has shipped since Windows 10 1809, and linking this
        /// backend makes it a load-time import, so in practice a process that
        /// reached this call has it. The version is still checked rather than
        /// assumed: `WebAuthNGetApiVersionNumber` also reports the *lesser* of
        /// the host and client versions over RDP, where it can legitimately be
        /// lower than the local machine's.
        pub fn detect() -> Option<Self> {
            let api_version = Win10::api_version();
            (api_version > 0).then_some(Self { api_version })
        }

        /// The API version this system reports. Recorded in diagnostics: it is
        /// what decides whether hybrid transport is on offer (version 7+).
        pub fn api_version(&self) -> u32 {
            self.api_version
        }
    }

    /// Turn a client error into something the user can act on.
    ///
    /// The strings mirror the frontend's `DOMException` mapping deliberately —
    /// which path ran a ceremony is an implementation detail, and the same
    /// failure should not read differently depending on it.
    fn describe(error: WebauthnCError, registering: bool) -> PasskeyError {
        let message = match error {
            WebauthnCError::Cancelled => {
                if registering {
                    "Registration was dismissed, timed out, or refused by your device. If no prompt appeared, no authenticator was reachable — try a security key, or your phone."
                } else {
                    "Sign-in was dismissed, timed out, or refused by your device. If no prompt appeared, none of this key's passkeys are available on this device."
                }
            }
            WebauthnCError::NotSupported => {
                "Your device could not provide a passkey of a type this app accepts."
            }
            WebauthnCError::Security => {
                "Windows refused the passkey request for this application's origin."
            }
            WebauthnCError::PlatformAuthenticator => {
                "Windows Hello could not complete the request. Check that a PIN, fingerprint or face unlock is set up, then try again."
            }
            WebauthnCError::InvalidRegistration => {
                "Your device returned a registration this app could not accept."
            }
            WebauthnCError::InvalidAssertion => {
                "Your device returned a sign-in response this app could not accept."
            }
            // Everything else is a transport or protocol fault with no remedy
            // the user can apply, so it is reported as itself rather than
            // dressed up. `WebauthnCError` messages name the failure and
            // interpolate no credential, challenge or key material.
            other => return PasskeyError::NativeCeremony(other.to_string()),
        };
        PasskeyError::NativeCeremony(message.to_string())
    }

    impl NativeAuthenticator for WindowsHello {
        fn label(&self) -> &'static str {
            "windows-webauthn"
        }

        fn register(
            &mut self,
            origin: &Url,
            challenge: CreationChallengeResponse,
        ) -> Result<RegisterPublicKeyCredential, PasskeyError> {
            let options = challenge.public_key;
            let timeout = ceremony_timeout_ms(options.timeout);
            Win10::default()
                .perform_register(origin.clone(), options, timeout)
                .map_err(|error| describe(error, true))
        }

        fn authenticate(
            &mut self,
            origin: &Url,
            challenge: RequestChallengeResponse,
        ) -> Result<PublicKeyCredential, PasskeyError> {
            let options = challenge.public_key;
            let timeout = ceremony_timeout_ms(options.timeout);
            Win10::default()
                .perform_auth(origin.clone(), options, timeout)
                .map_err(|error| describe(error, false))
        }
    }
}

#[cfg(windows)]
pub use windows_hello::WindowsHello;

/// The native client for the platform this binary was built for.
///
/// A concrete type rather than a trait object: every implementation is moved
/// onto a blocking thread for the duration of its modal dialog, and a concrete
/// `Send + 'static` value moves without ceremony.
#[cfg(windows)]
pub type PlatformAuthenticator = WindowsHello;

// ─── Platforms with no native broker ────────────────────────────────────────

/// The stand-in on platforms with no native WebAuthn client.
///
/// macOS and Linux land here, for different reasons. Apple's platform passkeys
/// are reachable only through `ASAuthorization`, which requires associated
/// domains — an `apple-app-site-association` file served over HTTPS from the RP
/// ID's domain — and a desktop app scoped to `localhost` cannot satisfy that.
/// Linux has no platform authenticator standard at all.
///
/// Neither is a fault to report loudly: [`detect`](Self::detect) returns `None`,
/// the capability status says no native ceremony is available, and the frontend
/// keeps using the webview client exactly as before.
#[cfg(not(windows))]
pub struct NoNativeAuthenticator(());

#[cfg(not(windows))]
impl NoNativeAuthenticator {
    pub fn detect() -> Option<Self> {
        None
    }
}

#[cfg(not(windows))]
impl NativeAuthenticator for NoNativeAuthenticator {
    fn label(&self) -> &'static str {
        "none"
    }

    fn register(
        &mut self,
        _origin: &Url,
        _challenge: CreationChallengeResponse,
    ) -> Result<RegisterPublicKeyCredential, PasskeyError> {
        Err(PasskeyError::NativeClientUnavailable)
    }

    fn authenticate(
        &mut self,
        _origin: &Url,
        _challenge: RequestChallengeResponse,
    ) -> Result<PublicKeyCredential, PasskeyError> {
        Err(PasskeyError::NativeClientUnavailable)
    }
}

#[cfg(not(windows))]
pub type PlatformAuthenticator = NoNativeAuthenticator;

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(spelling: &str) -> Url {
        Url::parse(spelling).expect("test origin parses")
    }

    #[test]
    fn the_production_windows_origin_is_accepted() {
        // The whole reason the wrapper trait is not used. `tauri.localhost` is
        // where every production Windows build runs, and the wrapper's own rule
        // would refuse it.
        assert!(
            ensure_native_origin(&origin("http://tauri.localhost"), "tauri.localhost").is_ok()
        );
    }

    #[test]
    fn the_development_origin_is_accepted() {
        assert!(ensure_native_origin(&origin("http://localhost:3000"), "localhost").is_ok());
    }

    #[test]
    fn https_is_accepted_for_any_domain() {
        assert!(ensure_native_origin(&origin("https://example.test"), "example.test").is_ok());
    }

    #[test]
    fn a_plain_http_origin_that_is_not_localhost_is_refused() {
        let error = ensure_native_origin(&origin("http://example.test"), "example.test")
            .expect_err("a non-localhost http origin must be refused");
        assert!(matches!(error, PasskeyError::NativeOriginRefused(_)));
    }

    #[test]
    fn an_ip_literal_has_no_relying_party_to_scope_to() {
        let error = ensure_native_origin(&origin("http://127.0.0.1:3000"), "127.0.0.1")
            .expect_err("an IP origin must be refused");
        assert!(matches!(error, PasskeyError::NativeOriginRefused(_)));
    }

    #[test]
    fn a_suffix_relationship_is_not_enough_where_equality_is_required() {
        // The wrapper trait would allow this; this relying party derives its RP
        // ID from its own origin, so anything but equality means something went
        // wrong upstream.
        let error = ensure_native_origin(&origin("https://app.example.test"), "example.test")
            .expect_err("a mere suffix must be refused");
        assert!(matches!(error, PasskeyError::NativeOriginRefused(_)));
    }

    #[test]
    fn a_zero_or_absent_timeout_becomes_the_budget_rather_than_no_timeout() {
        // Some brokers read 0 as "wait forever", which is the hang this budget
        // exists to prevent.
        assert_eq!(ceremony_timeout_ms(None), NATIVE_CEREMONY_TIMEOUT_MS);
        assert_eq!(ceremony_timeout_ms(Some(0)), NATIVE_CEREMONY_TIMEOUT_MS);
    }

    #[test]
    fn a_longer_request_is_clamped_and_a_shorter_one_is_honoured() {
        assert_eq!(
            ceremony_timeout_ms(Some(600_000)),
            NATIVE_CEREMONY_TIMEOUT_MS
        );
        assert_eq!(ceremony_timeout_ms(Some(15_000)), 15_000);
    }
}
