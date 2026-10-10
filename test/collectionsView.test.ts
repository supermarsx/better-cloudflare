/**
 * The Collections panel's rules, without a DOM.
 *
 * Four of these are contract facts rather than preferences, and each one is a
 * way the panel could lie about something that costs a user their API keys or
 * their confidence in them:
 *
 * - **A collection defaults to locked.** Unlock state lives in the backend's
 *   memory for the session only, so after a relaunch there are no statuses at
 *   all and every collection must read as locked. A default of "unlocked
 *   unless told otherwise" would render that lie on the very first paint,
 *   which is where it is least likely to be noticed.
 * - **Exactly two operations need the derived key.** Adding and removing a key
 *   re-seal the envelope; renaming, deleting and rotating deliberately do not,
 *   and `delete` not needing it is the recoverability argument paying out. A
 *   UI that demanded an unlock to delete would be asking for a passphrase to
 *   destroy something no key depends on.
 * - **A refusal's detail line is for the two codes that have something to
 *   say.** The contract asks for this by name: a verbatim message under a
 *   `locked` refusal adds nothing and invites quoting something irrelevant as
 *   though it were an explanation.
 * - **An id with no key renders as a remark, not as a blank line.**
 *   `memberIds` is a cleartext index kept beside the key records rather than
 *   inside them, so the two can drift.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectionActionNeedsUnlock,
  collectionIsFull,
  collectionLabelProblem,
  collectionMemberRows,
  collectionShowsDetail,
  isCollectionUnlocked,
  unassignedKeyRows,
  type CollectionKeySummary,
} from "../src/components/collections/collections-view";
import {
  MAX_COLLECTION_LABEL_LENGTH,
  MAX_COLLECTION_MEMBERS,
  type CollectionFailureCode,
  type CollectionRecord,
  type CollectionsOverview,
} from "../src/lib/collections/types";

function record(overrides: Partial<CollectionRecord> = {}): CollectionRecord {
  return {
    id: "col-1",
    label: "Work",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-09T09:00:00.000Z",
    memberIds: [],
    iterations: 600_000,
    // Bytes, not bits: `bc_crypto::AES_256_KEY_LENGTH_BYTES` is 32. This
    // fixture said 256 while the contract said "bits", and both were wrong —
    // a value `validate_key_length` would have rejected, sitting in a fixture
    // for the next reader to copy.
    keyLength: 32,
    algorithm: "PBKDF2-SHA256/AES-256-GCM",
    ...overrides,
  };
}

function overview(
  overrides: Partial<CollectionsOverview> = {},
): CollectionsOverview {
  return {
    collections: [record()],
    statuses: [],
    unassignedKeyIds: [],
    ...overrides,
  };
}

const KEYS: readonly CollectionKeySummary[] = [
  { id: "key-b", label: "Beta account", email: "beta@example.test" },
  { id: "key-a", label: "Alpha account" },
];

test("a collection with no reported status is locked, not unlocked", () => {
  // The relaunch case: the backend holds nothing, so it reports nothing.
  assert.equal(isCollectionUnlocked(overview(), "col-1"), false);
  // And an id that is not in the list at all is not somehow open either.
  assert.equal(
    isCollectionUnlocked(
      overview({ statuses: [{ id: "col-2", unlocked: true }] }),
      "col-1",
    ),
    false,
  );
});

test("a collection is unlocked only when its own status says so", () => {
  assert.equal(
    isCollectionUnlocked(
      overview({ statuses: [{ id: "col-1", unlocked: true }] }),
      "col-1",
    ),
    true,
  );
  assert.equal(
    isCollectionUnlocked(
      overview({ statuses: [{ id: "col-1", unlocked: false }] }),
      "col-1",
    ),
    false,
  );
});

test("adding and removing a key need the derived key, and nothing else does", () => {
  assert.equal(collectionActionNeedsUnlock("add-key"), true);
  assert.equal(collectionActionNeedsUnlock("remove-key"), true);
  // Each of these is a contract decision rather than an oversight, so each is
  // named rather than covered by a loop that would pass if one flipped.
  assert.equal(
    collectionActionNeedsUnlock("delete"),
    false,
    "deleting demanded an unlock, which asks for a passphrase to destroy something no key depends on",
  );
  assert.equal(collectionActionNeedsUnlock("rename"), false);
  assert.equal(
    collectionActionNeedsUnlock("rotate"),
    false,
    "rotating demanded an unlock, but it takes the old passphrase precisely so it does not rely on one",
  );
  assert.equal(collectionActionNeedsUnlock("create"), false);
  assert.equal(collectionActionNeedsUnlock("unlock"), false);
  assert.equal(collectionActionNeedsUnlock("lock"), false);
});

test("a label is refused for the three reasons the backend refuses one", () => {
  const existing = [record({ id: "col-1", label: "Work" })];
  assert.equal(collectionLabelProblem("Personal", existing), null);
  assert.equal(collectionLabelProblem("", existing), "empty");
  // Whitespace is not a name. Trimmed before the length check too, so a
  // padded label is not rejected for a length its stored form will not have.
  assert.equal(collectionLabelProblem("   ", existing), "empty");
  assert.equal(
    collectionLabelProblem("a".repeat(MAX_COLLECTION_LABEL_LENGTH), existing),
    null,
  );
  assert.equal(
    collectionLabelProblem(
      "a".repeat(MAX_COLLECTION_LABEL_LENGTH + 1),
      existing,
    ),
    "too-long",
  );
  assert.equal(collectionLabelProblem("Work", existing), "duplicate");
  assert.equal(collectionLabelProblem("  Work  ", existing), "duplicate");
});

test("renaming a collection to the name it already has is not a duplicate", () => {
  const existing = [
    record({ id: "col-1", label: "Work" }),
    record({ id: "col-2", label: "Personal" }),
  ];
  // Without the exclusion, Rename would be disabled on every collection the
  // moment it opened, reporting the collection as a clash with itself.
  assert.equal(collectionLabelProblem("Work", existing, "col-1"), null);
  // The other one's name is still taken.
  assert.equal(
    collectionLabelProblem("Personal", existing, "col-1"),
    "duplicate",
  );
});

test("the member cap is reached at the limit, not past it", () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_unused, index) => `key-${index}`);
  assert.equal(
    collectionIsFull(record({ memberIds: ids(MAX_COLLECTION_MEMBERS - 1) })),
    false,
  );
  assert.equal(
    collectionIsFull(record({ memberIds: ids(MAX_COLLECTION_MEMBERS) })),
    true,
  );
});

test("only the two codes with something to add carry a detail line", () => {
  assert.equal(collectionShowsDetail("backend-error"), true);
  assert.equal(collectionShowsDetail("corrupt"), true);
  // The code the contract names: its sentence is already the whole
  // explanation, and a quoted message under it would be presented as one.
  assert.equal(
    collectionShowsDetail("locked"),
    false,
    "a locked refusal was given a detail line, which the contract asks it not to have",
  );
  const silent: readonly CollectionFailureCode[] = [
    "not-found",
    "locked",
    "wrong-passphrase",
    "no-passphrase",
    "already-member",
    "not-a-member",
    "key-locked",
    "too-large",
    "duplicate-label",
    "invalid-label",
    "payload-too-new",
  ];
  for (const code of silent) {
    assert.equal(
      collectionShowsDetail(code),
      false,
      `${code} was given a detail line`,
    );
  }
});

test("a member id with no stored key is reported, not rendered blank", () => {
  const rows = collectionMemberRows(
    record({ memberIds: ["key-a", "key-gone"] }),
    KEYS,
  );
  const gone = rows.find((row) => row.id === "key-gone");
  assert.ok(gone, "the unresolved id was dropped from the list");
  assert.ok(
    gone.label === null,
    "an id with no key was given a label it does not have",
  );
  // Last, so it reads as a remark about the list rather than as the list.
  assert.equal(rows[rows.length - 1]?.id, "key-gone");
});

test("members and unassigned keys are ordered by name, not by backend order", () => {
  // `memberIds` is documented as being in no meaningful order, so a list that
  // followed it would reshuffle itself every time a key was added.
  assert.deepEqual(
    collectionMemberRows(record({ memberIds: ["key-b", "key-a"] }), KEYS).map(
      (row) => row.label,
    ),
    ["Alpha account", "Beta account"],
  );
  assert.deepEqual(
    unassignedKeyRows(
      overview({ unassignedKeyIds: ["key-b", "key-a"] }),
      KEYS,
    ).map((row) => row.label),
    ["Alpha account", "Beta account"],
  );
});

test("a key's email travels with it, and its absence is not an empty string", () => {
  const rows = unassignedKeyRows(
    overview({ unassignedKeyIds: ["key-a", "key-b"] }),
    KEYS,
  );
  assert.equal(rows[0]?.email, null);
  assert.equal(rows[1]?.email, "beta@example.test");
});
