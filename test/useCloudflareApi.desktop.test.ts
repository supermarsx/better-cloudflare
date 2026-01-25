import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";

import { useCloudflareAPI } from "../src/hooks/use-cloudflare-api";
import { TauriClient } from "../src/lib/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalGetZones = TauriClient.getZones;
const originalSimulate = TauriClient.simulateSPF;
const originalVault = TauriClient.getVaultSecret;
const originalRegOpts = TauriClient.getPasskeyRegistrationOptions;
const originalRegister = TauriClient.registerPasskey;
const originalAuthOpts = TauriClient.getPasskeyAuthOptions;
const originalAuth = TauriClient.authenticatePasskey;
const originalList = TauriClient.listPasskeys;
const originalDelete = TauriClient.deletePasskey;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.getZones = originalGetZones;
  TauriClient.simulateSPF = originalSimulate;
  TauriClient.getVaultSecret = originalVault;
  TauriClient.getPasskeyRegistrationOptions = originalRegOpts;
  TauriClient.registerPasskey = originalRegister;
  TauriClient.getPasskeyAuthOptions = originalAuthOpts;
  TauriClient.authenticatePasskey = originalAuth;
  TauriClient.listPasskeys = originalList;
  TauriClient.deletePasskey = originalDelete;
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

test("useCloudflareAPI routes getVaultSecret to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.getVaultSecret = async (...args: unknown[]) => {
    params = args;
    return "secret";
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI("token");
    return null;
  }

  act(() => {
    create(React.createElement(Wrapper));
  });

  const secret = await api.getVaultSecret("key1", "tok");
  assert.equal(secret, "secret");
  assert.deepEqual(params, ["key1", "tok"]);
});

test("useCloudflareAPI routes passkey commands to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let calls: Record<string, unknown[]> = {};
  TauriClient.getPasskeyRegistrationOptions = async (...args: unknown[]) => {
    calls.getPasskeyRegistrationOptions = args;
    return { options: { challenge: "abc" } };
  };
  TauriClient.registerPasskey = async (...args: unknown[]) => {
    calls.registerPasskey = args;
  };
  TauriClient.getPasskeyAuthOptions = async (...args: unknown[]) => {
    calls.getPasskeyAuthOptions = args;
    return { options: { challenge: "def" } };
  };
  TauriClient.authenticatePasskey = async (...args: unknown[]) => {
    calls.authenticatePasskey = args;
    return { success: true, token: "tok" };
  };
  TauriClient.listPasskeys = async (...args: unknown[]) => {
    calls.listPasskeys = args;
    return [{ id: "cid1" }];
  };
  TauriClient.deletePasskey = async (...args: unknown[]) => {
    calls.deletePasskey = args;
  };

  let api: ReturnType<typeof useCloudflareAPI>;
  function Wrapper() {
    api = useCloudflareAPI("token");
    return null;
  }

  act(() => {
    create(React.createElement(Wrapper));
  });

  await api.getPasskeyRegistrationOptions("kid");
  await api.registerPasskey("kid", { att: true });
  await api.getPasskeyAuthOptions("kid");
  await api.authenticatePasskey("kid", { assertion: true });
  await api.listPasskeys("kid");
  await api.deletePasskey("kid", "cid1");

  assert.deepEqual(calls.getPasskeyRegistrationOptions, ["kid"]);
  assert.deepEqual(calls.registerPasskey, ["kid", { att: true }]);
  assert.deepEqual(calls.getPasskeyAuthOptions, ["kid"]);
  assert.deepEqual(calls.authenticatePasskey, ["kid", { assertion: true }]);
  assert.deepEqual(calls.listPasskeys, ["kid"]);
  assert.deepEqual(calls.deletePasskey, ["kid", "cid1"]);
});
