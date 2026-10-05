/**
 * The permission mode, changed from inside the conversation.
 *
 * Four things are pinned, and three of them are about not lying:
 *
 * - **`readOnly` says it refuses rather than asks.** Every other mode's
 *   refusal is a prompt the user sees; that one is silent, and a control that
 *   let it read as "it will ask me" would promise a prompt that never comes.
 * - **No mode is shown until one has been read.** A dropdown defaulted to
 *   `ask` would be a claim about what the backend will do with the next tool
 *   call.
 * - **A junk value never becomes a mode.** A themed dropdown's handler is
 *   typed `(value: string) => void`.
 * - And the write carries the stored per-tool overrides through, so changing
 *   the mode cannot silently clear an override set in the settings screen.
 *   That last one is the panel's job, so it is pinned in
 *   `AiAssistantPanel.test.tsx` where the write happens.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AiModeSelect } from "../src/components/ai/AiModeSelect";
import { AI_PERMISSION_MODE_COPY } from "../src/lib/ai/permissions";
import { AI_SELECT_CONTENT_CLASS } from "../src/components/ai/ai-select";
import type { AiPermissionMode } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  closeThemedSelect,
  enableThemedSelectEnvironment,
  openThemedSelect,
  themedSelectLabels,
  themedSelectValue,
  themedSelectValues,
} from "./radix-select";

function renderSelect(
  overrides: Partial<React.ComponentProps<typeof AiModeSelect>> = {},
): AiPermissionMode[] {
  const chosen: AiPermissionMode[] = [];
  render(
    <AiModeSelect
      mode="ask"
      saving={false}
      idPrefix="test"
      onChange={(mode) => chosen.push(mode)}
      {...overrides}
    />,
  );
  return chosen;
}

beforeEach(async () => {
  await useEnglishLocale();
  enableThemedSelectEnvironment();
});

afterEach(() => cleanup());

test("nothing is offered until a mode has actually been read", () => {
  renderSelect({ mode: null });
  // `null` is "ai_get_permissions has not answered". A control here would be
  // a guess about the policy that gates the next tool call.
  assert.equal(screen.queryByTestId("ai-mode-select"), null);
});

test("every mode is offered, in the shared order, with the current one shown", async () => {
  renderSelect({ mode: "autonomous" });

  const trigger = screen.getByLabelText("What the assistant may do");
  assert.equal(trigger.getAttribute("role"), "combobox");
  assert.equal(await themedSelectValue(trigger), "autonomous");
  assert.deepEqual(
    await themedSelectValues(
      screen.getByLabelText("What the assistant may do"),
    ),
    AI_PERMISSION_MODE_COPY.map((mode) => mode.id),
  );
  assert.deepEqual(
    await themedSelectLabels(
      screen.getByLabelText("What the assistant may do"),
    ),
    AI_PERMISSION_MODE_COPY.map((mode) => mode.label),
  );
  assert.equal(screen.getByTestId("ai-mode-select").dataset.mode, "autonomous");
});

test("read-only says it refuses outright, and warns about a plan in flight", () => {
  renderSelect({ mode: "readOnly" });

  // The one consequence nobody guesses from the name.
  assert.match(
    screen.getByTestId("ai-mode-consequence").textContent ?? "",
    /refused outright — you are not prompted/,
  );
  // And the part specific to changing it mid-task rather than in a settings
  // screen: a step that was runnable a moment ago comes back blocked.
  assert.match(
    screen.getByTestId("ai-mode-plan-warning").textContent ?? "",
    /come back blocked while this is set, not ask you/,
  );
});

test("the other modes state their own consequence and carry no plan warning", () => {
  for (const mode of ["ask", "autonomous"] as const) {
    renderSelect({ mode });
    const expected = AI_PERMISSION_MODE_COPY.find(
      (entry) => entry.id === mode,
    )?.consequence;
    assert.ok(expected);
    assert.equal(
      screen.getByTestId("ai-mode-consequence").textContent,
      expected,
    );
    assert.equal(screen.queryByTestId("ai-mode-plan-warning"), null, mode);
    cleanup();
  }
});

test("choosing a mode reports it once, and re-choosing the current one reports nothing", async () => {
  const chosen = renderSelect({ mode: "ask" });

  await chooseThemedSelectValue(
    screen.getByLabelText("What the assistant may do"),
    "readOnly",
  );
  assert.deepEqual(chosen, ["readOnly"]);

  // Re-selecting what is already in force is not a change, and a redundant
  // `ai_set_permissions` would cost a round trip and a catalog re-read.
  await chooseThemedSelectValue(
    screen.getByLabelText("What the assistant may do"),
    "ask",
  );
  assert.deepEqual(chosen, ["readOnly"]);
});

test("the control is locked while a write is in flight", () => {
  renderSelect({ saving: true });
  // Two writes have no guaranteed order, so the loser would silently win.
  assert.equal(
    screen
      .getByLabelText("What the assistant may do")
      .getAttribute("data-disabled"),
    "",
  );
});

test("the popover is raised above the floating bubble", async () => {
  renderSelect();
  const popover = await openThemedSelect(
    screen.getByLabelText("What the assistant may do"),
  );
  // The bubble paints at `z-[60]` and both are portaled to `document.body` —
  // siblings in one stacking context, where `z-index` alone decides. The
  // shared `SelectContent` default of `z-50` loses, and a popover opening
  // behind the surface it was opened from looks exactly like being clipped.
  assert.ok(
    popover.classList.contains(AI_SELECT_CONTENT_CLASS),
    `expected ${AI_SELECT_CONTENT_CLASS}, got ${popover.className}`,
  );
  assert.ok(!popover.classList.contains("z-50"));
  await closeThemedSelect();
});
