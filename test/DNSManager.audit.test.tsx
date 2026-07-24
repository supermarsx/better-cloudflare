import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { DNSManager } from "../src/components/dns/DNSManager";
import { TauriClient } from "../src/lib/api/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalFetch = globalThis.fetch;
const originalGetPrefs = TauriClient.getPreferences;
const originalGetZones = TauriClient.getZones;
const originalGetDNSRecords = TauriClient.getDNSRecords;
const originalGetAuditEntries = TauriClient.getAuditEntries;
const originalClearAuditEntries = TauriClient.clearAuditEntries;

function setWindow(value: unknown): void {
  (globalThis as unknown as { window?: unknown }).window = value;
}

function setFetchMock(): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as Response;
}

function setDesktopClientMock(): void {
  TauriClient.getPreferences = async () => ({});
  TauriClient.getZones = async () => [];
  TauriClient.getDNSRecords = async () => [];
  TauriClient.getAuditEntries = async () => [];
  TauriClient.clearAuditEntries = async () => {};
}

beforeEach(() => {
  setWindow(originalWindow);
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  }
  setWindow(originalWindow);
  TauriClient.getPreferences = originalGetPrefs;
  TauriClient.getZones = originalGetZones;
  TauriClient.getDNSRecords = originalGetDNSRecords;
  TauriClient.getAuditEntries = originalGetAuditEntries;
  TauriClient.clearAuditEntries = originalClearAuditEntries;
  cleanup();
});

test("DNSManager shows audit button only in desktop mode", async () => {
  setWindow(undefined);
  setFetchMock();
  setDesktopClientMock();
  render(<DNSManager apiKey="token" onLogout={() => {}} />);

  await waitFor(() => {
    assert.equal(screen.queryByText(/Audit Log/i), null);
  });
  cleanup();

  setWindow({ __TAURI__: {} });
  setFetchMock();
  render(<DNSManager apiKey="token" onLogout={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: /audit log/i }));
  });
});

test("DNSManager opens audit dialog on click", async () => {
  setWindow({ __TAURI__: {} });
  setFetchMock();
  setDesktopClientMock();
  render(<DNSManager apiKey="token" onLogout={() => {}} />);

  const buttons = await screen.findAllByRole("button");
  const audit = buttons.find((button) =>
    String(button.getAttribute("aria-label") || "")
      .toLowerCase()
      .includes("audit log"),
  );
  assert.ok(audit);
  fireEvent.click(audit!);

  await waitFor(() => {
    assert.ok(
      screen.getByRole("heading", {
        name: /Audit log/i,
        level: 3,
      }),
    );
    assert.ok(screen.getByRole("button", { name: /refresh/i }));
  });
});
