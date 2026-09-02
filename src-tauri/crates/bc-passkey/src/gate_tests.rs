//! The gate, and the pieces of it that are only reachable from inside the
//! crate.
//!
//! Two things force these tests to live here rather than in `tests/`:
//!
//! - [`PasskeyManager::verify_token`] is hardcoded to `Ok(false)` while
//!   [`crate::TOKEN_VERIFICATION_ENABLED`] is `false`, so the token store's
//!   rules cannot be observed through the public API. They are exercised
//!   through the crate-private `verify_token_unguarded`, which is `#[cfg(test)]`
//!   and therefore does not exist in the shipped binary — it cannot become a
//!   way around the gate.
//! - Expiry is measured with `Instant`, so a test that waited for it would take
//!   two minutes. The stores expose `#[cfg(test)]` helpers to age an entry.
//!
//! The most important test in this file is
//! [`the_gate_refuses_even_a_genuinely_minted_token`]. Everything else
//! here describes behaviour that is *ready*; that one describes behaviour that
//! is still deliberately switched off, and it is what a reviewer should check
//! is still passing before believing the gate is shut.

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

// ─── The gate itself ────────────────────────────────────────────────────────

/// While the gate is shut, a token minted from a **genuinely verified
/// assertion** is still refused. This is what makes the rest of the ceremony
/// layer safe to land ahead of the frontend: `get_vault_secret` calls
/// `verify_token` and can therefore release nothing, exactly as before.
#[tokio::test]
async fn the_gate_refuses_even_a_genuinely_minted_token() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    assert!(
        !fixture
            .manager
            .verify_token(ACCOUNT, &token, true)
            .await
            .expect("verify_token must never return an error"),
        "the gate is open: `verify_token` accepted a token"
    );
    // The refusal above must not have consumed it either — when the gate opens,
    // the token that was minted is still the one that will be spent.
    assert!(
        fixture
            .manager
            .verify_token_unguarded(ACCOUNT, &token, true),
        "the token store itself must hold a valid token"
    );
}

/// `status()` and `verify_token` must flip together. Reporting availability
/// while the token gate is shut would produce a sign-in button that always
/// fails; the reverse would hide a working feature.
#[tokio::test]
async fn the_status_report_agrees_with_the_gate() {
    let mut fixture = Fixture::new();
    let status = fixture.manager.status();
    assert!(!status.registration_available);
    assert!(!status.authentication_available);
    assert!(!status.unavailable_reason.is_empty());

    // Even after a working enrolment and sign-in, the report is unchanged.
    fixture.register(ACCOUNT).await;
    fixture.sign_in(ACCOUNT).await;
    assert_eq!(fixture.manager.status(), status);
    assert!(
        fixture.manager.is_configured(),
        "the manager is configured; only the report is held back"
    );
}

// ─── Token rules, through a real assertion ──────────────────────────────────

#[tokio::test]
async fn a_token_is_minted_only_by_a_verified_assertion() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;

    // Nothing has succeeded yet, so no token exists for this account at all.
    assert_eq!(fixture.manager.tokens.live_count(), 0);
    assert!(!fixture
        .manager
        .verify_token_unguarded(ACCOUNT, "attacker-controlled-token", true));

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
    assert!(fixture
        .manager
        .verify_token_unguarded(ACCOUNT, &token, true));
}

#[tokio::test]
async fn a_token_is_spendable_once() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    assert!(fixture
        .manager
        .verify_token_unguarded(ACCOUNT, &token, true));
    assert!(
        !fixture
            .manager
            .verify_token_unguarded(ACCOUNT, &token, true),
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
        !fixture
            .manager
            .verify_token_unguarded(OTHER_ACCOUNT, &token, true),
        "a token minted for one key unlocked another key's vault"
    );
    assert!(
        fixture
            .manager
            .verify_token_unguarded(ACCOUNT, &token, true),
        "the cross-account rejection must not have burned the real token"
    );
}

#[tokio::test]
async fn an_expired_token_is_refused() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let token = fixture.sign_in(ACCOUNT).await;

    fixture.manager.tokens.expire_now(ACCOUNT);
    assert!(!fixture
        .manager
        .verify_token_unguarded(ACCOUNT, &token, true));
    assert_eq!(fixture.manager.tokens.live_count(), 0);
}

#[tokio::test]
async fn a_second_sign_in_invalidates_the_first_token() {
    let mut fixture = Fixture::new();
    fixture.register(ACCOUNT).await;
    let first = fixture.sign_in(ACCOUNT).await;
    let second = fixture.sign_in(ACCOUNT).await;

    assert_ne!(first, second);
    assert!(!fixture
        .manager
        .verify_token_unguarded(ACCOUNT, &first, true));
    assert!(fixture
        .manager
        .verify_token_unguarded(ACCOUNT, &second, true));
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
    assert!(!manager.verify_token_unguarded(ACCOUNT, "anything", true));
}
