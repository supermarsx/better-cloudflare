import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";

import { getCorsMiddleware } from "../src/server/cors.ts";

import type { AddressInfo } from "node:net";

import "cloudflare/shims/web";

function createApp() {
  const app = express();
  app.use(getCorsMiddleware());
  app.get("/api/test", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

test("allows request from configured origin", async () => {
  process.env.ALLOWED_ORIGINS = "http://allowed.test";
  const app = createApp();
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

test("blocks request from disallowed origin", async () => {
  process.env.ALLOWED_ORIGINS = "http://allowed.test";
  const app = createApp();
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

test("wildcard origin allows any origin", async () => {
  process.env.ALLOWED_ORIGINS = "*";
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/test`, {
      headers: { Origin: "http://random.test" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    server.close();
    delete process.env.ALLOWED_ORIGINS;
  }
});

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  process.env.ALLOWED_ORIGINS = "http://allowed.test";
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://localhost:${port}/api/test`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://allowed.test",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://allowed.test",
    );
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET,POST,PUT,DELETE,OPTIONS",
    );
    assert.equal(
      res.headers.get("access-control-allow-headers"),
      "Content-Type, Authorization, X-Auth-Key, X-Auth-Email, X-Passkey-Token",
    );
  } finally {
    server.close();
    delete process.env.ALLOWED_ORIGINS;
  }
});
