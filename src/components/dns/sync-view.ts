/**
 * The decisions behind the Sync settings panel, as functions over the contract
 * types.
 *
 * Everything here is the part of that screen that can be wrong without
 * throwing: whether a secret field means "leave it alone", whether anything is
 * actually unsaved, and what a cadence the backend adjusted should be reported
 * as. `src/components/dns/SyncSettings.tsx` is then markup, words and one hook
 * call — the same split `@/lib/history/undo` has with `UndoPreviewDialog`, and
 * for the same reason: the rules are worth testing without a DOM.
 *
 * No `t()` calls live here. The words are in the panel, where the reader of a
 * sentence can see the markup it sits in.
 */
import type {
  SyncManifest,
  SyncOutcome,
  SyncSettings,
  SyncSettingsInput,
  SyncStatus,
} from "@/lib/sync/types";

/**
 * What the user has done to one write-only secret field.
 *
 * The backend never returns a secret — {@link SyncSettings} carries only
 * `credentialPresent` and `passphrasePresent` — so the field cannot be a
 * string with the stored value in it. What it can be is a record of the
 * user's *intent*, which is the three cases
 * {@link SyncSettingsInput.credential} distinguishes and nothing less:
 *
 * - `keep` — the field was not touched, or was opened and left empty. The
 *   stored secret stays as it is.
 * - `clear` — the user asked for the stored secret to be removed.
 * - `set` — a replacement was typed.
 */
export type SyncSecretDraft =
  | { readonly mode: "keep" }
  | { readonly mode: "clear" }
  | { readonly mode: "set"; readonly value: string };

/** The resting state of a secret field: stored secret untouched. */
export const SYNC_SECRET_KEEP: SyncSecretDraft = { mode: "keep" };

/**
 * The value a secret field contributes to {@link SyncSettingsInput}, where
 * `undefined` means the key is left out of the payload entirely.
 *
 * The `set` branch is the one that matters. A box the user opened and then
 * left empty is *not* a request to delete the stored secret — it is a request
 * they have not finished — so it maps to `undefined` like an untouched field,
 * and only the explicit `clear` sends `""`. Mapping an empty box to `""`
 * instead would mean a user who clicked Replace, changed their mind and
 * pressed Save deleted the credential they were trying to keep.
 */
export function syncSecretInput(draft: SyncSecretDraft): string | undefined {
  switch (draft.mode) {
    case "keep":
      return undefined;
    case "clear":
      return "";
    case "set":
      return draft.value === "" ? undefined : draft.value;
  }
}

/** True when this draft would remove a stored secret. */
export function syncSecretClears(draft: SyncSecretDraft): boolean {
  return syncSecretInput(draft) === "";
}

/** True when this draft would write a new secret. */
export function syncSecretReplaces(draft: SyncSecretDraft): boolean {
  const value = syncSecretInput(draft);
  return value !== undefined && value !== "";
}

/**
 * The editable, non-secret half of the settings.
 *
 * Derived from {@link SyncSettings} rather than restated, so a field added to
 * the contract is a type error here instead of a field the panel silently
 * stops sending. The four omitted names are the ones the backend owns:
 * `version` is its own, the two `*Present` booleans are reports about the
 * keyring, and `lastSyncedAt` is a record of what happened.
 */
export type SyncDraft = Omit<
  SyncSettings,
  "version" | "credentialPresent" | "passphrasePresent" | "lastSyncedAt"
>;

/** The draft a freshly loaded status starts from. */
export function syncDraftFromSettings(settings: SyncSettings): SyncDraft {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    webdavUrl: settings.webdavUrl,
    webdavUsername: settings.webdavUsername,
    autoPushMinutes: settings.autoPushMinutes,
  };
}

export function syncDraftsEqual(a: SyncDraft, b: SyncDraft): boolean {
  return (
    a.enabled === b.enabled &&
    a.provider === b.provider &&
    a.webdavUrl === b.webdavUrl &&
    a.webdavUsername === b.webdavUsername &&
    a.autoPushMinutes === b.autoPushMinutes
  );
}

/**
 * The payload for `configure_sync`.
 *
 * A secret whose draft contributes `undefined` is left out of the object
 * rather than set to `undefined`, so that "I did not touch this field" is
 * absent on the wire and not a key whose value happens to serialise away. The
 * difference is invisible in JSON and very visible in a test, which is the
 * point: the claim being made is about the shape the backend is handed.
 */
export function syncSettingsInput(
  draft: SyncDraft,
  credential: SyncSecretDraft,
  passphrase: SyncSecretDraft,
): SyncSettingsInput {
  const credentialValue = syncSecretInput(credential);
  const passphraseValue = syncSecretInput(passphrase);
  return {
    ...draft,
    ...(credentialValue === undefined ? {} : { credential: credentialValue }),
    ...(passphraseValue === undefined ? {} : { passphrase: passphraseValue }),
  };
}

/** True when Save would change something the backend is storing. */
export function syncPanelDirty(
  draft: SyncDraft,
  settings: SyncSettings,
  credential: SyncSecretDraft,
  passphrase: SyncSecretDraft,
): boolean {
  if (!syncDraftsEqual(draft, syncDraftFromSettings(settings))) return true;
  return (
    syncSecretInput(credential) !== undefined ||
    syncSecretInput(passphrase) !== undefined
  );
}

/**
 * The cadence the backend stored, when it is not the one that was asked for.
 *
 * The bounds live in Rust (`MIN_AUTO_PUSH_MINUTES` / `MAX_AUTO_PUSH_MINUTES`)
 * and the contract does not export them, so this screen cannot claim a range
 * — see the note in `SyncSettings.tsx`. What it can do is read back what was
 * actually stored and say so, which is true whatever the bounds are and stays
 * true when they move.
 */
export function syncCadenceAdjustment(
  requested: number | null,
  confirmed: number | null,
): number | null {
  if (requested === null || confirmed === null) return null;
  return requested === confirmed ? null : confirmed;
}

/** The manifest an outcome carries, or `null` for the shapes with none. */
export function syncOutcomeManifest(outcome: SyncOutcome): SyncManifest | null {
  switch (outcome.state) {
    case "ok":
    case "unchanged":
      return outcome.manifest;
    case "conflict":
      return outcome.conflict.remote;
    case "failed":
      return null;
  }
}

/**
 * The cadence bounds, read from the status rather than restated.
 *
 * A thin accessor so that the one place the panel needs `min`/`max` does not
 * reach three levels into `SyncStatus` inline, and so that the next field the
 * backend starts carrying has somewhere obvious to go. The numbers themselves
 * are `MIN_AUTO_PUSH_MINUTES` and `MAX_AUTO_PUSH_MINUTES` in Rust; nothing
 * here may copy them.
 */
export function syncCadenceRange(status: SyncStatus): {
  min: number;
  max: number;
} {
  return {
    min: status.autoPushMinutesRange.min,
    max: status.autoPushMinutesRange.max,
  };
}
