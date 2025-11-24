// Debug helper script — keep types narrow where feasible
import createCredentialStore from "../src/lib/credential-store";
import { ServerAPI } from "../src/lib/server-api";
import { getAuditEntries } from "../src/lib/audit";
import { isAdmin } from "../src/lib/rbac";

process.env.CREDENTIAL_STORE = "sqlite";
process.env.ADMIN_TOKEN = "adm-token";
(async () => {
  try {
    type AnyStore = {
      db?: {
        type?: string;
        all?: (sql: string) => Promise<unknown>;
        close?: () => Promise<void>;
      };
      initPromise?: Promise<unknown>;
    };
    const store = createCredentialStore() as unknown as AnyStore;
    ServerAPI.setCredentialStore(store);
    console.log(
      "Store type",
      store.db ? store.db.type : store.constructor.name,
    );

    // Create user
    const handler = ServerAPI.createUser();
    const req = {
      body: { id: "u1", email: "admin@example.com", roles: ["admin"] },
      params: {},
      header(name: string) {
        return name === "x-admin-token" ? "adm-token" : undefined;
      },
    } as unknown as Request;

    let status: number | undefined;
    let jsonData: unknown;
    const res = {
      status(code: number) {
        status = code;
        return this as unknown as Response;
      },
      json(data: unknown) {
        jsonData = data;
      },
    } as unknown as Response;

    console.log("Invoking createUser handler...");
    await handler(req, res);
    console.log(
      "createUser handler returned, status=",
      status,
      "json=",
      jsonData,
    );

    // Inspect raw DB rows in store
    try {
      const raw = await store.db?.all?.("SELECT id, email, roles FROM users");
      console.log("Raw users in ServerAPI store db:", raw);
    } catch (e) {
      console.log(
        "Error reading users from server store db:",
        (e as unknown as Error)?.message ?? e,
      );
    }

    console.log("\nReading audit entries via ServerAPI.getAuditEntries");
    const arReq = {
      header() {
        return null;
      },
    } as unknown as Request;
    const arRes = {
      json(x: unknown) {
        console.log(
          "Audit entries returned length=",
          Array.isArray(x) ? x.length : "not-array",
        );
      },
    } as unknown as Response;
    const entryHandler = ServerAPI.getAuditEntries();
    try {
      await entryHandler(arReq, arRes);
    } catch (err) {
      console.log(
        "Expected error when calling getAuditEntries without credentials:",
        (err as Error).message,
      );
    }

    console.log("\ngetAuditEntries via direct function getAuditEntries():");
    const entries = await getAuditEntries();
    console.log("getAuditEntries() returned len=", entries.length);

    // Test middleware isAdmin behavior (should permit our admin user)
    console.log("\nTesting isAdmin middleware with email header...");
    let mwCalled = false;
    const mwReq = {
      header(name: string) {
        return name === "x-auth-email" ? "admin@example.com" : undefined;
      },
    } as unknown as Request;
    const mwRes = {
      status(code: number) {
        console.log("mwRes status", code);
        return mwRes;
      },
      json(data: unknown) {
        console.log("mwRes json", data);
      },
    } as unknown as Response;
    // Also inspect the DB used by a newly created store in isAdmin
    const newStore = createCredentialStore() as unknown as AnyStore;
    try {
      const raw2 = await newStore.db?.all("SELECT id, email, roles FROM users");
      console.log("Raw users in new store db:", raw2);
    } catch (e) {
      console.log(
        "Error reading users from new store db:",
        (e as unknown as Error)?.message ?? e,
      );
    }

    await new Promise<void>((resolve, reject) => {
      isAdmin(mwReq, mwRes, (err?: unknown) => {
        if (err) return reject(err);
        mwCalled = true;
        resolve();
      });
    });
    console.log("isAdmin middleware allowed:", mwCalled);

    console.log("Done");
  } catch (err) {
    console.error("Caught error in debug runner:", err);
    process.exit(1);
  }
})();
