//! The native ceremony path, driven end to end against an in-process software
//! authenticator.
//!
//! # What this is proving
//!
//! On Windows the client half of WebAuthn runs in this process, against
//! `webauthn.dll`, instead of in the webview. Windows Hello cannot be driven
//! from a test, so what is exercised here is everything *around* the broker:
//! the challenge this process builds, the origin check that decides whether a
//! native ceremony may run at all, the verification of what comes back, the
//! credential that gets stored, and the unlock token that gets minted.
//!
//! `SoftPasskey` stands in for the OS broker. That substitution is the point of
//! [`bc_passkey::NativeAuthenticator`] being a trait: the real Windows
//! implementation and this one reach `PasskeyManager` through exactly the same
//! method, so a break in the surrounding logic fails here rather than only on a
//! machine with Hello enrolled.
//!
//! # What this deliberately does not prove
//!
//! That `webauthn.dll` behaves. Nothing in a test can establish that, and
//! pretending otherwise would be worse than the honest gap. What it does
//! establish is that if the broker returns a well-formed attestation or
//! assertion, this crate does the right thing with it — and that if it returns
//! a bad one, this crate refuses.

use std::sync::{Arc, Mutex};

use bc_passkey::credential::load_credentials;
use bc_passkey::{
    ensure_native_origin, NativeAuthenticator, PasskeyError, PasskeyManager, Storage,
};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::AuthenticatorBackend;
use webauthn_rs::prelude::{
    CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse, Url,
};

const ACCOUNT: &str = "key_native";
const RP_ID: &str = "localhost";
const ORIGIN: &str = "https://localhost";

/// A [`NativeAuthenticator`] backed by the software token.
///
/// The token is shared behind an `Arc<Mutex<_>>` because the manager takes the
/// authenticator **by value** — it has to move it onto a blocking thread — and
/// a passkey enrolled on one device is precisely the thing that has to sign on
/// it later. Handing the second ceremony a fresh token would be testing two
/// unrelated authenticators and would pass for the wrong reason.
///
/// The `mode` field is what lets a test make the "broker" misbehave without
/// touching the manager, which is the only honest way to check that a bad
/// response is refused rather than stored.
#[derive(Clone)]
struct SoftNative {
    token: Arc<Mutex<SoftPasskey>>,
    mode: Mode,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Behave like a working authenticator.
    Honest,
    /// Refuse, the way a dismissed OS dialog does.
    Refuse,
    /// Answer for a different origin than the one the relying party expects.
    /// The signature is genuine; only the origin is wrong.
    WrongOrigin,
}

impl SoftNative {
    fn new(mode: Mode) -> Self {
        Self {
            // `falsify_uv` makes the software token claim user verification,
            // which `start_passkey_authentication` requires.
            token: Arc::new(Mutex::new(SoftPasskey::new(true))),
            mode,
        }
    }

    /// The same key material, behaving differently.
    fn with_mode(&self, mode: Mode) -> Self {
        Self {
            token: Arc::clone(&self.token),
            mode,
        }
    }

    fn effective_origin(&self, origin: &Url) -> Url {
        match self.mode {
            Mode::WrongOrigin => Url::parse("https://evil.localhost").expect("origin"),
            _ => origin.clone(),
        }
    }
}

impl NativeAuthenticator for SoftNative {
    fn label(&self) -> &'static str {
        "soft-native"
    }

    fn register(
        &mut self,
        origin: &Url,
        challenge: CreationChallengeResponse,
    ) -> Result<RegisterPublicKeyCredential, PasskeyError> {
        if self.mode == Mode::Refuse {
            return Err(PasskeyError::NativeCeremony("dismissed".to_string()));
        }
        let origin = self.effective_origin(origin);
        let options = challenge.public_key;
        self.token
            .lock()
            .expect("the software token is not poisoned")
            .perform_register(origin, options, 60_000)
            .map_err(|error| PasskeyError::NativeCeremony(error.to_string()))
    }

    fn authenticate(
        &mut self,
        origin: &Url,
        challenge: RequestChallengeResponse,
    ) -> Result<PublicKeyCredential, PasskeyError> {
        if self.mode == Mode::Refuse {
            return Err(PasskeyError::NativeCeremony("dismissed".to_string()));
        }
        let origin = self.effective_origin(origin);
        let options = challenge.public_key;
        self.token
            .lock()
            .expect("the software token is not poisoned")
            .perform_auth(origin, options, 60_000)
            .map_err(|error| PasskeyError::NativeCeremony(error.to_string()))
    }
}

fn manager() -> (PasskeyManager, Storage) {
    let origin = Url::parse(ORIGIN).expect("origin");
    (
        PasskeyManager::new(RP_ID, &origin).expect("relying party"),
        Storage::new(false),
    )
}

// ─── The path works ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_native_registration_stores_a_credential_the_native_path_can_then_use() {
    let (manager, storage) = manager();

    manager
        .register_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::Honest))
        .await
        .expect("native registration");

    // The *verified* credential store, not the legacy one: a native
    // registration must land where an assertion will look for it.
    let stored = load_credentials(&storage, ACCOUNT)
        .await
        .expect("verified credentials");
    assert_eq!(
        stored.credentials.len(),
        1,
        "exactly one verified credential should be enrolled"
    );
}

#[tokio::test]
async fn a_native_sign_in_mints_the_same_unlock_token_shape_as_the_webview_path() {
    let (manager, storage) = manager();
    // One authenticator across both ceremonies, because the passkey enrolled by
    // the first is what has to sign in the second.
    let token = SoftNative::new(Mode::Honest);

    manager
        .register_passkey_native(&storage, ACCOUNT, token.clone())
        .await
        .expect("native registration");

    let result = manager
        .authenticate_passkey_native(&storage, ACCOUNT, token.clone())
        .await
        .expect("native sign-in");

    assert_eq!(result["success"], true);
    let minted = result["token"].as_str().expect("a token was minted");
    assert!(!minted.is_empty());
    assert!(
        result["credentialId"].as_str().is_some(),
        "the audit record needs the credential id"
    );

    // The whole point of the token: it is accepted exactly once, and spending
    // it is what makes the second attempt fail.
    assert!(manager
        .verify_token(ACCOUNT, minted, true)
        .await
        .expect("the token verifies"));
    assert!(
        !manager
            .verify_token(ACCOUNT, minted, true)
            .await
            .expect("the second check completes"),
        "an unlock token must be single-use on the native path too"
    );
}

// ─── The path refuses ───────────────────────────────────────────────────────

#[tokio::test]
async fn an_assertion_for_the_wrong_origin_is_refused_and_mints_nothing() {
    // The signature is genuine and the RP-ID hash is right; only the origin in
    // clientDataJSON is wrong. This is the case a signature check alone cannot
    // catch, and it must not become reachable just because the ceremony moved
    // into this process.
    let (manager, storage) = manager();
    let token = SoftNative::new(Mode::Honest);

    manager
        .register_passkey_native(&storage, ACCOUNT, token.clone())
        .await
        .expect("native registration");

    // Same key material, wrong origin: the signature will verify, the origin
    // will not.
    let error = manager
        .authenticate_passkey_native(&storage, ACCOUNT, token.with_mode(Mode::WrongOrigin))
        .await
        .expect_err("an assertion from another origin must be refused");
    assert!(
        matches!(error, PasskeyError::Verification(_)),
        "expected the library to refuse it, got {error:?}"
    );
}

#[tokio::test]
async fn a_registration_for_the_wrong_origin_stores_nothing() {
    let (manager, storage) = manager();

    let error = manager
        .register_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::WrongOrigin))
        .await
        .expect_err("registration at another origin must be refused");
    assert!(matches!(error, PasskeyError::Verification(_)));
    assert!(
        load_credentials(&storage, ACCOUNT)
            .await
            .expect("verified credentials")
            .is_empty(),
        "nothing may be written on a failed registration"
    );
}

#[tokio::test]
async fn a_dismissed_prompt_stores_nothing_and_keeps_its_reason() {
    let (manager, storage) = manager();

    let error = manager
        .register_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::Refuse))
        .await
        .expect_err("a dismissed prompt must not enrol anything");
    assert!(
        matches!(error, PasskeyError::NativeCeremony(ref reason) if reason == "dismissed"),
        "the broker's own reason must survive to the caller, got {error:?}"
    );
    assert!(load_credentials(&storage, ACCOUNT)
            .await
            .expect("verified credentials")
            .is_empty());
}

#[tokio::test]
async fn a_native_sign_in_with_nothing_enrolled_says_so() {
    let (manager, storage) = manager();

    let error = manager
        .authenticate_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::Honest))
        .await
        .expect_err("there is nothing to sign in with");
    assert_eq!(error, PasskeyError::NoVerifiedCredentials);
}

#[tokio::test]
async fn a_manager_with_no_relying_party_refuses_both_native_ceremonies() {
    let storage = Storage::new(false);
    let manager = PasskeyManager::default();

    assert_eq!(
        manager
            .register_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::Honest))
            .await
            .expect_err("registration"),
        PasskeyError::SecureRegistrationUnavailable
    );
    assert_eq!(
        manager
            .authenticate_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::Honest))
            .await
            .expect_err("authentication"),
        PasskeyError::SecureVerificationUnavailable
    );
    assert!(load_credentials(&storage, ACCOUNT)
            .await
            .expect("verified credentials")
            .is_empty());
}

// ─── The origin gate ────────────────────────────────────────────────────────

#[tokio::test]
async fn a_relying_party_at_an_untrusted_origin_refuses_before_any_prompt() {
    // `http://example.test` builds a perfectly good relying party — the webview
    // path would run against it — but a native ceremony must not, and must
    // refuse before raising a dialog rather than after.
    let origin = Url::parse("http://example.test").expect("origin");
    let manager = PasskeyManager::new("example.test", &origin).expect("relying party");
    let storage = Storage::new(false);

    let error = manager
        .register_passkey_native(&storage, ACCOUNT, SoftNative::new(Mode::Honest))
        .await
        .expect_err("an untrusted origin must be refused");
    assert!(matches!(error, PasskeyError::NativeOriginRefused(_)));

    // And the capability report agrees, so the frontend is never sent down a
    // route that would refuse.
    assert!(!manager.status().native_ceremony);
    assert_eq!(manager.status().native_client, None);
}

#[test]
fn the_production_windows_origin_passes_the_gate_the_wrapper_trait_would_fail() {
    // The reason `WebauthnAuthenticator`'s safe wrapper is not used: its rule
    // demands the effective domain be exactly `localhost`, and every production
    // Windows build of this app runs at `http://tauri.localhost`.
    let origin = Url::parse("http://tauri.localhost").expect("origin");
    assert!(ensure_native_origin(&origin, "tauri.localhost").is_ok());
}

#[test]
fn an_unconfigured_manager_reports_no_native_ceremony() {
    let status = PasskeyManager::default().status();
    assert!(!status.native_ceremony);
    assert_eq!(status.native_client, None);
}
