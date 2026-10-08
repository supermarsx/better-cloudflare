/**
 * The saved-selection library, and the one thing it must never let slip.
 *
 * `an imported destructive tool arrives pending, not enabled` is the test this
 * file exists for. `src/lib/portable/types.ts` states it as a property of the
 * format -- "An import cannot grant a tool permission that manual use would
 * have asked about" -- and the property holds because the import path runs
 * `partitionMcpPermissionPolicySelection`, the same function a click in the
 * permissions screen runs. This screen is where that could be bypassed by
 * accident, so the test reads the application the component hands its owner
 * rather than trusting the lib on its own behalf.
 *
 * The second thing worth pinning is the pair of save refusals.
 * `saveMcpPermissionSet` returns `null` for an unusable name *and* for a full
 * library, and its own comment says callers need to tell the user which. These
 * check that both answers reach the screen.
 *
 * `assert.ok(node === null)` rather than `assert.equal(node, null)`: under
 * `node:assert/strict` a failed comparison inspects the actual value, and
 * inspecting a jsdom element walks its whole document graph.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  PermissionSetEditor,
  type PermissionSetApplication,
} from "../src/components/portable/PermissionSetEditor";
import { MAX_MCP_PERMISSION_SETS } from "../src/lib/mcp/tool-permissions";
import {
  exportToolPermissions,
  parseToolPermissionsFile,
  type PortableToolPermissionsApplication,
} from "../src/lib/portable";

import { useEnglishLocale } from "./i18n-ready";

const EXPORTED_AT = new Date("2026-03-04T05:06:07.000Z");

/** Read-risk, so it is granted outright. */
const READ_TOOL = "cf_list_zones";
/** Destructive, so granting it is always a question. */
const DESTRUCTIVE_TOOL = "cf_delete_dns_record";

interface Harness {
  saved: Array<{ name: string; toolIds: string[] }>;
  deleted: string[];
  applies: string[];
  imported: PortableToolPermissionsApplication[];
  written: Array<{ name: string; contents: string }>;
}

interface Behaviour {
  /** What `onSave` reports back; `null` is a refusal. */
  saveResult?: string | null;
  /** What `onApply` reports a switch did; `null` means no such set. */
  application?: PermissionSetApplication | null;
  /** What the host hands back, or a thunk that throws. */
  file?: string | null | (() => never);
  exportFailure?: unknown;
}

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof PermissionSetEditor>> = {},
  behaviour: Behaviour = {},
): Harness {
  const harness: Harness = {
    saved: [],
    deleted: [],
    applies: [],
    imported: [],
    written: [],
  };
  render(
    <PermissionSetEditor
      selectedToolIds={[READ_TOOL, DESTRUCTIVE_TOOL]}
      sets={{ "Read only": [READ_TOOL] }}
      onSave={(name, toolIds) => {
        harness.saved.push({ name, toolIds: [...toolIds] });
        return behaviour.saveResult === undefined ? name : behaviour.saveResult;
      }}
      onDelete={(name) => harness.deleted.push(name)}
      onApply={(name) => {
        harness.applies.push(name);
        return behaviour.application === undefined
          ? {
              enabledTools: [READ_TOOL],
              pendingHighRiskToolIds: [],
              removedToolIds: [],
            }
          : behaviour.application;
      }}
      onImport={(application) => harness.imported.push(application)}
      appVersion="9.9.9"
      onExportFile={async (name, contents) => {
        if (behaviour.exportFailure !== undefined)
          throw behaviour.exportFailure;
        harness.written.push({ name, contents });
      }}
      onPickFile={async () =>
        typeof behaviour.file === "function"
          ? behaviour.file()
          : (behaviour.file ?? null)
      }
      now={EXPORTED_AT}
      {...overrides}
    />,
  );
  return harness;
}

function setRow(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-set="${name}"]`);
  assert.ok(found, `expected a row for ${name}`);
  return found;
}

function typeName(value: string): void {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value } });
}

function clickIn(container: HTMLElement, name: string): void {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  assert.ok(button, `expected a ${name} button`);
  fireEvent.click(button);
}

function toolPermissionsFile(
  enabledToolIds: readonly string[],
  sets: Record<string, string[]> = {},
): string {
  return JSON.stringify(
    exportToolPermissions(
      { enabledToolIds, sets },
      { appVersion: "1.0.0", now: EXPORTED_AT },
    ),
  );
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

test("each saved set is listed with how many tools it holds", () => {
  renderEditor();
  assert.match(setRow("Read only").textContent ?? "", /1 tool\(s\)/);
});

test("an empty library says so", () => {
  renderEditor({ sets: {} });
  assert.ok(screen.getByTestId("no-sets"));
  assert.ok(
    document.querySelector('[data-testid="permission-set-row"]') === null,
  );
});

test("saving captures the current selection under the trimmed name", () => {
  const harness = renderEditor();

  typeName("  Everything  ");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  assert.deepEqual(harness.saved, [
    { name: "Everything", toolIds: [READ_TOOL, DESTRUCTIVE_TOOL] },
  ]);
  // Confirmed out loud: saving over an existing set changes nothing a reader
  // can see.
  assert.match(
    screen.getByTestId("permission-set-outcome").textContent ?? "",
    /Saved/,
  );
  assert.equal((screen.getByLabelText("Name") as HTMLInputElement).value, "");
});

test("a name that cannot be a storage key is refused, and not passed on", () => {
  const harness = renderEditor();

  typeName("   ");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  const alert = screen.getByTestId("permission-set-save-error");
  assert.equal(alert.getAttribute("data-reason"), "name");
  assert.match(alert.textContent ?? "", /That name cannot be used\./);
  assert.deepEqual(harness.saved, []);
});

test("a name carrying a control character is refused", () => {
  // `normalizeMcpPermissionSetName` refuses rather than stripping: a silently
  // stripped name would not match what the user typed.
  const harness = renderEditor();

  typeName("Read\u0001only");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  assert.equal(
    screen.getByTestId("permission-set-save-error").getAttribute("data-reason"),
    "name",
  );
  assert.deepEqual(harness.saved, []);
});

test("a full library is reported as full, not as a bad name", () => {
  const full: Record<string, string[]> = {};
  for (let index = 0; index < MAX_MCP_PERMISSION_SETS; index += 1) {
    full[`Set ${index}`] = [READ_TOOL];
  }
  const harness = renderEditor({ sets: full });

  typeName("One more");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  const alert = screen.getByTestId("permission-set-save-error");
  assert.equal(alert.getAttribute("data-reason"), "full");
  assert.match(
    alert.textContent ?? "",
    new RegExp(`${MAX_MCP_PERMISSION_SETS} saved sets`),
  );
  assert.deepEqual(harness.saved, []);
});

test("a full library still lets an existing set be overwritten", () => {
  const full: Record<string, string[]> = { "Read only": [READ_TOOL] };
  for (let index = 0; index < MAX_MCP_PERMISSION_SETS - 1; index += 1) {
    full[`Set ${index}`] = [READ_TOOL];
  }
  const harness = renderEditor({ sets: full });

  typeName("Read only");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  // The ceiling is on how many sets there are, not on saving. Refusing this
  // would strand a user at the limit with no way to change a set.
  assert.deepEqual(harness.saved, [
    { name: "Read only", toolIds: [READ_TOOL, DESTRUCTIVE_TOOL] },
  ]);
});

test("a refusal from storage that this render could not foresee reads as full", () => {
  // The name has already been through the same normalizer storage uses, so a
  // `null` after that can only mean the library is fuller than the `sets` prop
  // knew.
  renderEditor({}, { saveResult: null });

  typeName("Everything");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  assert.equal(
    screen.getByTestId("permission-set-save-error").getAttribute("data-reason"),
    "full",
  );
});

test("switching to a set names the tools that still need confirming", () => {
  const harness = renderEditor(
    {},
    {
      application: {
        enabledTools: [READ_TOOL],
        pendingHighRiskToolIds: [DESTRUCTIVE_TOOL],
        removedToolIds: [],
      },
    },
  );

  clickIn(setRow("Read only"), "Apply");

  assert.deepEqual(harness.applies, ["Read only"]);
  const outcome = screen.getByTestId("permission-set-outcome");
  assert.match(outcome.textContent ?? "", /Switched to Read only\./);
  const warning = outcome.querySelector('[data-reason="high-risk-pending"]');
  assert.ok(warning, "expected a pending-confirmation warning");
  assert.match(warning.textContent ?? "", /not enabled yet/);
  assert.match(warning.textContent ?? "", new RegExp(DESTRUCTIVE_TOOL));
});

test("a switch with nothing pending says only that it switched", () => {
  renderEditor();

  clickIn(setRow("Read only"), "Apply");

  const outcome = screen.getByTestId("permission-set-outcome");
  assert.match(outcome.textContent ?? "", /Switched to Read only\./);
  assert.ok(
    outcome.querySelector('[data-testid="permission-set-warnings"]') === null,
  );
});

test("a switch that dropped ids this build no longer knows names them", () => {
  renderEditor(
    {},
    {
      application: {
        enabledTools: [READ_TOOL],
        pendingHighRiskToolIds: [],
        removedToolIds: ["cf_not_a_real_tool"],
      },
    },
  );

  clickIn(setRow("Read only"), "Apply");

  const warning = document.querySelector<HTMLElement>(
    '[data-reason="unknown-tool-id"]',
  );
  assert.ok(warning, "expected an unknown-tool warning");
  assert.match(warning.textContent ?? "", /cf_not_a_real_tool/);
});

test("a set deleted elsewhere leaves nothing claiming it was switched to", () => {
  renderEditor({}, { application: null });

  clickIn(setRow("Read only"), "Apply");

  assert.ok(
    document.querySelector('[data-testid="permission-set-outcome"]') === null,
  );
});

test("delete asks the owner to remove that set", () => {
  const harness = renderEditor();
  clickIn(setRow("Read only"), "Delete");
  assert.deepEqual(harness.deleted, ["Read only"]);
});

test("the library exports as a file this build's parser accepts", async () => {
  const harness = renderEditor();

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => {
    assert.ok(harness.written.length === 1, "expected one write");
  });

  const written = harness.written[0];
  assert.equal(written.name, "better-cloudflare-tool-permissions.json");
  const parsed = parseToolPermissionsFile(written.contents);
  assert.ok(parsed.ok, "expected the written file to parse");
  assert.deepEqual(parsed.value.payload.enabledToolIds, [
    READ_TOOL,
    DESTRUCTIVE_TOOL,
  ]);
  assert.deepEqual(parsed.value.payload.sets, [
    { name: "Read only", toolIds: [READ_TOOL] },
  ]);
});

test("a host that refuses the write says so", async () => {
  renderEditor({}, { exportFailure: new Error("the folder is read-only") });

  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const alert = await screen.findByTestId("permission-set-host-error");
  assert.match(alert.textContent ?? "", /Export failed/);
  assert.match(alert.textContent ?? "", /the folder is read-only/);
});

test("an imported destructive tool arrives pending, not enabled", async () => {
  const harness = renderEditor(
    {},
    { file: toolPermissionsFile([READ_TOOL, DESTRUCTIVE_TOOL]) },
  );

  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => {
    assert.ok(harness.imported.length === 1, "expected one application");
  });

  const application = harness.imported[0];
  // This is the whole property: a file cannot enable anything a click would
  // have stopped to ask about. The read-risk tool is granted; the destructive
  // one is staged for confirmation and is absent from the enabled list.
  assert.deepEqual(application.enabledToolIds, [READ_TOOL]);
  assert.deepEqual(application.pendingHighRiskToolIds, [DESTRUCTIVE_TOOL]);

  const warning = document.querySelector<HTMLElement>(
    '[data-reason="high-risk-pending"]',
  );
  assert.ok(warning, "expected a pending-confirmation warning");
  assert.match(warning.textContent ?? "", /still need confirming/);
  assert.match(warning.textContent ?? "", new RegExp(DESTRUCTIVE_TOOL));
});

test("an imported file keeps the machine's own sets and adds its own", async () => {
  const harness = renderEditor(
    {},
    { file: toolPermissionsFile([READ_TOOL], { Everything: [READ_TOOL] }) },
  );

  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => {
    assert.ok(harness.imported.length === 1, "expected one application");
  });

  assert.deepEqual(Object.keys(harness.imported[0].sets).sort(), [
    "Everything",
    "Read only",
  ]);
  assert.match(
    screen.getByTestId("permission-set-outcome").textContent ?? "",
    /1 enabled tool\(s\), 1 saved set\(s\)/,
  );
});

test("an id this build has never heard of is dropped and reported", async () => {
  // Hand-built rather than exported: the exporter reconciles ids on the way
  // out, so a file naming an unknown tool is one this build did not write.
  const harness = renderEditor(
    {},
    {
      file: JSON.stringify({
        format: "better-cloudflare/portable-config",
        version: 1,
        kind: "tool-permissions",
        exportedAt: EXPORTED_AT.toISOString(),
        appVersion: "1.0.0",
        payload: {
          policyVersion: 1,
          enabledToolIds: [READ_TOOL, "cf_invented_tool"],
          sets: [],
        },
      }),
    },
  );

  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => {
    assert.ok(harness.imported.length === 1, "expected one application");
  });

  // Dropped rather than granted at the `admin` risk `resolveMcpTool` would
  // assign an unknown tool: there is no import-only path into the enabled set.
  assert.deepEqual(harness.imported[0].enabledToolIds, [READ_TOOL]);
  assert.deepEqual(harness.imported[0].removedToolIds, ["cf_invented_tool"]);
  const warning = document.querySelector<HTMLElement>(
    '[data-reason="unknown-tool-id"]',
  );
  assert.ok(warning, "expected an unknown-tool warning");
  assert.match(warning.textContent ?? "", /cf_invented_tool/);
});

test("a file that is not ours is refused and nothing is applied", async () => {
  const harness = renderEditor({}, { file: "{}" });

  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const alert = await screen.findByTestId("permission-set-rejection");
  assert.equal(alert.getAttribute("data-rejection"), "not-our-format");
  assert.deepEqual(harness.imported, []);
});

test("a cancelled dialog applies nothing and reports nothing", async () => {
  const harness = renderEditor({}, { file: null });

  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => {
    const button = screen.getByRole("button", { name: "Import" });
    assert.ok(button instanceof HTMLButtonElement && !button.disabled);
  });

  assert.deepEqual(harness.imported, []);
  assert.ok(
    document.querySelector('[data-testid="permission-set-rejection"]') === null,
  );
  assert.ok(
    document.querySelector('[data-testid="permission-set-outcome"]') === null,
  );
});
