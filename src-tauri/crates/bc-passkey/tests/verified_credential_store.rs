//! The verified-credential store: what it persists, what it refuses, and the
//! line it keeps between verified credentials and the dead legacy records that
//! preceded them.
//!
//! Two properties carry most of the weight here.
//!
//! **A `Passkey` must survive persistence byte for byte.** It is the only copy
//! of the public key an assertion can ever be verified against, and
//! `webauthn-rs` publishes no cross-version JSON stability guarantee for it. A
//! round trip that quietly drops or reshapes a field would not fail until a
//! user tried to sign in, by which point the credential is unrecoverable — the
//! private half lives in hardware and cannot be re-exported.
//!
//! **A legacy record must never be read as a verified one.** Legacy records are
//! browser JSON the old implementation stored without checking anything. If one
//! of them could be parsed into a `StoredCredential`, the app would offer a
//! credential it cannot verify, which is exactly the state `d05fe59` closed.

use bc_passkey::credential::{
    append_credential, classify_record, credential_storage_key, delete_credential,
    delete_dead_credential_at, encode_credential_id, load_credentials, replace_credential,
    DeadCredentialReason, RecordClass, StoredCredential, StoredCredentialSchema,
    CREDENTIAL_SCHEMA_V1,
};
use bc_passkey::{PasskeyError, PasskeyManager, Storage};
use serde_json::{json, Value};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::{Passkey, Url, Uuid};
use webauthn_rs::WebauthnBuilder;

const ACCOUNT: &str = "key_passkey";
const RP_ID: &str = "localhost";
const ORIGIN: &str = "https://localhost";
const CREATED_AT: &str = "2026-08-25T12:00:00Z";

/// A genuine `Passkey`, produced by a complete registration ceremony against an
/// in-process software authenticator. Real key material, real signature, real
/// library verification — not a hand-written literal that could encode an
/// assumption about the format rather than the format itself.
fn verified_passkey(seed: u8) -> Passkey {
    let origin = Url::parse(ORIGIN).expect("origin");
    let webauthn = WebauthnBuilder::new(RP_ID, &origin)
        .expect("rp id and origin agree")
        .rp_name("Better Cloudflare")
        .allow_subdomains(false)
        .allow_any_port(false)
        .build()
        .expect("build webauthn");

    let (challenge, state) = webauthn
        .start_passkey_registration(Uuid::from_bytes([seed; 16]), "Test key", "Test key", None)
        .expect("start registration");

    // `WebauthnAuthenticator` is a trait with a blanket impl over
    // `AuthenticatorBackend` in webauthn-authenticator-rs 0.6, not the wrapper
    // struct it was in 0.5 — the backend is driven directly, with the trait in
    // scope for `do_registration`.
    let mut authenticator = SoftPasskey::new(true);
    let registration = authenticator
        .do_registration(origin, challenge)
        .expect("software authenticator registration");

    webauthn
        .finish_passkey_registration(&registration, &state)
        .expect("finish registration")
}

fn stored(seed: u8) -> StoredCredential {
    StoredCredential::new(
        verified_passkey(seed),
        RP_ID,
        ORIGIN,
        CREATED_AT.to_string(),
    )
}

async fn raw_records(storage: &Storage, id: &str) -> Vec<Value> {
    storage
        .get_typed_list(&credential_storage_key(id))
        .await
        .expect("read raw verified records")
}

/// The property the whole store rests on: the exact bytes of a `Passkey` come
/// back out of storage.
///
/// `Passkey`'s `PartialEq` compares only the credential id, so `assert_eq!` on
/// two `Passkey` values would pass even if every byte of the public key had
/// been lost. The comparison has to be over the serialised form.
#[tokio::test]
async fn a_verified_passkey_survives_store_and_load_byte_identically() {
    let storage = Storage::new(false);
    let credential = stored(1);

    let passkey_before = serde_json::to_string(&credential.passkey).expect("serialize passkey");
    let record_before = serde_json::to_string(&credential).expect("serialize record");

    append_credential(&storage, ACCOUNT, credential)
        .await
        .expect("append verified credential");

    let loaded = load_credentials(&storage, ACCOUNT)
        .await
        .expect("load verified credentials");
    assert!(
        loaded.dead.is_empty(),
        "a freshly written record read back as dead"
    );
    assert_eq!(loaded.credentials.len(), 1);

    let passkey_after =
        serde_json::to_string(&loaded.credentials[0].passkey).expect("re-serialize passkey");
    let record_after = serde_json::to_string(&loaded.credentials[0]).expect("re-serialize record");

    assert_eq!(
        passkey_before, passkey_after,
        "the stored Passkey did not survive a storage round trip byte for byte"
    );
    assert_eq!(
        record_before, record_after,
        "the stored credential record did not survive a storage round trip byte for byte"
    );

    // And the public key itself, compared directly rather than through the
    // record that wraps it.
    assert_eq!(
        serde_json::to_string(loaded.credentials[0].passkey.get_public_key())
            .expect("serialize public key"),
        serde_json::to_string(
            &serde_json::from_str::<Passkey>(&passkey_before)
                .expect("reparse passkey")
                .get_public_key()
        )
        .expect("serialize reparsed public key")
    );
}

/// The committed fixture is the tripwire for a `webauthn-rs` upgrade that
/// changes how `Passkey` serialises. If that happens, every credential a user
/// has enrolled becomes unreadable — this test is what makes it fail in CI
/// instead of on their machine.
#[tokio::test]
async fn the_committed_golden_record_still_reads_back_as_a_verified_credential() {
    let fixture = include_str!("fixtures/stored_credential_v1.json");
    let value: Value = serde_json::from_str(fixture).expect("golden fixture is valid JSON");

    let RecordClass::Verified(credential) = classify_record(&value) else {
        panic!(
            "the committed golden record no longer reads as a verified credential; \
             a webauthn-rs upgrade has changed the persisted format and every \
             enrolled credential would be stranded"
        );
    };

    assert_eq!(credential.schema, StoredCredentialSchema::V1);
    assert_eq!(credential.rp_id, RP_ID);
    assert_eq!(credential.origin, ORIGIN);
    assert_eq!(
        credential.credential_id,
        encode_credential_id(credential.raw_credential_id())
    );
    assert!(
        !credential.raw_credential_id().is_empty(),
        "the fixture must carry a real credential id"
    );

    // It must also survive the store, not merely parse.
    let storage = Storage::new(false);
    append_credential(&storage, ACCOUNT, (*credential).clone())
        .await
        .expect("store the golden record");
    let loaded = load_credentials(&storage, ACCOUNT)
        .await
        .expect("load the golden record");
    assert_eq!(loaded.credentials.len(), 1);
    assert_eq!(
        serde_json::to_string(&loaded.credentials[0].passkey).expect("serialize"),
        serde_json::to_string(&credential.passkey).expect("serialize")
    );
}

/// The classification the migration message depends on. Every one of these is a
/// shape the old implementation could have written, plus the shapes
/// `tests/legacy_record_shapes.rs` already proves the recovery path survives.
#[test]
fn a_legacy_record_is_classified_as_legacy_rather_than_parsed_as_valid() {
    let legacy_shapes = vec![
        // What the deleted implementation actually stored.
        json!({
            "id": "Y3JlZGVudGlhbC1pZA",
            "rawId": "Y3JlZGVudGlhbC1pZA",
            "type": "public-key",
            "counter": 7,
            "response": { "attestationObject": "legacy-untrusted-data" },
        }),
        json!({ "id": "Y3JlZGVudGlhbC1pZA", "counter": 4 }),
        json!({ "rawId": "raw-only" }),
        json!({ "id": "", "counter": "not a number" }),
        json!({}),
        // Not even an object. A corrupt or hand-edited record looks like this.
        Value::Null,
        json!(0),
        json!(true),
        json!("a bare string"),
        json!([]),
        json!([{ "id": "nested" }]),
    ];

    for record in legacy_shapes {
        let class = classify_record(&record);
        assert!(
            !class.is_verified(),
            "legacy record {record} was parsed as a verified credential"
        );
        assert_eq!(
            class.dead_reason(),
            Some(DeadCredentialReason::Legacy),
            "legacy record {record} was not reported as legacy"
        );
    }
}

/// A record carrying a `passkey` but no schema is still legacy, not verified.
/// Nothing that predates the discriminator gets the benefit of the doubt.
#[test]
fn a_record_without_the_schema_discriminator_is_never_verified() {
    let complete = stored(2);
    let mut value = serde_json::to_value(&complete).expect("serialize");
    value
        .as_object_mut()
        .expect("object")
        .remove("schema")
        .expect("schema was present");

    let class = classify_record(&value);
    assert!(!class.is_verified());
    assert_eq!(class.dead_reason(), Some(DeadCredentialReason::Legacy));
}

/// A schema this build does not recognise is unreadable, and is reported
/// separately from legacy: it means the record was written by a *newer* build,
/// which is a different conversation with the user than corruption.
#[test]
fn an_unrecognised_schema_is_unreadable_rather_than_legacy_or_valid() {
    let complete = stored(3);
    for schema in [
        json!("bc-webauthn-v2"),
        json!("bc-webauthn-v1 "),
        json!(""),
        json!(null),
        json!(1),
        json!({ "version": 1 }),
    ] {
        let mut value = serde_json::to_value(&complete).expect("serialize");
        value["schema"] = schema.clone();

        let class = classify_record(&value);
        assert!(
            !class.is_verified(),
            "schema {schema} was accepted as {CREDENTIAL_SCHEMA_V1}"
        );
        assert!(
            matches!(
                class.dead_reason(),
                Some(DeadCredentialReason::Unreadable(_))
            ),
            "schema {schema} was misreported as legacy"
        );
    }
}

/// A record whose key material this build cannot deserialise is skipped and
/// flagged. It must not panic, and it must not be reported as valid.
#[test]
fn a_damaged_passkey_is_reported_as_unreadable_and_never_panics() {
    let complete = stored(4);
    let damaged = [
        json!(null),
        json!({}),
        json!({ "cred": {} }),
        json!("truncated"),
        json!({ "cred": { "cred_id": "AAAA", "counter": 0 } }),
    ];

    for passkey in damaged {
        let mut value = serde_json::to_value(&complete).expect("serialize");
        value["passkey"] = passkey.clone();

        let class = classify_record(&value);
        assert!(
            matches!(
                class.dead_reason(),
                Some(DeadCredentialReason::Unreadable(_))
            ),
            "a record with passkey {passkey} was not reported as unreadable"
        );
    }

    // A missing field is the same story.
    let mut value = serde_json::to_value(&complete).expect("serialize");
    value.as_object_mut().expect("object").remove("passkey");
    assert!(matches!(
        classify_record(&value).dead_reason(),
        Some(DeadCredentialReason::Unreadable(_))
    ));
}

/// The handle and the key material must agree. A record where they do not is
/// not a credential with a nickname: it is a record whose listed id addresses
/// key material that is not the key material it names.
#[test]
fn a_credential_id_that_disagrees_with_the_key_material_is_unreadable() {
    let complete = stored(5);
    let mut value = serde_json::to_value(&complete).expect("serialize");
    value["credentialId"] = json!("c29tZXRoaW5nLWVsc2U");

    let class = classify_record(&value);
    assert!(!class.is_verified());
    assert!(matches!(
        class.dead_reason(),
        Some(DeadCredentialReason::Unreadable(_))
    ));
}

/// Unreadable records are surfaced, not swallowed — and not repaired, and not
/// deleted. A user who has not been told cannot have decided.
#[tokio::test]
async fn unreadable_records_are_reported_and_left_in_place_beside_working_ones() {
    let storage = Storage::new(false);
    let good = stored(6);
    let good_id = good.credential_id.clone();

    let mut broken = serde_json::to_value(stored(7)).expect("serialize");
    broken["schema"] = json!("bc-webauthn-v99");
    let broken_before = serde_json::to_string(&broken).expect("serialize broken");

    storage
        .set_typed_list(
            &credential_storage_key(ACCOUNT),
            &[broken.clone(), serde_json::to_value(&good).expect("value")],
        )
        .await
        .expect("seed a mixed record");

    let loaded = load_credentials(&storage, ACCOUNT)
        .await
        .expect("load a mixed record");
    assert_eq!(loaded.credentials.len(), 1);
    assert_eq!(loaded.credentials[0].credential_id, good_id);
    assert_eq!(loaded.dead.len(), 1);
    assert_eq!(loaded.dead[0].index, 0);
    assert!(matches!(
        loaded.dead[0].reason,
        DeadCredentialReason::Unreadable(_)
    ));

    // Appending beside it must rewrite the unreadable record verbatim rather
    // than dropping what this build could not parse.
    append_credential(&storage, ACCOUNT, stored(8))
        .await
        .expect("append beside an unreadable record");
    let records = raw_records(&storage, ACCOUNT).await;
    assert_eq!(records.len(), 3);
    assert_eq!(
        serde_json::to_string(&records[0]).expect("serialize"),
        broken_before,
        "an unreadable record was altered by a write to its neighbour"
    );

    // It stays until something explicitly removes it.
    assert!(delete_dead_credential_at(&storage, ACCOUNT, 0)
        .await
        .expect("delete the dead record"));
    let loaded = load_credentials(&storage, ACCOUNT)
        .await
        .expect("load after removing the dead record");
    assert!(loaded.dead.is_empty());
    assert_eq!(loaded.credentials.len(), 2);
}

/// Deleting by index must never reach a working credential, whatever index is
/// supplied.
#[tokio::test]
async fn deleting_a_dead_record_by_index_never_removes_a_verified_one() {
    let storage = Storage::new(false);
    append_credential(&storage, ACCOUNT, stored(9))
        .await
        .expect("append");
    append_credential(&storage, ACCOUNT, stored(10))
        .await
        .expect("append");

    for index in [0, 1, 2, usize::MAX] {
        assert!(
            !delete_dead_credential_at(&storage, ACCOUNT, index)
                .await
                .expect("dead delete against a healthy store"),
            "index {index} claimed to remove a dead record"
        );
    }
    assert_eq!(
        load_credentials(&storage, ACCOUNT)
            .await
            .expect("load")
            .credentials
            .len(),
        2
    );
}

/// `94d74d1` fixed a collision where two spellings that no single encoder could
/// have produced decoded to the same octets through different alphabets, so one
/// delete removed a different credential. This store must not reintroduce it.
#[tokio::test]
async fn a_standard_alphabet_spelling_never_addresses_a_url_safe_credential() {
    let storage = Storage::new(false);
    let credential = stored(11);
    let url_safe = credential.credential_id.clone();
    append_credential(&storage, ACCOUNT, credential)
        .await
        .expect("append");

    // The same octets, spelled in the standard alphabet. Real credential ids
    // are 16+ random bytes, so the distinguishing characters occur routinely.
    let standard = url_safe.replace('-', "+").replace('_', "/");
    if standard != url_safe {
        assert!(
            !delete_credential(&storage, ACCOUNT, &standard)
                .await
                .expect("cross-alphabet delete"),
            "a standard-alphabet spelling matched a URL-safe credential"
        );
        assert_eq!(
            load_credentials(&storage, ACCOUNT)
                .await
                .expect("load")
                .credentials
                .len(),
            1,
            "a cross-alphabet delete removed a credential"
        );
    }

    // An empty or blank id must never behave as a wildcard.
    for blank in ["", "   ", "\n"] {
        assert!(!delete_credential(&storage, ACCOUNT, blank)
            .await
            .expect("blank delete"));
    }
    assert_eq!(
        load_credentials(&storage, ACCOUNT)
            .await
            .expect("load")
            .credentials
            .len(),
        1
    );

    // Padding and whitespace are still not a difference: that leniency costs
    // nothing because it cannot make two distinct ids collide.
    assert!(
        delete_credential(&storage, ACCOUNT, &format!(" {url_safe} "))
            .await
            .expect("delete by its own spelling")
    );
    assert!(load_credentials(&storage, ACCOUNT)
        .await
        .expect("load")
        .credentials
        .is_empty());
}

#[tokio::test]
async fn enrolling_the_same_authenticator_twice_is_refused_without_a_write() {
    let storage = Storage::new(false);
    let credential = stored(12);
    append_credential(&storage, ACCOUNT, credential.clone())
        .await
        .expect("first enrolment");

    let mut duplicate = credential.clone();
    duplicate.created_at = "2027-01-01T00:00:00Z".to_string();
    assert_eq!(
        append_credential(&storage, ACCOUNT, duplicate)
            .await
            .expect_err("duplicate enrolment"),
        PasskeyError::CredentialAlreadyEnrolled
    );

    let records = raw_records(&storage, ACCOUNT).await;
    assert_eq!(records.len(), 1, "a refused enrolment still wrote a record");
    assert_eq!(records[0]["createdAt"], json!(CREATED_AT));
}

#[tokio::test]
async fn replacing_a_credential_updates_it_in_place_and_never_inserts() {
    let storage = Storage::new(false);
    let credential = stored(13);
    append_credential(&storage, ACCOUNT, credential.clone())
        .await
        .expect("append");

    let mut updated = credential.clone();
    updated.last_used_at = Some("2026-09-01T09:00:00Z".to_string());
    replace_credential(&storage, ACCOUNT, updated)
        .await
        .expect("replace");

    let loaded = load_credentials(&storage, ACCOUNT).await.expect("load");
    assert_eq!(loaded.credentials.len(), 1);
    assert_eq!(
        loaded.credentials[0].last_used_at.as_deref(),
        Some("2026-09-01T09:00:00Z")
    );
    // The key material is untouched by a metadata update.
    assert_eq!(
        serde_json::to_string(&loaded.credentials[0].passkey).expect("serialize"),
        serde_json::to_string(&credential.passkey).expect("serialize")
    );

    // A credential that was never registered must not be created here.
    assert_eq!(
        replace_credential(&storage, "key_other", stored(14))
            .await
            .expect_err("replace an unregistered credential"),
        PasskeyError::NotFound
    );
    assert!(load_credentials(&storage, "key_other")
        .await
        .expect("load")
        .credentials
        .is_empty());
}

#[tokio::test]
async fn removing_the_last_credential_clears_the_record_without_stranding_a_list() {
    let storage = Storage::new(false);
    let credential = stored(15);
    let credential_id = credential.credential_id.clone();
    append_credential(&storage, ACCOUNT, credential)
        .await
        .expect("append");

    assert!(delete_credential(&storage, ACCOUNT, &credential_id)
        .await
        .expect("delete"));
    assert!(matches!(
        storage.get_secret(&credential_storage_key(ACCOUNT)).await,
        Err(bc_storage::StorageError::NotFound)
    ));

    // Deleting again is a no-op rather than an error surfaced to the caller.
    assert!(!delete_credential(&storage, ACCOUNT, &credential_id)
        .await
        .expect("delete from an emptied record"));
    assert!(
        !delete_credential(&storage, "key_never_enrolled", "anything")
            .await
            .expect("delete from an absent record")
    );
}

/// A stored value that is not a list at all must be an error, not "no passkeys
/// enrolled" — the same contract the legacy store already holds. Reading it as
/// empty would invite the app to overwrite a user's remaining credentials.
#[tokio::test]
async fn a_corrupt_verified_collection_is_an_error_not_an_empty_enrolment() {
    let storage = Storage::new(false);
    storage
        .store_secret(&credential_storage_key(ACCOUNT), "{\"not\":\"an array\"}")
        .await
        .expect("seed a malformed collection");

    assert!(load_credentials(&storage, ACCOUNT).await.is_err());
    assert!(delete_credential(&storage, ACCOUNT, "anything")
        .await
        .is_err());
    assert!(
        storage
            .get_secret(&credential_storage_key(ACCOUNT))
            .await
            .is_ok(),
        "a failed read must leave the stored record in place"
    );
}

/// Several credentials exceed the 2000-byte per-entry keyring limit, so the
/// store depends on `bc-storage`'s chunking. A credential that only round-trips
/// while it fits in one chunk would fail the moment a user enrolled a second
/// device.
#[tokio::test]
async fn credentials_large_enough_to_chunk_round_trip_intact() {
    let storage = Storage::new(false);
    let mut expected = Vec::new();
    for seed in 20..26 {
        let credential = stored(seed);
        expected.push(serde_json::to_string(&credential.passkey).expect("serialize"));
        append_credential(&storage, ACCOUNT, credential)
            .await
            .expect("append");
    }

    let raw = storage
        .get_secret(&credential_storage_key(ACCOUNT))
        .await
        .expect("read the stored collection");
    assert!(
        raw.len() > 2000,
        "the fixture no longer exceeds one keyring chunk ({} bytes); \
         this test is not exercising the chunking path",
        raw.len()
    );

    let loaded = load_credentials(&storage, ACCOUNT).await.expect("load");
    assert!(loaded.dead.is_empty());
    let actual: Vec<String> = loaded
        .credentials
        .iter()
        .map(|credential| serde_json::to_string(&credential.passkey).expect("serialize"))
        .collect();
    assert_eq!(actual, expected);
}

/// A credential enrolled under one RP ID can never be asserted under another.
/// Filtering has to happen here, before a ceremony, or the user sees an opaque
/// failure instead of "re-enroll".
#[tokio::test]
async fn credentials_are_filtered_by_the_rp_id_they_were_enrolled_under() {
    let storage = Storage::new(false);
    append_credential(&storage, ACCOUNT, stored(30))
        .await
        .expect("append");

    let mut elsewhere = stored(31);
    elsewhere.rp_id = "tauri.localhost".to_string();
    elsewhere.origin = "http://tauri.localhost".to_string();
    let elsewhere_id = elsewhere.credential_id.clone();
    append_credential(&storage, ACCOUNT, elsewhere)
        .await
        .expect("append");

    let loaded = load_credentials(&storage, ACCOUNT).await.expect("load");
    assert_eq!(loaded.credentials.len(), 2);
    assert_eq!(loaded.for_rp_id(RP_ID).len(), 1);
    assert_eq!(loaded.for_rp_id("tauri.localhost").len(), 1);
    assert_eq!(
        loaded.for_rp_id("tauri.localhost")[0].credential_id,
        elsewhere_id
    );
    assert!(loaded.for_rp_id("example.com").is_empty());
    // Both are still real credentials; neither is dead.
    assert!(loaded.dead.is_empty());
}

/// The two stores must not see each other. A write to one is invisible to the
/// other, which is what makes "a legacy record cannot be mistaken for a
/// verified credential" a structural property rather than a runtime check.
#[tokio::test]
async fn the_verified_store_and_the_legacy_store_stay_separate() {
    let storage = Storage::new(false);
    let manager = PasskeyManager::default();

    storage
        .store_passkey(ACCOUNT, json!({ "id": "Y3JlZGVudGlhbC1pZA", "counter": 4 }))
        .await
        .expect("seed a legacy record");
    append_credential(&storage, ACCOUNT, stored(40))
        .await
        .expect("append a verified credential");

    // `list_passkeys` is now a union over both stores: verified credentials
    // first, then legacy records. Updated when the ceremony layer landed — this
    // test previously asserted the legacy record was the *only* entry, which
    // was true only while nothing could write a verified credential. What it
    // exists to prove is unchanged: the two stores do not see each other, and
    // the legacy entry is reported byte for byte as it was before.
    let listed = manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list passkeys");
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0]["requiresReregistration"], json!(false));
    assert_eq!(listed[1]["id"], json!("Y3JlZGVudGlhbC1pZA"));
    assert_eq!(listed[1]["counter"], json!(4));
    assert_eq!(listed[1]["requiresReregistration"], json!(true));

    // And the verified store sees exactly one credential, with no legacy
    // record leaking in as a dead entry.
    let loaded = load_credentials(&storage, ACCOUNT).await.expect("load");
    assert_eq!(loaded.credentials.len(), 1);
    assert!(loaded.dead.is_empty());

    // Deleting the legacy record leaves the verified one alone.
    manager
        .delete_passkey(&storage, ACCOUNT, "Y3JlZGVudGlhbC1pZA")
        .await
        .expect("delete the legacy record");
    let listed = manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list after delete");
    assert_eq!(listed.len(), 1, "only the verified credential must remain");
    assert_eq!(listed[0]["requiresReregistration"], json!(false));
    assert_eq!(
        load_credentials(&storage, ACCOUNT)
            .await
            .expect("load")
            .credentials
            .len(),
        1,
        "deleting a legacy record removed a verified credential"
    );
}

/// This step adds a schema; it does not open the gate. Storing a verified
/// credential must not make the manager report itself available, must not make
/// a ceremony start, and must not make a token verify.
#[tokio::test]
async fn persisting_a_verified_credential_does_not_relax_the_fail_closed_gate() {
    let storage = Storage::new(false);
    let manager = PasskeyManager::default();
    append_credential(&storage, ACCOUNT, stored(50))
        .await
        .expect("append");

    let status = manager.status();
    assert!(!status.registration_available);
    assert!(!status.authentication_available);
    assert!(status.legacy_credentials_require_reregistration);

    assert!(manager
        .get_registration_options(&storage, ACCOUNT)
        .await
        .is_err());
    assert!(manager
        .register_passkey(&storage, ACCOUNT, json!({}))
        .await
        .is_err());
    assert!(manager.get_auth_options(&storage, ACCOUNT).await.is_err());
    assert!(manager
        .authenticate_passkey(&storage, ACCOUNT, json!({}))
        .await
        .is_err());
    assert!(
        !manager
            .verify_token(ACCOUNT, "attacker-controlled-token", true)
            .await
            .expect("verify token"),
        "a stored credential must not make an unminted token verify"
    );
}
