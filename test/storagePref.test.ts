import assert from "node:assert/strict";
import { test } from "node:test";
import { storageManager } from "../src/lib/storage/storage.ts";

test("auto refresh preference persisted", async () => {
  storageManager.setAutoRefreshInterval(60000);
  const v = storageManager.getAutoRefreshInterval();
  assert.equal(v, 60000);
  storageManager.setAutoRefreshInterval(null);
  assert.equal(storageManager.getAutoRefreshInterval(), null);
});

test("vault enabled persisted", async () => {
  storageManager.setVaultEnabled(true);
  assert.equal(storageManager.getVaultEnabled(), true);
  storageManager.setVaultEnabled(false);
  assert.equal(storageManager.getVaultEnabled(), false);
});

test("bubble position round-trips as a pair", async () => {
  storageManager.setAiAssistantBubblePosition({ right: 120, bottom: 48 });
  assert.deepEqual(storageManager.getAiAssistantBubblePosition(), {
    right: 120,
    bottom: 48,
  });
});

test("a bubble inset of zero is a position, not an absence", async () => {
  // Flush against the edge is somewhere the user can legitimately put it, so
  // this must not be rejected as falsy.
  storageManager.setAiAssistantBubblePosition({ right: 0, bottom: 0 });
  assert.deepEqual(storageManager.getAiAssistantBubblePosition(), {
    right: 0,
    bottom: 0,
  });
});

test("half a bubble position is not a position", async () => {
  // A profile carrying one inset without the other would otherwise place the
  // bubble somewhere the user never put it, which is worse than the default
  // corner.
  storageManager.setAiAssistantBubblePosition({ right: 200, bottom: 100 });
  const profile = storageManager as unknown as {
    data: { assistantBubbleBottom?: number };
  };
  delete profile.data.assistantBubbleBottom;
  assert.equal(storageManager.getAiAssistantBubblePosition(), null);
});

test("an unusable bubble inset is refused rather than stored", async () => {
  storageManager.setAiAssistantBubblePosition({ right: 10, bottom: 10 });
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    storageManager.setAiAssistantBubblePosition({ right: bad, bottom: 10 });
    assert.deepEqual(
      storageManager.getAiAssistantBubblePosition(),
      { right: 10, bottom: 10 },
      `${bad} must not overwrite a usable position`,
    );
  }
});

test("a stored bubble position is kept unclamped", async () => {
  // Deliberate: the stored point is the user's choice, made in whatever window
  // they had. Fitting it to the current viewport is the renderer's job, so a
  // window briefly made small must not rewrite where the bubble lives.
  storageManager.setAiAssistantBubblePosition({
    right: 99_000,
    bottom: 99_000,
  });
  assert.deepEqual(storageManager.getAiAssistantBubblePosition(), {
    right: 99_000,
    bottom: 99_000,
  });
});

test("clearing settings forgets the bubble position too", async () => {
  // Every other assistant preference is dropped by `clearSettings`, so a
  // position left behind would survive a reset and put the bubble somewhere
  // the user did not choose in their reset session.
  storageManager.setAiAssistantBubblePosition({ right: 321, bottom: 123 });
  assert.notEqual(storageManager.getAiAssistantBubblePosition(), null);
  storageManager.clearSettings();
  assert.equal(storageManager.getAiAssistantBubblePosition(), null);
});

test("update checking is on by default and can be turned off", async () => {
  // Default on: a notifier that is off by default notifies nobody.
  storageManager.clearSettings();
  assert.equal(storageManager.getUpdateCheckEnabled(), true);
  storageManager.setUpdateCheckEnabled(false);
  assert.equal(storageManager.getUpdateCheckEnabled(), false);
});

test("the check interval is clamped on the way out, not just in", async () => {
  // GitHub rate-limits unauthenticated callers, so a hand-edited profile
  // holding 0 must not become a request per render.
  storageManager.clearSettings();
  assert.equal(storageManager.getUpdateCheckIntervalHours(), 24);
  const profile = storageManager as unknown as {
    data: { updateCheckIntervalHours?: unknown };
  };
  for (const [stored, expected] of [
    [0, 1],
    [-5, 1],
    [10_000, 168],
    [Number.NaN, 24],
    ["soon", 24],
  ] as Array<[unknown, number]>) {
    profile.data.updateCheckIntervalHours = stored;
    assert.equal(
      storageManager.getUpdateCheckIntervalHours(),
      expected,
      `stored ${String(stored)} should read back as ${expected}`,
    );
  }
});

test("pre-releases are excluded unless asked for", async () => {
  storageManager.clearSettings();
  assert.equal(storageManager.getUpdateCheckIncludePrereleases(), false);
  storageManager.setUpdateCheckIncludePrereleases(true);
  assert.equal(storageManager.getUpdateCheckIncludePrereleases(), true);
});

test("clearing settings forgets the update-check preferences", async () => {
  storageManager.setUpdateCheckEnabled(false);
  storageManager.setUpdateCheckIntervalHours(72);
  storageManager.setUpdateCheckIncludePrereleases(true);
  storageManager.clearSettings();
  assert.equal(storageManager.getUpdateCheckEnabled(), true);
  assert.equal(storageManager.getUpdateCheckIntervalHours(), 24);
  assert.equal(storageManager.getUpdateCheckIncludePrereleases(), false);
});

test("a check is due when it has never run, and not again until the interval", async () => {
  storageManager.clearSettings();
  assert.equal(storageManager.getUpdateCheckLastCheckedAt(), null);
  assert.equal(storageManager.isUpdateCheckDue(new Date()), true);

  const at = new Date("2026-10-07T12:00:00.000Z");
  storageManager.setUpdateCheckLastCheckedAt(at.toISOString());
  storageManager.setUpdateCheckIntervalHours(24);

  const hoursLater = (h: number) => new Date(at.getTime() + h * 60 * 60 * 1000);
  assert.equal(storageManager.isUpdateCheckDue(hoursLater(1)), false);
  assert.equal(storageManager.isUpdateCheckDue(hoursLater(23.9)), false);
  assert.equal(storageManager.isUpdateCheckDue(hoursLater(24)), true);
});

test("a disabled check is never due, however long it has been", async () => {
  // The switch has to beat the clock, or turning it off would still let a
  // launch spend a request.
  storageManager.clearSettings();
  storageManager.setUpdateCheckLastCheckedAt("2020-01-01T00:00:00.000Z");
  storageManager.setUpdateCheckEnabled(false);
  assert.equal(storageManager.isUpdateCheckDue(new Date()), false);
});

test("a stamp in the future makes a check due rather than parking it", async () => {
  // A clock moved back, or a profile copied from another machine, must not
  // suppress checking until that future date arrives.
  storageManager.clearSettings();
  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  storageManager.setUpdateCheckLastCheckedAt(future.toISOString());
  assert.equal(storageManager.isUpdateCheckDue(new Date()), true);
});

test("an unreadable last-checked stamp is refused and reads as never", async () => {
  storageManager.clearSettings();
  storageManager.setUpdateCheckLastCheckedAt("whenever");
  assert.equal(storageManager.getUpdateCheckLastCheckedAt(), null);
  assert.equal(storageManager.isUpdateCheckDue(new Date()), true);
});
