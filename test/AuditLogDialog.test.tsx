import assert from "node:assert/strict";
import React from "react";
import { afterEach, test, beforeEach } from "node:test";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";

import { AuditLogDialog } from "../src/components/audit/AuditLogDialog";
import { TauriClient } from "../src/lib/api/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalExport = TauriClient.exportAuditEntries;
const originalGet = TauriClient.getAuditEntries;

beforeEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.exportAuditEntries = originalExport;
  TauriClient.getAuditEntries = originalGet;
});

afterEach(() => {
  cleanup();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.exportAuditEntries = originalExport;
  TauriClient.getAuditEntries = originalGet;
});

test("AuditLogDialog shows desktop-only message when not in Tauri", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  TauriClient.getAuditEntries = async () => [];
  TauriClient.exportAuditEntries = async () => "{}";
  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(screen.getByText(/desktop app/i));
  });
});

test("AuditLogDialog loads entries in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  TauriClient.exportAuditEntries = async () => "{}";
  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });

  await waitFor(() => {
    assert.ok(
      screen.getByText((content, element) =>
        Boolean(
          element?.tagName === "DIV" &&
            element.classList.contains("font-medium") &&
            /dns:create/.test(content),
        ),
      ),
    );
    const entryTimestamp = screen.getByText((content, element) =>
      Boolean(
        element?.tagName === "DIV" &&
          element.classList.contains("text-muted-foreground") &&
          /2026-01-01/i.test(content),
      ),
    );
    assert.ok(entryTimestamp);
    assert.ok(screen.getByRole("button", { name: "Export JSON" }));
    assert.ok(screen.getByRole("button", { name: "Export CSV" }));
  });
});

test("AuditLogDialog calls backend export", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  const called: string[] = [];
  TauriClient.exportAuditEntries = async (format = "json") => {
    called.push(format);
    return "{}";
  };

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Export JSON" }));
    assert.ok(screen.getByRole("button", { name: "Export CSV" }));
  });

  const exportJson = screen.getByRole("button", { name: "Export JSON" });
  const exportCsv = screen.getByRole("button", { name: "Export CSV" });
  await act(async () => {
    fireEvent.click(exportJson);
    fireEvent.click(exportCsv);
  });
  await waitFor(() => {
    assert.deepEqual(called, ["json", "csv"]);
  });
});

test("AuditLogDialog handles load errors", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => {
    throw new Error("boom");
  };
  TauriClient.exportAuditEntries = async () => "{}";

  await act(async () => {
    render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  });
  await waitFor(() => {
    assert.ok(screen.getByText(/boom/i));
  });
});
