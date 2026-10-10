/**
 * # Collections — the contract
 *
 * A **collection** is a named set of API keys sealed under one passphrase, so
 * that unlocking it once makes every member key usable without a per-key
 * prompt. That is the whole point: switching between a dozen Cloudflare
 * accounts today means typing a dozen passwords, and a collection reduces it
 * to one.
 *
 * This file is the contract between the Rust backend and the React frontend.
 * `bc-collections/src/lib.rs` pins against it with `include_str!` and a test
 * asserting every failure code below appears here, the same mechanism
 * `bc-sync` uses for `src/lib/sync/types.ts`. If you add a code, add it here
 * first or that test fails by name.
 *
 * ## What is sealed, and what is not
 *
 * The collection envelope's plaintext holds **only the member secrets**. A
 * key's label, email and id are already cleartext in `bc-storage`'s `ApiKey`
 * record and stay there. Sealing them a second time would grow the envelope
 * against a hard cap (see below) and buy nothing, since the cleartext copy is
 * still on disk either way.
 *
 * ## A key keeps its own envelope — deliberately
 *
 * Adding a key to a collection does **not** remove or replace that key's
 * per-key `encrypted_key`. Both envelopes exist and both decrypt to the same
 * secret, under two different passphrases with independent salts and nonces.
 *
 * This is the single most important decision in this design, and it is a
 * recoverability one. A collection is a convenience wrapper; if it were the
 * only envelope, forgetting one passphrase would destroy every key in the
 * collection at once. Keeping the per-key envelope means the collection can
 * always be abandoned and the keys still open individually. The cost is that
 * the plaintext is sealed twice, which is not a weakness — an attacker who
 * can break AES-256-GCM given one envelope is not inconvenienced by there
 * being one rather than two — but it does mean **a key's password and its
 * collection's passphrase must both be rotated to fully rotate access.** That
 * is a real caveat and the UI has to say it.
 *
 * ## Membership is exclusive
 *
 * A key belongs to at most one collection. Allowing several would mean a
 * passphrase rotation has to reach into every envelope the key appears in,
 * and it makes "which collection is this key in" unanswerable in a list. One
 * collection per key.
 *
 * **Where membership lives — corrected by the implementation.** This said
 * `collectionId` on the key record is the single source of truth. It is not,
 * and should not be: `commands/collections.rs` derives membership from the
 * **envelope**, rebuilding `memberIds` from what was actually sealed on every
 * re-seal, and computes `unassignedKeyIds` as the stored keys minus every
 * member.
 *
 * That is more robust than a field, for a reason I did not anticipate.
 * `commands::sync`'s `api_key(entry: VaultEntry) -> ApiKey` constructs a fresh
 * record from exactly seven fields, and `VaultEntry` has no eighth — so a
 * `collectionId` on `ApiKey` would be **silently dropped on every sync pull**,
 * losing every collection's membership, with nothing to report it. Carrying it
 * would mean changing the sync payload format, which is a separate decision
 * from this feature. And a second copy of membership can drift from the
 * envelope in a way a derived one cannot.
 *
 * So there is one source and it is the sealed plaintext. A key's membership is
 * a fact about which envelope holds its secret, which is also the only
 * definition that cannot disagree with reality.
 *
 * ## Adding a key needs its plaintext
 *
 * To put a key in a collection, the backend must have the key's *secret* to
 * seal — so the key has to be openable at that moment, by its own password or
 * through the OS vault. There is no way around this: a collection cannot wrap
 * a secret it cannot read. So the add flow is a two-passphrase operation
 * (the key's, then the collection's), and `keyLocked` below is the refusal
 * when the first one is missing. Building the UI as though adding a key were
 * a one-click action is the most likely way to get this wrong.
 *
 * ## The size cap is real and low
 *
 * `bc_crypto::MAX_PLAINTEXT_BYTES` is **64 KiB** and applies to one envelope.
 * The whole collection seals into one envelope, so the member count is
 * bounded by it. A member entry is an id and a secret — on the order of 120
 * bytes of JSON — which puts the practical ceiling in the hundreds of keys,
 * comfortably above any real use. But it is a hard cap that fails a *write*,
 * so it must fail predictably rather than at the point of sealing:
 * `MAX_COLLECTION_MEMBERS` below is checked before the seal, and `tooLarge`
 * is the refusal if the sealed form still does not fit.
 *
 * ## KDF parameters travel in cleartext, because the envelope has no room
 *
 * `bc-crypto`'s envelope is `salt || nonce || ciphertext || tag` and carries
 * **no iteration count**. So a collection sealed at 600,000 iterations cannot
 * be opened unless something outside the envelope remembers that number.
 * `CollectionRecord` carries `iterations`, `keyLength` and `algorithm` in
 * cleartext for exactly the reason `ApiKey` and `SyncManifest` do. They are
 * not secrets — knowing the iteration count does not help an attacker who
 * still has to run it — and losing them is unrecoverable.
 *
 * ## Unlock state is in memory, for the session only
 *
 * An unlocked collection is one whose **passphrase** the backend is holding
 * for this session. It is never written to disk, never put in the OS vault,
 * and does not survive a restart. `CollectionStatus.unlocked` reports whether
 * it is held right now. A collection shown as unlocked after a relaunch would
 * be a lie about where the secret lives.
 *
 * ### It is the passphrase, not a derived key — and that is worse
 *
 * This section said "unlocking derives a key and holds it in the backend's
 * memory" until the fr-FR translator read `bc-collections/src/vault.rs`
 * against it. That is **not implementable** against `bc-crypto` as it stands:
 * `CryptoManager::encrypt` and `decrypt` take a password `&str` and run
 * PBKDF2 themselves, and there is no entry point that accepts an
 * already-derived key. So what a session can hold is the passphrase, and
 * `CollectionVault` holds it in a `Zeroizing<String>` with a hand-written
 * `Debug`. The crate's author had documented this in that module's header; it
 * is my contract that was wrong, and it stayed wrong because nobody had to
 * reconcile the two until someone translated a sentence about it.
 *
 * **The difference is a disclosure, not a detail.** A derived key is scoped to
 * one collection's salt, so it opens that collection and nothing else. A
 * passphrase the user has also used somewhere else opens whatever else they
 * used it on, for as long as the app is running. So the wrong version of this
 * paragraph was not merely inaccurate, it was reassuring in the direction that
 * costs the user something.
 *
 * Narrowing it needs a `bc-crypto` change — a `derive_key` plus
 * `encrypt_with_key` / `decrypt_with_key` pair — which is on the list and is
 * not `bc-collections`' to make.
 *
 * **Consequence for the copy, which is the reason this is spelled out here:**
 * the user-facing strings say the *passphrase* is held in memory, and they are
 * correct. A reviewer who trusted the old paragraph would have "corrected"
 * them to say a key was held — turning accurate copy into a false and
 * flattering claim. Do not make that edit.
 */

/** Payload version of the collection envelope's plaintext document. */
export const COLLECTION_PAYLOAD_VERSION = 1;

/**
 * The most keys one collection may hold.
 *
 * Bounded by `bc_crypto::MAX_PLAINTEXT_BYTES` (64 KiB) rather than by taste,
 * with headroom: at ~120 bytes per member the cap below uses under a third of
 * the envelope, which leaves room for the payload's own framing and for a
 * member secret much longer than a Cloudflare token. Checked before sealing
 * so the refusal names the limit instead of surfacing as a crypto error.
 */
export const MAX_COLLECTION_MEMBERS = 128;

/** The longest a collection label may be. */
export const MAX_COLLECTION_LABEL_LENGTH = 120;

/**
 * One collection, as the backend stores it.
 *
 * Everything here is cleartext. The member *secrets* are in the envelope;
 * `memberIds` is the cleartext index of who is in it, which the UI needs to
 * render a list without unlocking anything.
 */
export interface CollectionRecord {
  id: string;
  label: string;
  /** RFC 3339. Display only — nothing orders on it. */
  createdAt: string;
  /** RFC 3339, updated on every re-seal. Display only. */
  updatedAt: string;
  /**
   * The keys in this collection, in no meaningful order.
   *
   * Cleartext on purpose: the UI must be able to show which keys a collection
   * covers while it is locked, or the user cannot tell which passphrase to
   * type. It discloses that two keys are administered together, which is
   * already visible from the key list.
   */
  memberIds: string[];
  /** PBKDF2 iterations the envelope was sealed with. See the header. */
  iterations: number;
  /**
   * Derived key length in **bytes**, not bits.
   *
   * This said "bits" until the collections UI agent noticed the repo implied
   * both: `test/SyncSettings.test.tsx`'s manifest fixture uses `keyLength: 32`
   * for the same field name. 32 settles it — `bc_crypto::AES_256_KEY_LENGTH_BYTES`
   * is `32`, and `EncryptionConfig`'s default `key_length` is `32`, which is
   * AES-256 measured in bytes. A Rust implementer reading "bits" would have
   * written `256` and failed `validate_key_length`, or worse, derived a
   * 256-byte key.
   */
  keyLength: number;
  /** KDF/cipher identifier, e.g. `"PBKDF2-SHA256/AES-256-GCM"`. */
  algorithm: string;
}

/** Whether a collection's derived key is held in memory right now. */
export interface CollectionStatus {
  id: string;
  /**
   * In-memory only, session-scoped, never persisted. False after a relaunch,
   * always.
   */
  unlocked: boolean;
}

/** What the settings UI needs to render the collections list. */
export interface CollectionsOverview {
  collections: CollectionRecord[];
  /**
   * Unlock state per collection.
   *
   * **Cardinality is deliberately not guaranteed.** A backend may report one
   * entry per collection, or only the collections whose derived key it is
   * actually holding — and one holding nothing will plausibly report an empty
   * array. Both are correct.
   *
   * So a client must treat a **missing entry as locked**, never as unknown and
   * never as unlocked. That asymmetry is the whole safety property here: the
   * two operations that re-seal the envelope are the ones gated on this, and
   * defaulting to unlocked would offer them when they cannot work. Reading it
   * the safe way costs a refusal the user can act on; reading it the unsafe
   * way costs an operation that fails for a reason the screen denied.
   */
  statuses: CollectionStatus[];
  /**
   * Keys that are in no collection.
   *
   * These still work exactly as they always have — a per-key password, or the
   * OS vault. Collections are additive and nothing is forced into one.
   */
  unassignedKeyIds: string[];
}

/**
 * Every way a collection operation can refuse.
 *
 * Pinned by a test in `bc-collections`: each string here must appear in this
 * file, so adding a variant to the Rust without adding it here fails by name.
 */
export type CollectionFailureCode =
  /** No collection with that id. */
  | "not-found"
  /** The operation needs the collection's derived key and it is not held. */
  | "locked"
  /** The passphrase did not open the envelope. */
  | "wrong-passphrase"
  /** No passphrase was supplied where one is required. */
  | "no-passphrase"
  /** The key is already in this collection, or in another one. */
  | "already-member"
  /** The key is not in this collection. */
  | "not-a-member"
  /**
   * The key's own secret could not be read, so there is nothing to seal.
   *
   * The two-passphrase constraint from the header, as a code. The caller has
   * to open the key first — its password, or the OS vault — and retry.
   */
  | "key-locked"
  /** Adding would exceed `MAX_COLLECTION_MEMBERS`, or the seal would exceed 64 KiB. */
  | "too-large"
  /** A collection with that label already exists. */
  | "duplicate-label"
  /** The label is empty, or longer than `MAX_COLLECTION_LABEL_LENGTH`. */
  | "invalid-label"
  /** The envelope or its payload could not be parsed. */
  | "corrupt"
  /** The payload was written by a newer version of this app. */
  | "payload-too-new"
  /** The backend refused for a reason it reports in a message. */
  | "backend-error";

/** A refusal, with the verbatim backend message where there is one. */
export interface CollectionFailure {
  code: CollectionFailureCode;
  /**
   * The backend's own words, in English, or `null`.
   *
   * Frame it, never promise to translate it — the same rule as sync's
   * `{{message}}`. And do not render it for a code whose meaning already says
   * everything: a detail line under a `locked` refusal adds nothing and
   * invites quoting something irrelevant as though it were an explanation.
   */
  message: string | null;
}

export type CollectionOutcome =
  { state: "ok" } | ({ state: "failed" } & CollectionFailure);

/** The commands the frontend may invoke. Names are the IPC contract. */
export const COLLECTION_COMMANDS = {
  list: "list_collections",
  create: "create_collection",
  rename: "rename_collection",
  delete: "delete_collection",
  unlock: "unlock_collection",
  lock: "lock_collection",
  addKey: "add_key_to_collection",
  removeKey: "remove_key_from_collection",
  rotate: "rotate_collection_passphrase",
} as const;

export type CollectionCommand =
  (typeof COLLECTION_COMMANDS)[keyof typeof COLLECTION_COMMANDS];

export interface CollectionCommandArgs {
  [COLLECTION_COMMANDS.list]: Record<string, never>;
  [COLLECTION_COMMANDS.create]: { label: string; passphrase: string };
  [COLLECTION_COMMANDS.rename]: { id: string; label: string };
  /**
   * Deleting a collection destroys its envelope, and that is what un-members
   * every key in it: membership *is* the envelope, so there is no second
   * record to clear. See the header on where membership lives.
   *
   * **No key is lost**, because every key still has its own envelope — that is
   * what the header's recoverability argument buys, and it is why this command
   * does not need the collection unlocked.
   */
  [COLLECTION_COMMANDS.delete]: { id: string };
  [COLLECTION_COMMANDS.unlock]: { id: string; passphrase: string };
  /** Drops the derived key from memory. Always succeeds. */
  [COLLECTION_COMMANDS.lock]: { id: string };
  /**
   * `keyPassword` opens the key so its secret can be sealed into the
   * collection. It is omitted when the OS vault already holds the decrypted
   * key; the backend answers `key-locked` if neither route works.
   */
  [COLLECTION_COMMANDS.addKey]: {
    id: string;
    keyId: string;
    keyPassword?: string;
  };
  [COLLECTION_COMMANDS.removeKey]: { id: string; keyId: string };
  /**
   * Re-seals the envelope under a new passphrase. Requires the old one
   * rather than relying on the collection being unlocked: an unlocked
   * collection would let someone who walked up to an open app change the
   * passphrase without knowing it.
   *
   * This rotates the collection only. Each member key's own password is
   * untouched and still opens that key — see the header.
   */
  [COLLECTION_COMMANDS.rotate]: {
    id: string;
    currentPassphrase: string;
    newPassphrase: string;
  };
}

/**
 * What each command answers with.
 *
 * This map did not exist in the first draft of this contract, and the gap was
 * found the only way it could be — by the first agent to build a client
 * against it, who had to *infer* that `list` answers with an overview and the
 * other eight with an outcome, because `CollectionsOverview` and
 * `CollectionOutcome` were both declared and neither was tied to a command.
 * An inference that happens to be right is still an inference, and the next
 * reader gets no help from it.
 *
 * `lock` is the one worth stating rather than leaving to reason. It cannot
 * fail — there is nothing to refuse, since dropping a key from memory
 * succeeds whether or not the key was there — so the obvious Rust is a
 * function returning unit, which reaches the frontend as `null`. A client
 * must read an empty answer from this command as success. That is safe to
 * rely on **because every refusal carries a code**: a `CollectionFailure`
 * without one is not representable, so an empty answer cannot be a refusal
 * wearing a disguise. Spelled out because a client that treated `null` as a
 * failure would report a lock that worked as a lock that did not, and
 * nothing on the Rust side would look wrong.
 *
 * `src/lib/sync/types.ts` has the same gap and has shipped with it. It is
 * worth closing there too, but not by guessing from this file — the sync
 * commands' answers should be read off `src-tauri/src/commands/sync.rs`.
 */
export interface CollectionCommandResults {
  [COLLECTION_COMMANDS.list]: CollectionsOverview;
  [COLLECTION_COMMANDS.create]: CollectionOutcome;
  [COLLECTION_COMMANDS.rename]: CollectionOutcome;
  [COLLECTION_COMMANDS.delete]: CollectionOutcome;
  [COLLECTION_COMMANDS.unlock]: CollectionOutcome;
  /** `null` — see above. Read it as success, never as a refusal. */
  [COLLECTION_COMMANDS.lock]: null;
  [COLLECTION_COMMANDS.addKey]: CollectionOutcome;
  [COLLECTION_COMMANDS.removeKey]: CollectionOutcome;
  [COLLECTION_COMMANDS.rotate]: CollectionOutcome;
}

/**
 * # What happens when a member key is deleted
 *
 * The header above reasons carefully about deleting a **collection** and
 * concludes that no key is lost. It said nothing about the other direction,
 * and that was a hole in the design rather than in the prose — found by the
 * first agent to build the panel, who could render the consequence but could
 * not answer it.
 *
 * The consequence, if nothing is specified: a key deleted from `bc-storage`
 * while it is a member leaves its secret inside the collection's sealed
 * plaintext, and its id inside `memberIds`. The user has destroyed a key and
 * the app is still holding its secret — in a file it will happily sync to a
 * Nextcloud server or a shared folder. That is the one outcome this feature
 * must not have, because it is the opposite of what deleting a key means.
 *
 * **The rule: deleting a key re-seals every collection that holds it, without
 * it.** Not "refuses while the key is a member", which would make deleting a
 * key impossible until the user hunted down a collection they may not
 * remember joining. Not "clears `memberIds` and leaves the envelope", which
 * is the silent-retention bug wearing a tidy index.
 *
 * ## The cost, stated rather than discovered
 *
 * Re-sealing needs the collection's passphrase, so this rule makes key
 * deletion **depend on an unlock**. Three cases, and the third is the one that
 * needs a decision from whoever implements it:
 *
 * 1. The key is in no collection — delete it, nothing else to do.
 * 2. The key is in an unlocked collection — delete it and re-seal.
 * 3. The key is in a **locked** collection — the secret cannot be removed
 *    without the passphrase. Deleting the key here and re-sealing later is
 *    not available: there is nothing to re-seal *from* without opening the
 *    envelope.
 *
 * For case 3 the honest options are to prompt for the passphrase as part of
 * deleting the key, or to refuse with a message naming the collection. Both
 * are defensible; **what is not defensible is deleting the key and leaving
 * the envelope**, which is case 3 handled by ignoring it. If this is ever
 * implemented as "best effort, re-seal what we can", that is case 3 handled
 * by ignoring it with extra steps.
 *
 * ## Until it is implemented
 *
 * Nothing in the shipped code deletes a key from a collection's envelope, so
 * the hole is open. The panel renders an id it has no key for as a named
 * "no longer stored on this device" row rather than a blank line, which keeps
 * the *display* honest and is not a fix. A `CollectionFailureCode` for case 3
 * is not in the list above because the command that would raise it does not
 * exist yet — add it with the implementation, not before.
 */
export const MEMBER_KEY_DELETION_IS_UNIMPLEMENTED = true;
