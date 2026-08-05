import assert from "node:assert/strict";
import { test } from "node:test";

import { getRecordBrowserUrl } from "../src/lib/dns/record-browser-url";
import type { DNSRecord } from "../src/types/dns";

function record(patch: Partial<DNSRecord> = {}): DNSRecord {
  return {
    id: "record-1",
    type: "A",
    name: "www",
    content: "192.0.2.10",
    ttl: 300,
    zone_id: "zone-1",
    zone_name: "example.com",
    created_on: "",
    modified_on: "",
    ...patch,
  };
}

test("derives HTTPS owner URLs for address and CNAME records", () => {
  assert.equal(
    getRecordBrowserUrl(record(), "example.com"),
    "https://www.example.com/",
  );
  assert.equal(
    getRecordBrowserUrl(record({ type: "AAAA", name: "@" }), "example.com"),
    "https://example.com/",
  );
  assert.equal(
    getRecordBrowserUrl(
      record({
        type: "CNAME",
        name: "alias.example.com.",
        content: "origin.example.net.",
      }),
      "example.com",
    ),
    "https://alias.example.com/",
  );
});

test("uses strict record content only when an owner cannot be browsed", () => {
  assert.equal(
    getRecordBrowserUrl(record({ name: "*", content: "192.0.2.10" })),
    "https://192.0.2.10/",
  );
  assert.equal(
    getRecordBrowserUrl(
      record({ type: "AAAA", name: "_service", content: "2001:db8::1" }),
    ),
    "https://[2001:db8::1]/",
  );
  assert.equal(
    getRecordBrowserUrl(
      record({
        type: "CNAME",
        name: "*",
        content: "origin.example.net.",
        zone_name: "",
      }),
    ),
    "https://origin.example.net/",
  );
});

test("rejects unsupported records and unsafe owner or fallback content", () => {
  assert.equal(getRecordBrowserUrl(record({ type: "TXT" })), null);
  assert.equal(
    getRecordBrowserUrl(
      record({ name: "user@example.com", content: "999.1.1.1" }),
      "example.com",
    ),
    null,
  );
  assert.equal(
    getRecordBrowserUrl(
      record({
        type: "CNAME",
        name: "www:443",
        content: "bad_target.example.net",
        zone_name: "",
      }),
    ),
    null,
  );
  assert.equal(
    getRecordBrowserUrl(
      record({ type: "AAAA", name: "*", content: "2001:db8::1%eth0" }),
    ),
    null,
  );
});
