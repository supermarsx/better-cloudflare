import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeExternalHttpUrl,
  openExternalUrl,
  type ExternalUrlAdapter,
} from "../src/lib/external-url";

test("external URL normalization only accepts credential-free HTTP(S)", () => {
  assert.equal(
    normalizeExternalHttpUrl("https://example.com/path?q=1"),
    "https://example.com/path?q=1",
  );
  assert.equal(normalizeExternalHttpUrl("ftp://example.com/file"), null);
  assert.equal(normalizeExternalHttpUrl("https://user:pass@example.com/"), null);
  assert.equal(normalizeExternalHttpUrl("https://example.com/\nnext"), null);
});

test("external URL opener routes web URLs through its injectable adapter", async () => {
  const opened: string[] = [];
  const adapter: ExternalUrlAdapter = {
    isDesktop: () => false,
    openDesktop: () => {
      throw new Error("desktop opener should not run");
    },
    openWeb: (url) => {
      opened.push(url);
    },
  };

  assert.equal(await openExternalUrl("https://example.com", adapter), true);
  assert.deepEqual(opened, ["https://example.com/"]);
  assert.equal(await openExternalUrl("javascript:alert(1)", adapter), false);
  assert.deepEqual(opened, ["https://example.com/"]);
});

test("external URL opener routes desktop URLs through the shell adapter", async () => {
  const opened: string[] = [];
  const adapter: ExternalUrlAdapter = {
    isDesktop: () => true,
    openDesktop: (url) => {
      opened.push(url);
    },
    openWeb: () => {
      throw new Error("web opener should not run");
    },
  };

  assert.equal(await openExternalUrl("http://example.com", adapter), true);
  assert.deepEqual(opened, ["http://example.com/"]);
});
