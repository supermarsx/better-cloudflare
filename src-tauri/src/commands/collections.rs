//! Key collections: the nine commands the settings panel drives.
//!
//! The renderer's half of this is `src/lib/collections/types.ts`, and **that
//! file is the contract**: every shape returned here is one of its types,
//! spelled the way it spells them. Read its header before this one, and
//! `bc_collections`'s after it. The four decisions they state — a key keeps
//! its own per-key envelope as well as being in a collection, membership is
//! exclusive, adding a key is inherently a two-passphrase operation, and the
//! KDF parameters travel in cleartext — are the ones this module carries out.
//!
//! # Where each half lives
//!
//! `bc_collections` holds the model and the crypto: the record, the envelope,
//! the membership invariants and the bounds. It has **no Tauri dependency and
//! persists nothing**. This module is the other half: it owns the store, the
//! session unlock state, the key secret that gets sealed, the audit trail and
//! the mapping from a crate error to a wire outcome. The same division as
//! `bc_sync` and `commands::sync`, for the same reason — a crate that cannot
//! reach a keyring can be tested exhaustively without one.
//!
//! It therefore raises the two codes the crate never constructs.
//! [`CollectionError::NotFound`] is a question about the store, and
//! [`CollectionError::KeyLocked`] is a question about the keyring and the OS
//! vault; both are answered here.
//!
//! # One store, and membership is derived from it
//!
//! Everything is in one logical secret, [`COLLECTIONS_KEY`], holding a list of
//! [`SealedCollection`] — which is the record **and** its envelope as one
//! value. That is not a convenience: the crate's header asks the command layer
//! to write both halves in one operation, because a record claiming 600,000
//! iterations beside an envelope sealed at 100,000 describes an envelope it
//! cannot open and the keys in it are gone with no error to read. Every write
//! here goes through [`Storage::mutate_typed_list`], which takes the logical
//! lock for the whole read-modify-write, so one value moves at a time and two
//! windows cannot clobber each other.
//!
//! **A key's membership is read off the records, not off the key.** The
//! contract says `collectionId` on the `ApiKey` record is the single source of
//! truth, and `bc_storage::ApiKey` has no such field. Adding one was
//! considered and is the worse design, not merely the more expensive one:
//! `member_ids` is rebuilt from what was actually sealed on every re-seal, so
//! it cannot drift from the envelope it describes, while a second copy on the
//! key record is a copy that can — and `commands::sync` replaces the whole key
//! list wholesale on a pull, which would silently drop a field it does not
//! carry. So [`holder_of`] answers "which collection is this key in" by
//! scanning the records, and `unassignedKeyIds` is the stored key list minus
//! every member. There is exactly one place membership is written, and it is
//! the envelope.
//!
//! # Secrets
//!
//! Nothing here holds a secret in a struct. The collection passphrase, the
//! key's own password and the key's decrypted secret are `Zeroizing<String>`
//! locals, and [`CollectionVault`] holds its session passphrases the same way
//! behind a hand-written `Debug`. The audit trail records the operation, the
//! collection id, the key id and the refusal code — never a passphrase, a key
//! derived from one, a member secret or a label.
//!
//! # PBKDF2 runs off the command's own task
//!
//! Every derivation goes through [`off_task`], the way `commands::auth`'s
//! `run_crypto_job` and `commands::sync`'s `seal_off_task` do: at this build's
//! iteration count one derivation is a few hundred milliseconds, and the
//! runtime serving the rest of the UI should not spend them. The consequence
//! for the store is that the expensive part happens **outside** the logical
//! lock, so a value read before a seal may have moved by the time the seal
//! finishes — which is what [`commit`] guards against.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, Utc};
use tauri::State;
use zeroize::Zeroizing;

use bc_collections::{
    labels_excluding, validate_label, CollectionError, CollectionMember, CollectionOutcome,
    CollectionRecord, CollectionVault, CollectionsOverview, SealedCollection,
};
use bc_crypto::CryptoError;
use bc_storage::{AuditOutcome, StorageError};

use crate::commands::trail::user_action;
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::storage::Storage;

// ── Bounds ──────────────────────────────────────────────────────────────────

/// The one logical secret the collections live in.
///
/// Its own key rather than a field of the preferences: the preference file is
/// a 1 MB JSON document the whole application writes, and a collection
/// envelope is up to 87 KiB of base64 that would compete with it for room. The
/// retained-record store is separated from the preferences for the same
/// reason — see `bc_storage`'s `RETAINED_RECORDS_KEY`.
const COLLECTIONS_KEY: &str = "collections_list";

/// The most collections one device may hold.
///
/// Bounded by the store rather than by taste. One logical secret is capped at
/// `bc_storage`'s 2 MB `MAX_SECRET_BYTES`, and one collection at the crate's
/// 64 KiB plaintext is an envelope of about 88 KiB once it is base64 — so
/// sixteen of them at the absolute worst case is 1.4 MB and still leaves room
/// for the records and the list's own framing. Checked before the write so the
/// refusal names the limit, instead of arriving as `LimitExceeded` from the
/// keyring: that failure is not about collections at all and the screen would
/// have nothing to say about it.
///
/// It is reported as `backend-error` with this message rather than as
/// `too-large`, which the contract defines as the member cap and the envelope
/// cap. A third meaning for that code would make it unactionable — the screen
/// words it as "this collection cannot take another key", which is not what
/// has happened here.
const MAX_COLLECTIONS: usize = 16;

// ── Session state ───────────────────────────────────────────────────────────

/// The collections unlocked in this session, as managed state.
///
/// A handle rather than the vault itself, because every operation that needs
/// the held passphrase also runs a key derivation, and that derivation belongs
/// off the runtime's threads. [`off_task`] takes an `Arc` clone and locks it on
/// a blocking thread, which is also why this is a `std` mutex and not a
/// `tokio` one: the lock is never held across an `await`.
///
/// `CollectionVault` is deliberately not `Clone` — a second copy of the map is
/// a second copy of every passphrase in it, and one of them would be locked
/// while the other was not. That is preserved here: cloning this hands out
/// another reference to the same vault, never another vault.
#[derive(Clone, Default)]
pub struct CollectionVaultState(Arc<Mutex<CollectionVault>>);

impl CollectionVaultState {
    /// A handle to the one vault, for moving onto a blocking thread.
    fn handle(&self) -> Arc<Mutex<CollectionVault>> {
        Arc::clone(&self.0)
    }
}

impl std::fmt::Debug for CollectionVaultState {
    /// Delegated to the vault's own hand-written `Debug`, which prints the
    /// number of held passphrases and none of them. Derived here would print
    /// the same thing, but only for as long as nobody adds a field.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_tuple("CollectionVaultState")
            .field(&*held(&self.0))
            .finish()
    }
}

/// Take the vault, ignoring a poisoned lock.
///
/// The same call `bc_storage` makes about its logical locks, and for the same
/// reason: nothing here leaves the vault half-updated, because the map is only
/// ever inserted into or removed from, so a panic elsewhere must not make
/// every later collection operation fail for the life of the process.
fn held(vault: &Mutex<CollectionVault>) -> MutexGuard<'_, CollectionVault> {
    vault.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── Failures ────────────────────────────────────────────────────────────────

/// Why a command could not finish.
///
/// The split is the whole error handling of this module, and it is
/// `commands::sync`'s. `Refused` is an operation that did not happen for a
/// reason the user can act on, and it reaches the renderer as a `failed`
/// [`CollectionOutcome`] carrying a `CollectionFailureCode`. `Broken` is this
/// application failing at something that is not about collections — an
/// unreadable keyring, an unwritable store — and it reaches the renderer as a
/// rejected promise. The hook keeps the two apart deliberately: a refusal is
/// the backend answering and the panel words it, a rejection is a broken host
/// and goes to its own alert.
#[derive(Debug)]
enum Failure {
    Refused(CollectionError),
    Broken(String),
}

impl From<CollectionError> for Failure {
    fn from(error: CollectionError) -> Self {
        Self::Refused(error)
    }
}

impl From<StorageError> for Failure {
    fn from(error: StorageError) -> Self {
        Self::Broken(error.to_string())
    }
}

impl Failure {
    /// The refusal code this failure reaches the renderer as, if it has one.
    ///
    /// `None` for `Broken`, which is not a refusal and has no code — see
    /// [`record`], which leaves the detail off rather than inventing one.
    fn code(&self) -> Option<&'static str> {
        match self {
            Self::Refused(error) => Some(error.code()),
            Self::Broken(_) => None,
        }
    }
}

/// Hand an operation's result to the renderer.
///
/// Every one of the eight operations answers a `CollectionOutcome`, so the
/// inner bodies return `Result<(), Failure>` and the outcome is built here.
/// That is what makes "a refusal always carries a code" structural rather than
/// a habit: there is no path by which an operation returns an empty success
/// that a client could mistake for a refusal, and no path by which a refusal
/// arrives without `CollectionError::code` having named it.
fn settle(result: Result<(), Failure>) -> Result<CollectionOutcome, String> {
    match result {
        Ok(()) => Ok(CollectionOutcome::Ok),
        Err(Failure::Refused(error)) => Ok(CollectionOutcome::from(&error)),
        Err(Failure::Broken(message)) => Err(message),
    }
}

/// Run a key derivation off the command's own task.
///
/// No concurrency cap, unlike `commands::auth`'s `run_crypto_job`: the panel
/// disables itself while an operation is in flight, and refusing a second one
/// with "encryption is busy" would refuse a collection operation for a reason
/// that has nothing to do with collections. What does serialise them is the
/// store's own logical lock, at the moment of the write.
async fn off_task<T, Job>(job: Job) -> Result<T, Failure>
where
    Job: FnOnce() -> Result<T, CollectionError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| Failure::Broken(format!("the encryption worker failed: {error}")))?
        .map_err(Failure::Refused)
}

// ── The store ───────────────────────────────────────────────────────────────

/// Every stored collection, record and envelope together.
async fn stored(storage: &Storage) -> Result<Vec<SealedCollection>, Failure> {
    Ok(storage.get_typed_list(COLLECTIONS_KEY).await?)
}

/// The collection with this id, or `not-found`.
///
/// The code the crate never constructs, raised at the only layer that can:
/// whether a collection exists is a question about a store the crate cannot
/// reach.
fn find(stored: &[SealedCollection], id: &str) -> Result<SealedCollection, CollectionError> {
    stored
        .iter()
        .find(|sealed| sealed.record.id == id)
        .cloned()
        .ok_or(CollectionError::NotFound)
}

/// The cleartext halves, which is all the renderer ever sees of a collection.
fn records(stored: &[SealedCollection]) -> Vec<CollectionRecord> {
    stored.iter().map(|sealed| sealed.record.clone()).collect()
}

/// Which collection holds this key, according to the store.
///
/// The `current_collection` argument [`SealedCollection::add_member`] requires.
/// It is read off `member_ids` because that index is rebuilt from what was
/// sealed on every re-seal — see the module header on why there is no second
/// copy of it on the key record. Any `Some` is an `already-member` refusal,
/// this collection's own id included, and that call belongs to the crate: the
/// decision is made once, where membership exclusivity is documented.
fn holder_of(stored: &[SealedCollection], key_id: &str) -> Option<String> {
    stored
        .iter()
        .find(|sealed| sealed.record.member_ids.iter().any(|id| id == key_id))
        .map(|sealed| sealed.record.id.clone())
}

/// The parameters this build seals with.
///
/// The user's own encryption setting, not a constant: they can benchmark and
/// raise it, and `add_api_key` and `commands::sync` already honour the same
/// setting. This is exactly why `CollectionRecord` carries the parameters — a
/// collection sealed at 600,000 iterations has to stay openable after the
/// setting changes, and the crate reads them back off the record to open it.
async fn seal_config(storage: &Storage) -> Result<EncryptionConfig, Failure> {
    let config = match storage.get_encryption_settings().await {
        Ok(config) => config,
        Err(StorageError::NotFound) => CryptoManager::default().get_config(),
        Err(error) => return Err(Failure::Broken(error.to_string())),
    };
    config
        .validated_for_encryption()
        .map_err(|error| Failure::Broken(error.to_string()))
}

/// Write a re-sealed collection back, refusing if it moved while we sealed.
///
/// The derivation runs outside the logical lock — see the module header — so
/// between reading `before` and writing `after` another window may have
/// re-sealed, renamed or deleted this collection. Writing anyway would revert
/// whatever it did, silently, and for a membership change that means a member
/// secret coming back after it was removed.
///
/// So the comparison is against the **whole** stored value rather than against
/// its envelope: a concurrent rename changes only the record, and `after`
/// carries the label as it was before, so an envelope-only guard would let the
/// rename be undone. One check over both halves, which is also why there is
/// not a second one on the record: two checks on one claim means a mutation to
/// either is caught by the other and neither is proven.
///
/// A refusal here is `backend-error` with this message. There is no contract
/// code for "it moved", and the user's action is the same either way: look at
/// the screen as it is now and try again.
async fn commit(
    storage: &Storage,
    before: SealedCollection,
    after: SealedCollection,
) -> Result<(), Failure> {
    let outcome: Result<(), CollectionError> = storage
        .mutate_typed_list(
            COLLECTIONS_KEY,
            true,
            move |stored: &mut Vec<SealedCollection>| {
                let Some(slot) = stored
                    .iter_mut()
                    .find(|sealed| sealed.record.id == after.record.id)
                else {
                    return Ok(Err(CollectionError::NotFound));
                };
                if *slot != before {
                    return Ok(Err(CollectionError::Backend(
                        "the collection changed while this operation was sealing, so nothing was written"
                            .to_string(),
                    )));
                }
                *slot = after;
                Ok(Ok(()))
            },
        )
        .await?;
    Ok(outcome?)
}

// ── The key's own secret ────────────────────────────────────────────────────

/// Read the secret a collection is being asked to seal.
///
/// The two-passphrase constraint from the contract header, as code. A
/// collection cannot wrap a secret it cannot read, so the key has to be
/// openable at this moment — by its own password, or through the OS vault,
/// which holds the already-decrypted key for someone who turned that on.
///
/// **A missing password means "try the vault", never "the password is
/// empty".** The renderer omits the field rather than sending `""` for exactly
/// this reason, and an empty string is treated the same way here: `bc_crypto`
/// refuses to seal anything under an empty password, so no key on this device
/// can have one, and trying it would fail to open a key the vault could have
/// supplied and then report `key-locked` for a key that was never locked.
///
/// A supplied password that does not open the key is **not** retried against
/// the vault. The user typed something and it was wrong; silently opening the
/// key another way would report success for a password they should be told
/// about.
async fn key_secret(
    storage: &Storage,
    key_id: &str,
    key_password: Option<String>,
) -> Result<Zeroizing<String>, Failure> {
    let key = match storage.get_api_key(key_id).await {
        Ok(key) => key,
        // Not `not-found`, which the contract defines as "no collection with
        // that id" and the screen words as "another window may have deleted
        // it" — about the collection. And not `key-locked`, whose sentence
        // sends the user to type the key's password, which cannot help for a
        // key that is gone.
        Err(StorageError::NotFound) => {
            return Err(Failure::Refused(CollectionError::Backend(
                "no API key with that id is stored on this device".to_string(),
            )))
        }
        Err(error) => return Err(Failure::Broken(error.to_string())),
    };

    match key_password.filter(|password| !password.is_empty()) {
        Some(password) => {
            let config = EncryptionConfig {
                iterations: key.iterations,
                key_length: key.key_length,
                algorithm: key.algorithm.clone(),
            };
            let ciphertext = key.encrypted_key.clone();
            let password = Zeroizing::new(password);
            off_task(move || open_key(&ciphertext, config, &password)).await
        }
        None => match storage.get_vault_secret(key_id).await {
            Ok(secret) if !secret.is_empty() => Ok(Zeroizing::new(secret)),
            // A blank vault entry counts as absent, the way every other
            // secret in this application is read: it cannot open anything, so
            // reporting it as present would be a success that seals nothing.
            Ok(_) | Err(StorageError::NotFound) => {
                Err(Failure::Refused(CollectionError::KeyLocked))
            }
            Err(error) => Err(Failure::Broken(error.to_string())),
        },
    }
}

/// Open one API key's own envelope.
///
/// `CryptoManager::new`, not `new_for_encryption`: a key sealed by an older
/// build at a lower iteration count must still open, or the secret this
/// collection wants is unreachable. The parameters come from the key's own
/// record for the same reason the crate reads a collection's off its record.
///
/// A failed decrypt is `key-locked` rather than `wrong-passphrase`. AES-GCM
/// cannot tell a wrong key from altered bytes, and both of this module's
/// candidates are honest about that — but `wrong-passphrase` is worded on
/// screen as "that passphrase did not open this **collection**", which is a
/// sentence about the wrong secret entirely. `key-locked` says the key could
/// not be opened and that the password for it "was wrong or missing", which is
/// true whether the password was absent, wrong, or right for a different key.
///
/// That quotation was "its own password is what is needed here" until the
/// fr-FR translator pointed out it reads as *absent* while this code raises
/// the same variant for a *wrong* password too — see `key_secret`'s two
/// branches. The string moved; this comment had argued for the old one, which
/// is a comment justifying wording the code has moved past. Caught by the
/// de-DE translator tracing both branches to check the reword was right.
fn open_key(
    ciphertext: &str,
    config: EncryptionConfig,
    password: &str,
) -> Result<Zeroizing<String>, CollectionError> {
    let crypto =
        CryptoManager::new(config).map_err(|error| CollectionError::Backend(error.to_string()))?;
    crypto
        .decrypt(ciphertext, password)
        .map(Zeroizing::new)
        .map_err(|error| match error {
            CryptoError::DecryptionFailed(_) | CryptoError::InvalidFormat => {
                CollectionError::KeyLocked
            }
            other => CollectionError::Backend(other.to_string()),
        })
}

// ── The audit trail ─────────────────────────────────────────────────────────

const OP_CREATE: &str = "collection:create";
const OP_RENAME: &str = "collection:rename";
const OP_DELETE: &str = "collection:delete";
const OP_UNLOCK: &str = "collection:unlock";
const OP_LOCK: &str = "collection:lock";
const OP_ADD_KEY: &str = "collection:add_key";
const OP_REMOVE_KEY: &str = "collection:remove_key";
const OP_ROTATE: &str = "collection:rotate";

/// Record what one operation did, and nothing about what was typed.
///
/// Through [`bc_storage::AuditEntry`] rather than the untyped `log_audit`
/// path, because two of the fields are caller-supplied: a collection id and a
/// key id arrive over IPC and nothing bounds them there. `AuditEntry` bounds
/// every text field, and that matters more than it looks — the whole log is one
/// stored secret with a hard ceiling, a write over it fails, and the trail
/// swallows its write errors, so one unbounded entry does not make one big
/// record, it stops the log recording anything ever again.
///
/// What an entry carries is the operation, the collection, the key where there
/// is one, and the refusal code. What it never carries is a passphrase, a key
/// derived from one, a member secret, or the collection's label — the label is the
/// one piece of user text here and it is already in the record the screen
/// shows, so the trail gains nothing by holding a copy.
///
/// `Denied` for a refusal and `Failed` for a broken store, which is the
/// vocabulary's own distinction: a refusal is this application declining
/// before anything was dispatched, and a failed keyring write is it trying and
/// breaking.
///
/// Every operation below writes its entry from inside the body that does the
/// work, rather than from the `#[tauri::command]` wrapper around it. That is
/// deliberate and it is what makes the trail testable: the wrappers exist only
/// to unwrap managed state and read the clock, and a command whose audit entry
/// lived up there would be an audit entry no test could reach.
fn record(
    storage: &Storage,
    operation: &str,
    collection: &str,
    key: Option<&str>,
    result: &Result<(), Failure>,
) {
    use bc_storage::AuditTrail;

    let outcome = match result {
        Ok(()) => AuditOutcome::Succeeded,
        Err(Failure::Refused(_)) => AuditOutcome::Denied,
        Err(Failure::Broken(_)) => AuditOutcome::Failed,
    };
    storage.record(
        user_action(operation, outcome)
            .resource(collection)
            .optional_detail("key", key.map(str::to_string))
            .optional_detail("code", result.as_ref().err().and_then(Failure::code)),
    );
}

// ── list_collections ────────────────────────────────────────────────────────

/// Everything the settings panel needs to render the list.
///
/// **Nothing has to be unlocked for this to answer.** It reports
/// `unlocked: false` for every collection whose passphrase the vault is not
/// holding, which after a relaunch is all of them, and the renderer treats a
/// missing entry as locked for the same reason. A read that refused because
/// nothing was open would leave the screen unable to offer the unlock that
/// would fix it.
#[tauri::command]
pub async fn list_collections(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
) -> Result<CollectionsOverview, String> {
    match overview(&storage, &vault.handle()).await {
        Ok(overview) => Ok(overview),
        Err(Failure::Refused(error)) => Err(error.to_string()),
        Err(Failure::Broken(message)) => Err(message),
    }
}

async fn overview(
    storage: &Storage,
    vault: &Arc<Mutex<CollectionVault>>,
) -> Result<CollectionsOverview, Failure> {
    let stored = stored(storage).await?;
    let collections = records(&stored);
    let statuses = held(vault).statuses(&collections);

    // The unassigned list is the stored keys minus every member, which is the
    // one place the derived membership index is read in bulk. A key the panel
    // can see and no collection claims is a key that still opens the way it
    // always has.
    let members: HashSet<&str> = stored
        .iter()
        .flat_map(|sealed| sealed.record.member_ids.iter().map(String::as_str))
        .collect();
    let unassigned_key_ids = storage
        .get_api_keys()
        .await?
        .into_iter()
        .filter(|key| !members.contains(key.id.as_str()))
        .map(|key| key.id)
        .collect();

    Ok(CollectionsOverview {
        collections,
        statuses,
        unassigned_key_ids,
    })
}

// ── create_collection ───────────────────────────────────────────────────────

/// Seal a new, empty collection under `passphrase`.
///
/// The new collection is **locked**. The passphrase was just typed, so holding
/// it would cost nothing in exposure and save a second prompt — but the vault
/// only accepts a passphrase it has verified against an envelope, which is
/// another derivation, and "unlocked" on screen has to trace back to a status
/// the backend reported rather than to an assumption made at creation. The
/// panel offers the unlock, which is the next thing the user wants anyway.
#[tauri::command]
pub async fn create_collection(
    storage: State<'_, Storage>,
    label: String,
    passphrase: String,
) -> Result<CollectionOutcome, String> {
    let id = format!("col_{}", uuid::Uuid::new_v4());
    settle(create_with(&storage, &id, &label, passphrase, Utc::now()).await)
}

async fn create_with(
    storage: &Storage,
    id: &str,
    label: &str,
    passphrase: String,
    now: DateTime<Utc>,
) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let config = seal_config(storage).await?;
        let passphrase = Zeroizing::new(passphrase);

        // Sealed with **no** other labels, because the duplicate check is
        // made inside the transaction below, against the list as it stands at
        // the moment of the write. Handing `create` the labels read a
        // derivation ago would be a second check of a claim already settled,
        // and two checks on one claim means a mutation to either is caught by
        // the other and neither is proven. What `create` still validates here
        // is the label itself — emptiness and length — which no concurrent
        // write can change.
        let owned_label = label.to_string();
        let owned_id = id.to_string();
        let sealed = off_task(move || {
            SealedCollection::create(owned_id, &owned_label, &passphrase, &[], config, now)
        })
        .await?;

        let outcome: Result<(), CollectionError> = storage
            .mutate_typed_list(
                COLLECTIONS_KEY,
                true,
                move |stored: &mut Vec<SealedCollection>| {
                    if stored.len() >= MAX_COLLECTIONS {
                        return Ok(Err(CollectionError::Backend(format!(
                            "this device already holds the maximum of {MAX_COLLECTIONS} collections"
                        ))));
                    }
                    // `validate_label` against the labels that are actually
                    // there, with the already-trimmed form `create` stored.
                    // The crate's check, made at the only moment it can be
                    // authoritative.
                    let labels = stored
                        .iter()
                        .map(|existing| existing.record.label.clone())
                        .collect::<Vec<_>>();
                    if let Err(error) = validate_label(&sealed.record.label, &labels) {
                        return Ok(Err(error));
                    }
                    stored.push(sealed);
                    Ok(Ok(()))
                },
            )
            .await?;
        Ok(outcome?)
    }
    .await;
    record(storage, OP_CREATE, id, None, &result);
    result
}

// ── rename_collection ───────────────────────────────────────────────────────

/// Change the cleartext label. The envelope is not touched.
///
/// No unlock and no derivation: a label is not sealed. The whole operation
/// therefore happens inside the transaction, where the duplicate check is
/// authoritative.
#[tauri::command]
pub async fn rename_collection(
    storage: State<'_, Storage>,
    id: String,
    label: String,
) -> Result<CollectionOutcome, String> {
    settle(rename_with(&storage, &id, label).await)
}

async fn rename_with(storage: &Storage, id: &str, label: String) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let owned_id = id.to_string();
        let outcome: Result<(), CollectionError> = storage
            .mutate_typed_list(
                COLLECTIONS_KEY,
                true,
                move |stored: &mut Vec<SealedCollection>| {
                    let current = match find(stored, &owned_id) {
                        Ok(current) => current,
                        Err(error) => return Ok(Err(error)),
                    };
                    // `labels_excluding`, never a hand-built list: renaming a
                    // collection to the label it already has must not be
                    // reported as a duplicate of itself.
                    let others = labels_excluding(&records(stored), &owned_id);
                    let renamed = match current.rename(&label, &others) {
                        Ok(renamed) => renamed,
                        Err(error) => return Ok(Err(error)),
                    };
                    if let Some(slot) = stored
                        .iter_mut()
                        .find(|sealed| sealed.record.id == owned_id)
                    {
                        slot.record = renamed;
                    }
                    Ok(Ok(()))
                },
            )
            .await?;
        Ok(outcome?)
    }
    .await;
    record(storage, OP_RENAME, id, None, &result);
    result
}

// ── delete_collection ───────────────────────────────────────────────────────

/// Destroy the envelope and with it every membership it recorded.
///
/// **No key is lost**, because every key still has its own envelope under its
/// own password — that is what the contract header's recoverability argument
/// buys, and it is why this needs no passphrase and no unlock. The members
/// return to the unassigned list, which needs no second write: membership is
/// the records, so removing the record is removing the membership.
///
/// The held passphrase is dropped too. A vault entry for a collection that no
/// longer exists is a secret kept for nothing.
#[tauri::command]
pub async fn delete_collection(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
    id: String,
) -> Result<CollectionOutcome, String> {
    settle(delete_with(&storage, &vault.handle(), &id).await)
}

async fn delete_with(
    storage: &Storage,
    vault: &Arc<Mutex<CollectionVault>>,
    id: &str,
) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let owned_id = id.to_string();
        let outcome: Result<(), CollectionError> = storage
            .mutate_typed_list(
                COLLECTIONS_KEY,
                true,
                move |stored: &mut Vec<SealedCollection>| {
                    let before = stored.len();
                    stored.retain(|sealed| sealed.record.id != owned_id);
                    if stored.len() == before {
                        return Ok(Err(CollectionError::NotFound));
                    }
                    Ok(Ok(()))
                },
            )
            .await?;
        outcome?;
        held(vault).lock(id);
        Ok(())
    }
    .await;
    record(storage, OP_DELETE, id, None, &result);
    result
}

// ── unlock_collection ───────────────────────────────────────────────────────

/// Verify the passphrase and hold it for the session.
///
/// Held in memory only: never written to disk, never put in the OS vault, and
/// gone on restart. The vault opens the envelope before it stores anything, so
/// "held" and "opens this collection" are the same thing and every later
/// operation can use the held value without re-checking it.
#[tauri::command]
pub async fn unlock_collection(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
    id: String,
    passphrase: String,
) -> Result<CollectionOutcome, String> {
    settle(unlock_with(&storage, &vault.handle(), &id, passphrase).await)
}

async fn unlock_with(
    storage: &Storage,
    vault: &Arc<Mutex<CollectionVault>>,
    id: &str,
    passphrase: String,
) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let sealed = find(&stored(storage).await?, id)?;
        let passphrase = Zeroizing::new(passphrase);
        let handle = Arc::clone(vault);
        // The vault's own `unlock` runs the derivation, so the whole call goes
        // onto a blocking thread with the lock. Verifying first and then
        // calling it would derive twice, and there is no way to put an
        // already-verified passphrase into the vault — which is the right
        // restriction: it is what makes "this vault holds a passphrase that
        // does not open its collection" unconstructible.
        off_task(move || held(&handle).unlock(&sealed, &passphrase)).await
    }
    .await;
    record(storage, OP_UNLOCK, id, None, &result);
    result
}

// ── lock_collection ─────────────────────────────────────────────────────────

/// Drop the held passphrase. Always succeeds.
///
/// Including for a collection that was not unlocked and one that does not
/// exist: there is nothing to refuse, since dropping a key from memory
/// succeeds whether or not the key was there. So this returns unit, which
/// reaches the renderer as `null`, and the contract states that a client must
/// read an empty answer here as success. That is safe to rely on **because
/// every other command's refusal carries a code** — a `CollectionFailure`
/// without one is not representable, so an empty answer cannot be a refusal
/// wearing a disguise.
///
/// The `Result` is Tauri's requirement rather than this command's: an async
/// command taking managed state by reference has to return one. The `Err` arm
/// is unreachable and nothing here can reach it, which is the whole claim —
/// `Ok(())` serialises as `null`, and that is the empty answer the contract
/// tells a client to read as success.
#[tauri::command]
pub async fn lock_collection(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
    id: String,
) -> Result<(), String> {
    lock_with(&storage, &vault.handle(), &id);
    Ok(())
}

fn lock_with(storage: &Storage, vault: &Arc<Mutex<CollectionVault>>, id: &str) {
    held(vault).lock(id);
    // Recorded as a success because it is one: there is no branch here that
    // can refuse, so the entry's outcome is a fact about the operation rather
    // than a result that was inspected.
    record(storage, OP_LOCK, id, None, &Ok(()));
}

// ── add_key_to_collection ───────────────────────────────────────────────────

/// Seal one key's secret into the collection.
///
/// Two secrets are in play. The collection must be unlocked, because its
/// plaintext has to be opened and written back out; and the key must be
/// openable, because a collection cannot wrap a secret it cannot read. The
/// contract calls a one-click add the most likely way to get this wrong.
///
/// The key's own `encrypted_key` is left exactly as it was. Both envelopes
/// exist afterwards and both decrypt to the same secret under two different
/// passphrases — see the contract header, which is where the cost of that
/// decision is stated: fully rotating access to a key means rotating its own
/// password **and** its collection's passphrase.
#[tauri::command]
pub async fn add_key_to_collection(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
    id: String,
    key_id: String,
    key_password: Option<String>,
) -> Result<CollectionOutcome, String> {
    settle(
        add_key_with(
            &storage,
            &vault.handle(),
            &id,
            &key_id,
            key_password,
            Utc::now(),
        )
        .await,
    )
}

async fn add_key_with(
    storage: &Storage,
    vault: &Arc<Mutex<CollectionVault>>,
    id: &str,
    key_id: &str,
    key_password: Option<String>,
    now: DateTime<Utc>,
) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let stored = stored(storage).await?;
        let sealed = find(&stored, id)?;
        let passphrase = Zeroizing::new(held(vault).passphrase(id)?.to_string());
        let config = seal_config(storage).await?;

        // The key's secret is read before the membership is checked, which
        // costs a derivation on a refusal: `add_member` is what decides
        // `already-member`, and it cannot be asked without the member to add.
        // Checking membership here first would be a second check of the
        // crate's claim, and that trade — a few hundred milliseconds on an
        // error path against a bound nobody can prove — is the wrong way
        // round.
        let secret = key_secret(storage, key_id, key_password).await?;
        let current = holder_of(&stored, key_id);
        let member = CollectionMember::new(key_id, secret.as_str());

        let before = sealed.clone();
        let after = off_task(move || {
            sealed.add_member(&passphrase, member, current.as_deref(), config, now)
        })
        .await?;
        commit(storage, before, after).await
    }
    .await;
    record(storage, OP_ADD_KEY, id, Some(key_id), &result);
    result
}

// ── remove_key_from_collection ──────────────────────────────────────────────

/// Take a key's secret out of the collection.
///
/// The key is not harmed: it still has its own envelope under its own
/// password. Needs the collection unlocked, because the remaining members are
/// written back out — the second of the two operations that re-seal.
///
/// A member id the key store no longer has is still removable this way, which
/// is the one thing that can be done about a key deleted while it was a member
/// (see the contract's closing section: that hole is open, and the envelope
/// keeps the secret until somebody takes it out).
#[tauri::command]
pub async fn remove_key_from_collection(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
    id: String,
    key_id: String,
) -> Result<CollectionOutcome, String> {
    settle(remove_key_with(&storage, &vault.handle(), &id, &key_id, Utc::now()).await)
}

async fn remove_key_with(
    storage: &Storage,
    vault: &Arc<Mutex<CollectionVault>>,
    id: &str,
    key_id: &str,
    now: DateTime<Utc>,
) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let sealed = find(&stored(storage).await?, id)?;
        let passphrase = Zeroizing::new(held(vault).passphrase(id)?.to_string());
        let config = seal_config(storage).await?;

        let before = sealed.clone();
        let owned_key = key_id.to_string();
        let after =
            off_task(move || sealed.remove_member(&passphrase, &owned_key, config, now)).await?;
        commit(storage, before, after).await
    }
    .await;
    record(storage, OP_REMOVE_KEY, id, Some(key_id), &result);
    result
}

// ── rotate_collection_passphrase ────────────────────────────────────────────

/// Re-seal the envelope under a new passphrase, proving the old one.
///
/// The current passphrase is an argument rather than read from the vault: an
/// unlocked collection in front of an unattended app must not have its
/// passphrase changed by someone who never knew it.
///
/// This rotates the collection only. Every member key's own password is
/// untouched and still opens that key, which the panel says in so many words —
/// a screen that reported "the passphrase was changed" alone would let someone
/// believe they had revoked an access they have not.
#[tauri::command]
pub async fn rotate_collection_passphrase(
    storage: State<'_, Storage>,
    vault: State<'_, CollectionVaultState>,
    id: String,
    current_passphrase: String,
    new_passphrase: String,
) -> Result<CollectionOutcome, String> {
    settle(
        rotate_with(
            &storage,
            &vault.handle(),
            &id,
            current_passphrase,
            new_passphrase,
            Utc::now(),
        )
        .await,
    )
}

async fn rotate_with(
    storage: &Storage,
    vault: &Arc<Mutex<CollectionVault>>,
    id: &str,
    current_passphrase: String,
    new_passphrase: String,
    now: DateTime<Utc>,
) -> Result<(), Failure> {
    let result: Result<(), Failure> = async {
        let sealed = find(&stored(storage).await?, id)?;
        let config = seal_config(storage).await?;
        let current = Zeroizing::new(current_passphrase);
        let new = Zeroizing::new(new_passphrase);

        let before = sealed.clone();
        let handle = Arc::clone(vault);
        // `CollectionVault::rotate`, not `SealedCollection::rotate`: a vault
        // left holding the old passphrase would keep reporting this collection
        // as unlocked while every operation using the held value failed as
        // `wrong-passphrase` — a lie on screen followed by an error naming the
        // wrong cause. A collection that was locked stays locked; a rotation
        // is not an unlock.
        let after =
            off_task(move || held(&handle).rotate(&sealed, &current, &new, config, now)).await?;

        // The vault moved with the rotation **before** this write, which is
        // the one ordering hazard in this module: a write that fails now would
        // leave the vault holding a passphrase the stored envelope does not
        // answer to. Dropping it is the honest repair — the collection reports
        // locked, which is true, and the old passphrase still opens the
        // envelope that is still there. Re-unlocking it here instead would
        // cost another derivation to restore a state the user can restore
        // themselves.
        match commit(storage, before, after).await {
            Ok(()) => Ok(()),
            Err(error) => {
                held(vault).lock(id);
                Err(error)
            }
        }
    }
    .await;
    record(storage, OP_ROTATE, id, None, &result);
    result
}

// ── Registration ────────────────────────────────────────────────────────────

/// The commands this feature adds, as `COLLECTION_COMMANDS` in
/// `src/lib/collections/types.ts` names them.
///
/// Read by `main`'s `every_collection_command_is_registered` and pinned
/// against the contract in both directions by the two tests below. An
/// unregistered command typechecks on both sides of the boundary and fails at
/// the moment a user reaches it, which has happened in this repository before.
///
/// `cfg(test)` like the other modules' lists: it exists to be asserted on, and
/// a production build that carried it would carry nine unread strings.
#[cfg(test)]
pub const COMMAND_NAMES: [&str; 9] = [
    "list_collections",
    "create_collection",
    "rename_collection",
    "delete_collection",
    "unlock_collection",
    "lock_collection",
    "add_key_to_collection",
    "remove_key_from_collection",
    "rotate_collection_passphrase",
];

#[cfg(test)]
mod tests {
    use super::*;

    use bc_collections::{CollectionFailure, MAX_COLLECTION_LABEL_LENGTH};
    use serde_json::Value;

    use crate::storage::ApiKey;

    /// The renderer's contract, read as text so the command names on this side
    /// cannot drift from it without a test failing.
    const CONTRACT: &str = include_str!("../../../src/lib/collections/types.ts");

    // ── Fixtures ────────────────────────────────────────────────────────

    /// One install: an in-memory keyring and a vault holding nothing.
    ///
    /// `Storage::new(false)` is process-local per instance, so two of these
    /// share nothing — which matters here because every test writes to the
    /// same logical key.
    ///
    /// The helpers apply [`settle`] the way the renderer receives it, so a
    /// refusal reads as the `failed` outcome it becomes on the wire rather
    /// than as an error. A `Broken` failure panics instead: nothing in these
    /// tests breaks the store, so one arriving is a bug in the module and not
    /// a case to assert on.
    struct Device {
        storage: Storage,
        vault: Arc<Mutex<CollectionVault>>,
    }

    impl Device {
        fn new() -> Self {
            Self {
                storage: Storage::new(false),
                vault: Arc::new(Mutex::new(CollectionVault::new())),
            }
        }

        /// Seal `secret` under `password` and store it as an API key.
        ///
        /// Through `add_api_key` and `bc_crypto`, not a literal: the whole
        /// point of `add_key_to_collection` is that it opens a real per-key
        /// envelope, and a fixture that stored a plaintext "ciphertext" would
        /// test a decrypt that never happened.
        async fn with_key(&self, label: &str, secret: &str, password: &str) -> String {
            let config = EncryptionConfig::default();
            let crypto = CryptoManager::new_for_encryption(config.clone())
                .expect("the default config must seal");
            let ciphertext = crypto.encrypt(secret, password).expect("seal a test key");
            self.storage
                .add_api_key(
                    label.to_string(),
                    ciphertext,
                    Some(format!("{label}@example.test")),
                    config,
                )
                .await
                .expect("seed a key")
        }

        /// Put a key's already-decrypted secret in the OS vault, which is the
        /// other route [`key_secret`] can take.
        async fn in_os_vault(&self, key_id: &str, secret: &str) {
            self.storage
                .store_vault_secret(key_id, secret)
                .await
                .expect("seed the OS vault");
        }

        async fn seal_at(&self, iterations: u32) {
            self.storage
                .set_encryption_settings(&EncryptionConfig {
                    iterations,
                    ..EncryptionConfig::default()
                })
                .await
                .expect("set this install's encryption parameters");
        }

        async fn create(&self, label: &str, passphrase: &str) -> CollectionOutcome {
            let id = format!("col_{}", uuid::Uuid::new_v4());
            settle(create_with(&self.storage, &id, label, passphrase.to_string(), at(0)).await)
                .expect("a create's refusals are outcomes, not errors")
        }

        /// A collection that exists, by its id.
        async fn holding(&self, label: &str, passphrase: &str) -> String {
            assert_eq!(
                self.create(label, passphrase).await,
                CollectionOutcome::Ok,
                "the fixture's own create must succeed"
            );
            self.id_of(label).await
        }

        async fn id_of(&self, label: &str) -> String {
            self.records()
                .await
                .into_iter()
                .find(|record| record.label == label)
                .map(|record| record.id)
                .unwrap_or_else(|| panic!("no collection labelled {label:?}"))
        }

        async fn overview(&self) -> CollectionsOverview {
            overview(&self.storage, &self.vault)
                .await
                .expect("the listing must answer")
        }

        async fn records(&self) -> Vec<CollectionRecord> {
            self.overview().await.collections
        }

        async fn record_of(&self, id: &str) -> CollectionRecord {
            self.records()
                .await
                .into_iter()
                .find(|record| record.id == id)
                .unwrap_or_else(|| panic!("no collection {id}"))
        }

        /// The stored value, both halves, as the store holds it.
        async fn sealed(&self, id: &str) -> SealedCollection {
            find(&stored(&self.storage).await.expect("read the store"), id)
                .expect("the collection must be stored")
        }

        async fn keys(&self) -> Vec<ApiKey> {
            self.storage.get_api_keys().await.expect("read the vault")
        }

        async fn unlock(&self, id: &str, passphrase: &str) -> CollectionOutcome {
            settle(unlock_with(&self.storage, &self.vault, id, passphrase.to_string()).await)
                .expect("an unlock's refusals are outcomes, not errors")
        }

        fn lock(&self, id: &str) {
            lock_with(&self.storage, &self.vault, id);
        }

        async fn rename(&self, id: &str, label: &str) -> CollectionOutcome {
            settle(rename_with(&self.storage, id, label.to_string()).await)
                .expect("a rename's refusals are outcomes, not errors")
        }

        async fn delete(&self, id: &str) -> CollectionOutcome {
            settle(delete_with(&self.storage, &self.vault, id).await)
                .expect("a delete's refusals are outcomes, not errors")
        }

        async fn add_key(
            &self,
            id: &str,
            key_id: &str,
            key_password: Option<&str>,
        ) -> CollectionOutcome {
            settle(
                add_key_with(
                    &self.storage,
                    &self.vault,
                    id,
                    key_id,
                    key_password.map(str::to_string),
                    at(1),
                )
                .await,
            )
            .expect("an add's refusals are outcomes, not errors")
        }

        async fn remove_key(&self, id: &str, key_id: &str) -> CollectionOutcome {
            settle(remove_key_with(&self.storage, &self.vault, id, key_id, at(1)).await)
                .expect("a remove's refusals are outcomes, not errors")
        }

        async fn rotate(&self, id: &str, current: &str, new: &str) -> CollectionOutcome {
            settle(
                rotate_with(
                    &self.storage,
                    &self.vault,
                    id,
                    current.to_string(),
                    new.to_string(),
                    at(1),
                )
                .await,
            )
            .expect("a rotation's refusals are outcomes, not errors")
        }

        fn unlocked(&self, id: &str) -> bool {
            held(&self.vault).is_unlocked(id)
        }

        async fn trail(&self) -> Vec<Value> {
            self.storage
                .get_audit_entries()
                .await
                .expect("read the audit trail")
        }
    }

    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T12:00:00+00:00")
            .expect("a fixed clock")
            .with_timezone(&Utc)
            + chrono::Duration::minutes(minutes)
    }

    fn failure_of(outcome: &CollectionOutcome) -> &CollectionFailure {
        match outcome {
            CollectionOutcome::Failed(failure) => failure,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn code_of(outcome: &CollectionOutcome) -> &str {
        &failure_of(outcome).code
    }

    /// The member secrets inside an envelope, which is the only way to check
    /// that a membership change actually changed what is sealed rather than
    /// only what the record says.
    fn members(sealed: &SealedCollection, passphrase: &str) -> Vec<(String, String)> {
        sealed
            .open(passphrase)
            .expect("the envelope must open")
            .members
            .iter()
            .map(|member| (member.id.clone(), member.secret.clone()))
            .collect()
    }

    fn opens(key: &ApiKey, password: &str) -> Option<String> {
        let config = EncryptionConfig {
            iterations: key.iterations,
            key_length: key.key_length,
            algorithm: key.algorithm.clone(),
        };
        CryptoManager::new(config)
            .expect("a stored key's parameters must be usable")
            .decrypt(&key.encrypted_key, password)
            .ok()
    }

    // ── The contract ────────────────────────────────────────────────────

    #[test]
    fn every_command_name_is_the_one_the_renderer_invokes() {
        for name in COMMAND_NAMES {
            assert!(
                CONTRACT.contains(&format!("\"{name}\"")),
                "{name} is not in COLLECTION_COMMANDS, so the renderer cannot reach it"
            );
        }
    }

    /// The other direction, which is the one that catches the real defect: a
    /// name in that table is a name something will eventually invoke, and
    /// invoking a command Tauri does not have fails at the moment a user
    /// clicks.
    #[test]
    fn the_contract_names_no_command_this_module_does_not_have() {
        let (_, after) = CONTRACT
            .split_once("COLLECTION_COMMANDS = {")
            .expect("the contract declares COLLECTION_COMMANDS");
        let (block, _) = after
            .split_once("} as const")
            .expect("COLLECTION_COMMANDS is a const object");
        let mut found = 0;
        for line in block.lines() {
            // Comment lines are skipped rather than read for a command name:
            // a doc comment above an entry may quote anything.
            let trimmed = line.trim_start();
            if trimmed.starts_with('*') || trimmed.starts_with("/*") || trimmed.starts_with("//") {
                continue;
            }
            let Some(name) = line.split('"').nth(1) else {
                continue;
            };
            found += 1;
            assert!(
                COMMAND_NAMES.contains(&name),
                "COLLECTION_COMMANDS names {name}, which this module does not register"
            );
        }
        assert_eq!(
            found,
            COMMAND_NAMES.len(),
            "the table and the module disagree about how many commands there are"
        );
    }

    /// Every failure code this module raises by name is one the contract has.
    ///
    /// `bc_collections` pins its own error type against that list. What this
    /// adds is the two codes the crate never constructs and this module does:
    /// a code invented here would reach the panel's exhaustive `switch` as a
    /// hyphenated identifier in English.
    #[test]
    fn the_codes_this_module_raises_are_in_the_contract() {
        for error in [
            CollectionError::NotFound,
            CollectionError::KeyLocked,
            CollectionError::Backend("anything".to_string()),
        ] {
            assert!(
                CONTRACT.contains(&format!("\"{}\"", error.code())),
                "{} is not a CollectionFailureCode",
                error.code()
            );
        }
    }

    // ── list_collections ────────────────────────────────────────────────

    /// The listing answers on a device where nothing has ever been created,
    /// and every stored key is unassigned.
    #[tokio::test]
    async fn a_fresh_install_lists_nothing_and_claims_every_key() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;

        let overview = device.overview().await;
        assert!(overview.collections.is_empty());
        assert!(overview.statuses.is_empty());
        assert_eq!(overview.unassigned_key_ids, vec![key]);
    }

    /// The claim the brief calls the likeliest thing to get wrong: the listing
    /// must answer while **nothing** is unlocked, reporting `false` rather
    /// than refusing.
    #[tokio::test]
    async fn the_listing_answers_with_no_collection_unlocked() {
        let device = Device::new();
        let work = device.holding("Work", "work-pass").await;
        let home = device.holding("Home", "home-pass").await;

        let overview = device.overview().await;
        assert_eq!(overview.statuses.len(), 2);
        assert!(
            overview.statuses.iter().all(|status| !status.unlocked),
            "a collection nothing is holding a passphrase for is locked"
        );

        assert_eq!(
            device.unlock(&work, "work-pass").await,
            CollectionOutcome::Ok
        );
        let overview = device.overview().await;
        let unlocked: Vec<&str> = overview
            .statuses
            .iter()
            .filter(|status| status.unlocked)
            .map(|status| status.id.as_str())
            .collect();
        assert_eq!(unlocked, vec![work.as_str()]);
        assert!(!device.unlocked(&home));
    }

    /// `unassignedKeyIds` is the stored keys minus every member, which is the
    /// whole of the derived membership index as the renderer sees it.
    #[tokio::test]
    async fn the_listing_separates_members_from_unassigned_keys() {
        let device = Device::new();
        let alpha = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let beta = device.with_key("Beta", "cf-token-beta", "beta-pass").await;
        let work = device.holding("Work", "work-pass").await;
        device.unlock(&work, "work-pass").await;
        assert_eq!(
            device.add_key(&work, &alpha, Some("alpha-pass")).await,
            CollectionOutcome::Ok
        );

        let overview = device.overview().await;
        assert_eq!(overview.collections[0].member_ids, vec![alpha.clone()]);
        assert_eq!(overview.unassigned_key_ids, vec![beta]);
    }

    // ── create_collection ───────────────────────────────────────────────

    #[tokio::test]
    async fn a_created_collection_is_empty_locked_and_openable() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;

        let record = device.record_of(&id).await;
        assert_eq!(record.label, "Work");
        assert!(record.member_ids.is_empty());
        assert_eq!(
            record.created_at, record.updated_at,
            "nothing has been re-sealed yet"
        );
        assert!(
            !device.unlocked(&id),
            "creating a collection does not unlock it"
        );
        assert!(
            device.sealed(&id).await.open("work-pass").is_ok(),
            "the passphrase that created it must open it"
        );
    }

    /// The record's KDF parameters describe the envelope beside it — the
    /// contract's reason for carrying them in cleartext. Sealed at a raised
    /// iteration count so the numbers are provably the ones used rather than
    /// the defaults either side would have guessed.
    #[tokio::test]
    async fn the_record_describes_the_envelope_it_was_sealed_with() {
        let device = Device::new();
        device.seal_at(120_000).await;
        let id = device.holding("Work", "work-pass").await;

        let sealed = device.sealed(&id).await;
        assert_eq!(sealed.record.iterations, 120_000);
        assert_eq!(sealed.record.key_length, 32, "bytes, not bits");
        assert_eq!(sealed.record.algorithm, "AES-GCM");
        assert!(
            sealed.open("work-pass").is_ok(),
            "the record's parameters are what the crate reads back to open it"
        );
    }

    #[tokio::test]
    async fn a_duplicate_label_is_refused_whatever_its_case() {
        let device = Device::new();
        device.holding("Work", "work-pass").await;

        let outcome = device.create("  work  ", "other-pass").await;
        assert_eq!(code_of(&outcome), "duplicate-label");
        assert_eq!(
            device.records().await.len(),
            1,
            "a refused create stores nothing"
        );
    }

    #[tokio::test]
    async fn an_empty_label_is_refused() {
        let device = Device::new();
        let outcome = device.create("   ", "work-pass").await;
        assert_eq!(code_of(&outcome), "invalid-label");
        assert!(device.records().await.is_empty());
    }

    #[tokio::test]
    async fn an_overlong_label_is_refused() {
        let device = Device::new();
        let label = "l".repeat(MAX_COLLECTION_LABEL_LENGTH + 1);
        let outcome = device.create(&label, "work-pass").await;
        assert_eq!(code_of(&outcome), "invalid-label");
        assert!(device.records().await.is_empty());
    }

    #[tokio::test]
    async fn a_missing_passphrase_stores_nothing() {
        let device = Device::new();
        let outcome = device.create("Work", "").await;
        assert_eq!(code_of(&outcome), "no-passphrase");
        assert!(device.records().await.is_empty());
    }

    /// The store's own ceiling, named in a message the panel prints.
    #[tokio::test]
    async fn the_number_of_collections_is_bounded() {
        let device = Device::new();
        for index in 0..MAX_COLLECTIONS {
            assert_eq!(
                device.create(&format!("Collection {index}"), "pass").await,
                CollectionOutcome::Ok
            );
        }

        let outcome = device.create("One too many", "pass").await;
        assert_eq!(code_of(&outcome), "backend-error");
        let message = failure_of(&outcome)
            .message
            .clone()
            .expect("backend-error is defined as carrying its message");
        assert!(
            message.contains(&MAX_COLLECTIONS.to_string()),
            "the refusal must name the limit: {message}"
        );
        assert_eq!(device.records().await.len(), MAX_COLLECTIONS);
    }

    // ── unlock_collection / lock_collection ─────────────────────────────

    #[tokio::test]
    async fn a_wrong_passphrase_never_enters_the_vault() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;

        let outcome = device.unlock(&id, "not-the-passphrase").await;
        assert_eq!(code_of(&outcome), "wrong-passphrase");
        assert!(!device.unlocked(&id));
    }

    /// Asked with **another** collection in the store, which is the version of
    /// this claim worth making: a lookup that matched the wrong value would
    /// still answer `not-found` on an empty device, so a test that did not
    /// first store something cannot tell "no such collection" from "the first
    /// one I had". It was a surviving mutation that said so — a `find` rigged
    /// to match anything went unnoticed by this test until the store had a
    /// collection in it.
    #[tokio::test]
    async fn unlocking_a_collection_that_is_not_there_is_not_found() {
        let device = Device::new();
        device.holding("Work", "work-pass").await;

        let outcome = device.unlock("col_nothing", "work-pass").await;
        assert_eq!(code_of(&outcome), "not-found");
    }

    #[tokio::test]
    async fn locking_drops_the_held_passphrase() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        assert!(device.unlocked(&id));

        device.lock(&id);
        assert!(!device.unlocked(&id));
    }

    /// Nothing to refuse, including for a collection that does not exist —
    /// which is why this command answers `null` rather than an outcome.
    #[tokio::test]
    async fn locking_something_that_was_never_unlocked_is_recorded_as_success() {
        let device = Device::new();
        device.lock("col_nothing");

        let trail = device.trail().await;
        assert_eq!(trail.len(), 1);
        assert_eq!(trail[0]["operation"], Value::from(OP_LOCK));
        assert_eq!(trail[0]["outcome"], Value::from("succeeded"));
    }

    // ── rename_collection ───────────────────────────────────────────────

    #[tokio::test]
    async fn renaming_to_its_own_label_is_allowed() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;

        assert_eq!(
            device.rename(&id, "Work").await,
            CollectionOutcome::Ok,
            "labels_excluding is what stops a rename refusing itself"
        );
        assert_eq!(device.record_of(&id).await.label, "Work");
    }

    #[tokio::test]
    async fn renaming_onto_another_collection_is_refused() {
        let device = Device::new();
        let work = device.holding("Work", "work-pass").await;
        device.holding("Home", "home-pass").await;

        let outcome = device.rename(&work, "Home").await;
        assert_eq!(code_of(&outcome), "duplicate-label");
        assert_eq!(device.record_of(&work).await.label, "Work");
    }

    /// A rename re-seals nothing, so the envelope and the update time both
    /// stay where they were. `updated_at` is defined as the time of the last
    /// re-seal, and a rename that moved it would date a change to the
    /// envelope that never happened.
    #[tokio::test]
    async fn a_rename_touches_neither_the_envelope_nor_the_update_time() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        let before = device.sealed(&id).await;

        device.rename(&id, "Renamed").await;

        let after = device.sealed(&id).await;
        assert_eq!(after.envelope, before.envelope);
        assert_eq!(after.record.updated_at, before.record.updated_at);
        assert_eq!(after.record.created_at, before.record.created_at);
    }

    /// With another collection stored, for the reason the unlock case states.
    /// This is the one that goes through the lookup *inside* the transaction.
    #[tokio::test]
    async fn renaming_a_collection_that_is_not_there_is_not_found() {
        let device = Device::new();
        device.holding("Home", "home-pass").await;

        let outcome = device.rename("col_nothing", "Work").await;
        assert_eq!(code_of(&outcome), "not-found");
        assert_eq!(
            device.records().await[0].label,
            "Home",
            "nothing else is renamed in its place"
        );
    }

    // ── delete_collection ───────────────────────────────────────────────

    /// The contract's recoverability argument, as an assertion: the envelope
    /// is gone, the members are unassigned again, and every key still opens
    /// with its own password.
    #[tokio::test]
    async fn deleting_loses_no_key_and_frees_its_members() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &key, Some("alpha-pass")).await;

        assert_eq!(device.delete(&id).await, CollectionOutcome::Ok);

        let overview = device.overview().await;
        assert!(overview.collections.is_empty());
        assert_eq!(overview.unassigned_key_ids, vec![key.clone()]);
        let stored = device.keys().await;
        assert_eq!(stored.len(), 1);
        assert_eq!(
            opens(&stored[0], "alpha-pass").as_deref(),
            Some("cf-token-alpha"),
            "the key's own envelope is untouched by anything a collection does"
        );
    }

    /// A vault entry for a collection that no longer exists is a secret kept
    /// for nothing.
    #[tokio::test]
    async fn deleting_drops_the_held_passphrase() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        device.delete(&id).await;
        assert!(!device.unlocked(&id));
    }

    /// With another collection stored, for the reason the unlock case states.
    #[tokio::test]
    async fn deleting_something_that_is_not_there_is_not_found() {
        let device = Device::new();
        device.holding("Work", "work-pass").await;

        let outcome = device.delete("col_nothing").await;
        assert_eq!(code_of(&outcome), "not-found");
        assert_eq!(
            device.records().await.len(),
            1,
            "nothing else is deleted in its place"
        );
    }

    // ── add_key_to_collection ───────────────────────────────────────────

    #[tokio::test]
    async fn adding_a_key_needs_the_collection_unlocked() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;

        let outcome = device.add_key(&id, &key, Some("alpha-pass")).await;
        assert_eq!(code_of(&outcome), "locked");
        assert!(device.record_of(&id).await.member_ids.is_empty());
    }

    /// The two-passphrase operation, end to end. Both envelopes exist
    /// afterwards and both open to the same secret under different
    /// passphrases, which is the decision the contract header spends its
    /// longest paragraph on.
    #[tokio::test]
    async fn a_keys_own_password_seals_its_secret_and_leaves_the_key_alone() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        let before = device.sealed(&id).await;

        assert_eq!(
            device.add_key(&id, &key, Some("alpha-pass")).await,
            CollectionOutcome::Ok
        );

        let after = device.sealed(&id).await;
        assert_eq!(after.record.member_ids, vec![key.clone()]);
        assert_eq!(
            members(&after, "work-pass"),
            vec![(key.clone(), "cf-token-alpha".to_string())],
            "the envelope holds the secret, not just the index"
        );
        assert_ne!(after.envelope, before.envelope);
        assert_ne!(
            after.record.updated_at, before.record.updated_at,
            "a re-seal moves the update time"
        );

        let stored = device.keys().await;
        assert_eq!(
            opens(&stored[0], "alpha-pass").as_deref(),
            Some("cf-token-alpha"),
            "the key keeps its own envelope under its own password"
        );
    }

    #[tokio::test]
    async fn the_os_vault_supplies_the_secret_when_no_password_is_given() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        device.in_os_vault(&key, "cf-token-alpha").await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        assert_eq!(device.add_key(&id, &key, None).await, CollectionOutcome::Ok);
        assert_eq!(
            members(&device.sealed(&id).await, "work-pass"),
            vec![(key, "cf-token-alpha".to_string())]
        );
    }

    /// An empty `keyPassword` means "try the vault", never "the password is
    /// empty". The renderer omits the field for exactly this reason, and a
    /// caller that sends `""` anyway must not be told a key is locked when
    /// the vault could have opened it — no key on this device can have an
    /// empty password, because `bc_crypto` refuses to seal under one.
    #[tokio::test]
    async fn an_empty_password_is_read_as_a_missing_one() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        device.in_os_vault(&key, "cf-token-alpha").await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        assert_eq!(
            device.add_key(&id, &key, Some("")).await,
            CollectionOutcome::Ok,
            "an empty password must fall through to the vault"
        );
    }

    #[tokio::test]
    async fn a_key_with_no_password_and_no_vault_entry_is_key_locked() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        let outcome = device.add_key(&id, &key, None).await;
        assert_eq!(code_of(&outcome), "key-locked");
        assert!(device.record_of(&id).await.member_ids.is_empty());
    }

    #[tokio::test]
    async fn a_wrong_key_password_is_key_locked() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        let outcome = device.add_key(&id, &key, Some("not-the-password")).await;
        assert_eq!(
            code_of(&outcome),
            "key-locked",
            "not wrong-passphrase, which the panel words as being about the collection"
        );
    }

    /// A supplied password that does not open the key is not retried against
    /// the vault: the user typed something wrong and must be told so.
    #[tokio::test]
    async fn a_wrong_key_password_is_not_rescued_by_the_vault() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        device.in_os_vault(&key, "cf-token-alpha").await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        let outcome = device.add_key(&id, &key, Some("not-the-password")).await;
        assert_eq!(code_of(&outcome), "key-locked");
        assert!(device.record_of(&id).await.member_ids.is_empty());
    }

    /// Membership is exclusive, and the store's answer to "which collection is
    /// this key in" is what the crate refuses on.
    ///
    /// # What the second assertion protects
    ///
    /// That the key is **still in the collection it was already in** looks
    /// redundant here, and in this module it is: membership *is* the envelope,
    /// and the one write happens after the last refusal can occur, so there is
    /// no membership write a refusal could leave behind. Nothing that could rot
    /// is being guarded.
    ///
    /// Proving it therefore meant *adding* that write rather than breaking one.
    /// The mutation cleared the old collection's index on the way in — the
    /// shape a `collectionId` on the key record takes if it is cleared before
    /// the seal is known to have succeeded, which is the implementation the
    /// contract originally described. The refusal still arrived, this assertion
    /// was the only one of the three refusal tests that saw it, and it reported
    /// `left: []` against `right: ["key_…"]`.
    ///
    /// So this line is here for a future two-store implementation, not for the
    /// present one. Anybody who moves membership onto the key record will find
    /// out from this test that a refused add must not clear it.
    #[tokio::test]
    async fn a_key_in_another_collection_is_refused_and_stays_where_it_is() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let work = device.holding("Work", "work-pass").await;
        let home = device.holding("Home", "home-pass").await;
        device.unlock(&work, "work-pass").await;
        device.unlock(&home, "home-pass").await;
        device.add_key(&work, &key, Some("alpha-pass")).await;

        let outcome = device.add_key(&home, &key, Some("alpha-pass")).await;
        assert_eq!(code_of(&outcome), "already-member");
        assert_eq!(device.record_of(&work).await.member_ids, vec![key]);
        assert!(device.record_of(&home).await.member_ids.is_empty());
    }

    #[tokio::test]
    async fn a_key_already_in_this_collection_is_refused() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &key, Some("alpha-pass")).await;
        let before = device.sealed(&id).await;

        let outcome = device.add_key(&id, &key, Some("alpha-pass")).await;
        assert_eq!(code_of(&outcome), "already-member");
        assert_eq!(
            device.sealed(&id).await.envelope,
            before.envelope,
            "a refused add re-seals nothing"
        );
    }

    /// Not `not-found`, which is about the collection, and not `key-locked`,
    /// which sends the user to type a password for a key that is gone.
    #[tokio::test]
    async fn an_api_key_that_is_not_stored_is_a_named_backend_error() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        let outcome = device.add_key(&id, "key_nothing", Some("alpha-pass")).await;
        assert_eq!(code_of(&outcome), "backend-error");
        assert!(failure_of(&outcome)
            .message
            .as_ref()
            .is_some_and(|message| message.contains("API key")));
    }

    /// With another collection stored and unlocked, which is where a lookup
    /// that matched the wrong value would do the most damage: it would seal
    /// this key into a collection nobody named.
    #[tokio::test]
    async fn adding_to_a_collection_that_is_not_there_is_not_found() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let work = device.holding("Work", "work-pass").await;
        device.unlock(&work, "work-pass").await;

        let outcome = device
            .add_key("col_nothing", &key, Some("alpha-pass"))
            .await;
        assert_eq!(code_of(&outcome), "not-found");
        assert!(
            device.record_of(&work).await.member_ids.is_empty(),
            "the key must not land in the collection that happened to be there"
        );
    }

    // ── remove_key_from_collection ──────────────────────────────────────

    #[tokio::test]
    async fn removing_takes_the_secret_out_and_frees_the_key() {
        let device = Device::new();
        let alpha = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let beta = device.with_key("Beta", "cf-token-beta", "beta-pass").await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &alpha, Some("alpha-pass")).await;
        device.add_key(&id, &beta, Some("beta-pass")).await;

        assert_eq!(device.remove_key(&id, &alpha).await, CollectionOutcome::Ok);

        let sealed = device.sealed(&id).await;
        assert_eq!(sealed.record.member_ids, vec![beta.clone()]);
        assert_eq!(
            members(&sealed, "work-pass"),
            vec![(beta, "cf-token-beta".to_string())],
            "the removed secret is out of the envelope, not just out of the index"
        );
        assert!(device.overview().await.unassigned_key_ids.contains(&alpha));
    }

    #[tokio::test]
    async fn removing_a_key_that_is_not_a_member_is_refused() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        let outcome = device.remove_key(&id, &key).await;
        assert_eq!(code_of(&outcome), "not-a-member");
    }

    #[tokio::test]
    async fn removing_a_key_needs_the_collection_unlocked() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &key, Some("alpha-pass")).await;
        device.lock(&id);

        let outcome = device.remove_key(&id, &key).await;
        assert_eq!(code_of(&outcome), "locked");
        assert_eq!(device.record_of(&id).await.member_ids, vec![key]);
    }

    // ── rotate_collection_passphrase ────────────────────────────────────

    #[tokio::test]
    async fn rotating_reseals_under_the_new_passphrase_only() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &key, Some("alpha-pass")).await;

        assert_eq!(
            device.rotate(&id, "work-pass", "new-work-pass").await,
            CollectionOutcome::Ok
        );

        let sealed = device.sealed(&id).await;
        assert!(sealed.open("work-pass").is_err(), "the old one is spent");
        assert_eq!(
            members(&sealed, "new-work-pass"),
            vec![(key.clone(), "cf-token-alpha".to_string())],
            "every member secret survives the rotation"
        );
        assert_eq!(
            opens(&device.keys().await[0], "alpha-pass").as_deref(),
            Some("cf-token-alpha"),
            "rotating a collection is not rotating access to its keys"
        );
    }

    /// The vault moves with the rotation, or it would keep reporting the
    /// collection as unlocked while holding a passphrase that opens nothing.
    #[tokio::test]
    async fn rotating_an_unlocked_collection_replaces_the_held_passphrase() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;

        device.rotate(&id, "work-pass", "new-work-pass").await;

        assert!(device.unlocked(&id));
        let sealed = device.sealed(&id).await;
        let held_passphrase = held(&device.vault)
            .passphrase(&id)
            .expect("still held")
            .to_string();
        assert!(
            sealed.verify_passphrase(&held_passphrase).is_ok(),
            "the held value must open the envelope that is actually stored"
        );
    }

    #[tokio::test]
    async fn rotating_a_locked_collection_leaves_it_locked() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;

        assert_eq!(
            device.rotate(&id, "work-pass", "new-work-pass").await,
            CollectionOutcome::Ok,
            "a rotation proves the old passphrase rather than needing an unlock"
        );
        assert!(
            !device.unlocked(&id),
            "a rotation is not an unlock: the next person at the keyboard must still type it"
        );
        assert!(device.sealed(&id).await.open("new-work-pass").is_ok());
    }

    #[tokio::test]
    async fn a_wrong_current_passphrase_changes_nothing() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        let before = device.sealed(&id).await;

        let outcome = device
            .rotate(&id, "not-the-passphrase", "new-work-pass")
            .await;
        assert_eq!(code_of(&outcome), "wrong-passphrase");
        assert_eq!(device.sealed(&id).await.envelope, before.envelope);
        assert_eq!(
            held(&device.vault).passphrase(&id).expect("still held"),
            "work-pass",
            "a refused rotation leaves the held passphrase alone"
        );
    }

    /// With another collection stored whose passphrase is the one being
    /// offered, which is the worst version of a lookup that reached for the
    /// wrong value: it would re-seal a collection nobody named, under a
    /// passphrase its owner never chose.
    #[tokio::test]
    async fn rotating_a_collection_that_is_not_there_is_not_found() {
        let device = Device::new();
        let work = device.holding("Work", "work-pass").await;

        let outcome = device
            .rotate("col_nothing", "work-pass", "new-work-pass")
            .await;
        assert_eq!(code_of(&outcome), "not-found");
        assert!(
            device.sealed(&work).await.open("work-pass").is_ok(),
            "the collection that is there keeps its own passphrase"
        );
    }

    // ── The write guard ─────────────────────────────────────────────────

    /// A value that moved between the read and the write is refused rather
    /// than clobbered. Driven directly, because the only way to reach it
    /// through a command is a second window.
    #[tokio::test]
    async fn a_collection_that_moved_while_sealing_is_not_clobbered() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        let before = device.sealed(&id).await;

        // A rename is enough: it changes the record and not the envelope, so
        // only a guard over the whole stored value catches it.
        device.rename(&id, "Renamed").await;

        let outcome = settle(commit(&device.storage, before.clone(), before).await)
            .expect("the guard refuses rather than breaking");
        assert_eq!(code_of(&outcome), "backend-error");
        assert_eq!(
            device.record_of(&id).await.label,
            "Renamed",
            "the concurrent rename survives"
        );
    }

    #[tokio::test]
    async fn committing_to_a_collection_that_was_deleted_is_not_found() {
        let device = Device::new();
        let id = device.holding("Work", "work-pass").await;
        let before = device.sealed(&id).await;
        device.delete(&id).await;

        let outcome = settle(commit(&device.storage, before.clone(), before).await)
            .expect("the guard refuses rather than breaking");
        assert_eq!(code_of(&outcome), "not-found");
        assert!(device.records().await.is_empty());
    }

    // ── The audit trail ────────────────────────────────────────────────

    /// Every operation reaches the trail, and nothing that was typed does.
    ///
    /// The secrets are checked against the serialised log rather than field by
    /// field: a leak would arrive in whichever field somebody added next, and
    /// the question worth asking is whether the string is anywhere in it.
    #[tokio::test]
    async fn the_trail_records_every_operation_and_no_secret() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &key, Some("alpha-pass")).await;
        device.rename(&id, "Renamed").await;
        device.rotate(&id, "work-pass", "new-work-pass").await;
        device.remove_key(&id, &key).await;
        device.lock(&id);
        device.delete(&id).await;

        let trail = device.trail().await;
        let operations: Vec<&str> = trail
            .iter()
            .map(|entry| entry["operation"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            operations,
            vec![
                OP_CREATE,
                OP_UNLOCK,
                OP_ADD_KEY,
                OP_RENAME,
                OP_ROTATE,
                OP_REMOVE_KEY,
                OP_LOCK,
                OP_DELETE,
            ]
        );
        assert!(
            trail.iter().all(|entry| entry["outcome"] == "succeeded"),
            "every one of those succeeded: {trail:?}"
        );
        assert_eq!(trail[2]["resource"], Value::from(id.as_str()));
        assert_eq!(trail[2]["key"], Value::from(key.as_str()));

        let serialised = serde_json::to_string(&trail).expect("the trail serialises");
        for secret in [
            "work-pass",
            "new-work-pass",
            "alpha-pass",
            "cf-token-alpha",
            "Renamed",
        ] {
            assert!(
                !serialised.contains(secret),
                "{secret:?} reached the audit trail: {serialised}"
            );
        }
    }

    /// A refusal is recorded as `denied` and names its code, which is the
    /// entry worth having: reaching one at all means the screen and the
    /// backend disagreed about what was possible.
    #[tokio::test]
    async fn a_refusal_is_recorded_with_its_code() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;

        device.add_key(&id, &key, Some("alpha-pass")).await;

        let trail = device.trail().await;
        let entry = trail.last().expect("the refusal is recorded");
        assert_eq!(entry["operation"], Value::from(OP_ADD_KEY));
        assert_eq!(entry["outcome"], Value::from("denied"));
        assert_eq!(entry["code"], Value::from("locked"));
    }

    /// Every argument the renderer sends is a parameter of the command it
    /// sends it to.
    ///
    /// Tauri's arguments are named, and it converts the renderer's camelCase
    /// to a Rust parameter's snake_case — so a handler that spelled
    /// `keyPassword` as `password` would typecheck on both sides of the
    /// boundary and fail only when a user reached the feature, with the
    /// argument silently unbound. Nothing else in this repository compares the
    /// two: `CollectionCommandArgs` is checked against the renderer's calls by
    /// the TypeScript compiler, and against this side by nothing at all.
    ///
    /// Comment lines are stripped before the fields are read, the lesson
    /// `commands::sync`'s command-table test records: English prose inside the
    /// block supplies colons freely, and rewording a doc comment would
    /// otherwise fix one run and break the next.
    #[test]
    fn every_argument_the_contract_names_is_a_parameter_of_that_command() {
        let source = include_str!("collections.rs");
        let commands = contract_commands();
        let mut checked = 0;
        for (key, fields) in contract_arguments() {
            let command = commands
                .iter()
                .find(|(table_key, _)| *table_key == key)
                .map(|(_, name)| name.as_str())
                .unwrap_or_else(|| {
                    panic!("CollectionCommandArgs names COLLECTION_COMMANDS.{key}, which the table has not got")
                });
            let (_, after) = source
                .split_once(&format!("pub async fn {command}("))
                .unwrap_or_else(|| panic!("{command} should be a command in this module"));
            let (signature, _) = after.split_once(')').expect("a signature closes");
            for field in fields {
                let parameter = snake_case(&field);
                assert!(
                    signature.contains(&format!("{parameter}: ")),
                    "{command} has no {parameter} parameter, so the renderer's {field} \
                     would arrive unbound:\n{signature}"
                );
                checked += 1;
            }
        }
        // A floor on the extraction, not on the contract: a parser that
        // quietly stopped matching would report no arguments, and "every
        // argument is a parameter" is exactly what finding none also says.
        assert!(
            checked >= 16,
            "expected at least sixteen arguments across the nine commands, read {checked}"
        );
    }

    /// `COLLECTION_COMMANDS`, as pairs of its key and the command it names.
    fn contract_commands() -> Vec<(String, String)> {
        let (_, after) = CONTRACT
            .split_once("COLLECTION_COMMANDS = {")
            .expect("the contract declares COLLECTION_COMMANDS");
        let (block, _) = after
            .split_once("} as const")
            .expect("COLLECTION_COMMANDS is a const object");
        block
            .lines()
            .filter(|line| !is_comment(line))
            .filter_map(|line| {
                let (key, rest) = line.split_once(':')?;
                let name = rest.split('"').nth(1)?;
                Some((key.trim().to_string(), name.to_string()))
            })
            .collect()
    }

    /// `CollectionCommandArgs`, as the command key and the fields it carries.
    fn contract_arguments() -> Vec<(String, Vec<String>)> {
        let (_, after) = CONTRACT
            .split_once("export interface CollectionCommandArgs {")
            .expect("the contract declares CollectionCommandArgs");
        let (block, _) = after
            .split_once("\n}\n")
            .expect("the interface closes on its own line");
        let mut entries = Vec::new();
        for chunk in block.split("[COLLECTION_COMMANDS.").skip(1) {
            let Some((key, body)) = chunk.split_once("]:") else {
                continue;
            };
            let body: String = body
                .lines()
                .filter(|line| !is_comment(line))
                .collect::<Vec<_>>()
                .join("\n");
            entries.push((key.trim().to_string(), fields_of(&body)));
        }
        entries
    }

    fn is_comment(line: &str) -> bool {
        let trimmed = line.trim_start();
        trimmed.starts_with('*') || trimmed.starts_with("/*") || trimmed.starts_with("//")
    }

    /// The field names in one `{ … }` body, however many lines it spans.
    fn fields_of(body: &str) -> Vec<String> {
        let mut fields = Vec::new();
        for statement in body.split(';') {
            for piece in statement.split('{') {
                let Some((name, _)) = piece.split_once(':') else {
                    continue;
                };
                let name = name.trim().trim_end_matches('?');
                if !name.is_empty() && name.chars().all(|letter| letter.is_ascii_alphanumeric()) {
                    fields.push(name.to_string());
                }
            }
        }
        fields
    }

    fn snake_case(camel: &str) -> String {
        let mut snake = String::with_capacity(camel.len() + 2);
        for letter in camel.chars() {
            if letter.is_ascii_uppercase() {
                snake.push('_');
                snake.push(letter.to_ascii_lowercase());
            } else {
                snake.push(letter);
            }
        }
        snake
    }

    /// A key deleted from the store while it was a member leaves its secret
    /// inside the envelope. That hole is the contract's closing section and
    /// nothing here closes it — there is no command that would.
    ///
    /// What this pins is the one thing a user can do about it: the orphaned
    /// member id is still removable, so the secret can be got out. The panel
    /// renders such an id as a named "no longer stored on this device" row
    /// rather than a blank line, which is what makes it reachable at all.
    #[tokio::test]
    async fn an_orphaned_member_can_still_be_taken_out_of_the_envelope() {
        let device = Device::new();
        let key = device
            .with_key("Alpha", "cf-token-alpha", "alpha-pass")
            .await;
        let id = device.holding("Work", "work-pass").await;
        device.unlock(&id, "work-pass").await;
        device.add_key(&id, &key, Some("alpha-pass")).await;

        device
            .storage
            .delete_api_key(key.clone())
            .await
            .expect("delete the key out from under the collection");

        // Deleting a key does not reach into a collection, so both the index
        // and the envelope still hold it. This is the defect, asserted so that
        // closing it later is a test that changes rather than one that was
        // never written.
        assert_eq!(device.record_of(&id).await.member_ids, vec![key.clone()]);
        assert_eq!(
            members(&device.sealed(&id).await, "work-pass").len(),
            1,
            "the secret of a deleted key is still sealed in here"
        );

        assert_eq!(device.remove_key(&id, &key).await, CollectionOutcome::Ok);
        assert!(
            members(&device.sealed(&id).await, "work-pass").is_empty(),
            "removing the orphan is what gets the secret out"
        );
    }
}
