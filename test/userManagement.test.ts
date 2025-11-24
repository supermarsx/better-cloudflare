import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { test } from "node:test";
import { ServerAPI } from "../src/lib/server-api.ts";
import createCredentialStore from "../src/lib/credential-store.ts";

test("admin user creation and roles update (sqlite)", async () => {
  process.env.CREDENTIAL_STORE = "sqlite";
  process.env.ADMIN_TOKEN = "admin-token";
  const store = createCredentialStore() as ReturnType<
    typeof createCredentialStore
  >;
  // ensure ServerAPI uses sqlite store in tests
  ServerAPI.setCredentialStore(store);
  const handlerCreate = ServerAPI.createUser();
  const req = {
    body: { id: "u1", email: "u1@example.com", roles: ["user"] },
    header(name: string) {
      return name === "x-admin-token" ? "admin-token" : undefined;
    },
  } as unknown as Request;
  function makeResponse() {
    let statusCode: number | undefined;
    let jsonData: unknown;
    const resObj: Partial<Response> = {
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
      res: resObj as Response,
      get status() {
        return statusCode;
      },
      get data() {
        return jsonData;
      },
    };
  }
  const createdRes = makeResponse();
  await handlerCreate(req, createdRes.res);
  assert.equal((createdRes.data as { success?: boolean }).success, true);

  const handlerGet = ServerAPI.getUser();
  const reqGet = {
    params: { id: "u1" },
    header() {
      return "admin-token";
    },
  } as unknown as Request;
  const resGet = makeResponse();
  await handlerGet(reqGet, resGet.res);
  assert.equal((resGet.data as { id?: string }).id, "u1");

  const handlerUpdate = ServerAPI.updateUserRoles();
  const reqUpdate = {
    params: { id: "u1" },
    body: { roles: ["admin"] },
    header() {
      return "admin-token";
    },
  } as unknown as Request;
  const resUpdate = makeResponse();
  await handlerUpdate(reqUpdate, resUpdate.res);
  assert.equal((resUpdate.data as { success?: boolean }).success, true);
});
