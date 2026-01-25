import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { ServerClient } from "../src/lib/server-client";
import { TauriClient } from "../src/lib/tauri-client";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;
const originalVerify = TauriClient.verifyToken;
const originalCreate = TauriClient.createDNSRecord;
const originalExport = TauriClient.exportDNSRecords;
const originalSimulate = TauriClient.simulateSPF;
const originalGraph = TauriClient.getSPFGraph;
const originalVault = TauriClient.getVaultSecret;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  TauriClient.verifyToken = originalVerify;
  TauriClient.createDNSRecord = originalCreate;
  TauriClient.exportDNSRecords = originalExport;
  TauriClient.simulateSPF = originalSimulate;
  TauriClient.getSPFGraph = originalGraph;
  TauriClient.getVaultSecret = originalVault;
});

test("verifyToken uses Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let called = false;
  TauriClient.verifyToken = async () => {
    called = true;
    return true;
  };
  const client = new ServerClient("token", "http://example.com");
  await client.verifyToken();
  assert.equal(called, true);
});

test("verifyToken throws when Tauri returns false", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.verifyToken = async () => false;
  const client = new ServerClient("token", "http://example.com");
  await assert.rejects(() => client.verifyToken(), /Token verification failed/);
});

test("createDNSRecord normalizes ttl auto in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let received: unknown = null;
  TauriClient.createDNSRecord = async (_k, _e, _z, record) => {
    received = record;
    return record as any;
  };
  const client = new ServerClient("token", "http://example.com");
  await client.createDNSRecord("zone", {
    type: "A",
    name: "example.com",
    content: "1.2.3.4",
    ttl: "auto" as any,
  });
  assert.equal((received as { ttl?: number }).ttl, 1);
});

test("exportDNSRecords routes to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.exportDNSRecords = async (...args: unknown[]) => {
    params = args;
    return "data";
  };
  const client = new ServerClient("token", "http://example.com");
  const data = await client.exportDNSRecords("zone", "csv", 2, 50);
  assert.equal(data, "data");
  assert.deepEqual(params, ["token", undefined, "zone", "csv", 2, 50]);
});

test("simulateSPF routes to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.simulateSPF = async (...args: unknown[]) => {
    params = args;
    return { result: "pass", reasons: [], lookups: 1 };
  };
  const client = new ServerClient("token", "http://example.com");
  const res = await client.simulateSPF("example.com", "1.2.3.4");
  assert.equal(res.result, "pass");
  assert.deepEqual(params, ["example.com", "1.2.3.4"]);
});

test("getSPFGraph routes to Tauri in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.getSPFGraph = async (...args: unknown[]) => {
    params = args;
    return { nodes: [], edges: [], lookups: 0, cyclic: false };
  };
  const client = new ServerClient("token", "http://example.com");
  const res = await client.getSPFGraph("example.com");
  assert.equal(res.cyclic, false);
  assert.deepEqual(params, ["example.com"]);
});

test("getVaultSecret passes token in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  let params: unknown[] = [];
  TauriClient.getVaultSecret = async (...args: unknown[]) => {
    params = args;
    return "secret";
  };
  const client = new ServerClient("token", "http://example.com");
  const secret = await client.getVaultSecret("key1", "ptok");
  assert.equal(secret, "secret");
  assert.deepEqual(params, ["key1", "ptok"]);
});

test("getVaultSecret surfaces missing token errors in desktop mode", async () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  TauriClient.getVaultSecret = async (_id: string, token?: string) => {
    if (!token) {
      throw new Error("Passkey token required");
    }
    return "secret";
  };
  const client = new ServerClient("token", "http://example.com");
  await assert.rejects(
    () => client.getVaultSecret("key1"),
    /Passkey token required/,
  );
});
