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
} from "../src/components/mcp/McpToolPermissions";
import type {
  McpServerStatus,
  McpToolDescriptor,
} from "../src/lib/api/tauri-client";

class PermissionStorage implements McpToolPermissionsStorage {
  current: string[];
  writes: string[][] = [];
  readError: Error | null = null;
  writeError: Error | null = null;

  constructor(current: string[] = []) {
    this.current = current;
  }

  getMcpEnabledTools(): string[] {
    if (this.readError) throw this.readError;
    return [...this.current];
  }

  setMcpEnabledTools(enabledTools: string[]): void {
    if (this.writeError) throw this.writeError;
    this.current = [...enabledTools];
    this.writes.push([...enabledTools]);
  }
}

function descriptor(name: string, enabled = false): McpToolDescriptor {
  return {
    name,
    title:
      name === "future_admin_tool"
        ? "Future admin tool"
        : `Backend title for ${name}`,
    description:
      name === "future_admin_tool"
        ? "A newly reported tool without reviewed frontend metadata."
        : `Backend description for ${name}`,
    enabled,
  };
}

function status(
  toolIds: string[],
  enabledTools: string[] = [],
): McpServerStatus {
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
} {
  const saveCalls: string[][] = [];
  return {
    saveCalls,
    client: {
      load: async () => initialStatus,
      save: async (enabledTools) => {
        saveCalls.push([...enabledTools]);
        return {
          ...initialStatus,
          enabledTools: [...enabledTools],
          tools: initialStatus.tools.map((tool) => ({
            ...tool,
            enabled: enabledTools.includes(tool.name),
          })),
        };
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

test("shows a persistent loading state while the MCP catalog is pending", () => {
  const client: McpToolPermissionsClient = {
    load: () => new Promise<McpServerStatus>(() => {}),
    save: async () => status([]),
  };

  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  assert.equal(
    screen.getByRole("status").textContent,
    "Loading MCP tool permissions…",
  );
});

test("shows a useful empty state when the backend reports no tools", async () => {
  const { client } = clientFor(status([]));
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  assert.ok(
    screen.getByText("No MCP tools are available from the desktop service."),
  );
  assert.ok(
    screen.getByText("0 of 0 classified tools enabled.", { exact: false }),
  );
});

test("unknown tools are visible, denied, and excluded from category grants", async () => {
  const initialStatus = status(
    ["cf_list_zones", "future_admin_tool"],
    ["future_admin_tool"],
  );
  const storage = new PermissionStorage(["future_admin_tool"]);
  const { client, saveCalls } = clientFor(initialStatus);
  render(<McpToolPermissions client={client} storage={storage} />);

  await waitUntilReady();
  const unknownCheckbox = screen.getByRole("checkbox", {
    name: /Future admin tool/,
  });
  assert.equal((unknownCheckbox as HTMLInputElement).checked, false);
  assert.equal((unknownCheckbox as HTMLInputElement).disabled, true);
  assert.ok(screen.getByText("Unclassified · denied"));
  assert.ok(
    screen.getByText("1 unclassified tool is denied.", { exact: false }),
  );
  assert.deepEqual(storage.writes.at(-1), []);

  const accessGroup = screen.getByRole("group", {
    name: /Access and zones/,
  });
  fireEvent.click(
    within(accessGroup).getByRole("button", { name: "Select category" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  });
  assert.equal(saveCalls.flat().includes("future_admin_tool"), false);

  const unclassifiedGroup = screen.getByRole("group", {
    name: /Unclassified tools/,
  });
  assert.equal(
    within(unclassifiedGroup).queryByRole("button", {
      name: "Select category",
    }),
    null,
  );
});

test("selects and clears a category while keeping category counts current", async () => {
  const { client, saveCalls } = clientFor(
    status(["cf_list_dns_records", "cf_create_dns_record"]),
  );
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  let dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  assert.ok(within(dnsGroup).getByText("0 / 2 enabled"));
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Select category" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_dns_records", "cf_create_dns_record"],
    ]);
    assert.ok(
      screen.getByText("2 of 2 classified tools enabled.", { exact: false }),
    );
  });

  dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  assert.ok(within(dnsGroup).getByText("2 / 2 enabled"));
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Clear category" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_dns_records", "cf_create_dns_record"],
      [],
    ]);
    assert.ok(
      screen.getByText("0 of 2 classified tools enabled.", { exact: false }),
    );
  });
});

test("requires confirmation for an individual destructive tool and cancel leaves state unchanged", async () => {
  const { client, saveCalls } = clientFor(status(["cf_delete_dns_record"]));
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  fireEvent.click(screen.getByRole("checkbox", { name: /Delete DNS record/ }));

  let confirmation = screen.getByRole("alertdialog");
  assert.ok(within(confirmation).getByText("Enable Delete DNS record?"));
  assert.deepEqual(saveCalls, []);
  assert.equal(
    (
      screen.getByRole("checkbox", {
        name: /Delete DNS record/,
      }) as HTMLInputElement
    ).checked,
    false,
  );

  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.equal(screen.queryByRole("alertdialog"), null);
  assert.deepEqual(saveCalls, []);
  assert.equal(
    (
      screen.getByRole("checkbox", {
        name: /Delete DNS record/,
      }) as HTMLInputElement
    ).checked,
    false,
  );

  fireEvent.click(screen.getByRole("checkbox", { name: /Delete DNS record/ }));
  confirmation = screen.getByRole("alertdialog");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [["cf_delete_dns_record"]]);
    assert.equal(
      (
        screen.getByRole("checkbox", {
          name: /Delete DNS record/,
        }) as HTMLInputElement
      ).checked,
      true,
    );
  });
});

test("requires confirmation for high-risk bulk selection and cancel leaves every tool unchanged", async () => {
  const { client, saveCalls } = clientFor(
    status(["cf_list_dns_records", "cf_delete_dns_record"]),
  );
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  let dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Select category" }),
  );

  let confirmation = screen.getByRole("alertdialog");
  assert.ok(within(confirmation).getByText("Enable DNS records?"));
  assert.ok(within(confirmation).getByText(/Delete DNS record/));
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.deepEqual(saveCalls, []);
  assert.ok(
    screen.getByText("0 of 2 classified tools enabled.", { exact: false }),
  );

  dnsGroup = screen.getByRole("group", { name: /DNS records/ });
  fireEvent.click(
    within(dnsGroup).getByRole("button", { name: "Select category" }),
  );
  confirmation = screen.getByRole("alertdialog");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Confirm enable" }),
  );

  await waitFor(() => {
    assert.deepEqual(saveCalls, [
      ["cf_list_dns_records", "cf_delete_dns_record"],
    ]);
  });
});

test("search filters by readable metadata and reports no matches accessibly", async () => {
  const { client } = clientFor(
    status(["cf_list_zones", "spf_simulate", "cf_get_dnssec"]),
  );
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  const search = screen.getByRole("searchbox", { name: "Search tools" });
  fireEvent.change(search, { target: { value: "SPF policy" } });

  assert.ok(screen.getByText("Simulate SPF"));
  assert.equal(screen.queryByText("List zones"), null);
  assert.equal(screen.queryByText("View DNSSEC"), null);

  fireEvent.change(search, { target: { value: "does-not-exist" } });
  assert.ok(screen.getByText("No MCP tools match “does-not-exist”."));
});

test("summary and category counts reflect only effective classified permissions", async () => {
  const { client } = clientFor(
    status(
      [
        "cf_list_zones",
        "cf_list_dns_records",
        "spf_simulate",
        "future_admin_tool",
      ],
      ["cf_list_zones", "spf_simulate", "future_admin_tool"],
    ),
  );
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  assert.ok(
    screen.getByText("2 of 3 classified tools enabled.", { exact: false }),
  );
  assert.ok(
    screen.getByText("1 unclassified tool is denied.", { exact: false }),
  );
  assert.ok(
    within(screen.getByRole("group", { name: /Access and zones/ })).getByText(
      "1 / 1 enabled",
    ),
  );
  assert.ok(
    within(screen.getByRole("group", { name: /DNS records/ })).getByText(
      "0 / 1 enabled",
    ),
  );
  assert.ok(
    within(screen.getByRole("group", { name: /SPF analysis/ })).getByText(
      "1 / 1 enabled",
    ),
  );
});

test("load errors remain visible and can be retried", async () => {
  let loads = 0;
  const client: McpToolPermissionsClient = {
    load: async () => {
      loads += 1;
      if (loads === 1) throw new Error("desktop service unavailable");
      return status([]);
    },
    save: async () => status([]),
  };
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /MCP tools could not be loaded: desktop service unavailable/,
      ),
    );
  });
  assert.ok(screen.getByRole("alert"));

  fireEvent.click(screen.getByRole("button", { name: "Retry loading tools" }));
  await waitFor(() => {
    assert.ok(
      screen.getByText("No MCP tools are available from the desktop service."),
    );
  });
  assert.equal(loads, 2);
});

test("save errors remain visible and leave the effective selection unchanged", async () => {
  const saveCalls: string[][] = [];
  const initialStatus = status(["cf_list_zones"]);
  const client: McpToolPermissionsClient = {
    load: async () => initialStatus,
    save: async (enabledTools) => {
      saveCalls.push([...enabledTools]);
      throw new Error("permission store is read-only");
    },
  };
  render(
    <McpToolPermissions client={client} storage={new PermissionStorage()} />,
  );

  await waitUntilReady();
  fireEvent.click(screen.getByRole("checkbox", { name: /List zones/ }));

  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /MCP permissions could not be saved.*permission store is read-only/,
      ),
    );
  });
  assert.deepEqual(saveCalls, [["cf_list_zones"]]);
  assert.equal(
    (
      screen.getByRole("checkbox", {
        name: /List zones/,
      }) as HTMLInputElement
    ).checked,
    false,
  );
  assert.ok(screen.getByRole("alert"));
});
