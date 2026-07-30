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
} from "../src/lib/storage/storage-util";

const originalIndexedDBDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
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
