import assert from "node:assert/strict";
import { test } from "node:test";
import { RECORD_TYPES, getRecordTypeLabel } from "../src/types/dns";

test("getRecordTypeLabel returns a non-empty label for every record type", () => {
  for (const t of RECORD_TYPES) {
    const l = getRecordTypeLabel(t);
    assert.ok(typeof l === "string" && l.length > 0, `expected label for ${t}`);
  }
});
