import assert from "node:assert/strict";
import React from "react";
import { after, test } from "node:test";
import { act, create } from "react-test-renderer";

import { AuditLogDialog } from "../src/components/audit/AuditLogDialog";
import { TauriClient } from "../src/lib/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalExport = TauriClient.exportAuditEntries;

after(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.exportAuditEntries = originalExport;
});

test("AuditLogDialog shows desktop-only message when not in Tauri", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(AuditLogDialog, {
        open: true,
        onOpenChange: () => {},
      }),
    );
  });
  const text = renderer.toJSON();
  const json = JSON.stringify(text);
  assert.match(json, /desktop app/i);
});

test("AuditLogDialog loads entries in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  const original = TauriClient.getAuditEntries;
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  TauriClient.exportAuditEntries = async () => "{}";
  try {
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        React.createElement(AuditLogDialog, {
          open: true,
          onOpenChange: () => {},
        }),
      );
    });
    const json = JSON.stringify(renderer!.toJSON());
    assert.match(json, /dns:create/);
    assert.match(json, /2026-01-01/);
    assert.match(json, /Export JSON/);
    assert.match(json, /Export CSV/);
  } finally {
    TauriClient.getAuditEntries = original;
  }
});

test("AuditLogDialog calls backend export", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getAuditEntries = async () => [
    { operation: "dns:create", timestamp: "2026-01-01T00:00:00Z" },
  ];
  let called: string[] = [];
  TauriClient.exportAuditEntries = async (format: "json" | "csv" = "json") => {
    called.push(format);
    return "{}";
  };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(AuditLogDialog, {
        open: true,
        onOpenChange: () => {},
      }),
    );
  });
  const buttons = renderer!.root.findAllByType("button");
  const exportJson = buttons.find((b) =>
    String(b.children).includes("Export JSON"),
  );
  const exportCsv = buttons.find((b) =>
    String(b.children).includes("Export CSV"),
  );
  await act(async () => exportJson!.props.onClick());
  await act(async () => exportCsv!.props.onClick());
  assert.deepEqual(called, ["json", "csv"]);
});

test("AuditLogDialog handles load errors", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  const original = TauriClient.getAuditEntries;
  TauriClient.getAuditEntries = async () => {
    throw new Error("boom");
  };
  TauriClient.exportAuditEntries = async () => "{}";
  try {
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        React.createElement(AuditLogDialog, {
          open: true,
          onOpenChange: () => {},
        }),
      );
    });
    const json = JSON.stringify(renderer!.toJSON());
    assert.match(json, /boom/);
  } finally {
    TauriClient.getAuditEntries = original;
  }
});

test("AuditLogDialog closes", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let closed = false;
  const renderer = create(
    React.createElement(AuditLogDialog, {
      open: true,
      onOpenChange: (open) => {
        closed = !open;
      },
    }),
  );
  const buttons = renderer.root.findAllByType("button");
  const close = buttons.find((b) =>
    String(b.children).toLowerCase().includes("close"),
  );
  assert.ok(close);
  await act(async () => close!.props.onClick());
  assert.equal(closed, true);
});
