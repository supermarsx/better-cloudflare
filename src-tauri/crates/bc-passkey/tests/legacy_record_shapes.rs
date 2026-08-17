//! Behaviour of the legacy passkey recovery paths against stored records that
//! are not the shape the code expects.
//!
//! `list_passkeys` and `delete_passkey` are the only two passkey operations
//! that still run, and both read arbitrary JSON that a previous build (or a
//! tampered keyring) wrote. Every field access is optional-chained, so the
//! intended contract is "never panic, never lose an unrelated credential". The
//! in-crate tests only ever store one well-formed record, so that contract has
//! never been exercised. A panic here aborts the Tauri backend and takes the
//! whole desktop app with it.

use bc_passkey::{PasskeyManager, Storage};
use serde_json::{json, Value};

const ACCOUNT: &str = "key_passkey";

async fn seed(storage: &Storage, records: Vec<Value>) {
    for record in records {
        storage
            .store_passkey(ACCOUNT, record)
            .await
            .expect("seed stored passkey record");
    }
}

#[tokio::test]
async fn records_of_any_json_shape_are_listed_instead_of_panicking() {
    let storage = Storage::new(false);
    let manager = PasskeyManager;
    // Every JSON shape a corrupt or hand-edited record could take, including
    // values where `get("id")` is not even meaningful.
    seed(
        &storage,
        vec![
            Value::Null,
            json!(0),
            json!(-1),
            json!(true),
            json!("a bare string"),
            json!([]),
            json!([{ "id": "nested" }]),
            json!({}),
            json!({ "id": 42 }),
            json!({ "id": null, "rawId": null }),
            json!({ "rawId": "raw-only" }),
            json!({ "id": "", "counter": "not a number" }),
            json!({ "id": "negative-counter", "counter": -5 }),
            json!({ "id": "float-counter", "counter": 1.5 }),
            json!({ "id": "huge-counter", "counter": u64::MAX }),
        ],
    )
    .await;

    let listed = manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("listing must survive every stored record shape");
    assert_eq!(listed.len(), 15, "every stored record must be reported");

    for (index, entry) in listed.iter().enumerate() {
        assert!(
            entry["id"].as_str().is_some(),
            "record {index} was listed without a usable identifier"
        );
        assert!(
            entry["counter"].as_u64().is_some(),
            "record {index} was listed without a numeric counter"
        );
        assert_eq!(
            entry["requiresReregistration"], true,
            "record {index} must be marked as needing re-enrolment"
        );
    }

    // A record with no usable identifier still needs a stable, unique handle so
    // the UI can address it; a shared placeholder would make one row delete
    // several credentials.
    let identifiers: Vec<&str> = listed
        .iter()
        .map(|entry| entry["id"].as_str().expect("identifier"))
        .collect();
    let mut unique = identifiers.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(
        unique.len(),
        identifiers.len(),
        "listed passkeys must have distinct identifiers: {identifiers:?}"
    );

    // A counter that is not a plain unsigned integer must read as zero rather
    // than being coerced into a value that looks like replay protection.
    assert_eq!(listed[11]["counter"].as_u64(), Some(0));
    assert_eq!(listed[12]["counter"].as_u64(), Some(0));
    assert_eq!(listed[13]["counter"].as_u64(), Some(0));
    assert_eq!(listed[14]["counter"].as_u64(), Some(u64::MAX));
}

#[tokio::test]
async fn an_empty_or_unmatched_credential_id_deletes_nothing() {
    let storage = Storage::new(false);
    let manager = PasskeyManager;
    seed(
        &storage,
        vec![
            json!({ "id": "Y3JlZGVudGlhbC1vbmU" }),
            json!({ "rawId": "Y3JlZGVudGlhbC10d28" }),
            json!({}),
        ],
    )
    .await;

    // An empty identifier must never behave as a wildcard: a UI bug that passed
    // an empty string would otherwise silently wipe every enrolled passkey.
    for credential_id in ["", "   ", "\n", "does-not-exist", "Y3JlZGVudGlhbA"] {
        manager
            .delete_passkey(&storage, ACCOUNT, credential_id)
            .await
            .expect("delete with a non-matching identifier");
        assert_eq!(
            manager
                .list_passkeys(&storage, ACCOUNT)
                .await
                .expect("list after non-matching delete")
                .len(),
            3,
            "deleting with '{credential_id}' removed a credential it did not match"
        );
    }
}

#[tokio::test]
async fn deleting_one_credential_leaves_the_others_and_empties_the_record_exactly_once() {
    let storage = Storage::new(false);
    let manager = PasskeyManager;
    seed(
        &storage,
        vec![
            json!({ "id": "Y3JlZGVudGlhbC1vbmU" }),
            json!({ "rawId": "Y3JlZGVudGlhbC10d28" }),
        ],
    )
    .await;

    manager
        .delete_passkey(&storage, ACCOUNT, "Y3JlZGVudGlhbC1vbmU")
        .await
        .expect("delete first credential");
    let remaining = manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list after first delete");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["id"].as_str(), Some("Y3JlZGVudGlhbC10d28"));

    // Matching must also work through the `rawId` spelling, and through the
    // padded Base64 form of the same bytes, because legacy records were written
    // with whichever encoding the browser happened to supply.
    manager
        .delete_passkey(&storage, ACCOUNT, "Y3JlZGVudGlhbC10d28=")
        .await
        .expect("delete second credential by padded encoding");
    assert!(manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list after second delete")
        .is_empty());

    // Deleting again on an already-empty record must stay a no-op rather than
    // surfacing a storage NotFound to the caller.
    manager
        .delete_passkey(&storage, ACCOUNT, "Y3JlZGVudGlhbC10d28")
        .await
        .expect("delete from an emptied record");

    // A record that never existed must behave the same way.
    manager
        .delete_passkey(&storage, "key_never_enrolled", "anything")
        .await
        .expect("delete from an absent record");
    assert!(manager
        .list_passkeys(&storage, "key_never_enrolled")
        .await
        .expect("list an absent record")
        .is_empty());
}

/// Deleting one credential must not take another with it just because the two
/// spellings decode to the same octets through *different* Base64 alphabets.
/// A real credential id is 16+ random bytes, so `-`/`_` and `+`/`/` land in it
/// routinely and two unrelated credentials can collide this way.
#[tokio::test]
async fn credentials_spelled_in_different_alphabets_are_different_credentials() {
    for (stored, requested) in [
        ("ab-c", "ab+c"),
        ("ab+c", "ab-c"),
        ("ab_c", "ab/c"),
        ("ab/c", "ab_c"),
        ("a-c=", "a+c="),
        ("ab-cde_g", "ab+cde/g"),
        ("ab+cde/g", "ab-cde_g"),
    ] {
        let storage = Storage::new(false);
        let manager = PasskeyManager;
        seed(&storage, vec![json!({ "id": stored })]).await;

        manager
            .delete_passkey(&storage, ACCOUNT, requested)
            .await
            .expect("delete across alphabets");
        let remaining = manager
            .list_passkeys(&storage, ACCOUNT)
            .await
            .expect("list after cross-alphabet delete");
        assert_eq!(
            remaining.len(),
            1,
            "deleting '{requested}' removed '{stored}', a different credential"
        );
        assert_eq!(remaining[0]["id"].as_str(), Some(stored));

        // The record must still be deletable by its own spelling: the point is
        // to bound the leniency, not to strand the record.
        manager
            .delete_passkey(&storage, ACCOUNT, stored)
            .await
            .expect("delete by its own spelling");
        assert!(manager
            .list_passkeys(&storage, ACCOUNT)
            .await
            .expect("list after same-alphabet delete")
            .is_empty());
    }
}

/// The leniency that alphabet-strictness must not cost: a legacy record is
/// still deletable when only padding or surrounding whitespace differs, in
/// either alphabet, because older builds stored whichever spelling the browser
/// supplied.
#[tokio::test]
async fn padding_and_whitespace_variants_of_one_spelling_still_match() {
    for (stored, requested) in [
        ("Y3JlZGVudGlhbC10d28", "Y3JlZGVudGlhbC10d28="),
        ("Y3JlZGVudGlhbC10d28=", "Y3JlZGVudGlhbC10d28"),
        ("ab-cde_g", " ab-cde_g "),
        ("ab+cde/g", "\tab+cde/g\n"),
        ("a-c", "a-c="),
        ("a+c=", "a+c"),
    ] {
        let storage = Storage::new(false);
        let manager = PasskeyManager;
        seed(&storage, vec![json!({ "id": stored })]).await;

        manager
            .delete_passkey(&storage, ACCOUNT, requested)
            .await
            .expect("delete by an equivalent spelling");
        assert!(
            manager
                .list_passkeys(&storage, ACCOUNT)
                .await
                .expect("list after equivalent-spelling delete")
                .is_empty(),
            "'{requested}' failed to delete the same credential stored as '{stored}'"
        );
    }
}

/// A record an older build wrote with a blank id was listed under that blank
/// id, which no delete can match. It has to be addressable by the synthetic
/// handle instead - and that handle must remove only its own row.
#[tokio::test]
async fn a_record_with_a_blank_identifier_is_deletable_by_its_listed_handle() {
    for blank in ["", "   ", "\n"] {
        let storage = Storage::new(false);
        let manager = PasskeyManager;
        seed(
            &storage,
            vec![
                json!({ "id": "Y3JlZGVudGlhbC1vbmU" }),
                json!({ "id": blank, "counter": 3 }),
                json!({ "id": "Y3JlZGVudGlhbC10d28" }),
            ],
        )
        .await;

        let listed = manager
            .list_passkeys(&storage, ACCOUNT)
            .await
            .expect("list");
        let handle = listed[1]["id"].as_str().expect("listed handle").to_string();
        assert!(
            !handle.trim().is_empty(),
            "a blank stored id must not be listed as a blank handle"
        );

        manager
            .delete_passkey(&storage, ACCOUNT, &handle)
            .await
            .expect("delete by synthetic handle");
        let remaining = manager
            .list_passkeys(&storage, ACCOUNT)
            .await
            .expect("list after delete");
        assert_eq!(
            remaining.len(),
            2,
            "the handle '{handle}' removed the wrong number of records"
        );
        assert_eq!(remaining[0]["id"].as_str(), Some("Y3JlZGVudGlhbC1vbmU"));
        assert_eq!(remaining[1]["id"].as_str(), Some("Y3JlZGVudGlhbC10d28"));
    }
}

/// A blank `id` must not hide a usable `rawId`: the record is still addressable
/// by the identifier it actually carries.
#[tokio::test]
async fn a_blank_id_falls_through_to_raw_id_rather_than_a_synthetic_handle() {
    let storage = Storage::new(false);
    let manager = PasskeyManager;
    seed(
        &storage,
        vec![json!({ "id": "", "rawId": "Y3JlZGVudGlhbC10d28" })],
    )
    .await;

    let listed = manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list");
    assert_eq!(listed[0]["id"].as_str(), Some("Y3JlZGVudGlhbC10d28"));

    manager
        .delete_passkey(&storage, ACCOUNT, "Y3JlZGVudGlhbC10d28")
        .await
        .expect("delete by rawId");
    assert!(manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list after delete")
        .is_empty());
}

/// Synthetic handles address one row each. A handle for a row that is not
/// blank, or an index past the end, must remove nothing.
#[tokio::test]
async fn a_synthetic_handle_never_matches_a_record_that_has_an_identifier() {
    let storage = Storage::new(false);
    let manager = PasskeyManager;
    seed(
        &storage,
        vec![
            json!({ "id": "Y3JlZGVudGlhbC1vbmU" }),
            json!({ "id": "" }),
            json!({}),
        ],
    )
    .await;

    for handle in [
        "legacy_credential_0",
        "legacy_credential_3",
        "legacy_credential_",
        "legacy_credential_01",
    ] {
        manager
            .delete_passkey(&storage, ACCOUNT, handle)
            .await
            .expect("delete with a handle that addresses nothing");
        assert_eq!(
            manager
                .list_passkeys(&storage, ACCOUNT)
                .await
                .expect("list")
                .len(),
            3,
            "'{handle}' removed a record it does not address"
        );
    }

    // The two blank rows are addressable individually, by index.
    manager
        .delete_passkey(&storage, ACCOUNT, "legacy_credential_2")
        .await
        .expect("delete the third row");
    let remaining = manager
        .list_passkeys(&storage, ACCOUNT)
        .await
        .expect("list");
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining[1]["id"].as_str(), Some("legacy_credential_1"));
}

#[tokio::test]
async fn a_corrupt_stored_collection_is_surfaced_as_an_error_not_an_empty_list() {
    let storage = Storage::new(false);
    let manager = PasskeyManager;
    // A readable but malformed record must not be reported as "no passkeys
    // enrolled": that reading would let the app quietly overwrite a user's only
    // remaining credential material.
    storage
        .store_secret("passkeys:key_passkey", "{\"not\":\"an array\"}")
        .await
        .expect("seed malformed passkey record");

    assert!(
        manager.list_passkeys(&storage, ACCOUNT).await.is_err(),
        "a corrupt passkey record must not be reported as an empty enrolment"
    );
    assert!(
        manager
            .delete_passkey(&storage, ACCOUNT, "anything")
            .await
            .is_err(),
        "deletion must not proceed against a record it could not parse"
    );
    assert!(
        storage.get_secret("passkeys:key_passkey").await.is_ok(),
        "a failed deletion must leave the stored record in place"
    );
}
