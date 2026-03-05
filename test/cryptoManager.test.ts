import assert from "node:assert/strict";
import { test } from "node:test";
import { CryptoManager } from "../src/lib/auth/crypto.ts";
import { benchmark } from "../src/lib/auth/crypto-benchmark.ts";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) {
    return Object.prototype.hasOwnProperty.call(this.store, key)
      ? this.store[key]
      : null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}

test("encrypt followed by decrypt returns original data", async () => {
  const storage = new LocalStorageMock();
  const cryptoMgr = new CryptoManager({ iterations: 1 }, storage);
  const data = "secret message";
  const password = "pw";
  const { encrypted, salt, iv } = await cryptoMgr.encrypt(data, password);
  const decrypted = await cryptoMgr.decrypt(encrypted, salt, iv, password);
  assert.equal(decrypted, data);
});

test("updateConfig persists changes across instances", () => {
  const storage = new LocalStorageMock();
  const cryptoMgr = new CryptoManager({}, storage);
  cryptoMgr.updateConfig({ algorithm: "AES-CBC", iterations: 200000 });
  // Simulate reload by creating a new manager that reads from storage
  const reloaded = new CryptoManager({}, storage);
  const config = reloaded.getConfig();
  assert.equal(config.algorithm, "AES-CBC");
  assert.equal(config.iterations, 200000);
});

test("minimum iterations are enforced against tampering", () => {
  const storage = new LocalStorageMock();
  // Simulate localStorage tampering: set iterations to 1
  storage.setItem("encryption-settings", JSON.stringify({ iterations: 1 }));
  const cryptoMgr = new CryptoManager({}, storage);
  const config = cryptoMgr.getConfig();
  // Should be clamped to the minimum (100000), not 1
  assert.ok(config.iterations >= 100000, `Expected >= 100000 but got ${config.iterations}`);
});

test("benchmark returns numeric duration", async () => {
  const result = await benchmark(1);
  assert.equal(typeof result, "number");
});
