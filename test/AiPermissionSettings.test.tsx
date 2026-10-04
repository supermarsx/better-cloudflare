/**
 * The permission settings screen.
 *
 * The assertions that matter are the ones about truthfulness: a row must show
 * the decision the backend reported, the global tool switch must win over the
 * catalog, and a disagreement between the two must be visible. Everything else
 * here is scaffolding for those.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import {
  AiPermissionSettings,
  applyAiToolOverride,
} from "../src/components/ai/AiPermissionSettings";
import { AI_TOOL_PERMISSIONS } from "../src/lib/ai/permissions";
import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
  themedSelectValue,
  themedSelectValues,
} from "./radix-select";
import type {
  AiPermissionMode,
  AiPermissions,
  AiPermissionsSnapshot,
  AiToolDescriptor,
  AiToolPermission,
} from "../src/types/ai";

function tool(
  name: string,
  classification: AiToolDescriptor["classification"],
  permission: AiToolPermission,
): AiToolDescriptor {
  return {
    name,
    classification,
    description: `Does a ${classification} thing`,
    permission,
  };
}

const READ = "cf_list_dns_records";
const WRITE = "cf_delete_dns_record";

function snapshot(
  mode: AiPermissionMode,
  overrides: Record<string, AiToolPermission> = {},
  catalog: AiToolDescriptor[] = [
    tool(READ, "read", "allow"),
    tool(WRITE, "write", mode === "autonomous" ? "allow" : "ask"),
  ],
): AiPermissionsSnapshot {
  return {
    mode,
    tools: overrides,
    catalog,
    // Part of `ai_get_permissions`, and nothing on this screen reads it: a row
    // reports the catalog's own decision, never a count. Present so the fixture
    // is the shape the command actually returns.
    availability: {
      dispatchAvailable: catalog.length > 0,
      grantedToolCount: catalog.length,
      usableToolCount: catalog.length,
      registeredToolCount: catalog.length,
    },
  };
}

interface Harness {
  saved: AiPermissions[];
  retries: number;
}

function renderSettings(
  overrides: Partial<React.ComponentProps<typeof AiPermissionSettings>> = {},
): Harness {
  const saved: AiPermissions[] = [];
  const harness: Harness = { saved, retries: 0 };
  render(
    <AiPermissionSettings
      snapshot={snapshot("ask")}
      toolsEnabled
      loading={false}
      saving={false}
      loadError={null}
      onSave={async (next) => {
        saved.push(next);
      }}
      onRetry={() => {
        harness.retries += 1;
      }}
      {...overrides}
    />,
  );
  return harness;
}

function row(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-tool="${name}"]`);
  assert.ok(found, `expected a row for ${name}`);
  return found;
}

beforeEach(async () => {
  // Without this the first synchronous test in the file renders before the
  // locale bundle has loaded and every short label comes back empty.
  await useEnglishLocale();
  // The per-tool picker is a Radix dropdown; opening one needs the two jsdom
  // gaps this installs. See `test/radix-select.ts`.
  enableThemedSelectEnvironment();
});

afterEach(() => {
  cleanup();
});

// ── The effective permission each mode produces ────────────────────────────

test("read-only reports writes as refused and says it will not ask", () => {
  // The backend resolves `readOnly` + write to `deny`, so that is what the
  // catalog carries and that is what the row has to show.
  renderSettings({
    snapshot: snapshot("readOnly", {}, [
      tool(READ, "read", "allow"),
      tool(WRITE, "write", "deny"),
    ]),
  });

  assert.equal(row(READ).dataset.effective, "allow");
  assert.equal(row(WRITE).dataset.effective, "deny");
  assert.equal(row(WRITE).dataset.reason, "mode");
  assert.match(
    within(row(WRITE)).getByTestId("ai-tool-effective").textContent ?? "",
    /Refused/,
  );

  // The consequence has to be stated where the mode is chosen, because a
  // silent refusal is the one outcome a user cannot infer from the control.
  const readOnlyOption = document.querySelector<HTMLElement>(
    '[data-mode-option="readOnly"]',
  );
  assert.ok(readOnlyOption);
  assert.match(readOnlyOption.textContent ?? "", /refused outright/);
  assert.match(readOnlyOption.textContent ?? "", /not prompted/);

  // And `ask` must promise the opposite, or the two are indistinguishable.
  const askOption = document.querySelector<HTMLElement>(
    '[data-mode-option="ask"]',
  );
  assert.ok(askOption);
  assert.match(askOption.textContent ?? "", /waits for your approval/);
});

test("ask runs reads and prompts for writes", () => {
  renderSettings({ snapshot: snapshot("ask") });

  assert.equal(row(READ).dataset.effective, "allow");
  assert.equal(row(WRITE).dataset.effective, "ask");
  assert.match(
    screen.getByTestId("ai-permissions-summary").textContent ?? "",
    /1 run, 1 ask first, 0 refused, of 2 tools\./,
  );
});

test("autonomous runs everything, and says so", () => {
  renderSettings({ snapshot: snapshot("autonomous") });

  assert.equal(row(READ).dataset.effective, "allow");
  assert.equal(row(WRITE).dataset.effective, "allow");
  const option = document.querySelector<HTMLElement>(
    '[data-mode-option="autonomous"]',
  );
  assert.ok(option);
  assert.match(option.textContent ?? "", /without asking/);
});

test("picking a mode sends the mode and keeps the existing overrides", async () => {
  const harness = renderSettings({
    snapshot: snapshot("ask", { [WRITE]: "deny" }),
  });

  fireEvent.click(screen.getByRole("radio", { name: /Autonomous/ }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.deepEqual(harness.saved[0], {
    mode: "autonomous",
    tools: { [WRITE]: "deny" },
  });
});

// ── The global tool switch ─────────────────────────────────────────────────

test("tool use off refuses every row even though the catalog says otherwise", () => {
  renderSettings({
    toolsEnabled: false,
    snapshot: snapshot("autonomous", {}, [
      tool(READ, "read", "allow"),
      tool(WRITE, "write", "allow"),
    ]),
  });

  // Both descriptors report `allow`. Nothing can run, so nothing may be shown
  // as running: this is the misreport the screen exists to avoid.
  assert.equal(row(READ).dataset.effective, "deny");
  assert.equal(row(WRITE).dataset.effective, "deny");
  assert.equal(row(READ).dataset.reason, "toolsOff");
  assert.match(
    screen.getByTestId("ai-permissions-summary").textContent ?? "",
    /0 run, 0 ask first, 2 refused/,
  );
  assert.match(
    screen.getByTestId("ai-permissions-tools-off").textContent ?? "",
    /every tool is refused/,
  );
  assert.equal(
    screen.getByTestId("ai-permissions").dataset.toolsEnabled,
    "false",
  );
});

// ── Per-tool overrides ─────────────────────────────────────────────────────

test("a per-tool choice is sent as an override and shown as the reason", async () => {
  const harness = renderSettings({
    snapshot: snapshot("readOnly", {}, [
      tool(READ, "read", "allow"),
      tool(WRITE, "write", "deny"),
    ]),
  });

  // The picker is the app's themed dropdown now, so it is opened and an
  // option is clicked rather than `change`d: a Radix trigger is a button, and
  // `fireEvent.change` on one does nothing at all.
  await chooseThemedSelectValue(
    within(row(WRITE)).getByRole("combobox"),
    "allow",
  );

  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.deepEqual(harness.saved[0], {
    mode: "readOnly",
    tools: { [WRITE]: "allow" },
  });
});

test("the per-tool picker offers exactly the storable values", async () => {
  renderSettings({ snapshot: snapshot("ask") });

  // "Use the mode" is a UI sentinel, not a permission: it is the absence of an
  // override. Everything else is a value the backend stores verbatim.
  assert.deepEqual(
    await themedSelectValues(within(row(WRITE)).getByRole("combobox")),
    ["inherit", ...AI_TOOL_PERMISSIONS],
  );
});

test("a value that is not a permission clears the override instead of storing it", () => {
  // The picker's whole write path. A themed dropdown reports a bare `string`,
  // and the options it reports from can have been re-rendered since, so this
  // guard is the thing standing between a junk value and the stored policy.
  assert.deepEqual(applyAiToolOverride({ [WRITE]: "allow" }, WRITE, "deny"), {
    [WRITE]: "deny",
  });
  for (const junk of ["inherit", "", "ALLOW", "allow ", "autonomous", "null"]) {
    assert.deepEqual(
      applyAiToolOverride({ [WRITE]: "allow", [READ]: "deny" }, WRITE, junk),
      { [READ]: "deny" },
      `${junk} must clear the override rather than become one`,
    );
  }
});

test("an override shows as the reason and clears back to the mode", async () => {
  const harness = renderSettings({
    snapshot: snapshot("ask", { [WRITE]: "allow" }, [
      tool(READ, "read", "allow"),
      tool(WRITE, "write", "allow"),
    ]),
  });

  assert.equal(row(WRITE).dataset.reason, "override");
  assert.equal(row(WRITE).dataset.override, "allow");
  assert.match(row(WRITE).textContent ?? "", /Set for this tool\./);
  assert.equal(
    await themedSelectValue(within(row(WRITE)).getByRole("combobox")),
    "allow",
  );

  // Choosing "use the mode" must delete the key, not store a third value.
  await chooseThemedSelectValue(
    within(row(WRITE)).getByRole("combobox"),
    "inherit",
  );
  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.deepEqual(harness.saved[0], { mode: "ask", tools: {} });
  assert.ok(!("cf_delete_dns_record" in harness.saved[0].tools));
});

test("clearing every per-tool setting sends an empty override map", async () => {
  const harness = renderSettings({
    snapshot: snapshot("ask", { [READ]: "deny", [WRITE]: "allow" }),
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Clear per-tool settings" }),
  );
  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.deepEqual(harness.saved[0], { mode: "ask", tools: {} });
});

test("the clear button is disabled when there is nothing to clear", () => {
  renderSettings({ snapshot: snapshot("ask") });
  assert.equal(
    (
      screen.getByRole("button", {
        name: "Clear per-tool settings",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
});

// ── Disagreement, failure, and the empty states ────────────────────────────

test("a reported decision the rules do not predict is marked, not corrected", () => {
  renderSettings({
    snapshot: snapshot("readOnly", {}, [tool(WRITE, "write", "allow")]),
  });

  // Read-only would deny this. The backend says it runs, and the backend is
  // what executes, so the row shows "runs" and flags the difference.
  assert.equal(row(WRITE).dataset.effective, "allow");
  assert.equal(row(WRITE).dataset.drifted, "true");
  assert.match(
    screen.getByTestId("ai-permissions-drift").textContent ?? "",
    /different decision than these rules produce for 1 tool/,
  );
  assert.match(row(WRITE).textContent ?? "", /the one that applies/);
});

test("a refused save keeps the backend's message and leaves the rows alone", async () => {
  render(
    <AiPermissionSettings
      snapshot={snapshot("ask")}
      toolsEnabled
      loading={false}
      saving={false}
      loadError={null}
      onSave={async () => {
        throw {
          code: "AI_INVALID_CONFIG",
          message: "Autonomous mode is disabled by policy.",
          source: "agent",
          operation: "ai:set_permissions",
          retryable: false,
          details: { remediation: "Ask an administrator." },
        };
      }}
      onRetry={() => {}}
    />,
  );

  fireEvent.click(screen.getByRole("radio", { name: /Autonomous/ }));

  assert.ok(await screen.findByText("Autonomous mode is disabled by policy."));
  // The mode still reads `ask`: a refused write must not be shown as applied.
  assert.equal(screen.getByTestId("ai-permissions").dataset.mode, "ask");
  assert.equal(
    (
      screen.getByRole("radio", {
        name: /Ask before changes/,
      }) as HTMLInputElement
    ).checked,
    true,
  );
});

test("every control is disabled while a save is in flight", () => {
  renderSettings({
    saving: true,
    snapshot: snapshot("ask", { [WRITE]: "deny" }),
  });

  assert.equal(
    (screen.getByRole("radio", { name: /Autonomous/ }) as HTMLInputElement)
      .disabled,
    true,
  );
  assert.equal(
    (within(row(WRITE)).getByRole("combobox") as HTMLSelectElement).disabled,
    true,
  );
});

test("an unread policy explains itself and offers a retry rather than guessing", () => {
  const harness = renderSettings({
    snapshot: null,
    loadError: {
      code: "AI_UNAVAILABLE",
      message: "The assistant is not running.",
      source: "agent",
      operation: "ai:get_permissions",
      retryable: true,
      details: {},
    },
  });

  // No mode is shown at all: inventing one would be a claim about what the
  // backend will do with the next tool call.
  assert.equal(screen.queryByRole("radio"), null);
  assert.ok(screen.getByText("The assistant is not running."));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.equal(harness.retries, 1);
});

test("search narrows the rows without changing what is in effect", () => {
  renderSettings({ snapshot: snapshot("ask") });

  fireEvent.change(screen.getByLabelText("Search tools"), {
    target: { value: "delete" },
  });

  assert.equal(
    document.querySelectorAll('[data-testid="ai-tool-row"]').length,
    1,
  );
  assert.ok(document.querySelector(`[data-tool="${WRITE}"]`));
  // The summary still counts the whole catalog, not the filtered view.
  assert.match(
    screen.getByTestId("ai-permissions-summary").textContent ?? "",
    /of 2 tools\./,
  );
});
