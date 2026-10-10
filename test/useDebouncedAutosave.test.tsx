/**
 * The settings autosave, on its own.
 *
 * `DNSManager.settingsAutosave.test.tsx` proves the wiring — that flipping a
 * switch in the settings panel reaches the host once. This file proves the
 * three properties that wiring depends on and that a panel test cannot
 * separate, because each of them is observable only through a sequence the UI
 * has no way to produce on demand:
 *
 *  1. **A burst spread across the window is one write.** The single pending
 *     slot already makes a *synchronous* burst one write whatever the timer
 *     does, so that is not the interesting case: what has to hold is that
 *     keystrokes arriving 30 ms apart over a quarter of a second restart the
 *     timer rather than letting the first one fire mid-burst.
 *  2. **The two halves of the ready gate, separately.** They overlap — a
 *     write refused at schedule time would also be refused at run time — so a
 *     single "nothing was written" assertion would be satisfied by either one
 *     alone and prove neither. They are told apart by `dirty`: the gate at
 *     schedule time is what stops the indicator claiming an unsaved change
 *     that is never going to be written.
 *  3. **A flush is synchronous.** The close-request listener and the unmount
 *     cleanup both depend on the write having happened by the time `flush`
 *     returns, because neither has a later moment to be called back in.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import { SETTINGS_INPUT_DEBOUNCE_MS } from "../src/components/dns/NotificationsSettingsControls";
import {
  SETTINGS_AUTOSAVE_DEBOUNCE_MS,
  useDebouncedAutosave,
  type AutosaveWrite,
  type DebouncedAutosave,
} from "../src/hooks/dns/use-debounced-autosave";

/** Short enough to keep the suite quick, long enough to stagger inside. */
const DELAY_MS = 60;

/**
 * The hook's own return value, captured on render.
 *
 * Assigning during render rather than through a ref callback because the test
 * needs `schedule` and `flush` *imperatively*, from outside React, which is
 * exactly how `DNSManager` calls them (from an effect and from a Tauri event
 * listener). Reset in `afterEach` so one test cannot read another's.
 */
let autosave: DebouncedAutosave | null = null;

function current(): DebouncedAutosave {
  assert.ok(autosave, "the harness has not rendered");
  return autosave;
}

function Harness({ ready, delayMs }: { ready: boolean; delayMs: number }) {
  autosave = useDebouncedAutosave({ ready, delayMs });
  return (
    <span
      data-testid="autosave"
      data-state={autosave.state}
      data-dirty={autosave.dirty}
    >
      {autosave.error ?? ""}
    </span>
  );
}

function indicator(): HTMLElement {
  return screen.getByTestId("autosave");
}

function state(): string | null {
  return indicator().getAttribute("data-state");
}

function dirty(): string | null {
  return indicator().getAttribute("data-dirty");
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

function schedule(write: AutosaveWrite): void {
  act(() => {
    current().schedule(write);
  });
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  autosave = null;
});

test("the autosave delay is the interval typed settings inputs already use", () => {
  // Two constants that have to agree, and nothing in the type system makes
  // them. The duplication is deliberate — importing the number from the
  // component module would drag the UI kit into a hook — so this is what
  // stops them drifting.
  assert.equal(SETTINGS_AUTOSAVE_DEBOUNCE_MS, SETTINGS_INPUT_DEBOUNCE_MS);
});

test("changes staggered across the window are written once, at the end", async () => {
  render(<Harness ready delayMs={DELAY_MS} />);
  const written: number[] = [];

  // Five changes, each arriving before the previous one's timer would have
  // fired, spanning four times the delay in total. A timer that is not
  // restarted fires in the middle of this and writes a value that is already
  // stale, then writes again at the end.
  for (let change = 1; change <= 5; change += 1) {
    schedule(() => {
      written.push(change);
    });
    await settle(DELAY_MS / 2);
  }

  assert.deepEqual(written, [], "a write landed before the burst had finished");
  assert.equal(dirty(), "true");

  await settle(DELAY_MS * 2);

  assert.deepEqual(
    written,
    [5],
    "the burst should have cost exactly one write, of the newest state",
  );
  assert.equal(state(), "saved");
  assert.equal(dirty(), "false");
});

test("a write scheduled before the gate opens is neither run nor reported", async () => {
  render(<Harness ready={false} delayMs={DELAY_MS} />);
  let runs = 0;

  schedule(() => {
    runs += 1;
  });
  await settle(DELAY_MS * 3);

  assert.equal(runs, 0, "a write ran before stored preferences had loaded");
  // The half of the gate this pins: nothing was taken, so there is nothing
  // outstanding to tell the user about. A `dirty` indicator here would be
  // promising a save that is never going to happen.
  assert.equal(dirty(), "false");
  assert.equal(state(), "loading");
});

test("a timer that outlives the gate does not get to write", async () => {
  const { rerender } = render(<Harness ready delayMs={DELAY_MS} />);
  let runs = 0;

  schedule(() => {
    runs += 1;
  });
  assert.equal(dirty(), "true", "the write was not taken in the first place");

  // The gate closes while the write is still only a timer — the one ordering
  // in which a pending write could land component defaults over stored
  // preferences.
  rerender(<Harness ready={false} delayMs={DELAY_MS} />);
  await settle(DELAY_MS * 3);

  assert.equal(runs, 0, "a timer wrote after the gate had closed");
});

test("a flush runs the pending write synchronously", () => {
  render(<Harness ready delayMs={DELAY_MS} />);
  let runs = 0;

  schedule(() => {
    runs += 1;
  });
  assert.equal(runs, 0);

  // No await: the close-request listener has no later moment to be called
  // back in, so a flush that only schedules the write would lose it.
  act(() => {
    current().flush();
  });

  assert.equal(runs, 1);
  assert.equal(state(), "saved");
});

test("a flush with nothing pending writes nothing", () => {
  render(<Harness ready delayMs={DELAY_MS} />);
  let runs = 0;

  schedule(() => {
    runs += 1;
  });
  act(() => {
    current().flush();
  });
  act(() => {
    current().flush();
  });

  assert.equal(runs, 1, "an idle flush repeated the last write");
});

test("unmounting inside the window still writes", () => {
  render(<Harness ready delayMs={DELAY_MS} />);
  let runs = 0;

  schedule(() => {
    runs += 1;
  });
  assert.equal(runs, 0);

  cleanup();

  assert.equal(
    runs,
    1,
    "a change made inside the debounce window was lost at unmount",
  );
});

test("unmounting before the gate opens writes nothing", () => {
  render(<Harness ready={false} delayMs={DELAY_MS} />);
  let runs = 0;

  schedule(() => {
    runs += 1;
  });
  cleanup();

  assert.equal(runs, 0, "the unmount flush wrote through a closed gate");
});

test("a rejected write reports the reason instead of a save", async () => {
  render(<Harness ready delayMs={DELAY_MS} />);

  schedule(() => Promise.reject(new Error("the host refused the write")));
  await settle(DELAY_MS * 3);

  assert.equal(state(), "error");
  assert.equal(indicator().textContent, "the host refused the write");
  assert.equal(dirty(), "false");
});

test("a write that throws outright reports the reason too", async () => {
  render(<Harness ready delayMs={DELAY_MS} />);

  // `storageManager` writes are synchronous and can be refused when a quota
  // is reached. That has to reach the indicator rather than escaping the
  // effect that scheduled it.
  schedule(() => {
    throw new Error("the quota is full");
  });
  await settle(DELAY_MS * 2);

  assert.equal(state(), "error");
  assert.equal(indicator().textContent, "the quota is full");
});

test("a write that finishes after a newer one was scheduled cannot report", async () => {
  render(<Harness ready delayMs={DELAY_MS} />);
  let release: (() => void) | null = null;

  schedule(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await settle(DELAY_MS * 2);
  assert.equal(state(), "saving");

  // A second change arrives while the first write is still in flight, and the
  // first one then lands. Letting it report would put "saved" over a newer
  // "saving" and claim the second change had been written.
  schedule(() => {});
  assert.equal(dirty(), "true");
  await act(async () => {
    release?.();
    await Promise.resolve();
  });

  assert.equal(
    state(),
    "saving",
    "the stale write reported a save over a newer, unwritten change",
  );
  assert.equal(dirty(), "true");
  await settle(DELAY_MS * 2);
  assert.equal(state(), "saved");
  assert.equal(dirty(), "false");
});

test("the gate opening does not overwrite what the last write reported", async () => {
  const { rerender } = render(<Harness ready delayMs={DELAY_MS} />);

  schedule(() => Promise.reject(new Error("refused")));
  await settle(DELAY_MS * 3);
  assert.equal(state(), "error");

  // A later reload must not turn a refusal into a blank slate: the failure is
  // still the truthful answer about the last write.
  rerender(<Harness ready delayMs={DELAY_MS + 1} />);
  assert.equal(state(), "error");
});
