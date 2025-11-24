import { dnsRecordSchema } from "../src/lib/validation";
import assert from "node:assert/strict";
import { test } from "node:test";

test("debug SPF", () => {
  const r = {
    type: "SPF",
    name: "test",
    content: "v=spf1 ip4:1.2.3.0/24 -all",
  } as Record<string, unknown>;
  const res = dnsRecordSchema.safeParse(r as unknown);
  if (!res.success) {
    console.log("spfreason", JSON.stringify(res.error.format(), null, 2));
  }
  assert.equal(res.success, true);
});
