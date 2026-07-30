import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  createSerializedPreferenceWriter,
  getTauriInvokeTimeoutMs,
  normalizeTauriInvokeError,
  TauriClient,
  withTauriUiTimeout,
} from "../src/lib/api/tauri-client";
import { formatRequestError, RequestError } from "../src/lib/api/request-error";

const originalWindow = (globalThis as unknown as { window?: unknown }).window;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  clearMocks();
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
});

test("isTauri returns true when window.__TAURI__ is present", () => {
  (globalThis as unknown as { window?: unknown }).window = { __TAURI__: {} };
  assert.equal(TauriClient.isTauri(), true);
});

test("isTauri returns false when window is missing", () => {
  (globalThis as unknown as { window?: unknown }).window = undefined;
  assert.equal(TauriClient.isTauri(), false);
});

test("sends MCP tool arguments using Tauri's camel-cased command contract", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown> | undefined;
  }> = [];
  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown> | undefined,
    });
    return {
      running: false,
      host: "127.0.0.1",
      port: 8787,
      url: "http://127.0.0.1:8787/mcp",
      enabledTools: ["dns_read"],
      tools: [],
    };
  });

  const enabledTools = ["dns_read"];
  await TauriClient.setMcpEnabledTools(enabledTools);
  await TauriClient.startMcpServer("127.0.0.1", 8787, enabledTools);

  assert.deepEqual(calls, [
    {
      command: "mcp_set_enabled_tools",
      payload: { enabledTools },
    },
    {
      command: "mcp_start_server",
      payload: {
        host: "127.0.0.1",
        port: 8787,
        enabledTools,
      },
    },
  ]);
  assert.equal("enabled_tools" in (calls[0]?.payload ?? {}), false);
  assert.equal("enabled_tools" in (calls[1]?.payload ?? {}), false);
});

test("sends DNS pagination and export arguments through IPC in camelCase", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown>;
  }> = [];
  const records = Array.from({ length: 500 }, (_, index) => ({
    id: `record-${index + 1}`,
    type: "A",
    name: `host-${index + 1}.example.com`,
    content: "192.0.2.1",
    zone_id: "zone-id",
    zone_name: "example.com",
    created_on: "2026-07-29T00:00:00Z",
    modified_on: "2026-07-29T00:00:00Z",
  }));
  const exportedRecords = JSON.stringify(records);

  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown>,
    });
    if (command === "get_dns_records") return records;
    if (command === "export_dns_records") return exportedRecords;
    throw new Error(`Unexpected Tauri command: ${command}`);
  });

  const listedRecords = await TauriClient.getDNSRecords(
    "api-key",
    "owner@example.com",
    "zone-id",
    2,
    500,
  );
  const exported = await TauriClient.exportDNSRecords(
    "api-key",
    "owner@example.com",
    "zone-id",
    "json",
    2,
    500,
  );

  assert.equal(listedRecords.length, 500);
  assert.equal(listedRecords[499]?.id, "record-500");
  assert.equal(exported, exportedRecords);
  assert.deepEqual(calls, [
    {
      command: "get_dns_records",
      payload: {
        apiKey: "api-key",
        email: "owner@example.com",
        zoneId: "zone-id",
        page: 2,
        perPage: 500,
      },
    },
    {
      command: "export_dns_records",
      payload: {
        apiKey: "api-key",
        email: "owner@example.com",
        zoneId: "zone-id",
        format: "json",
        page: 2,
        perPage: 500,
      },
    },
  ]);
  for (const { command, payload } of calls) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, "per_page"),
      false,
      `${command} payload must not emit per_page`,
    );
  }
});

test("sends complete bounded and open-ended Analytics payloads", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown>;
  }> = [];
  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown>,
    });
    return {};
  });

  await TauriClient.getZoneAnalytics(
    "zone-key",
    "zone-id",
    "2026-07-28T00:00:00Z",
    "2026-07-29T00:00:00Z",
    "owner@example.com",
    true,
  );
  await TauriClient.getZoneAnalytics("zone-key", "zone-id");
  await TauriClient.getDnsAnalytics(
    "dns-key",
    "dns-zone-id",
    "2026-07-27T00:00:00Z",
    "2026-07-29T00:00:00Z",
    "dns@example.com",
    ["queryName", "responseCode"],
    ["queryCount"],
  );
  await TauriClient.getDnsAnalytics("dns-key", "dns-zone-id");

  assert.deepEqual(calls, [
    {
      command: "get_zone_analytics",
      payload: {
        apiKey: "zone-key",
        zoneId: "zone-id",
        since: "2026-07-28T00:00:00Z",
        until: "2026-07-29T00:00:00Z",
        email: "owner@example.com",
        continuous: true,
      },
    },
    {
      command: "get_zone_analytics",
      payload: {
        apiKey: "zone-key",
        zoneId: "zone-id",
        since: null,
        until: null,
        email: null,
        continuous: null,
      },
    },
    {
      command: "get_dns_analytics",
      payload: {
        apiKey: "dns-key",
        zoneId: "dns-zone-id",
        since: "2026-07-27T00:00:00Z",
        until: "2026-07-29T00:00:00Z",
        email: "dns@example.com",
        dimensions: ["queryName", "responseCode"],
        metrics: ["queryCount"],
      },
    },
    {
      command: "get_dns_analytics",
      payload: {
        apiKey: "dns-key",
        zoneId: "dns-zone-id",
        since: null,
        until: null,
        email: null,
        dimensions: null,
        metrics: null,
      },
    },
  ]);

  for (const { command, payload } of calls) {
    const expectedKeys =
      command === "get_zone_analytics"
        ? ["apiKey", "zoneId", "since", "until", "email", "continuous"]
        : [
            "apiKey",
            "zoneId",
            "since",
            "until",
            "email",
            "dimensions",
            "metrics",
          ];
    for (const key of expectedKeys) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(payload, key),
        true,
        `${command} payload owns ${key}`,
      );
    }
  }
});

test("normalizes Tauri string failures without discarding native detail", () => {
  const error = normalizeTauriInvokeError(
    "HTTP error: connection refused password=secret-value",
    "verify_token",
  );
  assert.ok(error instanceof RequestError);
  assert.equal(error.kind, "network");
  assert.equal(error.source, "tauri");
  assert.equal(error.command, "verify_token");
  assert.equal(error.operation, "Tauri invoke");
  assert.equal(error.retryable, true);
  assert.match(error.message, /backend refused the connection/i);
  assert.doesNotMatch(error.message, /secret-value/);
  assert.match(formatRequestError(error), /command verify_token/);
});

test("normalizes structured Tauri failures with safe diagnostics", () => {
  const cause = {
    message: "Authentication failed for api_key=top-secret",
    status: 401,
    statusText: "Unauthorized",
    code: 10000,
    request_id: "cf-ray-7",
  };
  const error = normalizeTauriInvokeError(cause, "verify_token");
  assert.equal(error.kind, "http");
  assert.equal(error.status, 401);
  assert.equal(error.statusText, "Unauthorized");
  assert.equal(error.code, "10000");
  assert.equal(error.requestId, "cf-ray-7");
  assert.equal(error.cause, cause);
  assert.match(error.message, /Authentication was rejected/);
  assert.doesNotMatch(error.message, /top-secret/);
  const formatted = formatRequestError(error);
  assert.match(formatted, /source tauri/);
  assert.match(formatted, /status 401 Unauthorized/);
  assert.match(formatted, /code 10000/);
  assert.match(formatted, /request ID cf-ray-7/);
});

test("normalizes the exact serialized Rust AuthRequestFailed envelope", () => {
  const serialized =
    '{"code":"AUTH_REQUEST_FAILED","kind":"authentication","message":"Cloudflare rejected the supplied credentials (HTTP 403).","status":403,"source":"cloudflare","operation":"auth:verify_token","retryable":false,"retry_after":"30","details":{"provider_errors":[{"code":"9109","message":"Invalid access token token=provider-secret"},{"code":"10000","message":"Authentication error"}],"provider_codes":["9109","10000"],"provider_messages":["Invalid access token token=provider-secret","Authentication error"],"retry_after_secs":30,"remediation":"Check the API token, account email, and permissions."},"request_id":"rust-ray-123"}';
  const cause = JSON.parse(serialized) as unknown;
  assert.equal(JSON.stringify(cause), serialized);

  const error = normalizeTauriInvokeError(serialized, "verify_token");
  assert.equal(error.kind, "http");
  assert.equal(error.source, "cloudflare");
  assert.equal(error.command, "verify_token");
  assert.equal(error.operation, "auth:verify_token");
  assert.equal(error.status, 403);
  assert.equal(error.code, "AUTH_REQUEST_FAILED");
  assert.equal(error.requestId, "rust-ray-123");
  assert.equal(error.retryAfter, "30");
  assert.equal(error.retryable, false);
  assert.equal(
    error.remediation,
    "Check the API token, account email, and permissions.",
  );
  assert.deepEqual(error.providerCodes, ["9109", "10000"]);
  assert.match(error.providerMessages[0] ?? "", /\[redacted\]/);

  const formatted = formatRequestError(error);
  assert.match(formatted, /denied this operation/i);
  assert.match(formatted, /provider codes 9109, 10000/);
  assert.match(formatted, /request ID rust-ray-123/);
  assert.match(formatted, /retry after 30/);
  assert.match(formatted, /next step Check the API token/);
  assert.doesNotMatch(formatted, /provider-secret/);
});

test("preserves Rust network, timeout, and malformed response kinds", () => {
  const fixtures = [
    [
      "network",
      "network",
      "Could not reach Cloudflare to verify the credentials.",
      /could not be reached/i,
    ],
    [
      "timeout",
      "timeout",
      "Cloudflare token verification timed out.",
      /timed out/i,
    ],
    [
      "malformed_response",
      "malformed-response",
      "Cloudflare returned an unreadable token verification response.",
      /malformed response/i,
    ],
  ] as const;

  for (const [rustKind, expectedKind, message, expectedMessage] of fixtures) {
    const serialized = JSON.stringify({
      code: "AUTH_REQUEST_FAILED",
      kind: rustKind,
      message,
      source: rustKind === "malformed_response" ? "cloudflare" : "network",
      operation: "auth:verify_token",
      retryable: true,
      details: {
        provider_errors: [],
        provider_codes: [],
        provider_messages: [],
        remediation:
          "Check the internet connection, proxy, DNS, and TLS settings, then retry.",
      },
    });
    const error = normalizeTauriInvokeError(
      JSON.parse(serialized) as unknown,
      "verify_token",
    );
    assert.equal(error.kind, expectedKind);
    assert.equal(error.retryable, true);
    assert.equal(error.operation, "auth:verify_token");
    assert.match(error.message, expectedMessage);
    assert.doesNotMatch(error.message, /failed unexpectedly/i);
  }
});

test("bounds stalled auth and passkey Tauri UI operations", async () => {
  for (const command of ["verify_token", "list_passkeys"]) {
    await assert.rejects(
      () => withTauriUiTimeout(new Promise<never>(() => {}), command, 5),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.kind, "timeout");
        assert.equal(error.source, "tauri");
        assert.equal(error.command, command);
        assert.equal(
          error.retryable,
          false,
          "an unresolved native operation must never invite an automatic retry",
        );
        assert.match(error.message, /native task may still finish/i);
        return true;
      },
    );
  }
});

test("applies a timeout to every Tauri command and clears the fast-path timer", async () => {
  assert.equal(getTauriInvokeTimeoutMs("get_zones"), 15_000);
  assert.equal(getTauriInvokeTimeoutMs("resolve_topology_batch"), 120_000);
  assert.equal(
    await withTauriUiTimeout(Promise.resolve("ready"), "get_zones", 60_000),
    "ready",
  );
});

test("desktop invokes reject promptly on abort and suppress pre-aborted native work", async () => {
  let invocationCount = 0;
  let resolveNative!: (value: unknown[]) => void;
  mockIPC(() => {
    invocationCount += 1;
    return new Promise<unknown[]>((resolve) => {
      resolveNative = resolve;
    });
  });

  const controller = new AbortController();
  const request = TauriClient.getZones("api-key", undefined, controller.signal);
  await Promise.resolve();
  assert.equal(invocationCount, 1);
  controller.abort();
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.kind, "aborted");
    assert.match(error.message, /native task may still finish/i);
    return true;
  });

  resolveNative([]);
  await Promise.resolve();

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    () => TauriClient.getZones("api-key", undefined, preAborted.signal),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.kind, "aborted");
      return true;
    },
  );
  assert.equal(invocationCount, 1);
});

test("serializes reverse-ready preference writes and preserves the newest fields", async () => {
  let stored: Record<string, unknown> = { retained: true };
  const firstWrite = deferred<void>();
  const secondWrite = deferred<void>();
  const writes: Record<string, unknown>[] = [];
  const writer = createSerializedPreferenceWriter(
    async () => stored,
    async (snapshot) => {
      writes.push(snapshot);
      const gate =
        writes.length === 1 ? firstWrite.promise : secondWrite.promise;
      await gate;
      stored = snapshot;
    },
  );

  const older = writer.update({ selected_zone: "older" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);

  const newer = writer.update({ selected_zone: "newer", page_size: 100 });
  secondWrite.resolve(undefined);
  await Promise.resolve();
  assert.equal(
    writes.length,
    1,
    "the newer native write cannot start before the older one settles",
  );

  firstWrite.resolve(undefined);
  await older;
  await newer;
  assert.deepEqual(stored, {
    retained: true,
    selected_zone: "newer",
    page_size: 100,
  });
  assert.equal(writes.length, 2);
});

test("gives unknown native failures a diagnostic ID", () => {
  const error = normalizeTauriInvokeError(
    { reason: "Desktop bridge returned an undocumented state" },
    "get_preferences",
  );
  assert.equal(error.kind, "unknown");
  assert.match(error.message, /undocumented state/);
  assert.match(error.diagnosticId ?? "", /^REQ-[A-Z0-9-]+$/);
});
