//! Real WebAuthn ceremonies, driven end to end against an in-process software
//! authenticator.
//!
//! # Why the negative cases carry all the weight
//!
//! A passing happy path proves very little here. The implementation
//! `d05fe59` removed had a *working* happy path: it issued a challenge, the
//! browser came back, and it said yes. What it never did was check a signature.
//! Every test below that ends in "is rejected" is testing the thing that was
//! missing, and each one is written so that it would still pass if the check it
//! targets were the only one working — and, more importantly, would fail if
//! that check were removed.
//!
//! Two of them are deliberately built to carry a **cryptographically valid
//! signature**, so they cannot be satisfied by a signature check alone:
//!
//! - [`an_assertion_for_one_challenge_is_rejected_against_another`] replays a
//!   genuine assertion into a different ceremony. Everything about it verifies
//!   except the challenge.
//! - [`an_assertion_from_a_subdomain_origin_is_rejected`] has the authenticator
//!   sign a real assertion at `https://evil.localhost`. The signature is valid
//!   and the RP-ID hash is correct; only the origin is wrong.
//!
//! The rest tamper with bytes, which breaks the signature as well — that is
//! expected and fine, because the property under test is "rejected", not "
//! rejected for this specific reason".
//!
//! # What is deliberately *not* tested here
//!
//! No test asserts a clientDataJSON field, an RP-ID hash, a flag bit, or a
//! counter comparison directly. Those are `webauthn-rs` internals, and
//! re-deriving them in a test would pin our *assumptions* about the library
//! rather than the library. These tests establish that the library is wired up
//! such that its checks fire.

use std::collections::HashSet;

use base64::Engine;
use bc_passkey::credential::{
    append_credential, credential_storage_key, load_credentials, StoredCredential,
};
use bc_passkey::{PasskeyError, PasskeyManager, Storage};
use serde_json::{json, Value};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::{
    CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse, Url,
};
use webauthn_rs::WebauthnBuilder;

const ACCOUNT: &str = "key_passkey";
const OTHER_ACCOUNT: &str = "key_other";
const RP_ID: &str = "localhost";
const ORIGIN: &str = "https://localhost";

// ─── Harness ────────────────────────────────────────────────────────────────

/// A configured relying party, its storage, and a software authenticator.
struct Ceremony {
    manager: PasskeyManager,
    storage: Storage,
    authenticator: SoftPasskey,
    origin: Url,
}

impl Ceremony {
    fn new() -> Self {
        let origin = Url::parse(ORIGIN).expect("origin");
        Self {
            manager: PasskeyManager::new(RP_ID, &origin).expect("relying party"),
            storage: Storage::new(false),
            // `falsify_uv` makes the software authenticator claim user
            // verification, which `start_passkey_authentication` requires.
            authenticator: SoftPasskey::new(true),
            origin,
        }
    }

    async fn start_registration(&self, account: &str) -> Result<Value, PasskeyError> {
        self.manager
            .get_registration_options(&self.storage, account)
            .await
    }

    /// Drive the authenticator through a registration and return the raw
    /// attestation JSON, without submitting it.
    async fn attest(&mut self, account: &str) -> Value {
        let options = self
            .start_registration(account)
            .await
            .expect("registration options");
        let challenge: CreationChallengeResponse =
            serde_json::from_value(options).expect("creation challenge");
        let registration = self
            .authenticator
            .do_registration(self.origin.clone(), challenge)
            .expect("software authenticator registration");
        serde_json::to_value(&registration).expect("attestation json")
    }

    /// A complete, successful enrolment.
    async fn register(&mut self, account: &str) {
        let attestation = self.attest(account).await;
        self.manager
            .register_passkey(&self.storage, account, attestation)
            .await
            .expect("registration must complete");
    }

    /// Drive the authenticator through an assertion and return the raw JSON,
    /// without submitting it. The ceremony state stays pending.
    async fn assert_at(&mut self, account: &str, origin: &Url) -> Value {
        let options = self
            .manager
            .get_auth_options(&self.storage, account)
            .await
            .expect("auth options");
        let challenge: RequestChallengeResponse =
            serde_json::from_value(options).expect("request challenge");
        let assertion = self
            .authenticator
            .do_authentication(origin.clone(), challenge)
            .expect("software authenticator assertion");
        serde_json::to_value(&assertion).expect("assertion json")
    }

    async fn assertion(&mut self, account: &str) -> Value {
        let origin = self.origin.clone();
        self.assert_at(account, &origin).await
    }

    async fn submit(&self, account: &str, assertion: Value) -> Result<Value, PasskeyError> {
        self.manager
            .authenticate_passkey(&self.storage, account, assertion)
            .await
    }

    async fn credentials(&self, account: &str) -> Vec<StoredCredential> {
        load_credentials(&self.storage, account)
            .await
            .expect("load credentials")
            .credentials
    }

    async fn raw_records(&self, account: &str) -> Vec<Value> {
        self.storage
            .get_typed_list(&credential_storage_key(account))
            .await
            .expect("raw records")
    }
}

fn decode(value: &str) -> Vec<u8> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .expect("base64url field")
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Rewrite the decoded `clientDataJSON` of an assertion.
fn edit_client_data(assertion: &mut Value, edit: impl FnOnce(&mut Value)) {
    let raw = assertion["response"]["clientDataJSON"]
        .as_str()
        .expect("clientDataJSON");
    let mut client_data: Value = serde_json::from_slice(&decode(raw)).expect("client data json");
    edit(&mut client_data);
    assertion["response"]["clientDataJSON"] = json!(encode(
        &serde_json::to_vec(&client_data).expect("client data bytes")
    ));
}

/// Flip one bit of a base64url-encoded field.
fn flip_bit(assertion: &mut Value, path: &[&str], byte: usize) {
    let mut node = assertion;
    for step in &path[..path.len() - 1] {
        node = &mut node[*step];
    }
    let field = path[path.len() - 1];
    let mut bytes = decode(node[field].as_str().expect("encoded field"));
    bytes[byte] ^= 0x01;
    node[field] = json!(encode(&bytes));
}

// ─── The happy path, and what it must have persisted ────────────────────────

#[tokio::test]
async fn a_registered_passkey_authenticates_and_mints_a_token() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let stored = ceremony.credentials(ACCOUNT).await;
    assert_eq!(stored.len(), 1, "registration must persist one credential");
    assert_eq!(stored[0].rp_id, RP_ID);
    assert_eq!(
        stored[0].origin,
        Url::parse(ORIGIN).expect("origin").as_str(),
        "the credential records the origin it was enrolled under"
    );
    assert!(
        stored[0].last_used_at.is_none(),
        "a credential that has never signed in must not claim it has"
    );

    let assertion = ceremony.assertion(ACCOUNT).await;
    let result = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect("a genuine assertion must verify");

    assert_eq!(result["success"], json!(true));
    let token = result["token"].as_str().expect("token");
    assert_eq!(
        token.len(),
        43,
        "32 bytes of base64url, unpadded, is 43 characters"
    );
    assert_eq!(
        result["credentialId"].as_str(),
        Some(stored[0].credential_id.as_str()),
        "the audit record must be able to name the credential that signed"
    );

    let after = ceremony.credentials(ACCOUNT).await;
    assert!(
        after[0].last_used_at.is_some(),
        "a successful sign-in must be recorded"
    );
}

#[tokio::test]
async fn the_stored_counter_follows_the_authenticator_across_repeated_sign_ins() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;
    assert_eq!(
        ceremony.credentials(ACCOUNT).await[0].counter(),
        0,
        "registration records the authenticator's initial counter"
    );

    let mut seen = Vec::new();
    for _ in 0..3 {
        let assertion = ceremony.assertion(ACCOUNT).await;
        ceremony
            .submit(ACCOUNT, assertion)
            .await
            .expect("each sign-in must verify");
        seen.push(ceremony.credentials(ACCOUNT).await[0].counter());
    }

    // The point is not the specific values — those belong to the authenticator
    // — but that a second and third sign-in are accepted at all, and that what
    // the library reports is what gets persisted. A counter rule of our own
    // that was stricter than the specification's would fail here on the second
    // iteration.
    assert_eq!(seen, vec![1, 2, 3], "persisted counters: {seen:?}");
}

#[tokio::test]
async fn two_accounts_keep_separate_credentials_and_separate_ceremonies() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;
    ceremony.register(OTHER_ACCOUNT).await;

    assert_eq!(ceremony.credentials(ACCOUNT).await.len(), 1);
    assert_eq!(ceremony.credentials(OTHER_ACCOUNT).await.len(), 1);
    assert_ne!(
        ceremony.credentials(ACCOUNT).await[0].credential_id,
        ceremony.credentials(OTHER_ACCOUNT).await[0].credential_id
    );

    // An assertion produced for one account must not complete the other's
    // ceremony, even though both are live at the same time.
    let assertion = ceremony.assertion(ACCOUNT).await;
    ceremony
        .manager
        .get_auth_options(&ceremony.storage, OTHER_ACCOUNT)
        .await
        .expect("second ceremony");
    let error = ceremony
        .submit(OTHER_ACCOUNT, assertion)
        .await
        .expect_err("an assertion for another account must not verify");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

// ─── Negative cases: the checks that were missing ───────────────────────────

/// A **cryptographically valid** assertion, submitted against a challenge it
/// was not produced for. Nothing about it is malformed; only the challenge is
/// wrong. This is the test the old implementation would have passed while being
/// completely forgeable, and the one that proves the challenge is now bound
/// into something signed rather than merely echoed.
#[tokio::test]
async fn an_assertion_for_one_challenge_is_rejected_against_another() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let assertion = ceremony.assertion(ACCOUNT).await;
    // Starting a second ceremony replaces the pending state, so the assertion
    // above is now answering the wrong challenge.
    ceremony
        .manager
        .get_auth_options(&ceremony.storage, ACCOUNT)
        .await
        .expect("second ceremony");

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("an assertion for a different challenge must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

/// A genuine assertion, signed by the authenticator at a *subdomain* of the
/// configured origin. The signature verifies and the RP-ID hash is correct;
/// only `clientDataJSON.origin` disagrees. This is the case
/// `GHSA-22w3-693w-x895` was about, and it must stay rejected — which is what
/// `allow_subdomains(false)` buys.
#[tokio::test]
async fn an_assertion_from_a_subdomain_origin_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let evil = Url::parse("https://evil.localhost").expect("subdomain origin");
    let assertion = ceremony.assert_at(ACCOUNT, &evil).await;

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a subdomain origin must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

#[tokio::test]
async fn a_tampered_origin_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    edit_client_data(&mut assertion, |client_data| {
        client_data["origin"] = json!("https://attacker.example");
    });

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a rewritten origin must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

#[tokio::test]
async fn a_tampered_challenge_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    edit_client_data(&mut assertion, |client_data| {
        client_data["challenge"] = json!(encode(&[0x42_u8; 32]));
    });

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a rewritten challenge must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

#[tokio::test]
async fn a_tampered_ceremony_type_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    edit_client_data(&mut assertion, |client_data| {
        client_data["type"] = json!("webauthn.create");
    });

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a registration-typed clientDataJSON must not authenticate");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

/// The RP-ID hash is the first 32 bytes of `authenticatorData`.
#[tokio::test]
async fn a_tampered_rp_id_hash_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    flip_bit(&mut assertion, &["response", "authenticatorData"], 0);

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a corrupted RP-ID hash must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

/// Byte 32 of `authenticatorData` is the flag byte; clearing it clears user
/// presence and user verification together.
#[tokio::test]
async fn cleared_authenticator_flags_are_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    let raw = assertion["response"]["authenticatorData"]
        .as_str()
        .expect("authenticatorData");
    let mut bytes = decode(raw);
    bytes[32] = 0;
    assertion["response"]["authenticatorData"] = json!(encode(&bytes));

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("an assertion with no user presence must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

#[tokio::test]
async fn a_tampered_signature_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    flip_bit(&mut assertion, &["response", "signature"], 10);

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a flipped signature bit must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

#[tokio::test]
async fn an_unknown_credential_id_is_rejected() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    let unknown = encode(&[0x5a_u8; 32]);
    assertion["id"] = json!(unknown);
    assertion["rawId"] = json!(unknown);

    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("an unknown credential id must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

/// The single most important rewrite of the old suite. Previously this passed
/// vacuously, because *every* assertion was rejected. Here the assertion is
/// genuine and succeeds the first time; the second submission must fail.
#[tokio::test]
async fn a_valid_assertion_cannot_be_replayed() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let assertion = ceremony.assertion(ACCOUNT).await;
    let first = ceremony
        .submit(ACCOUNT, assertion.clone())
        .await
        .expect("the genuine assertion verifies once");
    assert_eq!(first["success"], json!(true));

    // Immediately: the challenge was consumed by the successful attempt.
    let error = ceremony
        .submit(ACCOUNT, assertion.clone())
        .await
        .expect_err("a used assertion must not verify again");
    assert_eq!(error, PasskeyError::ChallengeExpired);

    // And with a fresh ceremony open, so the failure cannot be attributed to
    // "no ceremony was pending": the replayed assertion answers the old
    // challenge, and the library rejects it.
    ceremony
        .manager
        .get_auth_options(&ceremony.storage, ACCOUNT)
        .await
        .expect("fresh ceremony");
    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a replayed assertion must not verify against a new challenge");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
}

/// A counter that goes backwards is the signal for a cloned authenticator. The
/// decision belongs entirely to `webauthn-rs`; this proves it reaches it.
#[tokio::test]
async fn a_counter_regression_is_rejected_and_mints_nothing() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;
    let assertion = ceremony.assertion(ACCOUNT).await;
    ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect("first sign-in");

    // Force the stored counter far ahead of the authenticator's, which is what
    // a cloned credential looks like from the relying party's side.
    let mut records = ceremony.raw_records(ACCOUNT).await;
    records[0]["passkey"]["cred"]["counter"] = json!(500);
    ceremony
        .storage
        .store_secret(
            &credential_storage_key(ACCOUNT),
            &serde_json::to_string(&records).expect("records"),
        )
        .await
        .expect("seed a regressed counter");
    assert_eq!(ceremony.credentials(ACCOUNT).await[0].counter(), 500);

    let assertion = ceremony.assertion(ACCOUNT).await;
    let error = ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect_err("a counter regression must be rejected");
    assert!(matches!(error, PasskeyError::Verification(_)), "{error:?}");
    assert_eq!(
        ceremony.credentials(ACCOUNT).await[0].counter(),
        500,
        "a rejected assertion must not move the stored counter"
    );
}

/// R3: a rule of our own that demanded a strictly increasing counter would
/// reject every iCloud Keychain, Windows Hello and Android passkey on the
/// second sign-in, because those report `0` permanently. `webauthn-rs`
/// implements the specification's exemption for that case; we must not layer
/// anything on top of it.
///
/// Neither software authenticator available here can emit a permanently-zero
/// counter — both increment — so the exemption itself cannot be exercised from
/// this crate. What *can* be pinned is the thing that would break it: that no
/// counter comparison exists anywhere in our own source. A future edit adding
/// `if result.counter() <= stored.counter() { reject }` fails this test.
#[test]
fn no_counter_policy_is_implemented_outside_the_library() {
    const SOURCES: [(&str, &str); 5] = [
        ("lib.rs", include_str!("../src/lib.rs")),
        ("credential.rs", include_str!("../src/credential.rs")),
        ("challenge.rs", include_str!("../src/challenge.rs")),
        ("token.rs", include_str!("../src/token.rs")),
        ("config.rs", include_str!("../src/config.rs")),
    ];
    // Comparison spellings that would constitute a counter policy of our own.
    const FORBIDDEN: [&str; 8] = [
        "counter >",
        "counter <",
        "counter ==",
        "counter !=",
        "counter() >",
        "counter() <",
        "counter() ==",
        "counter() !=",
    ];

    for (name, source) in SOURCES {
        // Doc comments discuss the counter policy at length and must not trip
        // this; only real code is examined.
        let code: String = source
            .lines()
            .filter(|line| {
                let trimmed = line.trim_start();
                !trimmed.starts_with("//") && !trimmed.starts_with("*")
            })
            .collect::<Vec<_>>()
            .join("\n");
        for spelling in FORBIDDEN {
            assert!(
                !code.contains(spelling),
                "{name} appears to implement its own counter policy (`{spelling}`); \
                 the decision belongs to `Passkey::update_credential`"
            );
        }
    }
}

// ─── Registration: nothing is written on any failure path ───────────────────

/// Note what is deliberately *absent* from this list: a byte flipped inside the
/// attestation object's public key. Under `AttestationConveyancePreference::None`
/// — the correct policy for this app, see plan §0.1 — the attestation object
/// carries no signature, so substituting a different public key there is not
/// detectable and is not meant to be. Registration binds a server-issued
/// challenge and an origin; it does not attest to the hardware. A test asserting
/// otherwise would be pinning a guarantee we do not have.
#[tokio::test]
async fn registration_writes_nothing_when_the_ceremony_is_tampered_with() {
    let mut ceremony = Ceremony::new();

    type Tamper = Box<dyn Fn(&mut Value)>;
    let cases: Vec<(&str, Tamper)> = vec![
        (
            "unreadable attestation object",
            Box::new(|attestation: &mut Value| {
                attestation["response"]["attestationObject"] = json!(encode(b"not cbor at all"));
            }),
        ),
        (
            "tampered client data",
            Box::new(|attestation: &mut Value| {
                let raw = attestation["response"]["clientDataJSON"]
                    .as_str()
                    .expect("clientDataJSON");
                let mut client_data: Value =
                    serde_json::from_slice(&decode(raw)).expect("client data");
                client_data["challenge"] = json!(encode(&[0x11_u8; 32]));
                attestation["response"]["clientDataJSON"] =
                    json!(encode(&serde_json::to_vec(&client_data).expect("bytes")));
            }),
        ),
        (
            "tampered origin",
            Box::new(|attestation: &mut Value| {
                let raw = attestation["response"]["clientDataJSON"]
                    .as_str()
                    .expect("clientDataJSON");
                let mut client_data: Value =
                    serde_json::from_slice(&decode(raw)).expect("client data");
                client_data["origin"] = json!("https://attacker.example");
                attestation["response"]["clientDataJSON"] =
                    json!(encode(&serde_json::to_vec(&client_data).expect("bytes")));
            }),
        ),
    ];

    for (name, tamper) in cases {
        let mut attestation = ceremony.attest(ACCOUNT).await;
        tamper(&mut attestation);
        let error = match ceremony
            .manager
            .register_passkey(&ceremony.storage, ACCOUNT, attestation)
            .await
        {
            Err(error) => error,
            Ok(()) => panic!("{name}: a tampered registration was accepted"),
        };
        assert!(
            matches!(
                error,
                PasskeyError::Verification(_) | PasskeyError::MalformedCeremonyResponse(_)
            ),
            "{name}: {error:?}"
        );
        assert!(
            ceremony.raw_records(ACCOUNT).await.is_empty(),
            "{name}: a failed registration wrote to storage"
        );
    }
}

/// A registration carries the credential id twice: once in the JSON envelope
/// (`id` / `rawId`) and once inside the attested credential data in the
/// attestation object. **The envelope is not authoritative and the library does
/// not check the two against each other** — measured, not assumed: rewriting
/// `id` and `rawId` to arbitrary values still produces a successful
/// registration.
///
/// That is only safe because the record we persist takes its handle from
/// `Passkey::cred_id()`, which the library read out of the attested data.
/// A version of `StoredCredential::new` that trusted the caller's `rawId`
/// instead would let an enrolment be filed under an id of the caller's
/// choosing — including one already belonging to another credential. This test
/// exists to make that dependency explicit and to fail if it is ever reversed.
#[tokio::test]
async fn the_stored_credential_id_comes_from_the_attested_data_not_the_envelope() {
    let mut ceremony = Ceremony::new();
    let mut attestation = ceremony.attest(ACCOUNT).await;
    let claimed = encode(&[0x7f_u8; 32]);
    attestation["id"] = json!(claimed);
    attestation["rawId"] = json!(claimed);

    ceremony
        .manager
        .register_passkey(&ceremony.storage, ACCOUNT, attestation)
        .await
        .expect("the library reads the credential id from the attested data");

    let stored = ceremony.credentials(ACCOUNT).await;
    assert_eq!(stored.len(), 1);
    assert_ne!(
        stored[0].credential_id, claimed,
        "the caller's `rawId` must not become the stored handle"
    );
    assert_eq!(
        stored[0].credential_id,
        bc_passkey::credential::encode_credential_id(stored[0].raw_credential_id()),
        "the stored handle must be the attested credential id"
    );
}

#[tokio::test]
async fn a_malformed_registration_body_writes_nothing() {
    let ceremony = Ceremony::new();
    ceremony
        .start_registration(ACCOUNT)
        .await
        .expect("registration options");

    let error = ceremony
        .manager
        .register_passkey(&ceremony.storage, ACCOUNT, json!({ "untrusted": true }))
        .await
        .expect_err("a body that is not an attestation must be refused");
    assert!(
        matches!(error, PasskeyError::MalformedCeremonyResponse(_)),
        "{error:?}"
    );
    assert!(ceremony.raw_records(ACCOUNT).await.is_empty());
}

/// The challenge is taken before verification, so a *failed* attempt burns it
/// too. Otherwise a caller could grind against one challenge until it found a
/// forgery the library accepted.
#[tokio::test]
async fn a_failed_registration_burns_the_challenge() {
    let mut ceremony = Ceremony::new();
    let mut attestation = ceremony.attest(ACCOUNT).await;
    let genuine = attestation.clone();
    attestation["response"]["attestationObject"] = json!(encode(b"not cbor at all"));

    ceremony
        .manager
        .register_passkey(&ceremony.storage, ACCOUNT, attestation)
        .await
        .expect_err("tampered registration must fail");

    // The same attestation that *would* have succeeded is now too late.
    let error = ceremony
        .manager
        .register_passkey(&ceremony.storage, ACCOUNT, genuine)
        .await
        .expect_err("the challenge must not survive a failed attempt");
    assert_eq!(error, PasskeyError::ChallengeExpired);
    assert!(ceremony.raw_records(ACCOUNT).await.is_empty());
}

#[tokio::test]
async fn a_failed_assertion_burns_the_challenge() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    let genuine = ceremony.assertion(ACCOUNT).await;
    let mut tampered = genuine.clone();
    flip_bit(&mut tampered, &["response", "signature"], 4);

    ceremony
        .submit(ACCOUNT, tampered)
        .await
        .expect_err("tampered assertion must fail");
    let error = ceremony
        .submit(ACCOUNT, genuine)
        .await
        .expect_err("the challenge must not survive a failed attempt");
    assert_eq!(error, PasskeyError::ChallengeExpired);
}

#[tokio::test]
async fn completing_a_ceremony_that_was_never_started_is_refused() {
    let ceremony = Ceremony::new();

    assert_eq!(
        ceremony
            .manager
            .register_passkey(&ceremony.storage, ACCOUNT, json!({}))
            .await
            .expect_err("no pending registration"),
        PasskeyError::ChallengeExpired
    );
    assert_eq!(
        ceremony
            .submit(ACCOUNT, json!({}))
            .await
            .expect_err("no pending authentication"),
        PasskeyError::ChallengeExpired
    );
}

/// An authenticator the user has already enrolled must be offered as an
/// exclusion, so it declines in the browser rather than silently creating a
/// second credential for the same device.
///
/// The server-side duplicate refusal is the backstop for an authenticator that
/// ignores the exclusion list; it is covered by
/// `verified_credential_store.rs::enrolling_the_same_authenticator_twice_is_refused_without_a_write`,
/// because `SoftPasskey` mints a fresh key pair on every registration and so
/// cannot produce a colliding credential id here.
#[tokio::test]
async fn an_enrolled_credential_is_excluded_from_the_next_registration() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;
    let first = ceremony.credentials(ACCOUNT).await.remove(0).credential_id;

    let options = ceremony
        .start_registration(ACCOUNT)
        .await
        .expect("registration options");
    let excluded: Vec<&str> = options["publicKey"]["excludeCredentials"]
        .as_array()
        .expect("excludeCredentials must be sent")
        .iter()
        .map(|entry| entry["id"].as_str().expect("excluded id"))
        .collect();
    assert_eq!(
        excluded,
        vec![first.as_str()],
        "the enrolled credential must be excluded: {options}"
    );

    // A genuinely different authenticator may still be added, and both
    // credentials then work.
    let challenge: CreationChallengeResponse =
        serde_json::from_value(options).expect("creation challenge");
    let mut second_device = SoftPasskey::new(true);
    let registration = second_device
        .do_registration(ceremony.origin.clone(), challenge)
        .expect("second authenticator registration");
    ceremony
        .manager
        .register_passkey(
            &ceremony.storage,
            ACCOUNT,
            serde_json::to_value(&registration).expect("attestation"),
        )
        .await
        .expect("a second, distinct authenticator may be enrolled");
    assert_eq!(ceremony.raw_records(ACCOUNT).await.len(), 2);

    let options = ceremony
        .manager
        .get_auth_options(&ceremony.storage, ACCOUNT)
        .await
        .expect("auth options");
    assert_eq!(
        options["publicKey"]["allowCredentials"]
            .as_array()
            .expect("allowCredentials")
            .len(),
        2,
        "both enrolled credentials must be offered"
    );

    // And the second device can sign in, which proves the credential the second
    // registration persisted is the one that was actually enrolled.
    let challenge: RequestChallengeResponse =
        serde_json::from_value(options).expect("request challenge");
    let assertion = second_device
        .do_authentication(ceremony.origin.clone(), challenge)
        .expect("second authenticator assertion");
    ceremony
        .submit(
            ACCOUNT,
            serde_json::to_value(&assertion).expect("assertion json"),
        )
        .await
        .expect("the second credential must authenticate");
}

// ─── Authentication preconditions ───────────────────────────────────────────

#[tokio::test]
async fn signing_in_without_a_verified_credential_is_a_named_refusal() {
    let ceremony = Ceremony::new();

    assert_eq!(
        ceremony
            .manager
            .get_auth_options(&ceremony.storage, ACCOUNT)
            .await
            .expect_err("no credentials"),
        PasskeyError::NoVerifiedCredentials
    );

    // A legacy record is not a fallback. It carries no public key, so offering
    // it would produce a ceremony that can never complete.
    ceremony
        .storage
        .store_passkey(ACCOUNT, json!({ "id": "Y3JlZGVudGlhbC1pZA", "counter": 4 }))
        .await
        .expect("legacy record");
    assert_eq!(
        ceremony
            .manager
            .get_auth_options(&ceremony.storage, ACCOUNT)
            .await
            .expect_err("legacy records are not credentials"),
        PasskeyError::NoVerifiedCredentials
    );
}

/// A credential enrolled under a different RP ID can never assert here — the
/// client will not even offer it. Refusing with a distinct, actionable error
/// beats letting it fail opaquely at the authenticator.
#[tokio::test]
async fn credentials_from_another_context_are_refused_by_name() {
    let mut ceremony = Ceremony::new();
    ceremony.register(ACCOUNT).await;

    // Re-store the credential as if it had been enrolled by the development
    // build, whose RP ID is `localhost` against a production RP ID of
    // `tauri.localhost`.
    let stored = ceremony.credentials(ACCOUNT).await.remove(0);
    let production_origin = Url::parse("http://tauri.localhost").expect("origin");
    let production = PasskeyManager::new("tauri.localhost", &production_origin)
        .expect("production relying party");
    let storage = Storage::new(false);
    append_credential(&storage, ACCOUNT, stored)
        .await
        .expect("seed a dev-enrolled credential");

    assert_eq!(
        production
            .get_auth_options(&storage, ACCOUNT)
            .await
            .expect_err("a dev credential must not be offered in production"),
        PasskeyError::CredentialsFromAnotherContext
    );
    // And registration in the production context is still possible: the user's
    // way out is to enroll again, so nothing may block that.
    production
        .get_registration_options(&storage, ACCOUNT)
        .await
        .expect("re-enrolment must remain possible");
}

// ─── Wire format: contracts the frontend depends on ─────────────────────────

/// Plan §8.4. `webauthn-rs` wraps both challenge responses in `publicKey`, and
/// the frontend's option-unwrapping has to know that. Pinning it here means a
/// library change that moved it would fail on this side of the boundary rather
/// than as a runtime "challenge is undefined" in the webview.
#[tokio::test]
async fn challenge_responses_are_wrapped_in_public_key_with_base64url_binaries() {
    let mut ceremony = Ceremony::new();

    let options = ceremony
        .start_registration(ACCOUNT)
        .await
        .expect("registration options");
    let public_key = options
        .get("publicKey")
        .expect("creation options must be wrapped in `publicKey`");
    assert!(
        public_key["challenge"].is_string(),
        "binary fields must serialise as base64url strings: {public_key}"
    );
    assert!(public_key["user"]["id"].is_string());
    assert_eq!(public_key["rp"]["id"], json!(RP_ID));

    ceremony.register(ACCOUNT).await;
    let options = ceremony
        .manager
        .get_auth_options(&ceremony.storage, ACCOUNT)
        .await
        .expect("auth options");
    let public_key = options
        .get("publicKey")
        .expect("request options must be wrapped in `publicKey`");
    assert!(public_key["challenge"].is_string());
    assert!(
        public_key["allowCredentials"][0]["id"].is_string(),
        "{public_key}"
    );
}

/// Plan §8.5. The frontend serialiser emits `clientExtensionResults`, which is
/// the name the WebAuthn IDL uses; `webauthn-rs` calls that field `extensions`
/// and marks it `#[serde(default)]`. The plan required this to be *proved*
/// rather than assumed, because a future version could stop defaulting it and
/// the failure would look like a mysterious sign-in error.
#[tokio::test]
async fn the_browsers_field_naming_round_trips_into_the_library_types() {
    let mut ceremony = Ceremony::new();

    let mut attestation = ceremony.attest(ACCOUNT).await;
    let object = attestation.as_object_mut().expect("attestation object");
    object.remove("extensions");
    object.insert("clientExtensionResults".to_string(), json!({}));
    serde_json::from_value::<RegisterPublicKeyCredential>(attestation.clone())
        .expect("a browser-shaped registration must deserialise");
    // And it must still verify, not merely parse.
    ceremony
        .manager
        .register_passkey(&ceremony.storage, ACCOUNT, attestation)
        .await
        .expect("a browser-shaped registration must verify");

    let mut assertion = ceremony.assertion(ACCOUNT).await;
    let object = assertion.as_object_mut().expect("assertion object");
    object.remove("extensions");
    object.insert("clientExtensionResults".to_string(), json!({}));
    serde_json::from_value::<PublicKeyCredential>(assertion.clone())
        .expect("a browser-shaped assertion must deserialise");
    ceremony
        .submit(ACCOUNT, assertion)
        .await
        .expect("a browser-shaped assertion must verify");
}

/// The user handle may be stored by a discoverable-credential authenticator and
/// shown in the platform's passkey list, so it must be stable per account — and
/// it must never be the API key.
#[tokio::test]
async fn the_user_handle_is_stable_across_enrolments() {
    let ceremony = Ceremony::new();
    let mut handles = HashSet::new();
    for _ in 0..3 {
        let options = ceremony
            .start_registration(ACCOUNT)
            .await
            .expect("registration options");
        handles.insert(
            options["publicKey"]["user"]["id"]
                .as_str()
                .expect("user handle")
                .to_string(),
        );
    }
    assert_eq!(
        handles.len(),
        1,
        "a fresh handle per enrolment litters the platform passkey list: {handles:?}"
    );
}

// ─── The golden fixture, against the ceremony code ──────────────────────────

/// The committed fixture is a credential produced by `webauthn-rs` 0.5.5 and
/// carried across the move to the 0.6 line. `verified_credential_store.rs`
/// proves it still deserialises; this proves the *library* still accepts the
/// deserialised key as an authentication candidate, which is the property a
/// user with an enrolled credential actually depends on.
///
/// It cannot complete an assertion: the private half was generated inside a
/// software authenticator in another process and is gone. That is inherent, not
/// an omission — a fixture that could complete an assertion would have to ship
/// a private key.
#[tokio::test]
async fn the_golden_fixture_is_still_a_usable_authentication_candidate() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/stored_credential_v1.json"))
        .expect("fixture json");
    let credential: StoredCredential =
        serde_json::from_value(fixture).expect("fixture must still deserialise");

    let storage = Storage::new(false);
    let rp_id = credential.rp_id.clone();
    let origin = Url::parse(&credential.origin).expect("fixture origin");
    let credential_id = credential.credential_id.clone();
    append_credential(&storage, ACCOUNT, credential)
        .await
        .expect("store the fixture credential");

    let manager = PasskeyManager::new(&rp_id, &origin).expect("relying party for the fixture");
    let options = manager
        .get_auth_options(&storage, ACCOUNT)
        .await
        .expect("the fixture credential must be offerable");

    assert_eq!(
        options["publicKey"]["allowCredentials"][0]["id"].as_str(),
        Some(credential_id.as_str()),
        "the library must accept the fixture's key material: {options}"
    );

    // Same relying party, same configuration, but the library must still refuse
    // a forged assertion against it.
    let forged = json!({
        "id": credential_id,
        "rawId": credential_id,
        "type": "public-key",
        "response": {
            "clientDataJSON": encode(b"{\"type\":\"webauthn.get\"}"),
            "authenticatorData": encode(&[0u8; 37]),
            "signature": encode(b"not a signature"),
            "userHandle": null,
        },
        "clientExtensionResults": {},
    });
    manager
        .authenticate_passkey(&storage, ACCOUNT, forged)
        .await
        .expect_err("a forged assertion against the fixture must be refused");
}

// ─── Origin policy, as pure configuration ───────────────────────────────────

/// The Tauri origins cannot be driven through a software authenticator (it
/// declines a non-special scheme), so the policy is asserted directly. These
/// are the exact spellings measured in the running app.
#[test]
fn the_tauri_origins_produce_the_relying_parties_the_platforms_need() {
    // Production on Windows: a normal HTTP origin, `.localhost` is
    // potentially-trustworthy in Chromium, and `window.location.origin` is
    // exactly this string with no trailing slash.
    let windows = Url::parse("http://tauri.localhost").expect("windows origin");
    assert!(PasskeyManager::new("tauri.localhost", &windows).is_ok());

    // macOS and Linux: a non-special scheme. `url` still reports a domain, so
    // the builder accepts it — whether the *webview* can run the ceremony is a
    // separate, platform question.
    let apple = Url::parse("tauri://localhost").expect("tauri origin");
    assert!(PasskeyManager::new("localhost", &apple).is_ok());

    // Development.
    let dev = Url::parse("http://localhost:3000").expect("dev origin");
    assert!(PasskeyManager::new("localhost", &dev).is_ok());

    // A wholly unrelated RP ID must be refused, not accommodated.
    assert_eq!(
        PasskeyManager::new("example.com", &windows).expect_err("unrelated rp id"),
        PasskeyError::RuntimeOriginUnavailable
    );
    // And a *parent* of the effective domain, which would widen the credential
    // scope beyond this application.
    assert!(
        PasskeyManager::new("localhost", &windows).is_ok(),
        "`tauri.localhost` is a subdomain of `localhost`, so the library allows \
         it as an RP ID — which is precisely why `allow_subdomains(false)` \
         matters and why the RP ID is derived from the origin rather than chosen"
    );
}

/// `url` does not slash-normalise a non-special scheme, so
/// `tauri://localhost` and `tauri://localhost/` are different URLs. Only the
/// spelling the webview reports can match at ceremony time, and this pins that
/// the two really are distinct so nobody "tidies" a trailing slash in.
#[test]
fn a_trailing_slash_changes_a_tauri_origin_but_not_an_http_one() {
    assert_ne!(
        Url::parse("tauri://localhost").expect("bare"),
        Url::parse("tauri://localhost/").expect("slashed"),
    );
    assert_eq!(
        Url::parse("http://tauri.localhost").expect("bare"),
        Url::parse("http://tauri.localhost/").expect("slashed"),
    );
}

/// `allow_subdomains` is never enabled, and the builder is the only place it
/// could be. Asserted through behaviour rather than by reading configuration:
/// see [`an_assertion_from_a_subdomain_origin_is_rejected`], which fails if it
/// is ever turned on.
#[test]
fn the_builder_configuration_is_the_one_the_policy_requires() {
    let origin = Url::parse(ORIGIN).expect("origin");
    WebauthnBuilder::new(RP_ID, &origin)
        .expect("builder")
        .rp_name(bc_passkey::RP_NAME)
        .allow_subdomains(false)
        .allow_any_port(false)
        .build()
        .expect("the configuration the manager uses must build");
}
