import assert from "node:assert/strict";
import { test } from "node:test";
import { dnsRecordSchema } from "../src/lib/validation";

test("hostname-like record validation rejects invalid content", () => {
  const bad = dnsRecordSchema.safeParse({
    type: "CNAME",
    name: "www",
    content: "bad host name",
    ttl: 300,
  });
  assert.equal(bad.success, false);
});

test("hostname-like record validation accepts valid hostname", () => {
  const good = dnsRecordSchema.safeParse({
    type: "CNAME",
    name: "www",
    content: "example.com",
    ttl: 300,
  });
  assert.equal(good.success, true);
});
