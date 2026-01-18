import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { ServerAPI } from "../src/lib/server-api.ts";

function createReq(body: unknown, params: Record<string, string>): Request {
  return {
    body,
    params,
    header() {
      return undefined;
    },
  } as unknown as Request;
}

function createRes() {
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

test("vault endpoints reject missing credentials", async () => {
  const storeH = ServerAPI.storeVaultSecret();
  const getH = ServerAPI.getVaultSecret();
  const delH = ServerAPI.deleteVaultSecret();

  await assert.rejects(
    () => storeH(createReq({ secret: "s" }, { id: "id1" }), createRes().res),
    (err: { status?: number }) => err.status === 400,
  );

  await assert.rejects(
    () => getH(createReq({}, { id: "id1" }), createRes().res),
    (err: { status?: number }) => err.status === 400,
  );

  await assert.rejects(
    () => delH(createReq({}, { id: "id1" }), createRes().res),
    (err: { status?: number }) => err.status === 400,
  );
});
