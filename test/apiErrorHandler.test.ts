import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";

import { apiRouter } from "../src/server/router.ts";
import { errorHandler } from "../src/server/errorHandler.ts";
import { asyncHandler } from "../src/lib/async-handler.ts";
import { getCorsMiddleware } from "../src/server/cors.ts";

import type { AddressInfo } from "node:net";

// Ensure fetch exists for Node
import "cloudflare/shims/web";

test("missing credentials returns 400 error", async () => {
  const app = express();
  app.use(express.json());
  app.use(apiRouter);
  app.use(errorHandler);

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/zones`);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(/Missing Cloudflare credentials/.test(data.error));
  } finally {
    server.close();
  }
});

test("generic errors return 500", async () => {
  const app = express();
  app.use(
    "/api/error",
    asyncHandler(async (_req, _res) => {
      void _req;
      void _res;
      throw new Error("boom");
    }),
  );
  app.use(errorHandler);

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/error`);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.ok(/boom/.test(data.error));
  } finally {
    server.close();
  }
});

test("allowed origin sets CORS header", async () => {
  process.env.ALLOWED_ORIGINS = "http://allowed.test";
  const app = express();
  app.use(getCorsMiddleware());
  app.get("/api/test", (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { Origin: "http://allowed.test" },
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://allowed.test",
    );
  } finally {
    server.close();
    delete process.env.ALLOWED_ORIGINS;
  }
});

test("disallowed origin returns 403", async () => {
  process.env.ALLOWED_ORIGINS = "http://allowed.test";
  const app = express();
  app.use(getCorsMiddleware());
  app.get("/api/test", (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { Origin: "http://evil.test" },
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.ok(/Origin not allowed/.test(data.error));
  } finally {
    server.close();
    delete process.env.ALLOWED_ORIGINS;
  }
});
