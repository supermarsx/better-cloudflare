import assert from "node:assert/strict";
import { test } from "node:test";
import openSqlite from "../src/lib/sqlite-driver.ts";
import path from "path";
import fs from "fs";

test("openSqlite should return a sqlite wrapper and support basic calls", async () => {
  const tmp = path.resolve(process.cwd(), "data", "test-credentials.db");
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore cleanup errors */
  }
  const wrapper = openSqlite(tmp);
  assert.ok(wrapper, "openSqlite returned a wrapper");
  assert.ok(
    ["better-sqlite3", "sqlite3", "sql.js"].includes(
      (wrapper as unknown as { type?: string }).type,
    ),
    "driver type should be known",
  );
  // basic run & get & all interface
  await wrapper.run(
    "CREATE TABLE IF NOT EXISTS tmp (id INTEGER PRIMARY KEY, v TEXT)",
  );
  const res = await wrapper.run("INSERT INTO tmp(v) VALUES(?)", ["x"]);
  assert.ok(
    res && (res as unknown as { lastInsertRowid?: unknown }).lastInsertRowid,
    "insert returns lastInsertRowid",
  );
  const row = await wrapper.get("SELECT id, v FROM tmp WHERE id = ?", [1]);
  assert.equal(row.v, "x");
  const rows = await wrapper.all("SELECT id, v FROM tmp");
  assert.ok(Array.isArray(rows));
  if (wrapper.close) await wrapper.close();
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore cleanup errors */
  }
});

test("SqliteCredentialStore can add/get/delete credentials", async () => {
  const tmpDB = path.resolve(process.cwd(), "data", "test-credentials-2.db");
  try {
    fs.unlinkSync(tmpDB);
  } catch {
    /* ignore cleanup errors */
  }
  process.env.CREDENTIAL_STORE = "sqlite";
  const createCredentialStore = (await import("../src/lib/credential-store.ts"))
    .default as unknown as () => unknown;
  const store = createCredentialStore() as unknown as {
    initPromise?: Promise<unknown>;
    addCredential: (id: string, cred: unknown) => Promise<void>;
    getCredentials: (id: string) => Promise<Array<Record<string, unknown>>>;
    deleteCredential: (id: string, cid: string) => Promise<void>;
    db?: { close?: () => Promise<void> };
  };
  // ensure the store's init completes
  await (store as { initPromise?: Promise<unknown> }).initPromise;
  await (store as { initPromise?: Promise<unknown> }).initPromise;
  const id = "u-test";
  await store.addCredential(id, {
    credentialID: "cid1",
    credentialPublicKey: "pk",
    counter: 0,
  });
  const creds = await store.getCredentials(id);
  assert.ok(Array.isArray(creds));
  assert.equal(creds.length, 1);
  await store.deleteCredential(id, "cid1");
  const after = await store.getCredentials(id);
  assert.equal(after.length, 0);
  if (store.db?.close) await store.db.close();
  try {
    fs.unlinkSync(tmpDB);
  } catch {
    /* ignore cleanup errors */
  }
});
