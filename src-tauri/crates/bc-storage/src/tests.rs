use super::*;
use serde_json::json;
use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Barrier, Condvar, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Operation {
    Get,
    Set,
    Delete,
}

#[derive(Debug)]
struct Fault {
    operation: Operation,
    target: usize,
    seen: usize,
}

#[derive(Default)]
struct FakeState {
    values: HashMap<String, String>,
    calls: Vec<(Operation, String)>,
    fault: Option<Fault>,
    commit_then_error: Option<Fault>,
}

#[derive(Default)]
struct ReadSerializationState {
    key: String,
    armed: bool,
    first_entered: bool,
    overlap: bool,
    released: bool,
}

#[derive(Default)]
struct ReadSerializationProbe {
    state: Mutex<ReadSerializationState>,
    changed: Condvar,
}

impl ReadSerializationProbe {
    fn arm(&self, key: &str) {
        let mut state = self.state.lock().expect("lock read serialization probe");
        state.key = key.to_string();
        state.armed = true;
        state.first_entered = false;
        state.overlap = false;
        state.released = false;
    }

    fn observe_and_block(&self, key: &str) {
        let mut state = self.state.lock().expect("lock read serialization probe");
        if !state.armed || state.key != key {
            return;
        }

        if state.first_entered {
            state.overlap = true;
            self.changed.notify_all();
        } else {
            state.first_entered = true;
            self.changed.notify_all();
        }

        while state.armed && !state.released {
            state = self
                .changed
                .wait(state)
                .expect("wait at read serialization probe");
        }
    }

    fn wait_for_first(&self, timeout: Duration) -> bool {
        let state = self.state.lock().expect("lock read serialization probe");
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.first_entered)
            .expect("wait for first serialized read");
        state.first_entered
    }

    fn wait_for_overlap(&self, timeout: Duration) -> bool {
        let state = self.state.lock().expect("lock read serialization probe");
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |state| !state.overlap)
            .expect("check for overlapping serialized reads");
        state.overlap
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("lock read serialization probe");
        state.released = true;
        state.armed = false;
        self.changed.notify_all();
    }
}

#[derive(Default)]
struct FakeBackend {
    state: Mutex<FakeState>,
    read_serialization: ReadSerializationProbe,
}

impl FakeBackend {
    fn put(&self, key: &str, value: &str) {
        self.state
            .lock()
            .expect("lock fake backend")
            .values
            .insert(key.to_string(), value.to_string());
    }

    fn value(&self, key: &str) -> Option<String> {
        self.state
            .lock()
            .expect("lock fake backend")
            .values
            .get(key)
            .cloned()
    }

    fn contains(&self, key: &str) -> bool {
        self.state
            .lock()
            .expect("lock fake backend")
            .values
            .contains_key(key)
    }

    fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        self.state
            .lock()
            .expect("lock fake backend")
            .values
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect()
    }

    fn clear_calls(&self) {
        self.state.lock().expect("lock fake backend").calls.clear();
    }

    fn fail_nth(&self, operation: Operation, target: usize) {
        assert!(target > 0);
        self.state.lock().expect("lock fake backend").fault = Some(Fault {
            operation,
            target,
            seen: 0,
        });
    }

    fn commit_then_error_nth_set(&self, target: usize) {
        assert!(target > 0);
        self.state
            .lock()
            .expect("lock fake backend")
            .commit_then_error = Some(Fault {
            operation: Operation::Set,
            target,
            seen: 0,
        });
    }

    fn call_count(&self, operation: Operation) -> usize {
        self.state
            .lock()
            .expect("lock fake backend")
            .calls
            .iter()
            .filter(|(actual, _)| *actual == operation)
            .count()
    }

    fn maybe_fail(state: &mut FakeState, operation: Operation) -> Result<(), BackendError> {
        let Some(fault) = state.fault.as_mut() else {
            return Ok(());
        };
        if fault.operation != operation {
            return Ok(());
        }
        fault.seen += 1;
        if fault.seen == fault.target {
            state.fault = None;
            return Err(BackendError::Failure);
        }
        Ok(())
    }

    fn should_commit_then_error(state: &mut FakeState) -> bool {
        let should_fail = {
            let Some(fault) = state.commit_then_error.as_mut() else {
                return false;
            };
            fault.seen += 1;
            fault.seen == fault.target
        };
        if should_fail {
            state.commit_then_error = None;
        }
        should_fail
    }
}

impl SecretBackend for FakeBackend {
    fn get(&self, key: &str) -> Result<String, BackendError> {
        self.read_serialization.observe_and_block(key);
        let mut state = self.state.lock().map_err(|_| BackendError::Failure)?;
        state.calls.push((Operation::Get, key.to_string()));
        Self::maybe_fail(&mut state, Operation::Get)?;
        state.values.get(key).cloned().ok_or(BackendError::NotFound)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), BackendError> {
        let mut state = self.state.lock().map_err(|_| BackendError::Failure)?;
        state.calls.push((Operation::Set, key.to_string()));
        Self::maybe_fail(&mut state, Operation::Set)?;
        let commit_then_error = Self::should_commit_then_error(&mut state);
        state.values.insert(key.to_string(), value.to_string());
        if commit_then_error {
            Err(BackendError::Failure)
        } else {
            Ok(())
        }
    }

    fn delete(&self, key: &str) -> Result<(), BackendError> {
        let mut state = self.state.lock().map_err(|_| BackendError::Failure)?;
        state.calls.push((Operation::Delete, key.to_string()));
        Self::maybe_fail(&mut state, Operation::Delete)?;
        if state.values.remove(key).is_some() {
            Ok(())
        } else {
            Err(BackendError::NotFound)
        }
    }
}

fn fake_storage() -> (Arc<FakeBackend>, Arc<Storage>) {
    let backend = Arc::new(FakeBackend::default());
    let storage = Arc::new(Storage::with_backend(backend.clone()));
    (backend, storage)
}

fn fake_storage_pair() -> (Arc<FakeBackend>, Arc<Storage>, Arc<Storage>) {
    let backend = Arc::new(FakeBackend::default());
    let left = Arc::new(Storage::with_backend(backend.clone()));
    let right = Arc::new(Storage::with_backend(backend.clone()));
    (backend, left, right)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("build test runtime")
}

fn assert_secret(actual: &str, expected: &str, context: &'static str) {
    assert!(actual == expected, "{context}");
}

fn manifest_from_backend(backend: &FakeBackend, key: &str) -> ChunkManifest {
    let root = backend.value(key).expect("manifest root exists");
    match parse_stored_root(&root).expect("parse manifest root") {
        StoredRoot::Manifest(manifest) => manifest,
        _ => panic!("root is not a manifest"),
    }
}

async fn seed_and_attempt(
    operation: Operation,
    fault_position: usize,
) -> (
    Arc<FakeBackend>,
    Arc<Storage>,
    String,
    Result<(), StorageError>,
) {
    let (backend, storage) = fake_storage();
    let old = "old-generation|".repeat(310);
    let new = "new-generation|".repeat(330);
    storage
        .store_secret("atomic", &old)
        .await
        .expect("seed old generation");
    backend.clear_calls();
    backend.fail_nth(operation, fault_position);
    let result = storage.store_secret("atomic", &new).await;
    (backend, storage, old, result)
}

#[test]
fn chunk_helpers_enforce_utf8_and_limits() {
    let input = "é".repeat(KEYRING_MAX_VALUE_BYTES + 11);
    let chunks = split_value_for_keyring(&input).expect("split UTF-8 payload");
    assert!(chunks.len() == 3);
    assert!(chunks
        .iter()
        .all(|chunk| chunk.len() <= KEYRING_MAX_VALUE_BYTES));
    assert_secret(&chunks.concat(), &input, "UTF-8 chunks did not round-trip");

    let oversized = "x".repeat(MAX_SECRET_BYTES + 1);
    assert!(matches!(
        split_value_for_keyring(&oversized),
        Err(StorageError::LimitExceeded)
    ));

    let chars_per_chunk = KEYRING_MAX_VALUE_BYTES / "€".len();
    let multibyte_1001_chunks = "€".repeat(chars_per_chunk * MAX_CHUNK_COUNT + 1);
    assert!(multibyte_1001_chunks.len() <= MAX_SECRET_BYTES);
    assert!(
        utf8_aware_chunk_count(&multibyte_1001_chunks).expect("count UTF-8 chunks")
            == MAX_CHUNK_COUNT + 1
    );
    assert!(matches!(
        split_value_for_keyring(&multibyte_1001_chunks),
        Err(StorageError::LimitExceeded)
    ));
}

#[tokio::test]
async fn explicit_memory_mode_roundtrips_without_platform_keyring() {
    let storage = Storage::new(false);
    storage
        .store_vault_secret("key_1", "secret-value")
        .await
        .expect("store memory-only vault secret");
    let secret = storage
        .get_vault_secret("key_1")
        .await
        .expect("read memory-only vault secret");
    assert_secret(&secret, "secret-value", "memory-only value changed");
    storage
        .store_secret("empty", "")
        .await
        .expect("store empty value");
    let empty = storage.get_secret("empty").await.expect("read empty value");
    assert!(empty.is_empty());
    storage
        .delete_vault_secret("key_1")
        .await
        .expect("delete memory-only vault secret");
    assert!(matches!(
        storage.get_vault_secret("key_1").await,
        Err(StorageError::NotFound)
    ));
}

#[tokio::test]
async fn every_chunk_write_failure_preserves_the_old_generation() {
    let new = "new-generation|".repeat(330);
    let chunk_count = split_value_for_keyring(&new)
        .expect("split replacement")
        .len();
    assert!(chunk_count > 1);

    for position in 1..=chunk_count {
        let (_backend, storage, old, result) = seed_and_attempt(Operation::Set, position).await;
        assert!(result.is_err(), "chunk write fault reported success");
        let visible = storage
            .get_secret("atomic")
            .await
            .expect("old generation remains readable");
        assert_secret(
            &visible,
            &old,
            "chunk write fault exposed a partial generation",
        );
    }
}

#[tokio::test]
async fn every_verification_read_failure_preserves_the_old_generation() {
    let new = "new-generation|".repeat(330);
    let chunk_count = split_value_for_keyring(&new)
        .expect("split replacement")
        .len();

    // Read 1 loads the old root. Reads 2.. verify each new immutable chunk.
    for position in 2..=(chunk_count + 1) {
        let (_backend, storage, old, result) = seed_and_attempt(Operation::Get, position).await;
        assert!(result.is_err(), "verification read fault reported success");
        let visible = storage
            .get_secret("atomic")
            .await
            .expect("old generation remains readable");
        assert_secret(
            &visible,
            &old,
            "verification fault exposed a partial generation",
        );
    }
}

#[tokio::test]
async fn manifest_write_failure_preserves_the_old_generation() {
    let new = "new-generation|".repeat(330);
    let chunk_count = split_value_for_keyring(&new)
        .expect("split replacement")
        .len();
    let (_backend, storage, old, result) = seed_and_attempt(Operation::Set, chunk_count + 1).await;
    assert!(result.is_err(), "manifest write fault reported success");
    let visible = storage
        .get_secret("atomic")
        .await
        .expect("old generation remains readable");
    assert_secret(
        &visible,
        &old,
        "manifest write fault exposed a partial generation",
    );
    let active = manifest_from_backend(&_backend, "atomic");
    let generation_keys = _backend.keys_with_prefix("atomic::generation:");
    assert!(
        generation_keys
            .iter()
            .all(|key| key.contains(&active.generation)),
        "proven-inactive replacement chunks were not cleaned up"
    );
}

#[tokio::test]
async fn manifest_commit_then_error_accepts_the_committed_generation() {
    let (backend, storage) = fake_storage();
    let old = "old-generation|".repeat(310);
    let new = "new-generation|".repeat(330);
    storage
        .store_secret("atomic", &old)
        .await
        .expect("seed old generation");
    let old_manifest = manifest_from_backend(&backend, "atomic");
    backend.clear_calls();

    let new_chunk_count = split_value_for_keyring(&new)
        .expect("split replacement")
        .len();
    backend.commit_then_error_nth_set(new_chunk_count + 1);
    storage
        .store_secret("atomic", &new)
        .await
        .expect("read-back must accept a manifest committed before its error");

    let visible = storage
        .get_secret("atomic")
        .await
        .expect("committed generation remains readable");
    assert_secret(
        &visible,
        &new,
        "commit-then-error did not retain the active generation",
    );
    for idx in 0..old_manifest.chunk_count {
        assert!(
            !backend.contains(&Storage::generation_chunk_key(
                "atomic",
                &old_manifest.generation,
                idx
            )),
            "accepted commit did not clean up the old generation"
        );
    }
}

#[tokio::test]
async fn inconclusive_manifest_error_readback_keeps_possibly_active_chunks() {
    let (backend, storage) = fake_storage();
    let old = "old-generation|".repeat(310);
    let new = "new-generation|".repeat(330);
    storage
        .store_secret("atomic", &old)
        .await
        .expect("seed old generation");
    let old_manifest = manifest_from_backend(&backend, "atomic");
    backend.clear_calls();

    let new_chunk_count = split_value_for_keyring(&new)
        .expect("split replacement")
        .len();
    backend.commit_then_error_nth_set(new_chunk_count + 1);
    // Root read 1 loads the old manifest, reads 2..=N+1 verify the new
    // generation, and read N+2 is the safety read-back after manifest error.
    backend.fail_nth(Operation::Get, new_chunk_count + 2);
    let result = storage.store_secret("atomic", &new).await;
    assert!(matches!(result, Err(StorageError::KeyringError(_))));

    let active = manifest_from_backend(&backend, "atomic");
    assert!(active.generation != old_manifest.generation);
    for idx in 0..active.chunk_count {
        assert!(
            backend.contains(&Storage::generation_chunk_key(
                "atomic",
                &active.generation,
                idx
            )),
            "inconclusive read-back deleted a possibly active chunk"
        );
    }
    for idx in 0..old_manifest.chunk_count {
        assert!(
            backend.contains(&Storage::generation_chunk_key(
                "atomic",
                &old_manifest.generation,
                idx
            )),
            "inconclusive read-back should not perform old-root cleanup"
        );
    }
    let visible = storage
        .get_secret("atomic")
        .await
        .expect("committed generation remains readable after transient read-back failure");
    assert_secret(
        &visible,
        &new,
        "inconclusive read-back corrupted the active generation",
    );
}

#[tokio::test]
async fn every_old_generation_cleanup_failure_is_best_effort_and_safe() {
    let (seed_backend, seed_storage) = fake_storage();
    let old = "old-generation|".repeat(310);
    seed_storage
        .store_secret("atomic", &old)
        .await
        .expect("seed old generation");
    let old_count = manifest_from_backend(&seed_backend, "atomic").chunk_count;

    for position in 1..=old_count {
        let (backend, storage) = fake_storage();
        storage
            .store_secret("atomic", &old)
            .await
            .expect("seed old generation");
        backend.clear_calls();
        backend.fail_nth(Operation::Delete, position);

        let new = "new-generation|".repeat(330);
        storage
            .store_secret("atomic", &new)
            .await
            .expect("cleanup failure must not fail committed write");
        let visible = storage
            .get_secret("atomic")
            .await
            .expect("new generation remains readable");
        assert_secret(
            &visible,
            &new,
            "cleanup fault removed or corrupted the active generation",
        );

        let active = manifest_from_backend(&backend, "atomic");
        for idx in 0..active.chunk_count {
            assert!(
                backend.contains(&Storage::generation_chunk_key(
                    "atomic",
                    &active.generation,
                    idx
                )),
                "active generation chunk was removed"
            );
        }
    }
}

#[tokio::test]
async fn backend_errors_fail_closed_and_not_found_stays_distinct() {
    let (backend, storage) = fake_storage();
    storage
        .store_secret("durable", "stored-value")
        .await
        .expect("seed durable value");

    backend.clear_calls();
    backend.fail_nth(Operation::Get, 1);
    let read_error = storage.get_secret("durable").await;
    assert!(matches!(read_error, Err(StorageError::KeyringError(_))));

    let still_visible = storage
        .get_secret("durable")
        .await
        .expect("transient read failure must not delete data");
    assert_secret(
        &still_visible,
        "stored-value",
        "transient read failure changed stored data",
    );

    backend.clear_calls();
    backend.fail_nth(Operation::Get, 1);
    let overwrite_after_read_error = storage.store_secret("durable", "replacement-value").await;
    assert!(matches!(
        overwrite_after_read_error,
        Err(StorageError::KeyringError(_))
    ));
    let after_failed_overwrite = storage
        .get_secret("durable")
        .await
        .expect("failed pre-write read must preserve active data");
    assert_secret(
        &after_failed_overwrite,
        "stored-value",
        "read failure allowed a destructive overwrite",
    );

    assert!(matches!(
        storage.get_secret("missing").await,
        Err(StorageError::NotFound)
    ));

    backend.clear_calls();
    backend.fail_nth(Operation::Set, 1);
    let write_error = storage.store_secret("new-key", "new-value").await;
    assert!(matches!(write_error, Err(StorageError::KeyringError(_))));
    assert!(matches!(
        storage.get_secret("new-key").await,
        Err(StorageError::NotFound)
    ));

    backend.clear_calls();
    backend.fail_nth(Operation::Delete, 1);
    let delete_error = storage.delete_secret("durable").await;
    assert!(matches!(delete_error, Err(StorageError::KeyringError(_))));
    let after_failed_delete = storage
        .get_secret("durable")
        .await
        .expect("failed delete must preserve active root");
    assert_secret(
        &after_failed_delete,
        "stored-value",
        "failed delete changed stored data",
    );

    let rendered = format!(
        "{} | {} | {} | {}",
        read_error.expect_err("read failed"),
        overwrite_after_read_error.expect_err("overwrite failed"),
        write_error.expect_err("write failed"),
        delete_error.expect_err("delete failed")
    );
    assert!(
        !rendered.contains("stored-value")
            && !rendered.contains("replacement-value")
            && !rendered.contains("new-value"),
        "storage error exposed a secret payload"
    );
}

#[tokio::test]
async fn well_formed_but_absurd_metadata_fails_before_chunk_iteration() {
    let (backend, storage) = fake_storage();
    let generation = uuid::Uuid::nil().to_string();
    let digest = payload_digest("x");
    let cases = [
        "__chunked__:0".to_string(),
        format!("__chunked__:{}", MAX_CHUNK_COUNT + 1),
        format!("{LEGACY_CHUNK_MARKER}{}", "9".repeat(MAX_MANIFEST_BYTES)),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:0:0:{digest}"),
        format!(
            "{CHUNK_MANIFEST_MARKER}{generation}:{}:1:{digest}",
            MAX_CHUNK_COUNT + 1
        ),
        format!(
            "{CHUNK_MANIFEST_MARKER}{generation}:1:{}:{digest}",
            MAX_SECRET_BYTES + 1
        ),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:1:2001:{digest}"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:2:1:{digest}"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:2:0:{digest}"),
        format!(
            "{CHUNK_MANIFEST_MARKER}{generation}:{}:1:{digest}",
            "9".repeat(MAX_MANIFEST_BYTES)
        ),
    ];

    for (idx, root) in cases.into_iter().enumerate() {
        let key = format!("malformed-{idx}");
        backend.put(&key, &root);
        backend.clear_calls();
        let result = storage.get_secret(&key).await;
        assert!(
            matches!(
                result,
                Err(StorageError::CorruptData(_)) | Err(StorageError::LimitExceeded)
            ),
            "absurd metadata was accepted"
        );
        assert!(
            backend.call_count(Operation::Get) == 1,
            "absurd metadata triggered chunk reads"
        );
    }
}

#[tokio::test]
async fn marker_prefixed_non_metadata_legacy_values_remain_directly_readable() {
    let (backend, storage) = fake_storage();
    let generation = uuid::Uuid::nil();
    let digest = payload_digest("x");
    let cases = [
        "__chunked__:".to_string(),
        "__chunked__:not-a-number".to_string(),
        "__chunked__:01".to_string(),
        "__chunked__:1:legacy-suffix".to_string(),
        CHUNK_MANIFEST_MARKER.to_string(),
        format!("{CHUNK_MANIFEST_MARKER}legacy-direct-value"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:1"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:one:1:{digest}"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:1:many:{digest}"),
        format!("{CHUNK_MANIFEST_MARKER}not-a-generation:1:1:{digest}"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:1:1:not-a-digest"),
        format!("{CHUNK_MANIFEST_MARKER}{generation}:1:1:{digest}:extra"),
    ];

    for (idx, direct_value) in cases.into_iter().enumerate() {
        let key = format!("marker-prefixed-direct-{idx}");
        backend.put(&key, &direct_value);
        backend.clear_calls();
        let visible = storage
            .get_secret(&key)
            .await
            .expect("read marker-prefixed direct legacy value");
        assert_secret(
            &visible,
            &direct_value,
            "marker-prefixed direct legacy value changed",
        );
        assert!(
            backend.call_count(Operation::Get) == 1,
            "direct legacy value triggered metadata chunk reads"
        );
    }
}

#[tokio::test]
async fn truncated_and_oversized_chunks_fail_closed() {
    let (backend, storage) = fake_storage();
    let generation = uuid::Uuid::nil().to_string();

    backend.put(
        "truncated",
        &ChunkManifest {
            generation: generation.clone(),
            chunk_count: 2,
            byte_len: 4,
            digest: payload_digest("abcd"),
        }
        .encode(),
    );
    backend.put(
        &Storage::generation_chunk_key("truncated", &generation, 0),
        "ab",
    );
    assert!(matches!(
        storage.get_secret("truncated").await,
        Err(StorageError::CorruptData(_))
    ));

    backend.put(
        "oversized-chunk",
        &ChunkManifest {
            generation: generation.clone(),
            chunk_count: 1,
            byte_len: KEYRING_MAX_VALUE_BYTES,
            digest: payload_digest(&"x".repeat(KEYRING_MAX_VALUE_BYTES)),
        }
        .encode(),
    );
    backend.put(
        &Storage::generation_chunk_key("oversized-chunk", &generation, 0),
        &"x".repeat(KEYRING_MAX_VALUE_BYTES + 1),
    );
    assert!(matches!(
        storage.get_secret("oversized-chunk").await,
        Err(StorageError::CorruptData(_))
    ));

    backend.put(
        "byte-mismatch",
        &ChunkManifest {
            generation: generation.clone(),
            chunk_count: 1,
            byte_len: 4,
            digest: payload_digest("abcd"),
        }
        .encode(),
    );
    backend.put(
        &Storage::generation_chunk_key("byte-mismatch", &generation, 0),
        "abc",
    );
    assert!(matches!(
        storage.get_secret("byte-mismatch").await,
        Err(StorageError::CorruptData(_))
    ));

    backend.put(
        "digest-mismatch",
        &ChunkManifest {
            generation: generation.clone(),
            chunk_count: 1,
            byte_len: 4,
            digest: payload_digest("abcd"),
        }
        .encode(),
    );
    backend.put(
        &Storage::generation_chunk_key("digest-mismatch", &generation, 0),
        "abce",
    );
    assert!(matches!(
        storage.get_secret("digest-mismatch").await,
        Err(StorageError::CorruptData(_))
    ));

    backend.put("legacy-truncated", "__chunked__:2");
    backend.put(&Storage::legacy_chunk_key("legacy-truncated", 0), "ab");
    assert!(matches!(
        storage.get_secret("legacy-truncated").await,
        Err(StorageError::CorruptData(_))
    ));
}

#[tokio::test]
async fn byte_and_count_ceilings_are_checked_before_backend_loops() {
    let (backend, storage) = fake_storage();
    let generation = uuid::Uuid::nil();
    let digest = payload_digest("x");

    backend.put(
        "absurd-count",
        &format!(
            "{CHUNK_MANIFEST_MARKER}{generation}:{}:{}:{digest}",
            MAX_CHUNK_COUNT + 1,
            MAX_SECRET_BYTES
        ),
    );
    backend.clear_calls();
    assert!(matches!(
        storage.get_secret("absurd-count").await,
        Err(StorageError::LimitExceeded)
    ));
    assert!(backend.call_count(Operation::Get) == 1);

    backend.put(
        "absurd-legacy-count",
        &format!("{LEGACY_CHUNK_MARKER}{}", MAX_CHUNK_COUNT + 1),
    );
    backend.clear_calls();
    assert!(matches!(
        storage.get_secret("absurd-legacy-count").await,
        Err(StorageError::LimitExceeded)
    ));
    assert!(backend.call_count(Operation::Get) == 1);

    backend.put(
        "oversized-legacy-marker",
        &format!("{LEGACY_CHUNK_MARKER}{}", "9".repeat(MAX_MANIFEST_BYTES)),
    );
    backend.clear_calls();
    assert!(matches!(
        storage.get_secret("oversized-legacy-marker").await,
        Err(StorageError::LimitExceeded)
    ));
    assert!(backend.call_count(Operation::Get) == 1);

    backend.put(
        "absurd-bytes",
        &format!(
            "{CHUNK_MANIFEST_MARKER}{generation}:1:{}:{digest}",
            MAX_SECRET_BYTES + 1
        ),
    );
    backend.clear_calls();
    assert!(matches!(
        storage.get_secret("absurd-bytes").await,
        Err(StorageError::LimitExceeded)
    ));
    assert!(backend.call_count(Operation::Get) == 1);

    backend.clear_calls();
    let oversized = "x".repeat(MAX_SECRET_BYTES + 1);
    assert!(matches!(
        storage.store_secret("too-large", &oversized).await,
        Err(StorageError::LimitExceeded)
    ));
    assert!(backend.call_count(Operation::Get) == 0);
    assert!(backend.call_count(Operation::Set) == 0);
}

#[tokio::test]
async fn legacy_direct_and_chunked_values_read_and_migrate() {
    let (backend, storage) = fake_storage();
    backend.put("legacy-direct", "direct-value");
    let direct = storage
        .get_secret("legacy-direct")
        .await
        .expect("read legacy direct value");
    assert_secret(
        &direct,
        "direct-value",
        "legacy direct value did not round-trip",
    );
    storage
        .store_secret("legacy-direct", "direct-migrated")
        .await
        .expect("migrate legacy direct value");
    assert!(matches!(
        parse_stored_root(
            &backend
                .value("legacy-direct")
                .expect("direct migration manifest root")
        ),
        Ok(StoredRoot::Manifest(_))
    ));

    backend.put("legacy-chunked", "__chunked__:3");
    backend.put(&Storage::legacy_chunk_key("legacy-chunked", 0), "first-");
    backend.put(&Storage::legacy_chunk_key("legacy-chunked", 1), "second-");
    backend.put(&Storage::legacy_chunk_key("legacy-chunked", 2), "third");
    let chunked = storage
        .get_secret("legacy-chunked")
        .await
        .expect("read legacy chunked value");
    assert_secret(
        &chunked,
        "first-second-third",
        "legacy chunks did not round-trip",
    );

    storage
        .store_secret("legacy-chunked", "migrated-value")
        .await
        .expect("migrate legacy chunks");
    assert!(matches!(
        parse_stored_root(
            &backend
                .value("legacy-chunked")
                .expect("migrated manifest root")
        ),
        Ok(StoredRoot::Manifest(_))
    ));
    for idx in 0..3 {
        assert!(
            !backend.contains(&Storage::legacy_chunk_key("legacy-chunked", idx)),
            "legacy chunk was not garbage-collected"
        );
    }
    let migrated = storage
        .get_secret("legacy-chunked")
        .await
        .expect("read migrated value");
    assert_secret(
        &migrated,
        "migrated-value",
        "migrated value did not round-trip",
    );
}

fn run_concurrently(
    backend: &Arc<FakeBackend>,
    key: &str,
    left_storage: Arc<Storage>,
    right_storage: Arc<Storage>,
    left: impl FnOnce(Arc<Storage>) + Send + 'static,
    right: impl FnOnce(Arc<Storage>) + Send + 'static,
) {
    assert!(
        !Arc::ptr_eq(&left_storage, &right_storage),
        "concurrency contract requires separately constructed Storage instances"
    );
    backend.read_serialization.arm(key);

    let start = Arc::new(Barrier::new(3));
    let (done_tx, done_rx) = mpsc::channel();
    let left_start = start.clone();
    let left_done = done_tx.clone();
    let left_thread = thread::spawn(move || {
        left_start.wait();
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| left(left_storage)));
        let _ = left_done.send(("left", outcome));
    });
    let right_start = start.clone();
    let right_done = done_tx;
    let right_thread = thread::spawn(move || {
        right_start.wait();
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| right(right_storage)));
        let _ = right_done.send(("right", outcome));
    });
    start.wait();

    if !backend
        .read_serialization
        .wait_for_first(Duration::from_secs(2))
    {
        backend.read_serialization.release();
        panic!("neither mutation reached the guarded backend read within 2 seconds");
    }
    let overlapped = backend
        .read_serialization
        .wait_for_overlap(Duration::from_millis(500));
    backend.read_serialization.release();

    let mut panic_payload = None;
    for _ in 0..2 {
        let (side, outcome) = done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("concurrent mutation deadlocked after read probe release");
        if let Err(payload) = outcome {
            panic_payload.get_or_insert((side, payload));
        }
    }
    left_thread.join().expect("left mutation harness thread");
    right_thread.join().expect("right mutation harness thread");

    assert!(
        !overlapped,
        "separate Storage instances reached the same backend root concurrently"
    );
    if let Some((_side, payload)) = panic_payload {
        panic::resume_unwind(payload);
    }
}

#[test]
fn api_key_add_add_and_add_delete_are_serialized() {
    let (backend, storage, peer_storage) = fake_storage_pair();
    run_concurrently(
        &backend,
        "api_keys_list",
        storage.clone(),
        peer_storage.clone(),
        |storage| {
            runtime()
                .block_on(storage.add_api_key(
                    "left".to_string(),
                    "left-secret".to_string(),
                    None,
                    EncryptionConfig::default(),
                ))
                .expect("left API key add");
        },
        |storage| {
            runtime()
                .block_on(storage.add_api_key(
                    "right".to_string(),
                    "right-secret".to_string(),
                    None,
                    EncryptionConfig::default(),
                ))
                .expect("right API key add");
        },
    );
    let keys = runtime()
        .block_on(storage.get_api_keys())
        .expect("read concurrent API keys");
    assert!(keys.len() == 2);
    assert!(keys.iter().any(|key| key.label == "left"));
    assert!(keys.iter().any(|key| key.label == "right"));

    let doomed = runtime()
        .block_on(storage.add_api_key(
            "doomed".to_string(),
            "doomed-secret".to_string(),
            None,
            EncryptionConfig::default(),
        ))
        .expect("seed doomed API key");
    run_concurrently(
        &backend,
        "api_keys_list",
        storage.clone(),
        peer_storage,
        |storage| {
            runtime()
                .block_on(storage.add_api_key(
                    "survivor".to_string(),
                    "survivor-secret".to_string(),
                    None,
                    EncryptionConfig::default(),
                ))
                .expect("concurrent survivor API key add");
        },
        move |storage| {
            runtime()
                .block_on(storage.delete_api_key(doomed))
                .expect("concurrent API key delete");
        },
    );
    let keys = runtime()
        .block_on(storage.get_api_keys())
        .expect("read API keys after add/delete");
    assert!(keys.iter().any(|key| key.label == "left"));
    assert!(keys.iter().any(|key| key.label == "right"));
    assert!(keys.iter().any(|key| key.label == "survivor"));
    assert!(!keys.iter().any(|key| key.label == "doomed"));
}

#[test]
fn passkey_add_add_and_add_delete_are_serialized() {
    let (backend, storage, peer_storage) = fake_storage_pair();
    run_concurrently(
        &backend,
        "passkeys:account",
        storage.clone(),
        peer_storage.clone(),
        |storage| {
            runtime()
                .block_on(storage.store_passkey("account", json!({"id":"left"})))
                .expect("left passkey add");
        },
        |storage| {
            runtime()
                .block_on(storage.store_passkey("account", json!({"id":"right"})))
                .expect("right passkey add");
        },
    );
    let passkeys = runtime()
        .block_on(storage.get_passkeys("account"))
        .expect("read concurrent passkeys");
    assert!(passkeys.len() == 2);

    runtime()
        .block_on(storage.store_passkey("account", json!({"id":"doomed"})))
        .expect("seed doomed passkey");
    run_concurrently(
        &backend,
        "passkeys:account",
        storage.clone(),
        peer_storage,
        |storage| {
            runtime()
                .block_on(storage.store_passkey("account", json!({"id":"survivor"})))
                .expect("concurrent survivor passkey add");
        },
        |storage| {
            runtime()
                .block_on(storage.delete_passkey("account", "doomed"))
                .expect("concurrent passkey delete");
        },
    );
    let passkeys = runtime()
        .block_on(storage.get_passkeys("account"))
        .expect("read passkeys after add/delete");
    assert!(passkeys
        .iter()
        .any(|value| value["id"].as_str() == Some("left")));
    assert!(passkeys
        .iter()
        .any(|value| value["id"].as_str() == Some("right")));
    assert!(passkeys
        .iter()
        .any(|value| value["id"].as_str() == Some("survivor")));
    assert!(!passkeys
        .iter()
        .any(|value| value["id"].as_str() == Some("doomed")));
}

#[test]
fn registrar_add_add_and_add_delete_are_serialized() {
    let (backend, storage, peer_storage) = fake_storage_pair();
    run_concurrently(
        &backend,
        "registrar_credentials",
        storage.clone(),
        peer_storage.clone(),
        |storage| {
            runtime()
                .block_on(storage.store_registrar_credential(&json!({
                    "id": "left",
                    "token": "left-secret"
                })))
                .expect("left registrar add");
        },
        |storage| {
            runtime()
                .block_on(storage.store_registrar_credential(&json!({
                    "id": "right",
                    "token": "right-secret"
                })))
                .expect("right registrar add");
        },
    );
    let credentials: Vec<Value> = runtime()
        .block_on(storage.get_registrar_credentials())
        .expect("read concurrent registrar credentials");
    assert!(credentials.len() == 2);

    runtime()
        .block_on(storage.store_registrar_credential(&json!({
            "id": "doomed",
            "token": "doomed-secret"
        })))
        .expect("seed doomed registrar credential");
    run_concurrently(
        &backend,
        "registrar_credentials",
        storage.clone(),
        peer_storage,
        |storage| {
            runtime()
                .block_on(storage.store_registrar_credential(&json!({
                    "id": "survivor",
                    "token": "survivor-secret"
                })))
                .expect("concurrent survivor registrar add");
        },
        |storage| {
            runtime()
                .block_on(storage.delete_registrar_credential("doomed"))
                .expect("concurrent registrar delete");
        },
    );
    let credentials: Vec<Value> = runtime()
        .block_on(storage.get_registrar_credentials())
        .expect("read registrar credentials after add/delete");
    for expected_id in ["left", "right", "survivor"] {
        assert!(
            credentials
                .iter()
                .any(|value| value["id"].as_str() == Some(expected_id)),
            "unrelated registrar credential was lost"
        );
    }
    assert!(!credentials
        .iter()
        .any(|value| value["id"].as_str() == Some("doomed")));
}

#[test]
fn audit_add_add_uses_the_same_serialized_collection_primitive() {
    let (backend, storage, peer_storage) = fake_storage_pair();
    run_concurrently(
        &backend,
        "audit_log",
        storage.clone(),
        peer_storage,
        |storage| {
            runtime()
                .block_on(storage.add_audit_entry(json!({"event":"left"})))
                .expect("left audit add");
        },
        |storage| {
            runtime()
                .block_on(storage.add_audit_entry(json!({"event":"right"})))
                .expect("right audit add");
        },
    );
    let entries = runtime()
        .block_on(storage.get_audit_entries())
        .expect("read concurrent audit entries");
    assert!(entries.len() == 2);
    assert!(entries
        .iter()
        .any(|value| value["event"].as_str() == Some("left")));
    assert!(entries
        .iter()
        .any(|value| value["event"].as_str() == Some("right")));
}

#[tokio::test]
async fn existing_models_and_bounded_audit_behavior_still_roundtrip() {
    let storage = Storage::new(false);
    let config = EncryptionConfig {
        iterations: 42,
        key_length: 16,
        algorithm: "AES-256-GCM".to_string(),
    };
    storage
        .set_encryption_settings(&config)
        .await
        .expect("set encryption settings");
    let loaded = storage
        .get_encryption_settings()
        .await
        .expect("get encryption settings");
    assert!(loaded.iterations == 42);

    let mut preferences = Preferences::default();
    preferences.vault_enabled = Some(true);
    preferences.auto_refresh_interval = Some(60_000);
    storage
        .set_preferences(&preferences)
        .await
        .expect("set preferences");
    let loaded = storage.get_preferences().await.expect("get preferences");
    assert!(loaded.vault_enabled == Some(true));
    assert!(loaded.auto_refresh_interval == Some(60_000));

    for idx in 0..1005 {
        storage
            .add_audit_entry(json!({"idx": idx}))
            .await
            .expect("add bounded audit entry");
    }
    let entries = storage.get_audit_entries().await.expect("get audit log");
    assert!(entries.len() == MAX_AUDIT_ENTRIES);
    assert!(entries[0]["idx"].as_u64() == Some(5));
}
