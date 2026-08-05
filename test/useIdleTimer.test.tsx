import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useIdleTimer } from "../src/hooks/auth/use-idle-timer";

const originalSetTimeout = window.setTimeout;
const originalClearTimeout = window.clearTimeout;

let nextTimerId = 0;
let timers = new Map<
  number,
  { callback: () => void; timeoutMs: number | undefined }
>();

function installControlledTimers(): void {
  nextTimerId = 0;
  timers = new Map<
    number,
    { callback: () => void; timeoutMs: number | undefined }
  >();

  window.setTimeout = ((handler: TimerHandler, timeoutMs?: number) => {
    assert.equal(typeof handler, "function");
    const id = ++nextTimerId;
    timers.set(id, { callback: handler as () => void, timeoutMs });
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) timers.delete(id);
  }) as typeof window.clearTimeout;
}

function runOnlyTimer(): void {
  assert.equal(timers.size, 1);
  const [[id, { callback }]] = [...timers.entries()];
  timers.delete(id);
  act(() => callback());
}

function getOnlyTimer(): {
  id: number;
  callback: () => void;
  timeoutMs: number | undefined;
} {
  assert.equal(timers.size, 1);
  const [[id, timer]] = [...timers.entries()];
  return { id, ...timer };
}

beforeEach(() => {
  installControlledTimers();
});

afterEach(() => {
  cleanup();
  window.setTimeout = originalSetTimeout;
  window.clearTimeout = originalClearTimeout;
});

test("idle timing starts immediately and user activity restarts it", () => {
  let idleCalls = 0;
  renderHook(() =>
    useIdleTimer({
      timeoutMs: 30_000,
      onIdle: () => {
        idleCalls += 1;
      },
    }),
  );

  assert.equal(timers.size, 1);
  const firstTimer = getOnlyTimer();
  assert.equal(firstTimer.timeoutMs, 30_000);

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown"));
  });

  assert.equal(timers.has(firstTimer.id), false);
  assert.equal(timers.size, 1);
  const resetTimer = getOnlyTimer();
  assert.notEqual(resetTimer.id, firstTimer.id);
  assert.equal(resetTimer.timeoutMs, 30_000);
  runOnlyTimer();
  assert.equal(idleCalls, 1);
});

test("the active timer always calls the latest callback", () => {
  let initialCalls = 0;
  let latestCalls = 0;
  const initialCallback = () => {
    initialCalls += 1;
  };
  const latestCallback = () => {
    latestCalls += 1;
  };

  const { rerender } = renderHook(
    ({ onIdle }: { onIdle: () => void }) =>
      useIdleTimer({ timeoutMs: 30_000, onIdle }),
    { initialProps: { onIdle: initialCallback } },
  );
  const initialTimerId = getOnlyTimer().id;

  rerender({ onIdle: latestCallback });

  assert.equal([...timers.keys()][0], initialTimerId);
  runOnlyTimer();
  assert.equal(initialCalls, 0);
  assert.equal(latestCalls, 1);
});

test("disabled and non-positive timers never schedule idle work", () => {
  const { rerender } = renderHook(
    ({ enabled, timeoutMs }: { enabled: boolean; timeoutMs: number }) =>
      useIdleTimer({ timeoutMs, enabled, onIdle: () => assert.fail() }),
    { initialProps: { enabled: false, timeoutMs: 30_000 } },
  );

  assert.equal(timers.size, 0);
  rerender({ enabled: true, timeoutMs: 30_000 });
  assert.equal(timers.size, 1);
  assert.equal(getOnlyTimer().timeoutMs, 30_000);
  rerender({ enabled: true, timeoutMs: 12_345 });
  assert.equal(timers.size, 1);
  assert.equal(getOnlyTimer().timeoutMs, 12_345);
  rerender({ enabled: true, timeoutMs: 0 });
  assert.equal(timers.size, 0);
});

test("unmount clears the timer and removes activity listeners", () => {
  const { unmount } = renderHook(() =>
    useIdleTimer({ timeoutMs: 30_000, onIdle: () => assert.fail() }),
  );

  assert.equal(timers.size, 1);
  unmount();
  assert.equal(timers.size, 0);

  window.dispatchEvent(new Event("pointerdown"));
  assert.equal(timers.size, 0);
});
