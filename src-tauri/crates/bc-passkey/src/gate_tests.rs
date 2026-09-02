//! The gate, and the pieces of it that are only reachable from inside the
//! crate.
//!
//! What forces these tests to live here rather than in `tests/` is expiry:
//! it is measured with `Instant`, so a test that waited for it would take two
//! minutes. The stores expose `#[cfg(test)]` helpers to age an entry, and
//! [`crate::PasskeyManager::tokens`] is private.
//!
//! Until the gate opened, these tests reached the token store through a
//! crate-private `verify_token_unguarded`, because
//! [`crate::PasskeyManager::verify_token`] was hardcoded to `Ok(false)` and the
//! store's rules were not observable through the public API. That bypass is
//! **gone**: every assertion below now goes through `verify_token` itself, so
//! what these tests pin is what a caller — `get_vault_secret` in particular —
//! actually gets.
//!
//! The most important test in this file is
//! [`the_open_gate_accepts_a_genuine_token_and_refuses_every_other_kind`]. It
//! is the inverse of the test that stood here while the gate was shut, and it
//! is what a reviewer should check is passing before believing that a passkey
//! sign-in works and that nothing else does.

use serde_json::Value;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::{CreationChallengeResponse, RequestChallengeResponse, Url};

use crate::{PasskeyError, PasskeyManager, Storage};

const ACCOUNT: &str = "key_passkey";
const OTHER_ACCOUNT: &str = "key_other";
const RP_ID: &str = "localhost";
const ORIGIN: &str = "https://localhost";

struct Fixture {
    manager: PasskeyManager,
    storage: Storage,
    authenticator: SoftPasskey,
    origin: Url,
}

impl Fixture {
    fn new() -> Self {
        let origin = Url::parse(ORIGIN).expect("origin");
        Self {
            manager: PasskeyManager::new(RP_ID, &origin).expect("relying party"),
            storage: Storage::new(false),
            authenticator: SoftPasskey::new(true),
            origin,
        }
    }

    async fn register(&mut self, account: &str) {
        let options = self
            .manager
            .get_registration_options(&self.storage, account)
            .await
            .expect("registration options");
        let challenge: CreationChallengeResponse =
            serde_json::from_value(options).expect("creation challenge");
        let registration = self
            .authenticator
            .do_registration(self.origin.clone(), challenge)
            .expect("authenticator registration");
        self.manager
            .register_passkey(
                &self.storage,
                account,
                serde_json::to_value(&registration).expect("attestation"),
            )
            .await
            .expect("registration must complete");
    }

    /// A complete, genuine sign-in. Returns the minted token.
    async fn sign_in(&mut self, account: &str) -> String {
        let options = self
            .manager
            .get_auth_options(&self.storage, account)
            .await
            .expect("auth options");
        let challenge: RequestChallengeResponse =
            serde_json::from_value(options).expect("request challenge");
        let assertion = self
            .authenticator
            .do_authentication(self.origin.clone(), challenge)
            .expect("authenticator assertion");
        let result: Value = self
            .manager
            .authenticate_passkey(
                &self.storage,
                account,
                serde_json::to_value(&assertion).expect("assertion"),
            )
            .await
            .expect("a genuine assertion must verify");
        result["token"].as_str().expect("token").to_string()
    }
}

/// `verify_token` through the public API, which is now the only way in.
///
/// It is documented never to return `Err` — a caller might read an error as
/// inconclusive rather than as a refusal — so a failure here is itself a
/// finding, not a test-harness detail.
async fn verify(manager: &PasskeyManager, account: &str, token: &str, consume: bool) -> bool {
    manager
        .verify_token(account, token, consume)
        .await
        .expect("verify_token must never return an error")
}

// ─── The gate itself ────────────────────────────────────────────────────────

/// The inverse of the test that stood here while the gate was shut.
///
/// That test — `the_gate_refuses_even_a_genuinely_minted_token` — asserted that
/// a token minted from a genuinely verified assertion was refused anyway. That
/// behaviour changed **by design** when [`crate::TOKEN_VERIFICATION_ENABLED`]
/// became `true`, so the test was rewritten rather than deleted: deleting it
/// would have removed the only place that states, in one test, what opening the
/// gate did and did not change.
///
/// What it now pins is both halves of that. A genuine token is accepted, so a
/// passkey sign-in can release a vault secret. Nothing else is: not a forged
/// token, not a bit-flipped version of the real one, not the real one for
/// another account, not a token already spent, and not an expired one. Each
/// negative below starts from the **genuinely minted** token, so it isolates
/// one rule rather than merely re-testing that nonsense is rejected.
#[tokio::test]
async fn the_open_gate_accepts_a_genuine_token_and_refuses_every_other_kind() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    fixture.register(OTHER_ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    // A forged token, and the genuine one tampered with in a single character.
    assert!(
        !verify(&fixture.manager, ACCOUNT, "attacker-controlled-token", true).await,
        "a forged token was accepted"
    );
    let mut tampered = token.clone();
    let last = tampered.pop().expect("a token is never empty");
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    assert_ne!(tampered, token);
    assert!(
        !verify(&fixture.manager, ACCOUNT, &tampered, true).await,
        "a tampered token was accepted"
    );

    // The genuine token, offered for a different account.
    assert!(
        !verify(&fixture.manager, OTHER_ACCOUNT, &token, true).await,
        "a token minted for one key unlocked another key's vault"
    );

    // None of those refusals may have burned the real token: an attacker able
    // to call the command must not be able to cancel a legitimate unlock.
    assert!(
        verify(&fixture.manager, ACCOUNT, &token, true).await,
        "the gate is shut: `verify_token` refused a genuinely minted token"
    );

    // And it was spent by that acceptance, so a replay is refused.
    assert!(
        !verify(&fixture.manager, ACCOUNT, &token, true).await,
        "a consumed token was accepted a second time"
    );

    // An expired token is refused even though it was never spent.
    let fresh = fixture.sign_in(ACCOUNT).await;
    fixture.manager.tokens.expire_now(ACCOUNT);
    assert!(
        !verify(&fixture.manager, ACCOUNT, &fresh, true).await,
        "an expired token was accepted"
    );
    assert_eq!(fixture.manager.tokens.live_count(), 0);
}

/// `status()` and `verify_token` flip together. Reporting availability while
/// the token gate is shut would produce a sign-in button that always fails; the
/// reverse would hide a working feature.
///
/// Inverted with the test above: a configured manager now reports available,
/// and an unconfigured one still does not — availability is `is_configured()`,
/// not a constant, so the two cases must be checked separately.
#[tokio::test]
async fn the_status_report_agrees_with_the_gate() {
    let mut fixture = Fixture::new();
    let status = fixture.manager.status();
    assert!(status.registration_available);
    assert!(status.authentication_available);
    assert!(
        status.unavailable_reason.is_empty(),
        "an available relying party must report no reason: {}",
        status.unavailable_reason
    );
    assert!(
        status.legacy_credentials_require_reregistration,
        "pre-verification records still cannot assert, whatever the gate says"
    );

    // A working enrolment and sign-in do not change the report...
    fixture.register(ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;
    assert_eq!(fixture.manager.status(), status);
    // ...and the capability it reports is real, not just claimed.
    assert!(verify(&fixture.manager, ACCOUNT, &token, true).await);

    // A manager with no relying party reports the opposite, with its reason.
    let unconfigured = PasskeyManager::unavailable(crate::REASON_ORIGIN_UNRESOLVED);
    let status = unconfigured.status();
    assert!(!status.registration_available);
    assert!(!status.authentication_available);
    assert_eq!(status.unavailable_reason, crate::REASON_ORIGIN_UNRESOLVED);
}

// ─── Token rules, through a real assertion ──────────────────────────────────

#[tokio::test]
async fn a_token_is_minted_only_by_a_verified_assertion() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;

    // Nothing has succeeded yet, so no token exists for this account at all.
    assert_eq!(fixture.manager.tokens.live_count(), 0);
    assert!(!verify(&fixture.manager, ACCOUNT, "attacker-controlled-token", true).await);

    // A failed assertion must not mint one either.
    let options = fixture
        .manager
        .get_auth_options(&fixture.storage, ACCOUNT)
        .await
        .expect("auth options");
    let challenge: RequestChallengeResponse =
        serde_json::from_value(options).expect("request challenge");
    let assertion = fixture
        .authenticator
        .do_authentication(fixture.origin.clone(), challenge)
        .expect("authenticator assertion");
    let mut tampered = serde_json::to_value(&assertion).expect("assertion");
    tampered["response"]["signature"] = serde_json::json!("dGFtcGVyZWQ");
    fixture
        .manager
        .authenticate_passkey(&fixture.storage, ACCOUNT, tampered)
        .await
        .expect_err("a tampered assertion must not verify");
    assert_eq!(
        fixture.manager.tokens.live_count(),
        0,
        "a failed assertion minted a token"
    );

    let token = fixture.sign_in(ACCOUNT).await;
    assert_eq!(fixture.manager.tokens.live_count(), 1);
    assert!(verify(&fixture.manager, ACCOUNT, &token, true).await);
}

#[tokio::test]
async fn a_token_is_spendable_once() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    assert!(verify(&fixture.manager, ACCOUNT, &token, true).await);
    assert!(
        !verify(&fixture.manager, ACCOUNT, &token, true).await,
        "a consumed token must not verify again"
    );
}

#[tokio::test]
async fn a_token_never_unlocks_another_account() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    fixture.register(OTHER_ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    assert!(
        !verify(&fixture.manager, OTHER_ACCOUNT, &token, true).await,
        "a token minted for one key unlocked another key's vault"
    );
    assert!(
        verify(&fixture.manager, ACCOUNT, &token, true).await,
        "the cross-account rejection must not have burned the real token"
    );
}

#[tokio::test]
async fn an_expired_token_is_refused() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    fixture.manager.tokens.expire_now(ACCOUNT);
    assert!(!verify(&fixture.manager, ACCOUNT, &token, true).await);
    assert_eq!(fixture.manager.tokens.live_count(), 0);
}

#[tokio::test]
async fn a_second_sign_in_invalidates_the_first_token() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let first = fixture.sign_in(ACCOUNT).await;
    let second = fixture.sign_in(ACCOUNT).await;

    assert_ne!(first, second);
    assert!(!verify(&fixture.manager, ACCOUNT, &first, true).await);
    assert!(verify(&fixture.manager, ACCOUNT, &second, true).await);
}

#[tokio::test]
async fn the_token_names_the_credential_that_signed() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    fixture.sign_in(ACCOUNT).await;

    let credential = crate::credential::load_credentials(&fixture.storage, ACCOUNT)
        .await
        .expect("load")
        .credentials
        .remove(0);
    assert_eq!(
        fixture.manager.token_credential(ACCOUNT),
        Some(credential.credential_id),
        "the audit trail must be able to name the credential behind a token"
    );
    assert_eq!(fixture.manager.token_credential(OTHER_ACCOUNT), None);
}

// ─── Challenge expiry and capacity, at the manager level ────────────────────

#[tokio::test]
async fn an_expired_registration_challenge_is_refused() {
    let mut fixture = Fixture::new();
    let options = fixture
        .manager
        .get_registration_options(&fixture.storage, ACCOUNT)
        .await
        .expect("registration options");
    let challenge: CreationChallengeResponse =
        serde_json::from_value(options).expect("creation challenge");
    let registration = fixture
        .authenticator
        .do_registration(fixture.origin.clone(), challenge)
        .expect("authenticator registration");

    fixture.manager.registrations.expire_now(ACCOUNT);

    let error = fixture
        .manager
        .register_passkey(
            &fixture.storage,
            ACCOUNT,
            serde_json::to_value(&registration).expect("attestation"),
        )
        .await
        .expect_err("an expired challenge must be refused");
    assert_eq!(error, PasskeyError::ChallengeExpired);
    assert!(
        crate::credential::load_credentials(&fixture.storage, ACCOUNT)
            .await
            .expect("load")
            .is_empty(),
        "an expired registration wrote a credential"
    );
}

#[tokio::test]
async fn an_expired_authentication_challenge_is_refused_and_mints_nothing() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;

    let options = fixture
        .manager
        .get_auth_options(&fixture.storage, ACCOUNT)
        .await
        .expect("auth options");
    let challenge: RequestChallengeResponse =
        serde_json::from_value(options).expect("request challenge");
    let assertion = fixture
        .authenticator
        .do_authentication(fixture.origin.clone(), challenge)
        .expect("authenticator assertion");

    fixture.manager.authentications.expire_now(ACCOUNT);

    let error = fixture
        .manager
        .authenticate_passkey(
            &fixture.storage,
            ACCOUNT,
            serde_json::to_value(&assertion).expect("assertion"),
        )
        .await
        .expect_err("an expired challenge must be refused");
    assert_eq!(error, PasskeyError::ChallengeExpired);
    assert_eq!(
        fixture.manager.tokens.live_count(),
        0,
        "an expired ceremony minted a token"
    );
}

/// A caller looping on `get_registration_options` for new account ids must not
/// be able to grow the challenge map without bound.
#[tokio::test]
async fn pending_ceremonies_are_capped_at_the_manager_level() {
    let fixture = Fixture::new();
    for index in 0..crate::MAX_PENDING_CEREMONIES {
        fixture
            .manager
            .get_registration_options(&fixture.storage, &format!("key_{index}"))
            .await
            .expect("registration options");
    }

    let error = fixture
        .manager
        .get_registration_options(&fixture.storage, "key_overflow")
        .await
        .expect_err("the cap must be enforced");
    assert_eq!(error, PasskeyError::TooManyPendingCeremonies);

    // An account that already has a ceremony can still retry.
    fixture
        .manager
        .get_registration_options(&fixture.storage, "key_0")
        .await
        .expect("a retry must always be possible");
}

// ─── The fail-closed manager still refuses everything ───────────────────────

#[tokio::test]
async fn an_unconfigured_manager_runs_no_ceremony_and_holds_no_token() {
    let storage = Storage::new(false);
    let manager = PasskeyManager::unavailable(crate::REASON_ORIGIN_UNRESOLVED);

    assert_eq!(
        manager
            .get_registration_options(&storage, ACCOUNT)
            .await
            .expect_err("registration"),
        PasskeyError::SecureRegistrationUnavailable
    );
    assert_eq!(
        manager
            .get_auth_options(&storage, ACCOUNT)
            .await
            .expect_err("auth options"),
        PasskeyError::SecureVerificationUnavailable
    );
    assert_eq!(
        manager
            .register_passkey(&storage, ACCOUNT, serde_json::json!({}))
            .await
            .expect_err("register"),
        PasskeyError::SecureRegistrationUnavailable
    );
    assert_eq!(
        manager
            .authenticate_passkey(&storage, ACCOUNT, serde_json::json!({}))
            .await
            .expect_err("authenticate"),
        PasskeyError::SecureVerificationUnavailable
    );
    assert_eq!(manager.tokens.live_count(), 0);
    assert!(!verify(&manager, ACCOUNT, "anything", true).await);
}
