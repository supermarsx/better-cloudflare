import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";

import { useCloudflareAPI } from "../src/hooks/use-cloudflare-api";
import { TauriClient } from "../src/lib/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalGetZones = TauriClient.getZones;
const originalSimulate = TauriClient.simulateSPF;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.getZones = originalGetZones;
  TauriClient.simulateSPF = originalSimulate;
});

test("useCloudflareAPI routes getZones to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.getZones = async (...args: unknown[]) => {
    params = args;
    return [{ id: "1", name: "zone" }] as any;
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI("token", "user@example.com");
    return null;
  }

  act(() => {
    create(React.createElement(Wrapper));
  });

  const zones = await api.getZones();
  assert.equal(zones.length, 1);
  assert.deepEqual(params, ["token", "user@example.com"]);
});

test("useCloudflareAPI routes simulateSPF to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.simulateSPF = async (...args: unknown[]) => {
    params = args;
    return { result: "pass", reasons: [], lookups: 1 };
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI("token");
    return null;
  }

  act(() => {
    create(React.createElement(Wrapper));
  });

  const res = await api.simulateSPF("example.com", "1.2.3.4");
  assert.equal(res.result, "pass");
  assert.deepEqual(params, ["example.com", "1.2.3.4"]);
});
