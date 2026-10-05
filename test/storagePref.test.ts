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
