import assert from "node:assert/strict";
import React from "react";
import { afterEach, test, beforeEach, mock } from "node:test";
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
  mock.restoreAll();
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
  mock.method(HTMLAnchorElement.prototype, "click", () => {});

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

test("AuditLogDialog ignores stale loads across close and reopen", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let resolveFirst: ((entries: unknown[]) => void) | undefined;
  let calls = 0;
  TauriClient.getAuditEntries = async () => {
    calls += 1;
    if (calls === 1) {
      return new Promise<unknown[]>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return [{ operation: "fresh-entry", timestamp: "2026-01-02T00:00:00Z" }];
  };

  const view = render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  view.rerender(<AuditLogDialog open={false} onOpenChange={() => {}} />);
  view.rerender(<AuditLogDialog open={true} onOpenChange={() => {}} />);

  await waitFor(() => {
    assert.ok(screen.getByText("fresh-entry"));
  });

  await act(async () => {
    resolveFirst?.([
      { operation: "stale-entry", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    await Promise.resolve();
  });

  assert.equal(screen.queryByText("stale-entry"), null);
  assert.ok(screen.getByText("fresh-entry"));
});

test("AuditLogDialog revokes export URLs and removes links when click fails", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  TauriClient.exportAuditEntries = async () => "{}";
  const revoked: string[] = [];
  mock.method(URL, "createObjectURL", () => "blob:audit-export");
  mock.method(URL, "revokeObjectURL", (url: string) => {
    revoked.push(url);
  });
  mock.method(HTMLAnchorElement.prototype, "click", () => {
    throw new Error("download click failed");
  });

  render(<AuditLogDialog open={true} onOpenChange={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Export JSON" }));
  });

  fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

  await waitFor(() => {
    assert.ok(screen.getByText("download click failed"));
  });
  assert.deepEqual(revoked, ["blob:audit-export"]);
  assert.equal(document.querySelector("a[download='audit-log.json']"), null);
});
