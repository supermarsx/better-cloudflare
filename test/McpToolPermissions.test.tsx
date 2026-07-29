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
  readError: Error | null = null;
  writeError: Error | null = null;

  constructor(
    current: unknown[] = [],
    configured = true,
    pendingHighRiskToolIds: string[] = [],
  ) {
    this.current = current;
    this.configured = configured;
    this.pendingHighRiskToolIds = pendingHighRiskToolIds;
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
    };
  }

  setMcpEnabledTools(enabledTools: string[]): void {
    if (this.writeError) throw this.writeError;
    this.current = [...enabledTools];
    this.configured = true;
    this.pendingHighRiskToolIds = [];
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

async function waitUntilReady(): Promise<void> {
  await waitFor(() => {
    assert.ok(screen.getByRole("heading", { name: "MCP tool permissions" }));
  });
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
  assert.deepEqual(storage.writes, [["cf_list_zones", "cf_create_dns_record"]]);
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
  assert.deepEqual(storage.writes, [["cf_list_zones"]]);

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

test("every newly enabled write tool requires confirmation and cancel changes nothing", async () => {
  const { client, saveCalls } = clientFor(status());
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );
  await waitUntilReady();
  assert.deepEqual(saveCalls, [[]]);

  const checkbox = screen.getByRole("checkbox", {
    name: /^Create DNS record/,
  });
  fireEvent.click(checkbox);

  let confirmation = screen.getByRole("alertdialog");
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
  });
});

test("confirmation modal traps focus, Escape cancels, and restores the trigger", async () => {
  const { client, saveCalls } = clientFor(status());
  render(
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
  assert.deepEqual(saveCalls, [[]]);
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
  const { rerender } = render(
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
