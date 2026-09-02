//! Relying-party configuration: the RP ID and origin this process verifies
//! against.
//!
//! # Why this is runtime state and not a constant
//!
//! The app's webview origin is not the same string in every build:
//!
//! | Context | Origin | Effective domain |
//! | --- | --- | --- |
//! | `npm run tauri:dev` | `http://localhost:3000` | `localhost` |
//! | Production, Windows (WebView2) | `http://tauri.localhost` | `tauri.localhost` |
//! | Production, macOS / Linux | `tauri://localhost` | *none — non-special scheme* |
//!
//! WebAuthn scopes a credential to its RP ID, so a credential enrolled under
//! `localhost` can never assert under `tauri.localhost`. That is not a bug to
//! configure away — it is how the specification works, and it was measured
//! directly in this app's own WebView2: asserting a dev-enrolled credential
//! from the production origin fails with `SecurityError`, and the client will
//! not even *send* the dev RP ID from the production origin. So the RP ID is
//! derived at runtime, recorded on each credential, and mismatches are refused
//! with a message that says to re-enroll — see
//! [`crate::PasskeyError::CredentialsFromAnotherContext`].
//!
//! # Two policy decisions that are deliberate and must stay
//!
//! `allow_subdomains(false)` and `allow_any_port(false)` are set explicitly
//! rather than left to the builder's defaults, so that turning either on is a
//! visible edit. `GHSA-22w3-693w-x895` was an origin-validation bug reachable
//! only when subdomains were allowed; no version bump makes enabling it safe
//! here, because this relying party has exactly one origin.
//!
//! # Failure is not an error to paper over
//!
//! If the runtime origin cannot be resolved, there is no correct RP ID to guess
//! and a permissive fallback would accept credentials from anywhere. The
//! construction fails, the caller builds
//! [`PasskeyManager::unavailable`](crate::PasskeyManager::unavailable), and
//! every ceremony refuses. Fail closed, never fall back.

use url::Url;
use webauthn_rs::{Webauthn, WebauthnBuilder};

use crate::PasskeyError;

/// Shown by authenticators and platform passkey managers.
pub const RP_NAME: &str = "Better Cloudflare";

/// A resolved relying party: the library instance plus the two strings that
/// are recorded on every credential it registers.
pub struct WebauthnConfig {
    webauthn: Webauthn,
    rp_id: String,
    origin: String,
}

impl WebauthnConfig {
    /// Build the relying party for a runtime origin.
    ///
    /// `rp_id` must be an effective domain of `origin`; the library enforces
    /// that and this returns [`PasskeyError::RuntimeOriginUnavailable`] when it
    /// does not hold, rather than retrying with something more permissive.
    pub fn new(rp_id: &str, origin: &Url) -> Result<Self, PasskeyError> {
        let webauthn = WebauthnBuilder::new(rp_id, origin)
            .map_err(|_| PasskeyError::RuntimeOriginUnavailable)?
            .rp_name(RP_NAME)
            // Both set explicitly. See the module documentation.
            .allow_subdomains(false)
            .allow_any_port(false)
            .build()
            .map_err(|_| PasskeyError::RuntimeOriginUnavailable)?;

        Ok(Self {
            webauthn,
            rp_id: rp_id.to_string(),
            // The URL's own spelling, kept byte-exact. `url` does not
            // slash-normalise non-special schemes, so `tauri://localhost` and
            // `tauri://localhost/` are different URLs and only one of them can
            // match what the webview reports. Recording whatever was passed in
            // keeps the diagnostic honest about which one was configured.
            origin: origin.as_str().to_string(),
        })
    }

    pub fn webauthn(&self) -> &Webauthn {
        &self.webauthn
    }

    /// The RP ID this process runs under. Recorded on every credential
    /// registered here, and compared before any assertion is attempted.
    pub fn rp_id(&self) -> &str {
        &self.rp_id
    }

    /// The origin, for diagnostics and for the "enrolled in a different
    /// context" message. Not a trust anchor: the trust anchor is the origin
    /// inside `webauthn`, which the library checks for itself.
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

impl std::fmt::Debug for WebauthnConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebauthnConfig")
            .field("rp_id", &self.rp_id)
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}
