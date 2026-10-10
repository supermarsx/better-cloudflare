/**
 * The sync panel's rules, without a DOM.
 *
 * One of these matters far more than the rest. `SyncSettingsInput` gives each
 * write-only secret three meanings — absent leaves the stored secret alone,
 * `""` deletes it, anything else replaces it — and the dangerous pair is the
 * first two, because they are one keystroke apart on screen and the difference
 * between "I did not touch that" and "delete my Nextcloud app password". So
 * the three are pinned as three distinct payload shapes, and the case where a
 * user opens the replace box and then leaves it empty is pinned separately:
 * that is a half-finished edit, not a deletion, and mapping it to `""` would
 * destroy the credential of someone who changed their mind.
 *
 * `syncPanelDirty` is here for the same reason from the other side: it is what
 * decides whether Save is offered at all, so a secret draft it failed to
 * notice would be a deletion the user could not perform, and a clean draft it
 * called dirty would be a configure call that rewrites the keyring for nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SYNC_SECRET_KEEP,
  syncCadenceAdjustment,
  syncDraftFromSettings,
  syncDraftsEqual,
  syncOutcomeManifest,
  syncPanelDirty,
  syncProviderIncomplete,
  syncSecretClears,
  syncSecretInput,
  syncSecretReplaces,
  syncSettingsInput,
  type SyncDraft,
} from "../src/components/dns/sync-view";
import type {
  SyncManifest,
  SyncSettings,
  SyncSettingsInput,
} from "../src/lib/sync/types";

function manifest(overrides: Partial<SyncManifest> = {}): SyncManifest {
  return {
    generation: 4,
    checksum: "a".repeat(64),
    bytes: 2048,
    writtenAt: "2026-10-09T09:00:00.000Z",
    deviceId: "device-a",
    deviceLabel: "Windows 11",
    payloadVersion: 1,
    iterations: 600_000,
    keyLength: 32,
    algorithm: "PBKDF2-HMAC-SHA256",
    ...overrides,
  };
}

function settings(overrides: Partial<SyncSettings> = {}): SyncSettings {
  return {
    version: 1,
    enabled: true,
    provider: "nextcloud",
    webdavUrl: "https://cloud.example.test/remote.php/dav/files/alice/bc",
    webdavUsername: "alice",
    folderPath: null,
    credentialPresent: true,
    passphrasePresent: true,
    autoPushMinutes: null,
    lastSyncedAt: "2026-10-09T09:00:00.000Z",
    ...overrides,
  };
}

const DRAFT: SyncDraft = syncDraftFromSettings(settings());

test("an untouched secret is absent from the payload, never empty", () => {
  assert.equal(syncSecretInput(SYNC_SECRET_KEEP), undefined);

  const input = syncSettingsInput(DRAFT, SYNC_SECRET_KEEP, SYNC_SECRET_KEEP);
  // `in` rather than a value comparison: the claim is about the shape handed
  // to `configure_sync`, and `{ credential: undefined }` would satisfy a
  // value check while still being a key the backend has to decide about.
  assert.ok(
    !("credential" in input),
    `an untouched credential must not appear in the payload: ${JSON.stringify(input)}`,
  );
  assert.ok(
    !("passphrase" in input),
    `an untouched passphrase must not appear in the payload: ${JSON.stringify(input)}`,
  );
});

test("the three secret states are three different payloads", () => {
  const keep = syncSettingsInput(DRAFT, SYNC_SECRET_KEEP, SYNC_SECRET_KEEP);
  const cleared = syncSettingsInput(DRAFT, { mode: "clear" }, SYNC_SECRET_KEEP);
  const replaced = syncSettingsInput(
    DRAFT,
    { mode: "set", value: "app-password" },
    SYNC_SECRET_KEEP,
  );

  assert.equal("credential" in keep, false);
  assert.equal(cleared.credential, "");
  assert.equal(replaced.credential, "app-password");

  // And the three are distinguishable as serialised, which is the form the
  // backend actually sees.
  const shapes = new Set(
    [keep, cleared, replaced].map((input) => JSON.stringify(input)),
  );
  assert.equal(shapes.size, 3);
});

test("a replace box left empty leaves the stored secret alone", () => {
  const draft = { mode: "set", value: "" } as const;
  assert.equal(syncSecretInput(draft), undefined);
  assert.equal(syncSecretClears(draft), false);
  assert.equal(syncSecretReplaces(draft), false);

  const input = syncSettingsInput(DRAFT, draft, draft);
  assert.ok(
    !("credential" in input) && !("passphrase" in input),
    "an empty replace box must not be sent as a deletion",
  );
});

test("clear and replace are reported as what they do", () => {
  assert.equal(syncSecretClears({ mode: "clear" }), true);
  assert.equal(syncSecretReplaces({ mode: "clear" }), false);
  assert.equal(syncSecretReplaces({ mode: "set", value: "x" }), true);
  assert.equal(syncSecretClears({ mode: "set", value: "x" }), false);
  assert.equal(syncSecretClears(SYNC_SECRET_KEEP), false);
  assert.equal(syncSecretReplaces(SYNC_SECRET_KEEP), false);
});

test("the payload carries the draft's own fields unchanged", () => {
  const draft: SyncDraft = {
    enabled: false,
    provider: "folder",
    webdavUrl: null,
    webdavUsername: null,
    folderPath: "C:/Users/alice/Drive/better-cloudflare",
    autoPushMinutes: 45,
  };
  const input: SyncSettingsInput = syncSettingsInput(
    draft,
    SYNC_SECRET_KEEP,
    SYNC_SECRET_KEEP,
  );
  assert.deepEqual(input, draft);
});

test("dirty is false for an untouched draft and true for each change", () => {
  const stored = settings();
  assert.equal(
    syncPanelDirty(
      syncDraftFromSettings(stored),
      stored,
      SYNC_SECRET_KEEP,
      SYNC_SECRET_KEEP,
    ),
    false,
  );

  assert.equal(
    syncPanelDirty(
      { ...syncDraftFromSettings(stored), webdavUsername: "bob" },
      stored,
      SYNC_SECRET_KEEP,
      SYNC_SECRET_KEEP,
    ),
    true,
  );
  // A secret the user means to change is the only change there is to see: the
  // non-secret half of the draft still matches what is stored.
  assert.equal(
    syncPanelDirty(
      syncDraftFromSettings(stored),
      stored,
      { mode: "clear" },
      SYNC_SECRET_KEEP,
    ),
    true,
  );
  assert.equal(
    syncPanelDirty(syncDraftFromSettings(stored), stored, SYNC_SECRET_KEEP, {
      mode: "set",
      value: "new",
    }),
    true,
  );
  // An opened-and-empty box is not a change, so Save is not offered for it.
  assert.equal(
    syncPanelDirty(syncDraftFromSettings(stored), stored, SYNC_SECRET_KEEP, {
      mode: "set",
      value: "",
    }),
    false,
  );
});

test("a draft follows every field the contract gives the renderer", () => {
  // Guards the `Omit` in `SyncDraft`: a new editable field in `SyncSettings`
  // that `syncDraftFromSettings` forgets would be a setting the panel shows
  // and never sends, which nothing else here would notice.
  const stored = settings({
    enabled: false,
    provider: "folder",
    webdavUrl: null,
    webdavUsername: null,
    folderPath: "C:/Users/alice/Drive/better-cloudflare",
    autoPushMinutes: 60,
  });
  const draft = syncDraftFromSettings(stored);
  assert.deepEqual(Object.keys(draft).sort(), [
    "autoPushMinutes",
    "enabled",
    "folderPath",
    "provider",
    "webdavUrl",
    "webdavUsername",
  ]);
  assert.equal(syncDraftsEqual(draft, syncDraftFromSettings(stored)), true);
  assert.equal(
    syncDraftsEqual(draft, { ...draft, autoPushMinutes: 61 }),
    false,
  );
  // The folder path is the newest field and the one a comparison written
  // against the old shape would miss, which would make choosing a different
  // folder a change Save never offered to store.
  assert.equal(
    syncDraftsEqual(draft, { ...draft, folderPath: "C:/elsewhere" }),
    false,
  );
});

test("an incomplete provider is named by the field its engine would miss", () => {
  // A mirror of `bc_sync::build_engine`, which answers `not-configured` when
  // the field its provider needs is missing or blank. The screen says the same
  // thing one step earlier, so the warning has to agree with that function
  // field for field — including the order, because Nextcloud needs both and
  // naming the second while the first is also empty would send someone to fix
  // the wrong box.
  const complete = syncDraftFromSettings(settings());
  assert.equal(syncProviderIncomplete(complete), null);
  assert.equal(
    syncProviderIncomplete({ ...complete, webdavUrl: null }),
    "webdavUrl",
  );
  assert.equal(
    syncProviderIncomplete({ ...complete, webdavUsername: "   " }),
    "webdavUsername",
    "whitespace is not a username: `build_engine` trims before it decides",
  );
  assert.equal(
    syncProviderIncomplete({
      ...complete,
      webdavUrl: null,
      webdavUsername: null,
    }),
    "webdavUrl",
    "the first missing field is the one to name",
  );

  // A folder needs its path and nothing else — in particular not a credential,
  // which it has no slot for, and not the WebDAV fields, which it ignores.
  const folder = syncDraftFromSettings(
    settings({
      provider: "folder",
      webdavUrl: null,
      webdavUsername: null,
      folderPath: "C:/Users/alice/Drive/better-cloudflare",
    }),
  );
  assert.equal(syncProviderIncomplete(folder), null);
  assert.equal(
    syncProviderIncomplete({ ...folder, folderPath: null }),
    "folderPath",
  );
  assert.equal(
    syncProviderIncomplete({ ...folder, folderPath: "  " }),
    "folderPath",
  );

  // No provider is not an incomplete provider. There is nothing to warn about
  // yet, and the panel already says "choose a provider" in that state.
  assert.equal(syncProviderIncomplete({ ...complete, provider: null }), null);
});

test("a cadence adjustment is reported only when the backend moved it", () => {
  assert.equal(syncCadenceAdjustment(30, 30), null);
  assert.equal(syncCadenceAdjustment(5, 15), 15);
  // Manual on either side is not an adjustment to report: the user switched
  // the schedule rather than had a number corrected.
  assert.equal(syncCadenceAdjustment(null, 15), null);
  assert.equal(syncCadenceAdjustment(15, null), null);
});

test("an outcome's manifest is the one that outcome is about", () => {
  const ok = manifest({ generation: 7 });
  const remote = manifest({ generation: 9, deviceId: "device-b" });
  assert.equal(syncOutcomeManifest({ state: "ok", manifest: ok }), ok);
  assert.equal(syncOutcomeManifest({ state: "unchanged", manifest: ok }), ok);
  assert.equal(
    syncOutcomeManifest({
      state: "conflict",
      conflict: { local: ok, remote, expectedGeneration: 7 },
    }),
    remote,
  );
  assert.equal(
    syncOutcomeManifest({
      state: "failed",
      code: "unreachable",
      message: null,
    }),
    null,
  );
});
