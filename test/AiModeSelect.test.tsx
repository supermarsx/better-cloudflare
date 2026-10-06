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

function assertAbsent(node: Element | null, label: string): void {
  // Compared to `null` first: inspecting a jsdom element on a failed
  // comparison walks its whole document graph. See AiAssistantPanel.test.tsx.
  assert.ok(node === null, `expected no ${label}`);
}

/** The node is in the accessibility tree but spends no layout height. */
function assertSrOnly(node: Element, label: string): void {
  assert.match(
    node.className,
    /(?:^|\s)sr-only(?:$|\s)/,
    `${label} must be sr-only, not printed`,
  );
}

/**
 * The trigger points at these nodes, in order, through `aria-describedby`.
 *
 * The association is the whole point of moving the prose: text that merely
 * exists somewhere in the DOM is not reachable, it is just hidden.
 */
function assertDescribes(trigger: Element, ...described: Element[]): void {
  assert.deepEqual(
    (trigger.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean),
    described.map((node) => node.id),
  );
  for (const node of described) {
    assert.ok(node.id.length > 0, "a described node needs an id");
  }
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
  const trigger = screen.getByLabelText("What the assistant may do");

  // The one consequence nobody guesses from the name.
  const consequence = screen.getByTestId("ai-mode-consequence");
  assert.match(
    consequence.textContent ?? "",
    /refused outright — you are not prompted/,
  );
  // And the part specific to changing it mid-task rather than in a settings
  // screen: a step that was runnable a moment ago comes back blocked.
  const warning = screen.getByTestId("ai-mode-plan-warning");
  assert.match(
    warning.textContent ?? "",
    /come back blocked while this is set, not ask you/,
  );

  // Both are *reachable*, not printed. This control is docked directly above
  // the message input now, and eight lines of standing prose there is height
  // the transcript needs more — so the sentences moved into the accessibility
  // tree and onto hover instead of being deleted.
  assertSrOnly(consequence, "the consequence");
  assertSrOnly(warning, "the plan warning");
  assertDescribes(trigger, consequence, warning);
  // Hover is where a sighted user still gets them, and the plan warning has
  // nowhere else to be seen at all.
  const title = trigger.getAttribute("title") ?? "";
  assert.match(title, /refused outright — you are not prompted/);
  assert.match(title, /come back blocked while this is set, not ask you/);
});

test("the other modes state their own consequence and carry no plan warning", () => {
  for (const mode of ["ask", "autonomous"] as const) {
    renderSelect({ mode });
    const expected = AI_PERMISSION_MODE_COPY.find(
      (entry) => entry.id === mode,
    )?.consequence;
    assert.ok(expected);
    const consequence = screen.getByTestId("ai-mode-consequence");
    assert.equal(consequence.textContent, expected);
    assert.equal(screen.queryByTestId("ai-mode-plan-warning"), null, mode);

    const trigger = screen.getByLabelText("What the assistant may do");
    assertSrOnly(consequence, `the consequence for ${mode}`);
    assertDescribes(trigger, consequence);
    assert.equal(trigger.getAttribute("title"), expected, mode);
    cleanup();
  }
});

test("the control is named without printing a label above it", () => {
  renderSelect({ mode: "ask" });

  // The visible "What the assistant may do" heading is gone — that is the line
  // the user objected to — but the name it carried is not: an unnamed dropdown
  // deciding what the assistant may do would be worse than a wasted line.
  const trigger = screen.getByLabelText("What the assistant may do");
  assert.equal(trigger.getAttribute("role"), "combobox");
  assertAbsent(
    document.querySelector("label[for]"),
    "a visible label element above the control",
  );

  // Nothing inside the control spends visible height on prose. Asserted over
  // every paragraph rather than the two known ids, so a third one added later
  // has to make the same choice.
  const control = screen.getByTestId("ai-mode-select");
  const paragraphs = Array.from(control.querySelectorAll("p"));
  assert.ok(paragraphs.length > 0, "the description must still exist");
  for (const paragraph of paragraphs) {
    assertSrOnly(paragraph, `"${paragraph.textContent?.slice(0, 32)}…"`);
  }
});

test("each option carries its own consequence, for the moment of choosing", async () => {
  renderSelect({ mode: "ask" });

  // The better placement would be a description inside each option, but the
  // shared `SelectItem` wraps every child in Radix's `ItemText`, so visible
  // text there would also be painted on the closed trigger. A `title` is what
  // is left that does not require changing a component this one does not own.
  const popover = await openThemedSelect(
    screen.getByLabelText("What the assistant may do"),
  );
  for (const entry of AI_PERMISSION_MODE_COPY) {
    const option = popover.querySelector(`[data-value="${entry.id}"]`);
    assert.ok(option, `no option for ${entry.id}`);
    assert.equal(option.getAttribute("title"), entry.consequence, entry.id);
  }
  await closeThemedSelect();
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
