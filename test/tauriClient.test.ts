import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  createPreferenceFailureReporter,
  createSerializedPreferenceWriter,
  getTauriInvokeTimeoutMs,
  getPropagationInvokeTimeoutMs,
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

test("uses the exact native preferences read and update command contracts", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown> | undefined;
  }> = [];
  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown> | undefined,
    });
    if (command === "get_preferences") {
      return { theme: "void", locale: "pt-PT" };
    }
    if (command === "update_preferences") return undefined;
    throw new Error(`Unexpected Tauri command: ${command}`);
  });

  const preferences = await TauriClient.getPreferences();
  await TauriClient.updatePreferences({ theme: "void", locale: "pt-PT" });

  assert.deepEqual(preferences, { theme: "void", locale: "pt-PT" });
  assert.deepEqual(calls, [
    { command: "get_preferences", payload: {} },
    {
      command: "update_preferences",
      payload: { prefs: { theme: "void", locale: "pt-PT" } },
    },
  ]);
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

test("sends complete IP access-rule invoke contracts without ip/value drift", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown>;
  }> = [];
  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown>,
    });
    if (command === "get_ip_access_rules") return [];
    if (command === "create_ip_access_rule") {
      return {
        id: "rule-id",
        mode: "block",
        notes: "abuse source",
        configuration: { target: "ip", value: "203.0.113.7" },
      };
    }
    if (command === "delete_ip_access_rule") return undefined;
    throw new Error(`Unexpected Tauri command: ${command}`);
  });

  await TauriClient.getIpAccessRules("api-key", "zone-id", "owner@example.com");
  await TauriClient.createIpAccessRule(
    "api-key",
    "zone-id",
    "block",
    "203.0.113.7",
    "abuse source",
    "owner@example.com",
  );
  await TauriClient.createIpAccessRule(
    "api-key",
    "zone-id",
    "challenge",
    "198.51.100.0/24",
  );
  await TauriClient.deleteIpAccessRule(
    "api-key",
    "zone-id",
    "rule-id",
    "owner@example.com",
  );

  assert.deepEqual(calls, [
    {
      command: "get_ip_access_rules",
      payload: {
        apiKey: "api-key",
        zoneId: "zone-id",
        email: "owner@example.com",
      },
    },
    {
      command: "create_ip_access_rule",
      payload: {
        apiKey: "api-key",
        zoneId: "zone-id",
        mode: "block",
        value: "203.0.113.7",
        notes: "abuse source",
        email: "owner@example.com",
      },
    },
    {
      command: "create_ip_access_rule",
      payload: {
        apiKey: "api-key",
        zoneId: "zone-id",
        mode: "challenge",
        value: "198.51.100.0/24",
        notes: "",
      },
    },
    {
      command: "delete_ip_access_rule",
      payload: {
        apiKey: "api-key",
        zoneId: "zone-id",
        ruleId: "rule-id",
        email: "owner@example.com",
      },
    },
  ]);

  for (const { command, payload } of calls.filter(
    ({ command }) => command === "create_ip_access_rule",
  )) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, "ip"),
      false,
      `${command} payload must map the public ip input to native value`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, "value"),
      true,
      `${command} payload must own the native value argument`,
    );
  }
  assert.equal(
    Object.prototype.hasOwnProperty.call(calls[2]?.payload ?? {}, "email"),
    false,
    "omitted optional email must not become an IPC argument",
  );
});

test("sends the complete topology invoke contract in camelCase and preserves optional value semantics", async () => {
  const calls: Array<{
    command: string;
    payload: Record<string, unknown>;
  }> = [];
  mockIPC((command, payload) => {
    calls.push({
      command,
      payload: payload as Record<string, unknown>,
    });
    return { resolutions: [], probes: [], tcp_probes: [] };
  });

  await TauriClient.resolveTopologyBatch(
    ["www.example.com", "api.example.com"],
    7,
    ["service.example.com"],
    "custom",
    "https://resolver.example/dns-query",
    "doh",
    "custom",
    "192.0.2.53",
    3456,
    true,
    [443, 8443],
    false,
    "internal",
    false,
  );
  await TauriClient.resolveTopologyBatch(["defaults.example.com"]);
  await TauriClient.resolveTopologyBatch(
    ["null-options.example.com"],
    4,
    null as unknown as string[] | undefined,
    "quad9",
    "",
    "dns",
    "9.9.9.9",
    "",
    1200,
    false,
    null as unknown as number[] | undefined,
    false,
    "auto",
    true,
  );

  assert.deepEqual(calls, [
    {
      command: "resolve_topology_batch",
      payload: {
        hostnames: ["www.example.com", "api.example.com"],
        maxHops: 7,
        serviceHosts: ["service.example.com"],
        dohProvider: "custom",
        dohCustomUrl: "https://resolver.example/dns-query",
        resolverMode: "doh",
        dnsServer: "custom",
        customDnsServer: "192.0.2.53",
        lookupTimeoutMs: 3456,
        disablePtrLookups: true,
        tcpServicePorts: [443, 8443],
        disableGeoLookups: false,
        geoProvider: "internal",
        scanResolutionChain: false,
      },
    },
    {
      command: "resolve_topology_batch",
      payload: {
        hostnames: ["defaults.example.com"],
        maxHops: 15,
        dohProvider: "cloudflare",
        dohCustomUrl: "",
        resolverMode: "dns",
        dnsServer: "1.1.1.1",
        customDnsServer: "",
        lookupTimeoutMs: 1200,
        disablePtrLookups: false,
        disableGeoLookups: false,
        geoProvider: "auto",
        scanResolutionChain: true,
      },
    },
    {
      command: "resolve_topology_batch",
      payload: {
        hostnames: ["null-options.example.com"],
        maxHops: 4,
        serviceHosts: null,
        dohProvider: "quad9",
        dohCustomUrl: "",
        resolverMode: "dns",
        dnsServer: "9.9.9.9",
        customDnsServer: "",
        lookupTimeoutMs: 1200,
        disablePtrLookups: false,
        tcpServicePorts: null,
        disableGeoLookups: false,
        geoProvider: "auto",
        scanResolutionChain: true,
      },
    },
  ]);
});

test("topology invokes never emit snake_case command argument keys", async () => {
  let payload: Record<string, unknown> | undefined;
  mockIPC((_command, args) => {
    payload = args as Record<string, unknown>;
    return { resolutions: [], probes: [], tcp_probes: [] };
  });

  await TauriClient.resolveTopologyBatch(
    ["www.example.com"],
    7,
    ["service.example.com"],
    "custom",
    "https://resolver.example/dns-query",
    "doh",
    "custom",
    "192.0.2.53",
    3456,
    true,
    [443],
    true,
    "ipwhois",
    false,
  );

  assert.ok(payload);
  for (const forbiddenKey of [
    "max_hops",
    "service_hosts",
    "doh_provider",
    "doh_custom_url",
    "resolver_mode",
    "dns_server",
    "custom_dns_server",
    "lookup_timeout_ms",
    "disable_ptr_lookups",
    "tcp_service_ports",
    "disable_geo_lookups",
    "geo_provider",
    "scan_resolution_chain",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, forbiddenKey),
      false,
      `topology payload must not emit ${forbiddenKey}`,
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
  assert.match(
    error.message,
    /desktop operation could not connect to a required service or Cloudflare upstream/i,
  );
  assert.match(error.remediation ?? "", /system DNS/i);
  assert.doesNotMatch(
    error.message,
    /configured (?:server|web backend)|NEXT_PUBLIC_SERVER_API_BASE/i,
  );
  assert.doesNotMatch(error.message, /secret-value/);
  assert.match(formatRequestError(error), /command verify_token/);
});

test("normalizes native DNS string and structured lookup failures without web-backend guidance", () => {
  const failures = [
    {
      cause: "getaddrinfo ENOTFOUND api.cloudflare.com token=string-secret",
      requestId: undefined,
    },
    {
      cause: {
        code: "ENOTFOUND",
        message:
          "DNS lookup failed for api.cloudflare.com token=structured-secret",
        request_id: "dns-ray-1",
      },
      requestId: "dns-ray-1",
    },
  ];

  for (const failure of failures) {
    const error = normalizeTauriInvokeError(failure.cause, "get_dns_records");
    const formatted = formatRequestError(error);

    assert.ok(error instanceof RequestError);
    assert.equal(error.kind, "network");
    assert.equal(error.source, "tauri");
    assert.equal(error.operation, "Tauri invoke");
    assert.equal(error.command, "get_dns_records");
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, failure.requestId);
    assert.match(
      error.message,
      /desktop operation could not resolve a required service or Cloudflare upstream hostname/i,
    );
    assert.match(error.remediation ?? "", /system DNS/i);
    assert.match(error.remediation ?? "", /proxy or VPN/i);
    assert.match(error.remediation ?? "", /firewall/i);
    assert.doesNotMatch(
      error.message,
      /configured (?:server|web backend)|NEXT_PUBLIC_SERVER_API_BASE|string-secret|structured-secret/i,
    );
    assert.match(formatted, /source tauri/i);
    assert.match(formatted, /command get_dns_records/i);
    assert.doesNotMatch(formatted, /string-secret|structured-secret/i);
  }

  const legacyProvider = normalizeTauriInvokeError(
    {
      code: "AUTH_REQUEST_FAILED",
      kind: "provider",
      source: "cloudflare",
      operation: "dns:list",
      retryable: false,
      message: "authentication failed token=legacy-tauri-secret",
    },
    "get_dns_records",
  );
  const formattedLegacyProvider = formatRequestError(legacyProvider);

  assert.equal(legacyProvider.kind, "http");
  assert.equal(legacyProvider.operation, "dns:list");
  assert.equal(legacyProvider.command, "get_dns_records");
  assert.equal(legacyProvider.retryable, false);
  assert.match(
    legacyProvider.message,
    /Cloudflare could not complete the requested operation/i,
  );
  assert.doesNotMatch(
    legacyProvider.message,
    /credential verification|supplied credentials|legacy-tauri-secret/i,
  );
  assert.doesNotMatch(formattedLegacyProvider, /legacy-tauri-secret/i);
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

test("coalesces preference writes and preserves the newest fields", async () => {
  const firstWrite = deferred<void>();
  const writes: Record<string, unknown>[] = [];
  const writer = createSerializedPreferenceWriter(async (fields) => {
    writes.push(fields);
    if (writes.length === 1) await firstWrite.promise;
  });

  const older = writer.update({ selected_zone: "older" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);

  const newer = writer.update({
    selected_zone: "newer",
    page_size: 100,
    auto_refresh_interval: null,
  });
  const newest = writer.update({ page_size: 200 });
  assert.equal(newer, newest);

  firstWrite.resolve(undefined);
  await Promise.all([older, newer, newest]);
  assert.deepEqual(writes, [
    { selected_zone: "older" },
    {
      selected_zone: "newer",
      page_size: 200,
      auto_refresh_interval: null,
    },
  ]);
});

test("bounds preference retries and diagnostic cooldown", async () => {
  let attempts = 0;
  const writer = createSerializedPreferenceWriter(
    async () => {
      attempts += 1;
      throw new Error("locked");
    },
    { retryDelaysMs: [0, 0, 0] },
  );
  await assert.rejects(writer.update({ theme: "dark" }), /locked/);
  assert.equal(attempts, 3);

  let now = 100;
  const reports: unknown[] = [];
  const report = createPreferenceFailureReporter(
    (error) => reports.push(error),
    50,
    () => now,
  );
  report("first");
  report("duplicate");
  now = 150;
  report("next");
  assert.deepEqual(reports, ["first", "next"]);
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

test("check_dns_propagation timeout scales with the requested resolver load", () => {
  assert.equal(getTauriInvokeTimeoutMs("check_dns_propagation"), 60_000);
  // 12 defaults at 3000 ms × 1 attempt: 2 rounds × 5 s + margin < the floor.
  assert.equal(getPropagationInvokeTimeoutMs(12), 60_000);
  // 64 resolvers at the maximum knobs: 8 rounds × 47 s + 5 s = 381 s.
  assert.equal(
    getPropagationInvokeTimeoutMs(64, { timeoutMs: 15_000, attempts: 3 }),
    381_000,
  );
  // Out-of-range input is clamped like the native side and never exceeds the cap.
  assert.equal(
    getPropagationInvokeTimeoutMs(10_000, { timeoutMs: 999_999, attempts: 99 }),
    381_000,
  );
});
