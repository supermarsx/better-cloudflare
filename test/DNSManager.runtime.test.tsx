import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DNSManager } from "../src/components/dns/DNSManager";
import { TauriClient, type McpServerStatus } from "../src/lib/api/tauri-client";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

const originalWindow = (globalThis as { window?: unknown }).window;
const originalFetch = globalThis.fetch;

function setDesktopWindow(): void {
  (globalThis as { window?: unknown }).window = { __TAURI__: {} };
}

function createMcpStatus(enabledTools: string[] = []): McpServerStatus {
  return {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    url: "http://127.0.0.1:8787/mcp",
    enabledTools,
    tools: [
      {
        name: "dns_read",
        title: "Read DNS",
        description: "Read DNS records",
        enabled: enabledTools.includes("dns_read"),
      },
    ],
    lastError: null,
  };
}

function mockDnsRuntime(
  getPreferences: () => Promise<Record<string, unknown>>,
  setTools: (tools: string[]) => Promise<McpServerStatus> = async (tools) =>
    createMcpStatus(tools),
): void {
  mock.method(TauriClient, "getPreferences", getPreferences);
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => []);
  mock.method(TauriClient, "getDNSRecords", async () => []);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "setMcpEnabledTools", setTools);
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetRuntimeReportingForTests();
  (globalThis as { window?: unknown }).window = originalWindow;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
});

test("rejected desktop DNS preferences are reported without destroying the manager", async () => {
  setDesktopWindow();
  mockDnsRuntime(async () => {
    throw new Error("preferences failed token=desktop-secret");
  });

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await waitFor(() => {
    assert.ok(
      getRuntimeDiagnostics().some((diagnostic) =>
        diagnostic.label?.includes("Load desktop DNS preferences"),
      ),
    );
  });
  assert.ok(screen.getByRole("button", { name: "Settings" }));
  assert.doesNotMatch(
    getRuntimeDiagnostics()
      .map((diagnostic) => diagnostic.message)
      .join("\n"),
    /desktop-secret/,
  );
});

test("login-time MCP synchronization is contained and attempted only once", async () => {
  setDesktopWindow();
  let attempts = 0;
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_enabled_tools: ["dns_read"],
    }),
    async () => {
      attempts += 1;
      throw new Error(
        "invalid args `enabledTools` for command `mcp_set_enabled_tools`",
      );
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);

  await waitFor(() => {
    assert.ok(
      getRuntimeDiagnostics().some(
        (diagnostic) =>
          diagnostic.label === "Synchronize MCP server preferences",
      ),
    );
  });
  assert.equal(attempts, 1);
  assert.ok(screen.getByRole("button", { name: "Settings" }));
});

test("rejected MCP tool mutation rolls back selection and shows sanitized context", async () => {
  setDesktopWindow();
  let rejectToolMutation = false;
  mockDnsRuntime(
    async () => ({
      mcp_server_enabled: false,
      mcp_enabled_tools: [],
    }),
    async (tools) => {
      if (rejectToolMutation) {
        throw new Error("MCP tools failed token=hidden-tool-secret");
      }
      return createMcpStatus(tools);
    },
  );

  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
  fireEvent.click(await screen.findByRole("button", { name: "MCP" }));

  const enableAll = await screen.findByRole("button", { name: "Enable all" });
  await waitFor(() => assert.equal(enableAll.hasAttribute("disabled"), false));
  rejectToolMutation = true;
  fireEvent.click(enableAll);

  await waitFor(() => {
    assert.ok(screen.getByText("MCP tools failed token=[redacted]"));
  });
  const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
  assert.equal(checkbox.checked, false);
  assert.ok(
    getRuntimeDiagnostics().some(
      (diagnostic) => diagnostic.label === "Update MCP tool access",
    ),
  );
  assert.doesNotMatch(document.body.textContent ?? "", /hidden-tool-secret/);
});
