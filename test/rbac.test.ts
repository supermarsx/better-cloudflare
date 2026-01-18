import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { test } from "node:test";
import { ServerAPI } from "../src/lib/server-api.ts";
import { isAdmin } from "../src/lib/rbac";
import createCredentialStore from "../src/lib/credential-store.ts";
import { CloudflareAPI } from "../src/lib/cloudflare.ts";

type MockReq = Partial<Request> & {
  header: (name: string) => string | undefined;
};

function makeReq(
  body: unknown,
  params: Record<string, unknown>,
  headers?: Record<string, string>,
): MockReq {
  return {
    body: body as unknown as Request["body"],
    params: params as unknown as Request["params"],
    header(name: string) {
      return (headers && headers[name]) ?? undefined;
    },
  };
}

function makeRes() {
  let statusCode: number | undefined;
  let jsonData: unknown;
  const res: Partial<Response> = {
    status(code: number) {
      statusCode = code;
      return this as Response;
    },
    json(data: unknown) {
      jsonData = data;
      return this as Response;
    },
  };
  return {
    res: res as Response,
    get status() {
      return statusCode;
    },
    get data() {
      return jsonData;
    },
  };
}

test("RBAC: admin token or user role is required for admin endpoints", async () => {
  process.env.CREDENTIAL_STORE = "sqlite";
  process.env.ADMIN_TOKEN = "adm-token";
  const origVerify = CloudflareAPI.prototype.verifyToken;
  CloudflareAPI.prototype.verifyToken = async () => {};
  const store = createCredentialStore() as ReturnType<
    typeof createCredentialStore
  >;
  ServerAPI.setCredentialStore(store);

  // Create user via admin token
  const reqCreate = makeReq(
    { id: "u1", email: "admin@example.com", roles: ["admin"] },
    {},
    { "x-admin-token": "adm-token" },
  );
  const createdRes = makeRes();
  await ServerAPI.createUser()(
    reqCreate as unknown as Request,
    createdRes.res as Response,
  );
  assert.equal(createdRes.data.success, true);

  // Now try to access audit without credentials -> 403
  const arReq = makeReq({}, {}, {});
  const arRes = makeRes();
  try {
    await ServerAPI.getAuditEntries()(
      arReq as unknown as Request,
      arRes.res as Response,
    );
    // Without admin token or Cloudflare creds, either 400 or 403 is acceptable
    assert.ok(arRes.status === 400 || arRes.status === 403);
  } catch (err: unknown) {
    assert.equal((err as { status?: number }).status, 400);
  }

  // With the admin token it works
  const arReq2 = makeReq({}, {}, { "x-admin-token": "adm-token" });
  const arRes2 = makeRes();
  console.log(
    "DEBUG adminToken env=",
    process.env.ADMIN_TOKEN,
    "req header=",
    arReq2.header("x-admin-token"),
  );
  process.env.DEBUG_SERVER_API = "1";
  await ServerAPI.getAuditEntries()(
    arReq2 as unknown as Request,
    arRes2.res as Response,
  );
  assert.ok(Array.isArray(arRes2.data));

  // Check role-based admin via middleware: isAdmin should allow our admin user
  const mwReq = makeReq(
    {},
    {},
    { "x-auth-email": "admin@example.com", "x-auth-key": "key" },
  );
  const mwRes = makeRes();
  let called = false;
  await new Promise<void>((resolve, reject) => {
    isAdmin(
      mwReq as unknown as Request,
      mwRes.res as Response,
      (err?: unknown) => {
        if (err) {
          reject(err);
        } else {
          called = true;
          resolve();
        }
      },
    );
  });
  assert.equal(called, true);
  CloudflareAPI.prototype.verifyToken = origVerify;
});
