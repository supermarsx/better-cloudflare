import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  toDesktopPropagationFields,
  usePropagationSettings,
} from "../src/hooks/dns/use-propagation-settings";
import { DEFAULT_PROPAGATION_RESOLVER_IDS } from "../src/lib/dns/propagation-resolvers";
import { storageManager } from "../src/lib/storage/storage";

beforeEach(() => {
  storageManager.resetPropagationSettings();
});

afterEach(() => {
  cleanup();
  storageManager.resetPropagationSettings();
});

test("starts from defaults and persists updates through storageManager", () => {
  const { result } = renderHook(() => usePropagationSettings());
  assert.deepEqual(result.current.settings.resolvers, [
    ...DEFAULT_PROPAGATION_RESOLVER_IDS,
  ]);
  assert.equal(result.current.settings.consensusPercent, 100);

  act(() => {
    result.current.update({
      resolvers: ["8.8.8.8", "1.1.1.1", "unknown"],
      customResolvers: ["9.9.9.11", "not-an-ip"],
      timeoutMs: 99_999,
      attempts: 2,
      consensusPercent: 90,
      watchIntervalS: 1,
    });
  });

  const expected = {
    resolvers: ["1.1.1.1", "8.8.8.8"],
    customResolvers: ["9.9.9.11"],
    timeoutMs: 15000,
    attempts: 2,
    consensusPercent: 90,
    watchIntervalS: 5,
  };
  assert.deepEqual(result.current.settings, expected);
  assert.deepEqual(storageManager.getPropagationSettings(), expected);

  // A fresh hook instance reads the persisted values back.
  const second = renderHook(() => usePropagationSettings());
  assert.deepEqual(second.result.current.settings, expected);
});

// `storageManager` dispatches `preferences-changed` with the global
// `CustomEvent`, which under the node test harness is Node's class rather than
// jsdom's; jsdom rejects it and `test/node-test-env.ts` swallows the throw. So
// the notification is replayed here with a jsdom-native event, exactly as the
// browser delivers it.
function notifyPreferencesChanged(detail: Record<string, unknown>): void {
  window.dispatchEvent(
    new window.CustomEvent("preferences-changed", { detail }),
  );
}

test("reflects preference changes made outside the hook", () => {
  const { result } = renderHook(() => usePropagationSettings());
  act(() => {
    storageManager.setPropagationConsensusPercent(75);
    notifyPreferencesChanged({ propagationConsensusPercent: 75 });
  });
  assert.equal(result.current.settings.consensusPercent, 75);

  act(() => {
    storageManager.setPropagationResolvers(["9.9.9.9"]);
    notifyPreferencesChanged({ propagationResolvers: ["9.9.9.9"] });
  });
  assert.deepEqual(result.current.settings.resolvers, ["9.9.9.9"]);

  // Unrelated preference events do not trigger a re-read.
  act(() => {
    storageManager.setPropagationAttempts(3);
    notifyPreferencesChanged({ confirmLogout: true });
  });
  assert.equal(result.current.settings.attempts, 1);

  act(() => {
    storageManager.resetPropagationSettings();
    notifyPreferencesChanged({ settingsCleared: true });
  });
  assert.equal(result.current.settings.consensusPercent, 100);
});

test("reset restores defaults", () => {
  const { result } = renderHook(() => usePropagationSettings());
  act(() => {
    result.current.update({
      consensusPercent: 50,
      customResolvers: ["8.8.4.4"],
    });
  });
  assert.equal(result.current.settings.consensusPercent, 50);
  act(() => {
    result.current.reset();
  });
  assert.equal(result.current.settings.consensusPercent, 100);
  assert.deepEqual(result.current.settings.customResolvers, []);
  assert.deepEqual(storageManager.getPropagationCustomResolvers(), []);
});

test("desktop field mapping uses the snake_case Preferences keys", () => {
  assert.deepEqual(
    toDesktopPropagationFields({
      resolvers: ["1.1.1.1"],
      customResolvers: ["9.9.9.11"],
      timeoutMs: 3000,
      attempts: 1,
      consensusPercent: 100,
      watchIntervalS: 15,
    }),
    {
      propagation_resolvers: ["1.1.1.1"],
      propagation_custom_resolvers: ["9.9.9.11"],
      propagation_timeout_ms: 3000,
      propagation_attempts: 1,
      propagation_consensus_percent: 100,
      propagation_watch_interval_s: 15,
    },
  );
});
