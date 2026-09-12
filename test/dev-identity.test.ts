/**
 * The dev-server identity token, from both ends.
 *
 * `scripts/dev-server.mjs` generates the token and `app/layout.tsx` renders it.
 * They live in different languages and cannot share a module, so each keeps its
 * own copy of the constants. If those copies ever drift, the layout renders a
 * tag the tooling never reads - every dev server stops verifying as ours, and
 * the failure looks like a broken probe rather than a renamed constant. This file
 * is what holds the two copies together.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEV_IDENTITY_ENV,
  DEV_IDENTITY_META,
  DEV_IDENTITY_TOKEN_PATTERN,
  createDevIdentityToken,
  extractDevIdentity,
  isDevIdentityToken,
} from "../scripts/dev-port.mjs";
import {
  DEV_IDENTITY_ENV as LAYOUT_ENV,
  DEV_IDENTITY_META as LAYOUT_META,
  DEV_IDENTITY_TOKEN_PATTERN as LAYOUT_PATTERN,
  devIdentityMetadata,
} from "../src/lib/dev-identity";

test("the layout and the launcher agree on every identity constant", () => {
  assert.equal(LAYOUT_ENV, DEV_IDENTITY_ENV);
  assert.equal(LAYOUT_META, DEV_IDENTITY_META);
  assert.equal(LAYOUT_PATTERN.source, DEV_IDENTITY_TOKEN_PATTERN.source);
  assert.equal(LAYOUT_PATTERN.flags, DEV_IDENTITY_TOKEN_PATTERN.flags);
});

test("a launcher token survives the layout and the tag it renders", () => {
  const token = createDevIdentityToken();
  assert.ok(isDevIdentityToken(token));

  const metadata = devIdentityMetadata({
    NODE_ENV: "development",
    [DEV_IDENTITY_ENV]: token,
  });
  assert.deepEqual(metadata, { other: { [DEV_IDENTITY_META]: token } });

  // Next documents `metadata.other` as rendering `<meta name content />`. The
  // tooling has to read exactly what that produces.
  const rendered = `<html><head><meta name="${DEV_IDENTITY_META}" content="${token}" /></head></html>`;
  assert.equal(extractDevIdentity(rendered), token);
});

test("every launch gets a token no other launch has", () => {
  const tokens = new Set(
    Array.from({ length: 64 }, () => createDevIdentityToken()),
  );
  assert.equal(tokens.size, 64);
});

test("the identity tag is rendered in development only", () => {
  // A static export is built with NODE_ENV=production. Even a shell that
  // happens to carry the variable must not bake a token into `out/`.
  const token = createDevIdentityToken();
  for (const NODE_ENV of ["production", "test", undefined]) {
    assert.deepEqual(
      devIdentityMetadata({ NODE_ENV, [DEV_IDENTITY_ENV]: token }),
      {},
      `NODE_ENV=${String(NODE_ENV)} must render no identity tag`,
    );
  }
});

test("a missing or malformed token renders nothing", () => {
  for (const value of [
    undefined,
    "",
    "short",
    `${createDevIdentityToken()}=`,
    "a".repeat(44),
    "a b".padEnd(43, "c"),
    '"><script>alert(1)</script>'.padEnd(43, "x"),
  ]) {
    assert.deepEqual(
      devIdentityMetadata({
        NODE_ENV: "development",
        [DEV_IDENTITY_ENV]: value,
      }),
      {},
      `${JSON.stringify(value)} must not be rendered`,
    );
  }
});
