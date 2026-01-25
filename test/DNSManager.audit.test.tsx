import assert from "node:assert/strict";
import React from "react";
import { test, afterEach } from "node:test";
import { act, create } from "react-test-renderer";

import { DNSManager } from "../src/components/dns/DNSManager";
import { useCloudflareAPI } from "../src/hooks/use-cloudflare-api";
import { TauriClient } from "../src/lib/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalUseCloudflare = useCloudflareAPI;
const originalGetPrefs = TauriClient.getPreferences;

function mockHook() {
  return {
    getZones: async () => [],
    getDNSRecords: async () => [],
    createDNSRecord: async () => ({}),
    updateDNSRecord: async () => ({}),
    bulkCreateDNSRecords: async () => ({ created: [], skipped: [] }),
    deleteDNSRecord: async () => {},
    exportDNSRecords: async () => "",
  };
}

afterEach(() => {
  (useCloudflareAPI as unknown as (apiKey?: string, email?: string) => any) =
    originalUseCloudflare;
  TauriClient.getPreferences = originalGetPrefs;
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("DNSManager shows audit button only in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  (useCloudflareAPI as unknown as (apiKey?: string, email?: string) => any) =
    mockHook;
  let renderer = create(
    React.createElement(DNSManager, {
      apiKey: "token",
      onLogout: () => {},
    }),
  );
  let json = JSON.stringify(renderer.toJSON());
  assert.ok(!json.includes("Audit Log"));

  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getPreferences = async () => ({});
  renderer = create(
    React.createElement(DNSManager, {
      apiKey: "token",
      onLogout: () => {},
    }),
  );
  json = JSON.stringify(renderer.toJSON());
  assert.ok(json.includes("Audit Log"));

});

test("DNSManager opens audit dialog on click", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getPreferences = async () => ({});
  (useCloudflareAPI as unknown as (apiKey?: string, email?: string) => any) =
    mockHook;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(DNSManager, {
        apiKey: "token",
        onLogout: () => {},
      }),
    );
  });
  const buttons = renderer!.root.findAllByType("button");
  const audit = buttons.find((b) =>
    String(b.children).includes("Audit Log"),
  );
  assert.ok(audit);
  await act(async () => {
    audit!.props.onClick();
  });
  const json = JSON.stringify(renderer!.toJSON());
  assert.ok(json.includes("Audit Log"));
});
