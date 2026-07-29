import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import {
  McpToolPermissions,
  type McpToolPermissionsApplication,
  type McpToolPermissionsClient,
  type McpToolPermissionsStorage,
  type McpToolPermissionsStorageSnapshot,
} from "../src/components/mcp/McpToolPermissions";
import type {
  McpServerStatus,
  McpToolDescriptor,
} from "../src/lib/api/tauri-client";
import {
  DEFAULT_MCP_ENABLED_TOOL_IDS,
  MAX_MCP_PERMISSION_DIAGNOSTIC_IDS,
  MAX_MCP_PERMISSION_TOOL_ID_LENGTH,
  MCP_PERMISSION_POLICY_VERSION,
  MCP_TOOL_FALLBACKS,
  STABLE_MCP_TOOL_IDS,
  reconcileMcpEnabledToolIdsDetailed,
} from "../src/lib/mcp/tool-permissions";

class PermissionStorage implements McpToolPermissionsStorage {
  current: unknown[];
  writes: string[][] = [];
  stageWrites: Array<{
    enabledTools: string[];
    pendingHighRiskToolIds: string[];
    removedToolIds: string[];
  }> = [];
  configured: boolean;
  pendingHighRiskToolIds: string[];
  permissionPolicyVersion: number | undefined;
  readError: Error | null = null;
  writeError: Error | null = null;

  constructor(
    current: unknown[] = [],
    configured = true,
    pendingHighRiskToolIds: string[] = [],
    permissionPolicyVersion: number | null = MCP_PERMISSION_POLICY_VERSION,
  ) {
    this.current = current;
    this.configured = configured;
    this.pendingHighRiskToolIds = pendingHighRiskToolIds;
    this.permissionPolicyVersion = permissionPolicyVersion ?? undefined;
  }

  getMcpEnabledTools(): string[] {
    if (this.readError) throw this.readError;
    return reconcileMcpEnabledToolIdsDetailed(this.current).enabledToolIds;
  }

  getMcpEnabledToolsSnapshot(): McpToolPermissionsStorageSnapshot {
    if (this.readError) throw this.readError;
    const reconciliation = reconcileMcpEnabledToolIdsDetailed(this.current);
    return {
      enabledTools: reconciliation.enabledToolIds,
      removedToolIds: reconciliation.removedToolIds,
      pendingHighRiskToolIds: [...this.pendingHighRiskToolIds],
      configured: this.configured,
      permissionPolicyVersion: this.permissionPolicyVersion,
    };
  }

  setMcpEnabledTools(enabledTools: string[]): void {
    if (this.writeError) throw this.writeError;
    this.current = [...enabledTools];
    this.configured = true;
    this.pendingHighRiskToolIds = [];
    this.permissionPolicyVersion = MCP_PERMISSION_POLICY_VERSION;
    this.writes.push([...enabledTools]);
  }

  stageMcpEnabledTools(
    enabledTools: string[],
    pendingHighRiskToolIds: string[],
    removedToolIds: string[],
  ): void {
    if (this.writeError) throw this.writeError;
    this.current = [...enabledTools];
    this.configured = true;
    this.pendingHighRiskToolIds = [...pendingHighRiskToolIds];
    this.permissionPolicyVersion = MCP_PERMISSION_POLICY_VERSION;
    this.stageWrites.push({
      enabledTools: [...enabledTools],
      pendingHighRiskToolIds: [...pendingHighRiskToolIds],
      removedToolIds: [...removedToolIds],
    });
  }
}

function descriptor(name: string, enabled = false): McpToolDescriptor {
  const fallback = MCP_TOOL_FALLBACKS.find((tool) => tool.id === name);
  return {
    name,
    title:
      name === "future_admin_tool"
        ? "Future admin tool"
        : (fallback?.label ?? `Backend title for ${name}`),
    description:
      name === "future_admin_tool"
        ? "A newly reported tool without reviewed frontend metadata."
        : (fallback?.description ?? `Backend description for ${name}`),
    enabled,
  };
}

function status(
  enabledTools: string[] = [...STABLE_MCP_TOOL_IDS],
  extraToolIds: string[] = [],
): McpServerStatus {
  const toolIds = [...STABLE_MCP_TOOL_IDS, ...extraToolIds];
  return {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    url: "http://127.0.0.1:8787/mcp",
    enabledTools,
    tools: toolIds.map((id) => descriptor(id, enabledTools.includes(id))),
  };
}

function clientFor(initialStatus: McpServerStatus): {
  client: McpToolPermissionsClient;
  saveCalls: string[][];
  appliedStatuses: McpServerStatus[];
} {
  const saveCalls: string[][] = [];
  const appliedStatuses: McpServerStatus[] = [];
  return {
    saveCalls,
    appliedStatuses,
    client: {
      load: async () => initialStatus,
      save: async (enabledTools) => {
        saveCalls.push([...enabledTools]);
        const appliedStatus = {
          ...initialStatus,
          enabledTools: [...enabledTools],
          tools: initialStatus.tools.map((tool) => ({
            ...tool,
            enabled: enabledTools.includes(tool.name),
          })),
        };
        appliedStatuses.push(appliedStatus);
        return appliedStatus;
      },
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function statusWithoutEnabledFields(
  tools: McpToolDescriptor[] | undefined,
): McpServerStatus {
  return {
    ...status([]),
    enabledTools: undefined,
    enabled_tools: undefined,
    tools: tools as McpToolDescriptor[],
  };
}

async function waitUntilReady(): Promise<void> {
  await waitFor(() => {
    assert.ok(screen.getByRole("heading", { name: "MCP tool permissions" }));
  });
}

function renderInStrictMode(element: React.ReactElement) {
  return render(<React.StrictMode>{element}</React.StrictMode>);
}

afterEach(() => {
  cleanup();
});

test("shows a persistent reconciliation state while the MCP catalog is pending", () => {
  const client: McpToolPermissionsClient = {
    load: () => new Promise<McpServerStatus>(() => {}),
    save: async () => status([]),
  };

  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  assert.equal(
    screen.getByRole("status").textContent,
    "Loading and reconciling MCP tool permissions…",
  );
});

test("StrictMode effect replay restores the mounted generation and reconciles once", async () => {
  const storage = new PermissionStorage();
  const { client, saveCalls } = clientFor(status([]));

  renderInStrictMode(
    <McpToolPermissions client={client} storage={storage} />,
  );
  await waitUntilReady();

  assert.deepEqual(saveCalls, [[]]);
  assert.deepEqual(storage.current, []);
  assert.equal(screen.queryByRole("alert"), null);
});

test("StrictMode and 96 controlled updates coalesce one deferred load and apply only the bounded latest selection", async () => {
  const deferredLoad = deferred<McpServerStatus>();
  const storage = new PermissionStorage();
  const saveCalls: string[][] = [];
  const callbacks: string[][] = [];
  let loadCalls = 0;
  const client: McpToolPermissionsClient = {
    load: () => {
      loadCalls += 1;
      return deferredLoad.promise;
    },
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      return status(enabledTools);
    },
  };
  const onApplied = (enabledTools: string[]) => {
    callbacks.push([...enabledTools]);
  };
  const rendered = renderInStrictMode(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );

  await waitFor(() => assert.equal(loadCalls, 1));
  let latestControlledSelection = [
    "cf_get_zone_analytics",
    "unknown_latest_controlled_tool",
  ];
  for (let index = 0; index < 96; index += 1) {
    latestControlledSelection =
      index === 95
        ? ["cf_get_zone_analytics", "unknown_latest_controlled_tool"]
        : [
            index % 2 === 0
              ? "cf_list_zones"
              : "cf_list_dns_records",
            `unknown_stale_controlled_${String(index).padStart(3, "0")}`,
          ];
    rendered.rerender(
      <React.StrictMode>
        <McpToolPermissions
          client={client}
          storage={storage}
          enabledTools={latestControlledSelection}
          onApplied={onApplied}
        />
      </React.StrictMode>,
    );
  }

  await Promise.resolve();
  assert.equal(loadCalls, 1);
  assert.deepEqual(saveCalls, []);

  deferredLoad.resolve(status([]));
  await waitUntilReady();

  assert.equal(loadCalls, 1);
  assert.deepEqual(saveCalls, [["cf_get_zone_analytics"]]);
  assert.deepEqual(storage.current, ["cf_get_zone_analytics"]);
  assert.deepEqual(callbacks, [["cf_get_zone_analytics"]]);
  assert.deepEqual(storage.stageWrites, [
    {
      enabledTools: ["cf_get_zone_analytics"],
      pendingHighRiskToolIds: [],
      removedToolIds: ["unknown_latest_controlled_tool"],
    },
  ]);
  assert.ok(screen.getByText(/unknown_latest_controlled_tool/));
  assert.equal(screen.queryByText(/unknown_stale_controlled_/), null);
  assert.equal(screen.queryByRole("alertdialog"), null);
});

test("load immediately applies the reconciled stored source of truth instead of the stale server state", async () => {
  const storage = new PermissionStorage([
    "cf_create_dns_record",
    "cf_list_zones",
    "removed_persisted_tool",
  ]);
  const initialStatus = status([
    "cf_list_zones",
    "cf_create_dns_record",
    "cf_get_dnssec",
    "removed_server_tool",
  ]);
  const { client, saveCalls, appliedStatuses } = clientFor(initialStatus);
  const applied: Array<{ enabledTools: string[]; status: McpServerStatus }> =
    [];

  render(
    <McpToolPermissions
      client={client}
      storage={storage}
      onApplied={(enabledTools, nextStatus) =>
        applied.push({ enabledTools, status: nextStatus })
      }
    />,
  );

  await waitUntilReady();
  assert.deepEqual(saveCalls, [["cf_list_zones", "cf_create_dns_record"]]);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.stageWrites, [
    {
      enabledTools: ["cf_list_zones", "cf_create_dns_record"],
      pendingHighRiskToolIds: [],
      removedToolIds: ["removed_persisted_tool", "removed_server_tool"],
    },
  ]);
  assert.deepEqual(applied, [
    {
      enabledTools: ["cf_list_zones", "cf_create_dns_record"],
      status: appliedStatuses[0],
    },
  ]);
  assert.ok(
    screen.getByText(
      /Removed 2 unknown MCP tool IDs.*removed_persisted_tool.*removed_server_tool/,
    ),
  );
  assert.equal(
    (
      screen.getByRole("checkbox", {
        name: /^Create DNS record/,
      }) as HTMLInputElement
    ).checked,
    true,
  );
});

for (const [label, permissionPolicyVersion] of [
  ["absent", null],
  ["unknown", MCP_PERMISSION_POLICY_VERSION + 1],
] as const) {
  test(`${label} custom-storage policy versions stage legacy high-risk permissions before server reconciliation`, async () => {
    const storage = new PermissionStorage(
      ["cf_list_zones", "cf_create_dns_record"],
      true,
      [],
      permissionPolicyVersion,
    );
    const { client, saveCalls } = clientFor(
      status(["cf_list_zones", "cf_create_dns_record"]),
    );

    render(<McpToolPermissions client={client} storage={storage} />);
    await waitUntilReady();

    const confirmation = screen.getByRole("alertdialog");
    assert.ok(within(confirmation).getByText(/Create DNS record/));
    assert.deepEqual(saveCalls, [["cf_list_zones"]]);
    assert.deepEqual(storage.current, ["cf_list_zones"]);
    assert.deepEqual(storage.pendingHighRiskToolIds, [
      "cf_create_dns_record",
    ]);
    assert.equal(
      storage.permissionPolicyVersion,
      MCP_PERMISSION_POLICY_VERSION,
    );
    assert.equal(storage.stageWrites.length, 2);
    for (const staged of storage.stageWrites) {
      assert.deepEqual(staged, {
        enabledTools: ["cf_list_zones"],
        pendingHighRiskToolIds: ["cf_create_dns_record"],
        removedToolIds: [],
      });
    }
  });
}

test("fresh installation applies only conservative read-only defaults even when the server starts empty", async () => {
  const storage = new PermissionStorage(
    [...DEFAULT_MCP_ENABLED_TOOL_IDS],
    false,
  );
  const { client, saveCalls } = clientFor(status([]));

  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  assert.deepEqual(saveCalls, [[...DEFAULT_MCP_ENABLED_TOOL_IDS]]);
  assert.deepEqual(storage.writes, [[...DEFAULT_MCP_ENABLED_TOOL_IDS]]);
  const highRiskIds = new Set(
    MCP_TOOL_FALLBACKS.filter(({ risk }) => risk !== "read").map(
      ({ id }) => id,
    ),
  );
  assert.equal(
    saveCalls[0].some((toolId) => highRiskIds.has(toolId)),
    false,
  );
  assert.equal(screen.queryByRole("alertdialog"), null);
});

test("unknown tools are listed, warned, denied, and removed from server and storage", async () => {
  const storage = new PermissionStorage(["cf_list_zones", "future_admin_tool"]);
  const { client, saveCalls } = clientFor(
    status(["cf_list_zones", "future_admin_tool"], ["future_admin_tool"]),
  );

  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  const unknownCheckbox = screen.getByRole("checkbox", {
    name: /Future admin tool/,
  });
  assert.equal((unknownCheckbox as HTMLInputElement).checked, false);
  assert.equal((unknownCheckbox as HTMLInputElement).disabled, true);
  assert.ok(screen.getByText("Unclassified · denied"));
  assert.ok(screen.getByText(/Removed 1 unknown MCP tool ID/));
  assert.ok(within(screen.getByRole("alert")).getByText(/future_admin_tool/));
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.stageWrites, [
    {
      enabledTools: ["cf_list_zones"],
      pendingHighRiskToolIds: [],
      removedToolIds: ["future_admin_tool"],
    },
  ]);

  const unclassifiedGroup = screen.getByRole("group", {
    name: /Unclassified tools/,
  });
  assert.equal(
    within(unclassifiedGroup).queryByRole("button", {
      name: "Select visible",
    }),
    null,
  );
});

test("unknown permission diagnostics remain count- and length-bounded in UI staging", async () => {
  const unknownIds = Array.from(
    { length: MAX_MCP_PERMISSION_DIAGNOSTIC_IDS + 24 },
    (_, index) =>
      `unknown_${String(index).padStart(3, "0")}_${"x".repeat(
        MAX_MCP_PERMISSION_TOOL_ID_LENGTH * 2,
      )}`,
  );
  const storage = new PermissionStorage(unknownIds);
  const { client, saveCalls } = clientFor(status([]));

  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  assert.deepEqual(saveCalls, [[]]);
  assert.equal(storage.stageWrites.length, 1);
  assert.equal(
    storage.stageWrites[0].removedToolIds.length,
    MAX_MCP_PERMISSION_DIAGNOSTIC_IDS,
  );
  assert.equal(
    storage.stageWrites[0].removedToolIds.every(
      (id) => id.length <= MAX_MCP_PERMISSION_TOOL_ID_LENGTH,
    ),
    true,
  );
  assert.ok(
    screen.getByText(
      new RegExp(
        `Removed ${MAX_MCP_PERMISSION_DIAGNOSTIC_IDS} unknown MCP tool IDs`,
      ),
    ),
  );
  assert.equal(screen.queryByText(/unknown_064_/), null);
});

test("an incomplete catalogue retains at most the independent unknown-descriptor cap", async () => {
  const unknownToolIds = Array.from(
    { length: MAX_MCP_PERMISSION_DIAGNOSTIC_IDS },
    (_, index) => `unknown_catalogue_${String(index).padStart(3, "0")}`,
  );
  const cappedStatus = {
    ...status([]),
    tools: [
      descriptor("cf_list_zones", false),
      ...unknownToolIds.map((id) => descriptor(id, false)),
    ],
  };
  const { client, saveCalls } = clientFor(cappedStatus);

  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();

  assert.deepEqual(saveCalls, [[]]);
  assert.ok(
    screen.getByText(
      new RegExp(
        `${MAX_MCP_PERMISSION_DIAGNOSTIC_IDS} unclassified tools are denied`,
      ),
    ),
  );
  assert.equal(
    screen.getAllByText("Unclassified · denied").length,
    MAX_MCP_PERMISSION_DIAGNOSTIC_IDS,
  );
});

test("an incomplete catalogue exceeding the unknown-descriptor cap fails closed before save", async () => {
  const unknownToolIds = Array.from(
    { length: MAX_MCP_PERMISSION_DIAGNOSTIC_IDS + 1 },
    (_, index) => `unknown_catalogue_${String(index).padStart(3, "0")}`,
  );
  const overLimitStatus = {
    ...status([]),
    tools: [
      descriptor("cf_list_zones", false),
      ...unknownToolIds.map((id) => descriptor(id, false)),
    ],
  };
  const saveCalls: string[][] = [];
  const client: McpToolPermissionsClient = {
    load: async () => overLimitStatus,
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      return status(enabledTools);
    },
  };

  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        new RegExp(
          `more than ${MAX_MCP_PERMISSION_DIAGNOSTIC_IDS} unreviewed MCP tool descriptors`,
        ),
      ),
    );
  });
  assert.deepEqual(saveCalls, []);
});

test("every newly enabled write tool requires confirmation and cancel changes nothing", async () => {
  const { client, saveCalls } = clientFor(status());
  const { container } = render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();
  assert.deepEqual(saveCalls, [[]]);

  const checkbox = screen.getByRole("checkbox", {
    name: /^Create DNS record/,
  });
  fireEvent.click(checkbox);

  let confirmation = screen.getByRole("alertdialog");
  assert.equal(container.getAttribute("inert"), "");
  assert.equal(container.getAttribute("aria-hidden"), "true");
  assert.equal(container.style.pointerEvents, "none");
  assert.ok(within(confirmation).getByText("Enable Create DNS record?"));
  assert.ok(within(confirmation).getByText(/Changes data/));
  assert.equal(
    document.activeElement ===
      within(confirmation).getByRole("button", { name: "Cancel" }),
    true,
  );
  assert.deepEqual(saveCalls, [[]]);

  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(document.activeElement === checkbox, true));
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.equal(container.hasAttribute("inert"), false);
  assert.equal(container.hasAttribute("aria-hidden"), false);
  assert.equal(container.style.pointerEvents, "");
  assert.deepEqual(saveCalls, [[]]);
  assert.equal((checkbox as HTMLInputElement).checked, false);

  fireEvent.click(checkbox);
  confirmation = screen.getByRole("alertdialog");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [[], ["cf_create_dns_record"]]);
    assert.equal((checkbox as HTMLInputElement).checked, true);
    assert.equal(document.activeElement === checkbox, true);
    assert.equal(container.hasAttribute("inert"), false);
    assert.equal(container.hasAttribute("aria-hidden"), false);
    assert.equal(container.style.pointerEvents, "");
  });
});

test("confirmation modal traps focus, Escape cancels, and restores the trigger", async () => {
  const { client, saveCalls } = clientFor(status());
  const { container } = render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();

  const trigger = screen.getByRole("checkbox", {
    name: /^Delete DNS record/,
  });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("alertdialog");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  const confirm = within(dialog).getByRole("button", {
    name: "Confirm enable",
  });
  assert.equal(document.activeElement === cancel, true);

  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement === confirm, true);
  fireEvent.keyDown(confirm, { key: "Tab" });
  assert.equal(document.activeElement === cancel, true);

  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => assert.equal(document.activeElement === trigger, true));
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.equal(container.hasAttribute("inert"), false);
  assert.equal(container.hasAttribute("aria-hidden"), false);
  assert.equal(container.style.pointerEvents, "");
  assert.deepEqual(saveCalls, [[]]);
});

test("confirmation makes surrounding search, bulk controls, and checkboxes genuinely inert", async () => {
  const { client, saveCalls } = clientFor(status());
  const { container } = render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();

  const search = screen.getByRole("searchbox", { name: "Search tools" });
  const dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  const selectVisible = within(dnsGroup).getByRole("button", {
    name: "Select visible",
  });
  const readCheckbox = within(dnsGroup).getByRole("checkbox", {
    name: /^List DNS records/,
  });
  const highRiskTrigger = within(dnsGroup).getByRole("checkbox", {
    name: /^Create DNS record/,
  });

  fireEvent.click(highRiskTrigger);
  const dialog = screen.getByRole("alertdialog");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  assert.equal(container.getAttribute("inert"), "");
  assert.equal(container.getAttribute("aria-hidden"), "true");
  assert.equal(container.style.pointerEvents, "none");

  search.focus();
  assert.equal(document.activeElement === cancel, true);
  fireEvent.click(selectVisible);
  fireEvent.click(readCheckbox);
  assert.equal(screen.getByRole("alertdialog"), dialog);
  assert.equal((readCheckbox as HTMLInputElement).checked, false);
  assert.deepEqual(saveCalls, [[]]);

  fireEvent.click(cancel);
  await waitFor(() => assert.equal(document.activeElement, highRiskTrigger));
  assert.equal(container.hasAttribute("inert"), false);
  assert.equal(container.hasAttribute("aria-hidden"), false);
  assert.equal(container.style.pointerEvents, "");

  search.focus();
  assert.equal(document.activeElement, search);
  fireEvent.click(readCheckbox);
  await waitFor(() => {
    assert.deepEqual(saveCalls, [[], ["cf_list_dns_records"]]);
    assert.equal((readCheckbox as HTMLInputElement).checked, true);
  });
});

test("modal isolation restores the exact surrounding DOM state on unmount", async () => {
  const { client } = clientFor(status());
  const rendered = render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();

  fireEvent.click(screen.getByRole("checkbox", { name: /^Create DNS record/ }));
  assert.equal(rendered.container.getAttribute("inert"), "");
  rendered.unmount();

  assert.equal(rendered.container.hasAttribute("inert"), false);
  assert.equal(rendered.container.hasAttribute("aria-hidden"), false);
  assert.equal(rendered.container.style.pointerEvents, "");
});

test("the portal modal inerts and restores external application siblings", async () => {
  const externalSibling = document.createElement("button");
  externalSibling.textContent = "External application action";
  externalSibling.setAttribute("aria-hidden", "false");
  externalSibling.style.pointerEvents = "auto";
  document.body.appendChild(externalSibling);

  try {
    const { client } = clientFor(status());
    render(
      <McpToolPermissions client={client} storage={new PermissionStorage()} />,
    );
    await waitUntilReady();

    const trigger = screen.getByRole("checkbox", {
      name: /^Create DNS record/,
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });

    assert.ok(screen.getByTestId("mcp-permission-modal-backdrop"));
    assert.equal(externalSibling.getAttribute("inert"), "");
    assert.equal(externalSibling.getAttribute("aria-hidden"), "true");
    assert.equal(externalSibling.style.pointerEvents, "none");

    externalSibling.focus();
    assert.equal(document.activeElement, cancel);

    fireEvent.click(cancel);
    await waitFor(() => assert.equal(document.activeElement, trigger));
    assert.equal(externalSibling.hasAttribute("inert"), false);
    assert.equal(externalSibling.getAttribute("aria-hidden"), "false");
    assert.equal(externalSibling.style.pointerEvents, "auto");
  } finally {
    externalSibling.remove();
  }
});

test("filtered category bulk actions affect only the currently visible tools", async () => {
  const storage = new PermissionStorage(["cf_list_dns_records"]);
  const { client, saveCalls } = clientFor(status());
  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();
  assert.deepEqual(saveCalls, [["cf_list_dns_records"]]);

  fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), {
    target: { value: "cf_create_dns_record" },
  });
  let dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  assert.ok(within(dnsGroup).getByText("0 / 1 visible enabled"));
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Select visible" }),
  );
  const confirmation = screen.getByRole("alertdialog");
  assert.ok(within(confirmation).getByText("Enable visible DNS records?"));
  assert.equal(within(confirmation).queryByText(/Bulk create/), null);
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_dns_records"],
      ["cf_list_dns_records", "cf_create_dns_record"],
    ]);
  });
  dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  assert.ok(within(dnsGroup).getByText("1 / 1 visible enabled"));
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Clear visible" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls.at(-1), ["cf_list_dns_records"]);
  });
});

test("unfiltered category selection confirms every newly enabled high-risk tier", async () => {
  const { client, saveCalls } = clientFor(status());
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();

  const dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Select visible" }),
  );
  const confirmation = screen.getByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));
  assert.ok(within(confirmation).getByText(/Bulk create DNS records/));
  assert.ok(within(confirmation).getByText(/Bulk delete DNS records/));
  assert.ok(within(confirmation).getByText(/Export DNS records/));
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );

  const expectedDnsIds = MCP_TOOL_FALLBACKS.filter(
    ({ categoryId }) => categoryId === "dns-records",
  ).map(({ id }) => id);
  await waitFor(() => {
    assert.deepEqual(saveCalls, [[], expectedDnsIds]);
  });
});

test("initial controlled/imported high-risk values cannot bypass confirmation", async () => {
  const { client, saveCalls } = clientFor(status([]));
  const applied: string[][] = [];
  render(
    <McpToolPermissions
      client={client}
      storage={new PermissionStorage()}
      enabledTools={["cf_list_zones", "cf_create_dns_record"]}
      onApplied={(enabledTools) => applied.push(enabledTools)}
    />,
  );

  await waitUntilReady();
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.deepEqual(applied, [["cf_list_zones"]]);
  const confirmation = screen.getByRole("alertdialog");
  assert.ok(
    within(confirmation).getByText("Apply imported or parent MCP permissions?"),
  );
  assert.ok(within(confirmation).getByText(/Create DNS record/));

  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );
  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_zones"],
      ["cf_list_zones", "cf_create_dns_record"],
    ]);
    assert.deepEqual(applied.at(-1), ["cf_list_zones", "cf_create_dns_record"]);
  });
});

test("provisional conservative application preserves the requested high-risk selection and stable modal", async () => {
  const { client, saveCalls } = clientFor(status([]));
  const storage = new PermissionStorage();
  const applications: Array<{
    enabledTools: string[];
    synchronization: McpToolPermissionsApplication["synchronization"];
  }> = [];

  function ControlledPermissions() {
    const [requestedTools, setRequestedTools] = React.useState([
      "cf_list_zones",
      "cf_create_dns_record",
    ]);

    return (
      <>
        <output data-testid="requested-mcp-tools">
          {requestedTools.join(",")}
        </output>
        <McpToolPermissions
          client={client}
          storage={storage}
          enabledTools={requestedTools}
          onApplied={(enabledTools, _status, application) => {
            applications.push({
              enabledTools: [...enabledTools],
              synchronization: application.synchronization,
            });
            if (application.synchronization === "final") {
              setRequestedTools([...enabledTools]);
            }
          }}
        />
      </>
    );
  }

  render(<ControlledPermissions />);

  const confirmation = await screen.findByRole("alertdialog");
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.equal(
    screen.getByTestId("requested-mcp-tools").textContent,
    "cf_list_zones,cf_create_dns_record",
  );
  assert.deepEqual(applications, [
    {
      enabledTools: ["cf_list_zones"],
      synchronization: "provisional",
    },
  ]);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(screen.getByRole("alertdialog"), confirmation);

  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );
  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_zones"],
      ["cf_list_zones", "cf_create_dns_record"],
    ]);
    assert.deepEqual(applications.at(-1), {
      enabledTools: ["cf_list_zones", "cf_create_dns_record"],
      synchronization: "final",
    });
  });
});

test("noninteractive reconciliation applies the safe subset and defers confirmation UI", async () => {
  const storage = new PermissionStorage(["cf_list_zones"], true, [
    "cf_create_dns_record",
  ]);
  const { client, saveCalls } = clientFor(status([]));
  const props = {
    client,
    storage,
    enabledTools: ["cf_list_zones", "cf_create_dns_record"],
  };
  const { rerender } = render(
    <McpToolPermissions {...props} interactive={false} />,
  );

  await waitUntilReady();
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.equal(screen.queryByRole("alertdialog"), null);

  rerender(<McpToolPermissions {...props} interactive />);
  const confirmation = await screen.findByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
});

test("a late hidden high-risk request first synchronizes its conservative selection", async () => {
  const storage = new PermissionStorage(["cf_list_zones"]);
  const { client, saveCalls } = clientFor(status(["cf_list_zones"]));
  const applications: McpToolPermissionsApplication["synchronization"][] = [];
  const onApplied = (
    _enabledTools: string[],
    _status: McpServerStatus,
    application: McpToolPermissionsApplication,
  ) => applications.push(application.synchronization);
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      interactive={false}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_create_dns_record"]}
      interactive={false}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => {
    assert.deepEqual(saveCalls, [["cf_list_zones"], []]);
    assert.deepEqual(applications, ["final", "provisional"]);
  });
  assert.equal(screen.queryByRole("alertdialog"), null);

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_create_dns_record"]}
      interactive
      onApplied={onApplied}
    />,
  );
  assert.ok(await screen.findByRole("alertdialog"));
  assert.deepEqual(saveCalls, [["cf_list_zones"], []]);
});

test("storage-imported high-risk values stay staged until the same confirmation path approves them", async () => {
  const storage = new PermissionStorage(["cf_list_zones"], true, [
    "cf_create_dns_record",
    "cf_bulk_create_dns_records",
  ]);
  const { client, saveCalls } = clientFor(status([]));
  render(<McpToolPermissions client={client} storage={storage} />);

  await waitUntilReady();
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(storage.stageWrites, [
    {
      enabledTools: ["cf_list_zones"],
      pendingHighRiskToolIds: [
        "cf_create_dns_record",
        "cf_bulk_create_dns_records",
      ],
      removedToolIds: [],
    },
  ]);
  assert.deepEqual(storage.pendingHighRiskToolIds, [
    "cf_create_dns_record",
    "cf_bulk_create_dns_records",
  ]);
  const confirmation = screen.getByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));
  assert.ok(within(confirmation).getByText(/Bulk create DNS records/));

  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );
  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_zones"],
      ["cf_list_zones", "cf_create_dns_record", "cf_bulk_create_dns_records"],
    ]);
    assert.deepEqual(storage.writes, [
      ["cf_list_zones", "cf_create_dns_record", "cf_bulk_create_dns_records"],
    ]);
    assert.deepEqual(storage.pendingHighRiskToolIds, []);
  });
});

test("cancelling a staged import clears it without ever applying its high-risk tools", async () => {
  const storage = new PermissionStorage(["cf_list_zones"], true, [
    "cf_create_dns_record",
  ]);
  const { client, saveCalls } = clientFor(status([]));
  render(<McpToolPermissions client={client} storage={storage} />);

  await waitUntilReady();
  const confirmation = screen.getByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    assert.equal(screen.queryByRole("alertdialog"), null);
    assert.deepEqual(storage.pendingHighRiskToolIds, []);
  });
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.deepEqual(storage.writes, [["cf_list_zones"]]);
});

test("controlled changes use onApplied as the single parent synchronization contract", async () => {
  const { client, saveCalls, appliedStatuses } = clientFor(status());
  const callbacks: Array<{
    enabledTools: string[];
    status: McpServerStatus;
  }> = [];
  const storage = new PermissionStorage();
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={(enabledTools, nextStatus) =>
        callbacks.push({ enabledTools, status: nextStatus })
      }
    />,
  );
  await waitUntilReady();
  assert.deepEqual(callbacks, [
    { enabledTools: [], status: appliedStatuses[0] },
  ]);

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones", "unknown_profile_tool"]}
      onApplied={(enabledTools, nextStatus) =>
        callbacks.push({ enabledTools, status: nextStatus })
      }
    />,
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
    assert.deepEqual(callbacks.at(-1), {
      enabledTools: ["cf_list_zones"],
      status: appliedStatuses[1],
    });
  });
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.ok(screen.getByText(/unknown_profile_tool/));

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones", "cf_update_dnssec"]}
      onApplied={(enabledTools, nextStatus) =>
        callbacks.push({ enabledTools, status: nextStatus })
      }
    />,
  );
  const confirmation = await screen.findByRole("alertdialog");
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    assert.deepEqual(callbacks.at(-1)?.enabledTools, ["cf_list_zones"]);
  });
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
});

test("the latest controlled request supersedes a stale high-risk confirmation", async () => {
  const { client, saveCalls } = clientFor(status([]));
  const storage = new PermissionStorage();
  const { container, rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={() => {}}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_create_dns_record"]}
      onApplied={() => {}}
    />,
  );
  const staleConfirmation = await screen.findByRole("alertdialog");
  assert.ok(within(staleConfirmation).getByText(/Create DNS record/));
  assert.equal(container.getAttribute("inert"), "");

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={() => {}}
    />,
  );

  await waitFor(() => {
    assert.equal(screen.queryByRole("alertdialog"), null);
    assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
  });
  assert.deepEqual(storage.current, ["cf_list_zones"]);
  assert.equal(container.hasAttribute("inert"), false);
  assert.equal(container.hasAttribute("aria-hidden"), false);
  assert.equal(container.style.pointerEvents, "");
});

test("a confirmed-safe profile clears superseded staged permissions before restart", async () => {
  const { client, saveCalls } = clientFor(status([]));
  const storage = new PermissionStorage();
  const applications: Array<{
    enabledTools: string[];
    pendingHighRiskToolIds: string[];
    synchronization: McpToolPermissionsApplication["synchronization"];
  }> = [];
  const onApplied = (
    enabledTools: string[],
    _status: McpServerStatus,
    application: McpToolPermissionsApplication,
  ) => {
    applications.push({
      enabledTools: [...enabledTools],
      pendingHighRiskToolIds: [...storage.pendingHighRiskToolIds],
      synchronization: application.synchronization,
    });
  };
  const { rerender, unmount } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones", "cf_create_dns_record"]}
      onApplied={onApplied}
    />,
  );
  assert.ok(await screen.findByRole("alertdialog"));
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
  assert.deepEqual(storage.pendingHighRiskToolIds, [
    "cf_create_dns_record",
  ]);

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => {
    assert.equal(screen.queryByRole("alertdialog"), null);
    assert.deepEqual(storage.pendingHighRiskToolIds, []);
    assert.deepEqual(applications.at(-1), {
      enabledTools: ["cf_list_zones"],
      pendingHighRiskToolIds: [],
      synchronization: "final",
    });
  });
  assert.deepEqual(storage.writes, [["cf_list_zones"]]);

  unmount();
  const restartedClient = clientFor(status(["cf_list_zones"]));
  render(
    <McpToolPermissions
      client={restartedClient.client}
      storage={storage}
    />,
  );
  await waitUntilReady();

  assert.deepEqual(storage.pendingHighRiskToolIds, []);
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.deepEqual(restartedClient.saveCalls, [["cf_list_zones"]]);
});

test("cancelling high-risk C after in-flight B completes reasserts the last confirmed selection", async () => {
  const inFlightB = deferred<McpServerStatus>();
  const restoredA = deferred<McpServerStatus>();
  const saveCalls: string[][] = [];
  const callbacks: string[][] = [];
  const storage = new PermissionStorage();
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      if (saves === 1) return status([]);
      if (saves === 2) return inFlightB.promise;
      if (saves === 3) return restoredA.promise;
      throw new Error("cancel reconciliation scheduled more than one restore");
    },
  };
  const onApplied = (enabledTools: string[]) => {
    callbacks.push([...enabledTools]);
  };
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => assert.equal(saveCalls.length, 2));

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_create_dns_record"]}
      onApplied={onApplied}
    />,
  );
  const confirmation = await screen.findByRole("alertdialog");
  assert.ok(within(confirmation).getByText(/Create DNS record/));
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);

  inFlightB.resolve(status(["cf_list_zones"]));
  await inFlightB.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(screen.getByRole("alertdialog"), confirmation);
  assert.equal(saveCalls.length, 2);

  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  await waitFor(() => assert.equal(saveCalls.length, 3));
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
  assert.deepEqual(storage.current, []);
  assert.equal(
    callbacks.some((enabledTools) =>
      enabledTools.some(
        (id) => id === "cf_list_zones" || id === "cf_create_dns_record",
      ),
    ),
    false,
  );

  restoredA.resolve(status([]));
  await waitFor(() => {
    assert.equal(screen.queryByRole("alertdialog"), null);
    assert.deepEqual(storage.current, []);
    assert.deepEqual(callbacks.at(-1), []);
    assert.equal(screen.queryByRole("alert"), null);
  });
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
});

test("a hanging save retains only the latest of many controlled updates", async () => {
  const hangingSave = deferred<McpServerStatus>();
  const latestSave = deferred<McpServerStatus>();
  const saveCalls: string[][] = [];
  const callbacks: string[][] = [];
  const storage = new PermissionStorage();
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      if (saves === 1) return status([]);
      if (saves === 2) return hangingSave.promise;
      if (saves === 3) return latestSave.promise;
      throw new Error("latest-wins scheduler retained more than one queued save");
    },
  };
  const onApplied = (enabledTools: string[]) => {
    callbacks.push([...enabledTools]);
  };
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => assert.equal(saveCalls.length, 2));

  let latestControlledSelection = ["cf_list_dns_records"];
  for (let index = 0; index < 96; index += 1) {
    latestControlledSelection =
      index % 2 === 0
        ? ["cf_list_dns_records"]
        : ["cf_get_zone_analytics"];
    rerender(
      <McpToolPermissions
        client={client}
        storage={storage}
        enabledTools={latestControlledSelection}
        onApplied={onApplied}
      />,
    );
  }
  await Promise.resolve();
  assert.equal(
    saveCalls.length,
    2,
    "only the active request reaches the client while it is unresolved",
  );

  hangingSave.resolve(status(["cf_list_zones"]));
  await hangingSave.promise;
  await waitFor(() => assert.equal(saveCalls.length, 3));
  assert.deepEqual(saveCalls[2], latestControlledSelection);
  assert.deepEqual(storage.current, []);
  assert.deepEqual(callbacks, [[]]);

  const latestStatus = status(latestControlledSelection);
  latestSave.resolve(latestStatus);
  await waitFor(() => {
    assert.deepEqual(storage.current, latestControlledSelection);
    assert.deepEqual(callbacks.at(-1), latestControlledSelection);
    assert.equal(screen.queryByRole("alert"), null);
  });
  assert.deepEqual(saveCalls, [
    [],
    ["cf_list_zones"],
    latestControlledSelection,
  ]);
});

test("a newer controlled save supersedes an older save that resolves first", async () => {
  const olderSave = deferred<McpServerStatus>();
  const newerSave = deferred<McpServerStatus>();
  const saveCalls: string[][] = [];
  const callbacks: Array<{
    enabledTools: string[];
    status: McpServerStatus;
  }> = [];
  const storage = new PermissionStorage();
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      if (saves === 1) return status([]);
      if (saves === 2) return olderSave.promise;
      return newerSave.promise;
    },
  };
  const onApplied = (enabledTools: string[], nextStatus: McpServerStatus) => {
    callbacks.push({ enabledTools, status: nextStatus });
  };
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => assert.equal(saveCalls.length, 2));
  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_dns_records"]}
      onApplied={onApplied}
    />,
  );
  await Promise.resolve();
  assert.equal(
    saveCalls.length,
    2,
    "the newer controlled save waits for the in-flight save",
  );

  const staleStatus = status(["cf_list_zones"], ["stale_catalogue_tool"]);
  olderSave.resolve(staleStatus);
  await olderSave.promise;
  await waitFor(() => assert.equal(saveCalls.length, 3));
  assert.deepEqual(storage.current, []);
  assert.deepEqual(storage.writes, [[]]);
  assert.deepEqual(
    callbacks.map(({ enabledTools }) => enabledTools),
    [[]],
  );
  assert.equal(screen.queryByText("stale_catalogue_tool"), null);

  const authoritativeNewStatus = status(
    ["cf_list_dns_records"],
    ["new_catalogue_tool"],
  );
  newerSave.resolve(authoritativeNewStatus);
  await waitFor(() => {
    assert.deepEqual(storage.current, ["cf_list_dns_records"]);
    assert.deepEqual(callbacks.at(-1), {
      enabledTools: ["cf_list_dns_records"],
      status: authoritativeNewStatus,
    });
  });

  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], ["cf_list_dns_records"]]);
  assert.deepEqual(storage.writes, [[], ["cf_list_dns_records"]]);
  assert.equal(screen.queryByText("stale_catalogue_tool"), null);
  assert.ok(screen.getByText("new_catalogue_tool"));
  assert.equal(screen.queryByRole("alert"), null);
});

test("reverting a controlled request reasserts the applied selection after its stale save", async () => {
  const staleSave = deferred<McpServerStatus>();
  const restoreSave = deferred<McpServerStatus>();
  const saveCalls: string[][] = [];
  const callbacks: string[][] = [];
  const storage = new PermissionStorage();
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      if (saves === 1) return status([]);
      if (saves === 2) return staleSave.promise;
      return restoreSave.promise;
    },
  };
  const onApplied = (enabledTools: string[]) => {
    callbacks.push([...enabledTools]);
  };
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => assert.equal(saveCalls.length, 2));

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await Promise.resolve();
  assert.equal(saveCalls.length, 2);

  staleSave.resolve(status(["cf_list_zones"]));
  await staleSave.promise;
  await waitFor(() => assert.equal(saveCalls.length, 3));
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
  assert.deepEqual(storage.current, []);
  assert.deepEqual(callbacks, [[]]);

  const restoredStatus = status([]);
  restoreSave.resolve(restoredStatus);
  await waitFor(() => {
    assert.deepEqual(storage.current, []);
    assert.deepEqual(callbacks, [[], []]);
    assert.equal(screen.queryByRole("alert"), null);
  });
});

test("a stale non-authoritative save is ignored before the queued controlled save is applied", async () => {
  const olderSave = deferred<McpServerStatus>();
  const newerSave = deferred<McpServerStatus>();
  const saveCalls: string[][] = [];
  const callbacks: Array<{
    enabledTools: string[];
    status: McpServerStatus;
  }> = [];
  const storage = new PermissionStorage();
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      if (saves === 1) return status([]);
      if (saves === 2) return olderSave.promise;
      return newerSave.promise;
    },
  };
  const onApplied = (enabledTools: string[], nextStatus: McpServerStatus) => {
    callbacks.push({ enabledTools, status: nextStatus });
  };
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={[]}
      onApplied={onApplied}
    />,
  );
  await waitUntilReady();

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={onApplied}
    />,
  );
  await waitFor(() => assert.equal(saveCalls.length, 2));
  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_dns_records"]}
      onApplied={onApplied}
    />,
  );
  await Promise.resolve();
  assert.equal(
    saveCalls.length,
    2,
    "the newer controlled save is serialized behind the in-flight save",
  );

  olderSave.resolve(statusWithoutEnabledFields([]));
  await olderSave.promise;
  await waitFor(() => assert.equal(saveCalls.length, 3));

  const authoritativeNewStatus = status(["cf_list_dns_records"]);
  newerSave.resolve(authoritativeNewStatus);
  await waitFor(() => {
    assert.deepEqual(storage.current, ["cf_list_dns_records"]);
    assert.deepEqual(callbacks.at(-1), {
      enabledTools: ["cf_list_dns_records"],
      status: authoritativeNewStatus,
    });
  });
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], ["cf_list_dns_records"]]);
  assert.deepEqual(storage.writes, [[], ["cf_list_dns_records"]]);
  assert.deepEqual(
    callbacks.map(({ enabledTools }) => enabledTools),
    [[], ["cf_list_dns_records"]],
  );
  assert.equal(callbacks.length, 2);
  assert.equal(callbacks[1].status, authoritativeNewStatus);
  assert.equal(
    (
      screen.getByRole("checkbox", {
        name: /^List DNS records/,
      }) as HTMLInputElement
    ).checked,
    true,
  );
  assert.equal(
    (
      screen.getByRole("checkbox", {
        name: /^List zones/,
      }) as HTMLInputElement
    ).checked,
    false,
  );
  assert.equal(screen.queryByRole("alert"), null);
});

test("an unknown-only controlled change is reconciled back through onApplied without a server write", async () => {
  const { client, saveCalls, appliedStatuses } = clientFor(status([]));
  const storage = new PermissionStorage();
  const callbacks: Array<{
    enabledTools: string[];
    status: McpServerStatus;
  }> = [];
  const { rerender } = render(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones"]}
      onApplied={(enabledTools, nextStatus) =>
        callbacks.push({ enabledTools, status: nextStatus })
      }
    />,
  );
  await waitUntilReady();
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);

  rerender(
    <McpToolPermissions
      client={client}
      storage={storage}
      enabledTools={["cf_list_zones", "future_profile_tool"]}
      onApplied={(enabledTools, nextStatus) =>
        callbacks.push({ enabledTools, status: nextStatus })
      }
    />,
  );

  await waitFor(() => {
    assert.deepEqual(callbacks.at(-1), {
      enabledTools: ["cf_list_zones"],
      status: appliedStatuses[0],
    });
    assert.ok(screen.getByText(/future_profile_tool/));
  });
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
});

test("a non-exact server response is rejected instead of diverging from storage and UI", async () => {
  let saves = 0;
  const storage = new PermissionStorage();
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async () => {
      saves += 1;
      return saves === 1 ? status(["cf_list_zones"]) : status([]);
    },
  };
  render(<McpToolPermissions client={client} storage={storage} />);

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /did not apply the exact reconciled MCP permission selection.*previous MCP server selection was restored/,
      ),
    );
  });
  assert.equal(saves, 2);
  assert.deepEqual(storage.writes, []);
});

for (const [label, nonAuthoritativeStatus] of [
  ["missing permission state", statusWithoutEnabledFields(undefined)],
  ["an empty catalogue", statusWithoutEnabledFields([])],
  [
    "a partial catalogue",
    statusWithoutEnabledFields([descriptor("cf_list_zones", true)]),
  ],
  [
    "conflicting explicit permission fields",
    {
      ...status(["cf_list_zones"]),
      enabled_tools: ["cf_list_dns_records"],
    },
  ],
] as const) {
  test(`${label} is non-authoritative and restores the last authoritative selection`, async () => {
    const storage = new PermissionStorage();
    const saveCalls: string[][] = [];
    let saves = 0;
    const client: McpToolPermissionsClient = {
      load: async () => status([]),
      save: async (enabledTools) => {
        saveCalls.push([...enabledTools]);
        saves += 1;
        if (saves === 1) return status([]);
        if (saves === 2) return nonAuthoritativeStatus;
        return status([]);
      },
    };
    render(<McpToolPermissions client={client} storage={storage} />);
    await waitUntilReady();

    const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
    fireEvent.click(checkbox);

    const expectedError =
      "MCP permissions could not be saved. No local selection was changed: " +
      "The desktop service response did not report authoritative MCP permission state. " +
      "Expected enabledTools/enabled_tools or a complete reviewed tool catalogue. " +
      "The previous MCP server selection was restored.";
    await waitFor(() => {
      assert.equal(screen.getByRole("alert").textContent, expectedError);
    });
    assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
    assert.deepEqual(storage.writes, [[]]);
    assert.equal((checkbox as HTMLInputElement).checked, false);
  });
}

for (const [label, duplicateEnabledState] of [
  ["duplicate", true],
  ["contradictory", false],
] as const) {
  test(`${label} catalogue descriptors fail closed during apply and restore the confirmed selection`, async () => {
    const storage = new PermissionStorage();
    const saveCalls: string[][] = [];
    const malformedApplyStatus = status(["cf_list_zones"]);
    malformedApplyStatus.tools = [
      ...malformedApplyStatus.tools,
      descriptor("cf_list_zones", duplicateEnabledState),
    ];
    let saves = 0;
    const client: McpToolPermissionsClient = {
      load: async () => status([]),
      save: async (enabledTools) => {
        saveCalls.push([...enabledTools]);
        saves += 1;
        if (saves === 1) return status([]);
        if (saves === 2) return malformedApplyStatus;
        return status([]);
      },
    };
    render(<McpToolPermissions client={client} storage={storage} />);
    await waitUntilReady();

    const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
    fireEvent.click(checkbox);

    await waitFor(() => {
      assert.ok(
        screen.getByText(
          /duplicate or contradictory MCP tool descriptors for cf_list_zones.*previous MCP server selection was restored/,
        ),
      );
    });
    assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
    assert.deepEqual(storage.current, []);
    assert.equal((checkbox as HTMLInputElement).checked, false);
  });

  test(`${label} catalogue descriptors also fail closed when verifying rollback`, async () => {
    const storage = new PermissionStorage();
    const saveCalls: string[][] = [];
    const malformedRollbackStatus = status([]);
    malformedRollbackStatus.tools = [
      ...malformedRollbackStatus.tools,
      descriptor("cf_list_zones", !duplicateEnabledState),
    ];
    let saves = 0;
    const client: McpToolPermissionsClient = {
      load: async () => status([]),
      save: async (enabledTools) => {
        saveCalls.push([...enabledTools]);
        saves += 1;
        if (saves === 1) return status([]);
        if (saves === 2) return status([]);
        return malformedRollbackStatus;
      },
    };
    render(<McpToolPermissions client={client} storage={storage} />);
    await waitUntilReady();

    const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
    fireEvent.click(checkbox);

    await waitFor(() => {
      assert.ok(
        screen.getByText(
          /did not apply the exact reconciled MCP permission selection.*Automatic rollback.*duplicate or contradictory MCP tool descriptors for cf_list_zones/,
        ),
      );
    });
    assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
    assert.deepEqual(storage.current, []);
    assert.equal((checkbox as HTMLInputElement).checked, false);
  });
}

test("a complete reviewed catalogue is authoritative without enabled-tools fields", async () => {
  const storage = new PermissionStorage();
  const saveCalls: string[][] = [];
  let saves = 0;
  const completeCatalogueStatus = statusWithoutEnabledFields(
    STABLE_MCP_TOOL_IDS.map((id) => descriptor(id, id === "cf_list_zones")),
  );
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      return saves === 1 ? status([]) : completeCatalogueStatus;
    },
  };
  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
  fireEvent.click(checkbox);
  await waitFor(() => {
    assert.equal((checkbox as HTMLInputElement).checked, true);
  });

  assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
  assert.deepEqual(storage.writes, [[], ["cf_list_zones"]]);
  assert.equal(screen.queryByRole("alert"), null);
});

test("an explicit empty enabledTools array is authoritative", async () => {
  const storage = new PermissionStorage(["cf_list_zones"]);
  const saveCalls: string[][] = [];
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status(["cf_list_zones"]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      if (saves === 1) return status(["cf_list_zones"]);
      return { ...statusWithoutEnabledFields([]), enabledTools: [] };
    },
  };
  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
  fireEvent.click(checkbox);
  await waitFor(() => {
    assert.equal((checkbox as HTMLInputElement).checked, false);
  });

  assert.deepEqual(saveCalls, [["cf_list_zones"], []]);
  assert.deepEqual(storage.writes, [["cf_list_zones"], []]);
  assert.equal(screen.queryByRole("alert"), null);
});

test("rollback is not reported successful when its response is non-authoritative", async () => {
  const storage = new PermissionStorage();
  const saveCalls: string[][] = [];
  let saves = 0;
  const nonAuthoritative = statusWithoutEnabledFields([]);
  const client: McpToolPermissionsClient = {
    load: async () => status([]),
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      saves += 1;
      return saves === 1 ? status([]) : nonAuthoritative;
    },
  };
  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  fireEvent.click(screen.getByRole("checkbox", { name: /List zones/ }));

  const authorityError =
    "The desktop service response did not report authoritative MCP permission state. " +
    "Expected enabledTools/enabled_tools or a complete reviewed tool catalogue.";
  const expectedError =
    "MCP permissions could not be saved. No local selection was changed: " +
    `${authorityError} Automatic rollback to the previous MCP server selection also failed: ${authorityError}`;
  await waitFor(() => {
    assert.equal(screen.getByRole("alert").textContent, expectedError);
  });
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
  assert.deepEqual(storage.writes, [[]]);
});

test("a local persistence failure rolls the server back and leaves the applied UI unchanged", async () => {
  const storage = new PermissionStorage();
  const { client, saveCalls } = clientFor(status([]));
  render(<McpToolPermissions client={client} storage={storage} />);
  await waitUntilReady();

  storage.writeError = new Error("local permission storage is full");
  const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
  fireEvent.click(checkbox);

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /could not be persisted locally.*previous MCP server selection was restored/,
      ),
    );
  });
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"], []]);
  assert.equal((checkbox as HTMLInputElement).checked, false);
  assert.deepEqual(storage.current, []);
});

test("search uses reviewed metadata and reports no matches accessibly", async () => {
  const { client } = clientFor(status());
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();
  const search = screen.getByRole("searchbox", { name: "Search tools" });

  fireEvent.change(search, { target: { value: "SPF" } });
  assert.ok(screen.getByText("Simulate SPF"));
  assert.ok(screen.getByText("Build SPF graph"));
  assert.equal(screen.queryByText("List zones"), null);

  fireEvent.change(search, { target: { value: "does-not-exist" } });
  assert.ok(screen.getByText("No MCP tools match “does-not-exist”."));
});

test("load reconciliation failures remain visible and can be retried", async () => {
  let saves = 0;
  const client: McpToolPermissionsClient = {
    load: async () => status(),
    save: async (enabledTools) => {
      saves += 1;
      if (saves === 1) throw new Error("desktop permission store unavailable");
      return status(enabledTools);
    },
  };
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /could not be loaded and reconciled: desktop permission store unavailable/,
      ),
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry loading tools" }));
  await waitUntilReady();
  assert.equal(saves, 2);
});

test("save errors remain visible and leave the applied selection unchanged", async () => {
  const saveCalls: string[][] = [];
  let saves = 0;
  const initialStatus = status();
  const client: McpToolPermissionsClient = {
    load: async () => initialStatus,
    save: async (enabledTools) => {
      saves += 1;
      saveCalls.push([...enabledTools]);
      if (saves > 1) throw new Error("permission store is read-only");
      return status(enabledTools);
    },
  };
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();

  const checkbox = screen.getByRole("checkbox", { name: /List zones/ });
  fireEvent.click(checkbox);

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /MCP permissions could not be saved.*permission store is read-only/,
      ),
    );
  });
  assert.deepEqual(saveCalls, [[], ["cf_list_zones"]]);
  assert.equal((checkbox as HTMLInputElement).checked, false);
});
