/**
 * The decisions behind the Collections settings panel, as functions over the
 * contract types.
 *
 * Everything here is the part of that screen that can be wrong without
 * throwing: whether a collection is unlocked, whether an operation needs it to
 * be, whether a label will be refused, and whether a refusal has a detail line
 * worth printing. `./CollectionsSettings.tsx` is then markup, words and one
 * hook call — the same split `./../dns/sync-view.ts` has with
 * `SyncSettings.tsx`, and for the same reason: the rules are worth testing
 * without a DOM.
 *
 * No `t()` calls live here. The words are in the panel, where the reader of a
 * sentence can see the markup it sits in.
 */
import {
  MAX_COLLECTION_LABEL_LENGTH,
  MAX_COLLECTION_MEMBERS,
  type CollectionFailureCode,
  type CollectionRecord,
  type CollectionsOverview,
} from "@/lib/collections/types";

/**
 * One thing the panel can ask the backend to do.
 *
 * Not the command names — those are {@link COLLECTION_COMMANDS} and are the
 * IPC contract. This is the set of *user intentions*, which is what decides
 * how a refusal is worded: `wrong-passphrase` means "that is not this
 * collection's passphrase" when unlocking and "the current one you typed is
 * not it, so nothing was changed" when rotating, and one sentence for both
 * gets the second one's reassurance wrong.
 */
export type CollectionAction =
  | "create"
  | "rename"
  | "delete"
  | "unlock"
  | "lock"
  | "add-key"
  | "remove-key"
  | "rotate";

/**
 * Whether this operation needs the collection's derived key in memory.
 *
 * The contract's `locked` code, one step earlier, on the screen that can fix
 * it — the same job `syncProviderIncomplete` does for `not-configured`.
 *
 * Exactly two operations re-seal the envelope and therefore need it open:
 * adding a key writes a new member secret into the plaintext, and removing one
 * writes the remaining members back out. The other six deliberately do not,
 * and each of those is a decision rather than an omission:
 *
 * - `delete` destroys the envelope, so there is nothing to open. This is the
 *   recoverability argument in the contract header paying out: no key is lost,
 *   so there is no reason to demand a passphrase for it.
 * - `rename` touches only the cleartext label.
 * - `rotate` takes the old passphrase as an argument instead, so that an
 *   unlocked collection in front of an unattended app cannot have its
 *   passphrase changed by someone who never knew it.
 * - `create`, `unlock` and `lock` carry or drop the key themselves.
 */
export function collectionActionNeedsUnlock(action: CollectionAction): boolean {
  return action === "add-key" || action === "remove-key";
}

/**
 * Whether this collection's derived key is held right now.
 *
 * Read off {@link CollectionsOverview.statuses} and **false when the id is not
 * in it**. That default is the point: unlock state is in the backend's memory
 * for the session only, so after a relaunch there are no statuses and every
 * collection is locked. A function that answered "unlocked unless told
 * otherwise" would render the lie the contract header spends a paragraph
 * forbidding — and it would do so precisely on the first paint after launch,
 * where it is least likely to be noticed.
 *
 * There is also nothing persisted for this to read. The panel holds no unlock
 * flag of its own either: the backend's answer is re-read after every
 * operation, so "unlocked" on screen always traces back to a status the
 * backend reported in this session.
 */
export function isCollectionUnlocked(
  overview: CollectionsOverview,
  id: string,
): boolean {
  return overview.statuses.some(
    (status) => status.id === id && status.unlocked,
  );
}

/** Why a label would be refused, or `null` when it would be accepted. */
export type CollectionLabelProblem = "empty" | "too-long" | "duplicate";

/**
 * What the backend will refuse about this label, said before it is sent.
 *
 * A mirror of the contract's `invalid-label` and `duplicate-label`, so a
 * hopeless Create or Rename is disabled with a reason instead of making a
 * round trip to be told no. The refusal codes are still worded by the panel:
 * this check runs on the panel's own list of collections, which a second
 * window can have moved on from.
 *
 * `excludeId` is the collection being renamed — otherwise renaming a
 * collection to the name it already has would report itself as a duplicate.
 *
 * **The comparison is exact, after trimming.** The contract does not say
 * whether the backend folds case, and the two possible mistakes are not
 * symmetrical: comparing case-insensitively here would disable a Create that
 * the backend would have accepted, which looks like a broken button, while
 * comparing exactly at worst lets a `duplicate-label` through to be worded as
 * a sentence. Guessing in the direction of the recoverable mistake.
 */
export function collectionLabelProblem(
  label: string,
  collections: readonly CollectionRecord[],
  excludeId?: string,
): CollectionLabelProblem | null {
  const trimmed = label.trim();
  if (trimmed === "") return "empty";
  if (trimmed.length > MAX_COLLECTION_LABEL_LENGTH) return "too-long";
  const clash = collections.some(
    (collection) => collection.id !== excludeId && collection.label === trimmed,
  );
  return clash ? "duplicate" : null;
}

/**
 * Whether this collection has reached the member cap.
 *
 * `MAX_COLLECTION_MEMBERS` is checked by the backend before it seals, so this
 * is the same refusal said earlier. It is deliberately **not** the whole of
 * `too-large`: the sealed form can exceed 64 KiB below the member cap, which
 * no renderer can predict, so the code still has to be worded for the case
 * where this returned `false` and the seal failed anyway.
 */
export function collectionIsFull(record: CollectionRecord): boolean {
  return record.memberIds.length >= MAX_COLLECTION_MEMBERS;
}

/**
 * Whether a refusal's verbatim `message` should be printed under it.
 *
 * The contract asks for this explicitly: a detail line under a `locked`
 * refusal adds nothing and invites quoting something irrelevant as though it
 * were an explanation. Taken to its conclusion that rules out every code whose
 * sentence is already complete, which is all but two:
 *
 * - `backend-error` is *defined* as "refused for a reason it reports in a
 *   message", so its message is the only content it has.
 * - `corrupt` is the one state where what could not be parsed is worth
 *   seeing, because the sentence can only say that something could not be.
 *
 * Every other code names its own cause. `wrong-passphrase` with "The provided
 * passphrase is incorrect" appended is the same sentence twice; `too-large`
 * with a byte count is a number the user cannot act on.
 */
export function collectionShowsDetail(code: CollectionFailureCode): boolean {
  return code === "backend-error" || code === "corrupt";
}

/** The little the panel needs to know about one stored API key. */
export interface CollectionKeySummary {
  id: string;
  label: string;
  email?: string;
}

/**
 * One row in a member or unassigned list.
 *
 * `label` is `null` for an id the host's key list does not contain. That is
 * not expected — the backend clears `collectionId` when a key is deleted — but
 * `memberIds` is a cleartext index maintained separately from the key records,
 * and a row rendering as an empty line would be the worst way to find out they
 * had drifted apart.
 */
export interface CollectionKeyRow {
  id: string;
  label: string | null;
  email: string | null;
}

function keyRows(
  ids: readonly string[],
  keys: readonly CollectionKeySummary[],
): CollectionKeyRow[] {
  const byId = new Map(keys.map((key) => [key.id, key]));
  return ids
    .map((id) => {
      const key = byId.get(id);
      return {
        id,
        label: key?.label ?? null,
        email: key?.email ?? null,
      };
    })
    .sort((a, b) => {
      // Sorted here rather than left as the backend sent it: `memberIds` is
      // documented as being in no meaningful order, so a list that followed it
      // would reshuffle itself every time a key was added. Unresolved ids go
      // last, where they read as a remark rather than as the list.
      if ((a.label === null) !== (b.label === null))
        return a.label === null ? 1 : -1;
      return (a.label ?? a.id).localeCompare(b.label ?? b.id);
    });
}

/** The keys this collection holds, in a stable order. */
export function collectionMemberRows(
  record: CollectionRecord,
  keys: readonly CollectionKeySummary[],
): CollectionKeyRow[] {
  return keyRows(record.memberIds, keys);
}

/** The keys in no collection, in a stable order. */
export function unassignedKeyRows(
  overview: CollectionsOverview,
  keys: readonly CollectionKeySummary[],
): CollectionKeyRow[] {
  return keyRows(overview.unassignedKeyIds, keys);
}
