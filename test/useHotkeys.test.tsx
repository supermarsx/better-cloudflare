import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, renderHook } from "@testing-library/react";

import { formatHotkey, useHotkeys } from "../src/hooks/use-hotkeys";

const isApple = /Mac|iPhone|iPad|iPod/i.test(
  navigator.platform ?? navigator.userAgent ?? "",
);
const platformModifier: KeyboardEventInit = isApple
  ? { metaKey: true }
  : { ctrlKey: true };
const otherPlatformModifier: KeyboardEventInit = isApple
  ? { ctrlKey: true }
  : { metaKey: true };

function pressKey(
  target: Window | HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

test("hotkeys require exact modifiers and consume a matching event", () => {
  const handled: string[] = [];
  renderHook(() =>
    useHotkeys([
      {
        key: "s",
        ctrl: true,
        shift: true,
        handler: (event) => handled.push(event.key),
      },
    ]),
  );

  const missingShift = pressKey(window, "s", platformModifier);
  const extraAlt = pressKey(window, "s", {
    ...platformModifier,
    shiftKey: true,
    altKey: true,
  });
  const bothPlatformModifiers = pressKey(window, "s", {
    ...platformModifier,
    ...otherPlatformModifier,
    shiftKey: true,
  });
  const wrongPlatformModifier = pressKey(window, "s", {
    ...otherPlatformModifier,
    shiftKey: true,
  });
  const matchingEvent = pressKey(window, "S", {
    ...platformModifier,
    shiftKey: true,
  });

  assert.deepEqual(handled, ["S"]);
  assert.equal(missingShift.defaultPrevented, false);
  assert.equal(extraAlt.defaultPrevented, false);
  assert.equal(bothPlatformModifiers.defaultPrevented, false);
  assert.equal(wrongPlatformModifier.defaultPrevented, false);
  assert.equal(matchingEvent.defaultPrevented, true);
});

test("input fields suppress shortcuts unless a binding opts in", () => {
  let blockedCalls = 0;
  let allowedCalls = 0;
  renderHook(() =>
    useHotkeys([
      { key: "x", handler: () => (blockedCalls += 1) },
      {
        key: "y",
        allowInInput: true,
        handler: () => (allowedCalls += 1),
      },
    ]),
  );
  const input = document.createElement("input");
  document.body.append(input);

  pressKey(input, "x");
  const allowedEvent = pressKey(input, "y");

  assert.equal(blockedCalls, 0);
  assert.equal(allowedCalls, 1);
  assert.equal(allowedEvent.defaultPrevented, true);
});

test("rerenders use the latest handler without duplicating listeners", () => {
  let firstCalls = 0;
  let latestCalls = 0;
  const { rerender } = renderHook(
    ({ handler, enabled }: { handler: () => void; enabled: boolean }) =>
      useHotkeys([{ key: "k", handler }], enabled),
    {
      initialProps: {
        handler: () => {
          firstCalls += 1;
        },
        enabled: true,
      },
    },
  );

  rerender({
    handler: () => {
      latestCalls += 1;
    },
    enabled: true,
  });
  pressKey(window, "k");
  rerender({ handler: () => assert.fail(), enabled: false });
  pressKey(window, "k");

  assert.equal(firstCalls, 0);
  assert.equal(latestCalls, 1);
});

test("disabled bindings are skipped and shortcut labels are readable", () => {
  let fallbackCalls = 0;
  renderHook(() =>
    useHotkeys([
      { key: "Delete", disabled: true, handler: () => assert.fail() },
      { key: "Delete", handler: () => (fallbackCalls += 1) },
    ]),
  );

  pressKey(window, "Delete");

  assert.equal(fallbackCalls, 1);
  assert.equal(
    formatHotkey({ key: "Escape", ctrl: true, shift: true, alt: true }),
    isApple ? "\u2318\u21e7\u2325Esc" : "Ctrl+Shift+Alt+Esc",
  );
  assert.equal(formatHotkey({ key: " " }), "Space");
});
