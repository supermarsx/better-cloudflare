//! Boundary and failure behaviour of secure storage, exercised only through the
//! public API.
//!
//! The in-crate unit tests inject backend faults through a private fake. That
//! proves the recovery logic in isolation but never drives a payload through
//! the whole `store_secret` -> chunk -> manifest -> verify -> `get_secret`
//! pipeline at the sizes where the pipeline actually changes shape. These tests
//! do exactly that, at each side of every documented ceiling, so a regression in
//! chunk splitting, manifest accounting, or metadata disambiguation shows up as
//! a corrupted or unreadable secret rather than as a passing unit test.
//!
//! Every limit below is written as a literal rather than imported, so a test
//! failure means the *contract* moved, not merely a constant.

use bc_storage::{Storage, StorageError};
use std::collections::HashMap;

/// Largest value the keyring accepts in a single entry.
const KEYRING_MAX_VALUE_BYTES: usize = 2000;
/// Hard ceiling for one logical secret.
const MAX_SECRET_BYTES: usize = 2_000_000;
/// Hard ceiling on retained audit entries.
const MAX_AUDIT_ENTRIES: usize = 1000;

fn storage() -> Storage {
    Storage::new(false)
}

/// Compare payloads without printing either one: a failure message must never
/// carry a secret into CI logs.
fn assert_roundtrip(actual: &str, expected: &str, context: &str) {
    assert!(
        actual == expected,
        "{context}: expected {} bytes, read back {} bytes",
        expected.len(),
        actual.len()
    );
}

async fn roundtrip(store: &Storage, key: &str, value: &str) -> String {
    store
        .store_secret(key, value)
        .await
        .unwrap_or_else(|error| panic!("store {key} ({} bytes): {error}", value.len()));
    store
        .get_secret(key)
        .await
        .unwrap_or_else(|error| panic!("read {key} ({} bytes): {error}", value.len()))
}

// ── Chunk size boundaries ───────────────────────────────────────────────────

#[tokio::test]
async fn payloads_around_every_chunk_boundary_round_trip_byte_for_byte() {
    let store = storage();
    // One under, exactly at, and one over each of the first two chunk edges.
    // 2001 bytes is the first payload that cannot live in a single entry, and
    // 4001 is the first that needs a third.
    for size in [
        0,
        1,
        KEYRING_MAX_VALUE_BYTES - 1,
        KEYRING_MAX_VALUE_BYTES,
        KEYRING_MAX_VALUE_BYTES + 1,
        2 * KEYRING_MAX_VALUE_BYTES,
        2 * KEYRING_MAX_VALUE_BYTES + 1,
    ] {
        // A repeating alphabet rather than one character, so a chunk written in
        // the wrong order or joined with an off-by-one offset cannot still
        // compare equal.
        let value: String = (0..size)
            .map(|index| char::from(b'a' + (index % 26) as u8))
            .collect();
        let key = format!("chunk-boundary-{size}");
        let read_back = roundtrip(&store, &key, &value).await;
        assert_roundtrip(&read_back, &value, &format!("payload of {size} bytes"));
    }
}

#[tokio::test]
async fn multi_byte_characters_straddling_a_chunk_edge_survive_the_split() {
    let store = storage();
    // Each payload places a 2-, 3-, or 4-byte character so that a naive
    // `value[..2000]` split would land inside it and panic or corrupt the text.
    for (label, filler_bytes, straddler) in [
        ("two-byte", KEYRING_MAX_VALUE_BYTES - 1, 'é'),
        ("three-byte", KEYRING_MAX_VALUE_BYTES - 1, '€'),
        ("three-byte-offset", KEYRING_MAX_VALUE_BYTES - 2, '€'),
        ("four-byte", KEYRING_MAX_VALUE_BYTES - 1, '😀'),
        ("four-byte-offset", KEYRING_MAX_VALUE_BYTES - 3, '😀'),
    ] {
        let mut value = "a".repeat(filler_bytes);
        value.push(straddler);
        value.push_str(&"z".repeat(KEYRING_MAX_VALUE_BYTES));
        assert!(value.len() > KEYRING_MAX_VALUE_BYTES);

        let read_back = roundtrip(&store, &format!("straddle-{label}"), &value).await;
        assert_roundtrip(&read_back, &value, &format!("{label} straddling payload"));
    }

    // A payload made entirely of characters that do not divide the chunk size
    // evenly, long enough to need several chunks.
    let dense = "😀".repeat(KEYRING_MAX_VALUE_BYTES);
    let read_back = roundtrip(&store, "straddle-dense", &dense).await;
    assert_roundtrip(&read_back, &dense, "dense four-byte payload");
}

#[tokio::test]
async fn the_secret_size_ceiling_is_inclusive_and_one_byte_over_is_refused() {
    let store = storage();
    let at_limit = "x".repeat(MAX_SECRET_BYTES);
    let read_back = roundtrip(&store, "ceiling", &at_limit).await;
    assert!(
        read_back.len() == MAX_SECRET_BYTES && read_back == at_limit,
        "the documented maximum secret size must remain storable"
    );

    let over_limit = "x".repeat(MAX_SECRET_BYTES + 1);
    assert!(
        matches!(
            store.store_secret("ceiling-over", &over_limit).await,
            Err(StorageError::LimitExceeded)
        ),
        "one byte past the ceiling must be refused, not silently truncated"
    );
    assert!(
        matches!(
            store.get_secret("ceiling-over").await,
            Err(StorageError::NotFound)
        ),
        "a refused oversized write must leave nothing behind"
    );

    // The refusal must not have disturbed the value already stored.
    let still_there = store
        .get_secret("ceiling")
        .await
        .expect("maximum-size secret remains readable");
    assert!(
        still_there == at_limit,
        "refused write corrupted a neighbour"
    );
}

// ── Metadata disambiguation ─────────────────────────────────────────────────

#[tokio::test]
async fn payloads_that_impersonate_chunk_metadata_round_trip_verbatim() {
    let store = storage();
    // Storage encodes its own bookkeeping into the same keyring value space as
    // user data. A secret whose *content* is a well-formed manifest or legacy
    // marker must come back unchanged rather than being re-interpreted as
    // metadata pointing at chunks that do not exist.
    let impostors = [
        "__chunked__:1",
        "__chunked__:3",
        "__chunked__:1000",
        "__bc_chunks_v2__:00000000-0000-0000-0000-000000000000:1:5:0123456789abcdef",
        "__bc_chunks_v2__:00000000-0000-0000-0000-000000000000:1000:2000000:ffffffffffffffff",
        // A marker-shaped payload long enough to be chunked itself.
        &format!("__chunked__:2{}", "p".repeat(KEYRING_MAX_VALUE_BYTES)),
    ];

    for (index, impostor) in impostors.iter().enumerate() {
        let key = format!("impostor-{index}");
        let read_back = roundtrip(&store, &key, impostor).await;
        assert_roundtrip(&read_back, impostor, &format!("impostor payload {index}"));

        // Overwriting it and reading again must not resolve to the old value or
        // to chunks the impostor text appears to describe.
        let replacement = format!("replacement-{index}");
        let read_back = roundtrip(&store, &key, &replacement).await;
        assert_roundtrip(&read_back, &replacement, &format!("replacement {index}"));
    }
}

#[tokio::test]
async fn overwriting_a_chunked_secret_with_a_shorter_one_leaves_no_readable_remnant() {
    let store = storage();
    let long = "L".repeat(5 * KEYRING_MAX_VALUE_BYTES);
    let short = "S";

    roundtrip(&store, "shrink", &long).await;
    let read_back = roundtrip(&store, "shrink", short).await;
    assert_roundtrip(&read_back, short, "shrunk payload");

    // Growing again must not resurrect any part of the first generation.
    let regrown = "R".repeat(3 * KEYRING_MAX_VALUE_BYTES);
    let read_back = roundtrip(&store, "shrink", &regrown).await;
    assert_roundtrip(&read_back, &regrown, "regrown payload");

    store
        .delete_secret("shrink")
        .await
        .expect("delete chunked secret");
    assert!(matches!(
        store.get_secret("shrink").await,
        Err(StorageError::NotFound)
    ));
}

// ── Audit log ceiling ───────────────────────────────────────────────────────

#[tokio::test]
async fn the_audit_log_retains_the_newest_thousand_entries_exactly() {
    // One under the cap, exactly at it, and one over: the trip point is where a
    // reporting or forensic gap would appear if the drain arithmetic slipped.
    for total in [
        MAX_AUDIT_ENTRIES - 1,
        MAX_AUDIT_ENTRIES,
        MAX_AUDIT_ENTRIES + 1,
    ] {
        let store = storage();
        for index in 0..total {
            store
                .add_audit_entry(serde_json::json!({ "seq": index }))
                .await
                .expect("append audit entry");
        }

        let entries = store.get_audit_entries().await.expect("read audit log");
        let expected_len = total.min(MAX_AUDIT_ENTRIES);
        assert_eq!(
            entries.len(),
            expected_len,
            "audit log length after {total} appends"
        );

        let first_retained = total.saturating_sub(expected_len);
        assert_eq!(
            entries[0]["seq"].as_u64(),
            Some(first_retained as u64),
            "oldest retained entry after {total} appends"
        );
        assert_eq!(
            entries[entries.len() - 1]["seq"].as_u64(),
            Some(total as u64 - 1),
            "newest entry must always be retained after {total} appends"
        );
    }
}

#[tokio::test]
async fn clearing_the_audit_log_is_idempotent_and_leaves_it_empty() {
    let store = storage();
    for index in 0..5 {
        store
            .add_audit_entry(serde_json::json!({ "seq": index }))
            .await
            .expect("append audit entry");
    }
    store.clear_audit_entries().await.expect("clear audit log");
    assert!(store
        .get_audit_entries()
        .await
        .expect("read cleared audit log")
        .is_empty());

    // Clearing an already-absent log must not surface NotFound to the caller.
    store
        .clear_audit_entries()
        .await
        .expect("clearing an empty audit log must succeed");

    // The log must remain usable afterwards.
    store
        .add_audit_entry(serde_json::json!({ "seq": 99 }))
        .await
        .expect("append after clear");
    let entries = store.get_audit_entries().await.expect("read audit log");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["seq"].as_u64(), Some(99));
}

// ── Absent-key semantics ────────────────────────────────────────────────────

#[tokio::test]
async fn absent_records_report_not_found_rather_than_a_silent_default() {
    let store = storage();

    // Encryption settings must fail loudly: silently substituting a default
    // would re-derive keys with the wrong parameters and lock the user out.
    assert!(matches!(
        store.get_encryption_settings().await,
        Err(StorageError::NotFound)
    ));
    assert!(matches!(
        store.get_api_key("key_missing").await,
        Err(StorageError::NotFound)
    ));
    assert!(matches!(
        store.get_encrypted_key("key_missing").await,
        Err(StorageError::NotFound)
    ));
    assert!(matches!(
        store.get_vault_secret("missing").await,
        Err(StorageError::NotFound)
    ));
    assert!(matches!(
        store
            .get_registrar_credential::<serde_json::Value>("missing")
            .await,
        Err(StorageError::NotFound)
    ));

    // Collections are absence-tolerant by design and must report emptiness.
    assert!(store.get_api_keys().await.expect("api keys").is_empty());
    assert!(store
        .get_passkeys("nobody")
        .await
        .expect("passkeys")
        .is_empty());
    assert!(store
        .get_audit_entries()
        .await
        .expect("audit entries")
        .is_empty());
    assert!(store
        .get_registrar_secrets("missing")
        .await
        .expect("registrar secrets")
        .is_empty());
    assert!(store
        .get_typed_list::<serde_json::Value>("missing-list")
        .await
        .expect("typed list")
        .is_empty());
    assert!(store
        .get_typed_map::<serde_json::Value>("missing-map")
        .await
        .expect("typed map")
        .is_empty());
    assert!(store
        .get_legacy_preferences()
        .await
        .expect("legacy preferences")
        .is_none());

    // Deleting what is not there must succeed, so cleanup paths cannot wedge.
    store
        .delete_secret("missing")
        .await
        .expect("delete absent secret");
    store
        .delete_vault_secret("missing")
        .await
        .expect("delete absent vault secret");
    store
        .delete_api_key("key_missing".to_string())
        .await
        .expect("delete absent API key");
    store
        .delete_registrar_secrets("missing")
        .await
        .expect("delete absent registrar secrets");
}

#[tokio::test]
async fn updating_an_unknown_api_key_reports_not_found_without_creating_one() {
    let store = storage();
    let result = store
        .update_api_key(
            "key_does_not_exist".to_string(),
            Some("relabelled".to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
    assert!(matches!(result, Err(StorageError::NotFound)));
    assert!(
        store.get_api_keys().await.expect("api keys").is_empty(),
        "a failed update must not materialise a key"
    );
}

// ── Typed collections ───────────────────────────────────────────────────────

#[tokio::test]
async fn typed_collections_survive_payloads_large_enough_to_chunk() {
    let store = storage();
    // Values chosen so the serialized JSON crosses several chunk edges and
    // contains characters JSON must escape, which changes the byte length after
    // serialization and would expose an accounting error between the two.
    let items: Vec<String> = (0..400)
        .map(|index| format!("entry-{index}-\"quoted\"-\\escaped\\-😀-é-\n"))
        .collect();
    store
        .set_typed_list("big-list", &items)
        .await
        .expect("store typed list");
    let read_back: Vec<String> = store
        .get_typed_list("big-list")
        .await
        .expect("read typed list");
    assert!(read_back == items, "typed list did not round-trip");

    let map: HashMap<String, String> = items
        .iter()
        .enumerate()
        .map(|(index, value)| (format!("k{index}"), value.clone()))
        .collect();
    store
        .set_typed_map("big-map", &map)
        .await
        .expect("store typed map");
    let read_back: HashMap<String, String> = store
        .get_typed_map("big-map")
        .await
        .expect("read typed map");
    assert!(read_back == map, "typed map did not round-trip");
}

#[tokio::test]
async fn a_corrupt_stored_collection_is_reported_rather_than_read_as_empty() {
    let store = storage();
    // A readable secret whose contents are not the expected shape must be
    // distinguishable from "nothing stored"; conflating the two would let a
    // corrupted credential list look like a clean first run and be overwritten.
    store
        .store_secret("api_keys_list", "{\"not\":\"a list\"}")
        .await
        .expect("seed malformed collection");
    assert!(matches!(
        store.get_api_keys().await,
        Err(StorageError::CorruptData(_))
    ));

    store
        .store_secret("encryption_settings", "not json at all")
        .await
        .expect("seed malformed settings");
    assert!(matches!(
        store.get_encryption_settings().await,
        Err(StorageError::CorruptData(_))
    ));

    store
        .store_secret("registrar_credentials", "[{\"id\":42}]")
        .await
        .expect("seed malformed registrar credential");
    assert!(matches!(
        store.get_registrar_credential::<TestCredential>("42").await,
        Err(StorageError::NotFound) | Err(StorageError::CorruptData(_))
    ));
}

#[derive(serde::Deserialize)]
struct TestCredential {
    #[allow(dead_code)]
    id: String,
}

// ── Passkeys ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn removing_the_last_passkey_clears_the_record_without_stranding_an_empty_list() {
    let store = storage();
    store
        .store_passkey("account", serde_json::json!({ "id": "cred-a" }))
        .await
        .expect("store first passkey");
    store
        .store_passkey("account", serde_json::json!({ "rawId": "cred-b" }))
        .await
        .expect("store second passkey");

    // Deletion must match either identifier spelling a credential can carry.
    store
        .delete_passkey("account", "cred-b")
        .await
        .expect("delete by rawId");
    let remaining = store.get_passkeys("account").await.expect("read passkeys");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["id"].as_str(), Some("cred-a"));

    store
        .delete_passkey("account", "cred-a")
        .await
        .expect("delete by id");
    assert!(store
        .get_passkeys("account")
        .await
        .expect("read emptied passkeys")
        .is_empty());
    assert!(
        matches!(
            store.get_secret("passkeys:account").await,
            Err(StorageError::NotFound)
        ),
        "emptying the list must delete the record, not store an empty array"
    );

    // Deleting from an already-empty record must stay a no-op.
    store
        .delete_passkey("account", "cred-a")
        .await
        .expect("delete from empty passkey record");

    // And the record must still be usable afterwards.
    store
        .store_passkey("account", serde_json::json!({ "id": "cred-c" }))
        .await
        .expect("store after emptying");
    assert_eq!(
        store
            .get_passkeys("account")
            .await
            .expect("read passkeys")
            .len(),
        1
    );
}

// ── Logical key validation ──────────────────────────────────────────────────

#[tokio::test]
async fn reserved_key_shapes_are_refused_on_every_mutating_path() {
    let store = storage();
    let generation = "00000000-0000-0000-0000-000000000000";
    for reserved in [
        "victim::chunk:0",
        &format!("victim::generation:{generation}:chunk:0"),
        // The reservation is a substring rule, so it must hold mid-key too.
        "prefix::chunk:12/suffix",
    ] {
        assert!(
            matches!(
                store.store_secret(reserved, "value").await,
                Err(StorageError::InvalidKey)
            ),
            "reserved key shape accepted for write: {reserved}"
        );
        assert!(
            matches!(
                store.delete_secret(reserved).await,
                Err(StorageError::InvalidKey)
            ),
            "reserved key shape accepted for delete: {reserved}"
        );
    }

    // Vault and registrar helpers derive keys from caller-supplied identifiers,
    // so the same reservation must survive the prefixing they apply.
    assert!(matches!(
        store.store_vault_secret("id::chunk:0", "value").await,
        Err(StorageError::InvalidKey)
    ));
    assert!(matches!(
        store
            .store_registrar_secrets("id::chunk:0", &HashMap::new())
            .await,
        Err(StorageError::InvalidKey)
    ));

    // An empty identifier still produces a non-empty prefixed key, so it is
    // accepted; what matters is that it cannot collide with another record.
    store
        .store_vault_secret("", "empty-id-value")
        .await
        .expect("empty vault identifier");
    assert!(
        store.get_vault_secret("").await.expect("read empty id") == "empty-id-value",
        "empty vault identifier did not round-trip"
    );
}
