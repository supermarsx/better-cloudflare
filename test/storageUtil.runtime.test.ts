import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  getRuntimeDiagnostics,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";
import { getStorage } from "../src/lib/storage/storage-util";

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
    getRuntimeDiagnostics()[0]?.label ?? "",
    /Select browser storage: access denied/,
  );
});
