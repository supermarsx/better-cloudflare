import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import {
  StorageNotReadyError,
  createMigratingStorage,
  getStorage,
  resetStorageSelectionForTests,
  sanitizeBrowserPreferencesRaw,
  sanitizeBrowserPreferencesValue,
} from "../src/lib/storage/storage-util";
import { CryptoManager } from "../src/lib/auth/crypto";
import { StorageManager } from "../src/lib/storage/storage";

const originalIndexedDBDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalSessionStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "sessionStorage",
);

afterEach(() => {
  resetRuntimeReportingForTests();
  resetStorageSelectionForTests();
  if (originalIndexedDBDescriptor) {
    Object.defineProperty(globalThis, "indexedDB", originalIndexedDBDescriptor);
  } else {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  }
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(
      globalThis,
      "localStorage",
      originalLocalStorageDescriptor,
    );
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  if (originalSessionStorageDescriptor) {
    Object.defineProperty(
      globalThis,
      "sessionStorage",
      originalSessionStorageDescriptor,
    );
  } else {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

class MapStorage {
  readonly values = new Map<string, string>();
  setFailure: Error | undefined;
  removeFailure: Error | undefined;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setFailure) throw this.setFailure;
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    if (this.removeFailure) throw this.removeFailure;
    this.values.delete(key);
  }
}

test("migration blocks pre-hydration access and preserves legacy values", async () => {
  const durable = new MapStorage();
  durable.setItem("saved", "stale-local-value");
  let release!: (values: ReadonlyMap<string, string>) => void;
  const deferred = new Promise<ReadonlyMap<string, string>>((resolve) => {
    release = resolve;
  });
  const storage = createMigratingStorage(durable, () => deferred);

  assert.equal(storage.getItem("saved"), "stale-local-value");
  assert.throws(
    () => storage.setItem("saved", "premature"),
    StorageNotReadyError,
  );
  release(new Map([["saved", "legacy"]]));
  await storage.ready?.();

  assert.equal(storage.getItem("saved"), "legacy");
  storage.setItem("saved", "new");
  assert.equal(durable.getItem("saved"), "new");
});

test("migration fails closed within a bounded startup window and ignores late hydration", async () => {
  const durable = new MapStorage();
  let release!: (values: ReadonlyMap<string, string>) => void;
  const deferred = new Promise<ReadonlyMap<string, string>>((resolve) => {
    release = resolve;
  });
  const storage = createMigratingStorage(durable, () => deferred, {
    timeoutMs: 5,
  });

  await assert.rejects(storage.ready?.(), /timed out/i);
  release(new Map([["saved", "late-value"]]));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(durable.getItem("saved"), null);
  assert.throws(() => storage.setItem("later", "value"), /timed out/i);
});

test("migration refuses unexpected or oversized legacy key sets", async () => {
  const durable = new MapStorage();
  const storage = createMigratingStorage(
    durable,
    async () =>
      new Map([
        ["cloudflare-dns-manager", '{"apiKeys":[]}'],
        ["encryption-settings", "{}"],
        ["unrelated-origin-data", "must-not-be-copied"],
      ]),
    {
      allowedKeys: ["cloudflare-dns-manager", "encryption-settings"],
    },
  );

  await assert.rejects(storage.ready?.(), /unexpected legacy storage key/i);
  assert.equal(durable.values.size, 0);

  const oversized = createMigratingStorage(
    durable,
    async () =>
      new Map([["cloudflare-dns-manager", "x".repeat(3 * 1024 * 1024)]]),
  );
  await assert.rejects(oversized.ready?.(), /migration byte limit/i);
  assert.equal(durable.values.size, 0);
});

test("migration rolls back partial writes and keeps the adapter failed closed", async () => {
  const durable = new MapStorage();
  let writes = 0;
  const originalSet = durable.setItem.bind(durable);
  durable.setItem = (key, value) => {
    writes += 1;
    originalSet(key, value);
    if (writes === 2) throw new Error("forced migration write failure");
  };
  const storage = createMigratingStorage(
    durable,
    async () =>
      new Map([
        ["first", "one"],
        ["second", "two"],
      ]),
  );

  await assert.rejects(storage.ready?.(), /forced migration write failure/);
  assert.equal(durable.getItem("first"), null);
  assert.equal(durable.getItem("second"), null);
  assert.throws(() => storage.setItem("later", "value"));
});

test("synchronous durable write and delete failures are surfaced", async () => {
  const durable = new MapStorage();
  const storage = createMigratingStorage(durable, async () => new Map());
  await storage.ready?.();

  durable.setFailure = new Error("forced set failure");
  assert.throws(() => storage.setItem("key", "value"), /forced set failure/);
  durable.setFailure = undefined;
  durable.setItem("key", "value");
  durable.removeFailure = new Error("forced remove failure");
  assert.throws(() => storage.removeItem("key"), /forced remove failure/);
  assert.equal(durable.getItem("key"), "value");
});

test("storage selection falls back to memory when localStorage access is denied", () => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("blocked", "SecurityError");
    },
  });

  const storage = getStorage();
  assert.doesNotThrow(() => storage.setItem("safe", "fallback"));
  assert.equal(storage.getItem("safe"), "fallback");
  assert.match(
    getRuntimeDiagnostics()
      .map((diagnostic) => diagnostic.label)
      .join("\n"),
    /Select browser storage: access denied/,
  );
});

test("IndexedDB migration sanitizes the primary payload and writes its marker last", async () => {
  const durable = new MapStorage();
  const writes: Array<[string, string]> = [];
  const setItem = durable.setItem.bind(durable);
  durable.setItem = (key, value) => {
    writes.push([key, value]);
    setItem(key, value);
  };
  const secret = "legacy-encrypted-secret";
  const storage = createMigratingStorage(
    durable,
    async () =>
      new Map([
        [
          "cloudflare-dns-manager",
          JSON.stringify({
            apiKeys: [{ encryptedKey: secret, email: "legacy@example.test" }],
            currentSession: "legacy-session",
            lastZone: "safe-zone",
          }),
        ],
        ["encryption-settings", '{"algorithm":"AES-GCM"}'],
      ]),
  );

  await storage.ready?.();
  assert.deepEqual(
    JSON.parse(durable.getItem("cloudflare-dns-manager") ?? ""),
    {
      lastZone: "safe-zone",
    },
  );
  assert.equal(
    JSON.stringify([...durable.values.values()]).includes(secret),
    false,
  );
  assert.equal(writes.at(-1)?.[0], "better-cloudflare-storage-v2-migrated");
});

test("browser credentials are runtime-only and stale session blobs are purged", async () => {
  const local = new MapStorage();
  const session = new MapStorage();
  local.setItem("better-cloudflare-storage-v2-migrated", "1");
  local.setItem(
    "cloudflare-dns-manager",
    JSON.stringify({
      apiKeys: [],
      currentSession: "legacy",
      lastZone: "legacy-zone",
    }),
  );
  local.setItem("cloudflare-dns-manager:recovery", "raw-secret");
  session.setItem("cloudflare-dns-manager", "session-secret");
  session.setItem("cloudflare-dns-manager:recovery", "recovery-secret");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: local,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: session,
  });
  resetStorageSelectionForTests();

  const storage = getStorage();
  const manager = new StorageManager(storage, new CryptoManager({}, storage));
  const id = await manager.addApiKey(
    "runtime key",
    "live-api-secret",
    "password",
    "live@example.test",
  );
  manager.setCurrentSession(id);
  manager.setLastZone("retained-zone");
  assert.equal(
    (await manager.getDecryptedApiKey(id, "password"))?.key,
    "live-api-secret",
  );
  await manager.updateApiKey(id, {
    currentPassword: "password",
    newPassword: "rotated-password",
    email: "rotated@example.test",
  });
  assert.equal(
    (await manager.getDecryptedApiKey(id, "rotated-password"))?.key,
    "live-api-secret",
  );
  manager.removeApiKey(id);
  manager.setConfirmLogout(false);

  const persisted = local.getItem("cloudflare-dns-manager") ?? "";
  assert.doesNotMatch(
    persisted,
    /apiKeys|currentSession|encryptedKey|email|secret/,
  );
  assert.equal(local.getItem("cloudflare-dns-manager:recovery"), null);
  assert.equal(session.getItem("cloudflare-dns-manager"), null);
  assert.equal(session.getItem("cloudflare-dns-manager:recovery"), null);
  const restarted = new StorageManager(storage, new CryptoManager({}, storage));
  assert.equal(restarted.getApiKeys().length, 0);
  assert.equal(restarted.getCurrentSession(), undefined);
  assert.equal(restarted.getLastZone(), "retained-zone");
});

test("preference reconstruction drops unknown, inherited, and invalid nested leaves", () => {
  const profile = Object.create({ password: "inherited-secret" }) as Record<
    string,
    unknown
  >;
  profile.defaultPerPage = 25;
  profile.rewriteCopiedRecordDomains = false;
  profile.email = "nested@example.test";
  profile.zonePerPage = { good: 50, bad: "secret" };
  const zoneMap = Object.create({ inherited: 100 }) as Record<string, unknown>;
  zoneMap.own = 20;
  const safe = sanitizeBrowserPreferencesValue({
    apiKeys: [{ encryptedKey: "secret" }],
    currentSession: "secret-session",
    unknown: "secret",
    rewriteCopiedRecordDomains: false,
    zonePerPage: zoneMap,
    sessionSettingsProfiles: { profile },
  });
  const plain = JSON.parse(JSON.stringify(safe)) as typeof safe;

  assert.deepEqual(plain.zonePerPage, { own: 20 });
  assert.equal(plain.rewriteCopiedRecordDomains, false);
  assert.deepEqual(plain.sessionSettingsProfiles?.profile, {
    defaultPerPage: 25,
    rewriteCopiedRecordDomains: false,
    zonePerPage: { good: 50 },
  });
  assert.equal(JSON.stringify(safe).includes("secret"), false);
});

test("browser preference byte limits are exact for multibyte and astral text", () => {
  const limit = 2 * 1024 * 1024;
  const makeRaw = (target: number, finalCharacter: string): string => {
    const values: string[] = [];
    while (
      Buffer.byteLength(
        JSON.stringify({
          topologyTcpServices: [...values, "a".repeat(60_000), finalCharacter],
        }),
      ) <= target
    )
      values.push("a".repeat(60_000));
    const base = JSON.stringify({
      topologyTcpServices: [...values, finalCharacter],
    });
    const fill = target - Buffer.byteLength(base);
    return JSON.stringify({
      topologyTcpServices: [...values, `${"a".repeat(fill)}${finalCharacter}`],
    });
  };

  for (const character of ["é", "😀"]) {
    const exact = makeRaw(limit, character);
    assert.equal(Buffer.byteLength(exact), limit);
    assert.equal(
      Buffer.byteLength(sanitizeBrowserPreferencesRaw(exact)),
      limit,
    );
    assert.throws(
      () => sanitizeBrowserPreferencesRaw(makeRaw(limit + 1, character)),
      /byte limit/,
    );
  }
});
