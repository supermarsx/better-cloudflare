/**
 * The per-type content format table is a teaching surface: a wrong example
 * teaches someone to write a broken record. These tests pin the invariants that
 * keep it safe — documentation-only domains and addresses, correct digest
 * lengths, and coverage of every type the dialog offers by default.
 */
import assert from "node:assert/strict";
import React from "react";
import { test, afterEach } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import { AddRecordDialog } from "../src/components/dns/AddRecordDialog";
import {
  RECORD_FORMATS,
  RECORD_FORMAT_OMISSIONS,
  getRecordFormat,
} from "../src/components/dns/builders/record-formats";
import {
  CLOUDFLARE_SUPPORTED_RECORD_TYPES,
  RECORD_TYPES,
} from "../src/types/dns";
import type { DNSRecord } from "../src/types/dns";

const noop = () => {};

afterEach(() => cleanup());

test("every Cloudflare-supported record type has a format and example", () => {
  const missing = CLOUDFLARE_SUPPORTED_RECORD_TYPES.filter(
    (type) => !getRecordFormat(type),
  );
  assert.deepEqual(missing, []);
});

test("every record type is either documented or explicitly omitted with a reason", () => {
  const unaccounted = RECORD_TYPES.filter(
    (type) => !RECORD_FORMATS[type] && !RECORD_FORMAT_OMISSIONS[type],
  );
  assert.deepEqual(
    unaccounted,
    [],
    "a type must have a format entry or a stated reason for having none",
  );

  // An omission must never also carry a format; that would be contradictory.
  for (const type of Object.keys(RECORD_FORMAT_OMISSIONS)) {
    assert.equal(
      RECORD_FORMATS[type as keyof typeof RECORD_FORMATS],
      undefined,
    );
  }
});

test("examples only use reserved documentation domains and addresses", () => {
  // RFC 5737 documentation ranges.
  const docV4 = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;
  for (const [type, entry] of Object.entries(RECORD_FORMATS)) {
    const example = entry?.example ?? "";

    for (const host of example.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []) {
      const lower = host.toLowerCase();
      // Skip anything that is actually a dotted-quad, handled below.
      if (/^\d+(\.\d+)+$/.test(lower)) continue;
      assert.ok(
        lower.endsWith("example.com") ||
          lower.endsWith("example.net") ||
          lower.endsWith("example.org") ||
          lower.endsWith(".test") ||
          lower === "letsencrypt.org",
        `${type} example uses non-reserved host "${host}"`,
      );
    }

    for (const ipv4 of example.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
      assert.match(ipv4, docV4, `${type} example uses non-documentation IPv4`);
    }

    for (const ipv6 of example.match(/\b2[0-9a-f]{3}:[0-9a-f:]+/gi) ?? []) {
      assert.match(
        ipv6.toLowerCase(),
        /^2001:db8/,
        `${type} example uses non-documentation IPv6`,
      );
    }
  }
});

test("hash-bearing examples carry the digest length their algorithm implies", () => {
  // DS/TLSA/SMIMEA digest type 2 or matching type 1 is SHA-256: 64 hex chars.
  const sha256Hex = /\b[0-9A-F]{64}\b/;
  for (const type of ["DS", "TLSA", "SMIMEA", "SSHFP"] as const) {
    const example = RECORD_FORMATS[type]?.example ?? "";
    assert.match(example, sha256Hex, `${type} example needs a 64-char SHA-256`);
    assert.doesNotMatch(
      example,
      /\b[0-9A-F]{40}\b/,
      `${type} example must not show a SHA-1 digest`,
    );
  }
});

test("every format states its field order with angle-bracket placeholders", () => {
  for (const [type, entry] of Object.entries(RECORD_FORMATS)) {
    assert.ok(entry, `${type} entry missing`);
    assert.match(
      entry.format,
      /<[a-z0-9 |-]+>/i,
      `${type} format needs angle-bracket field placeholders`,
    );
    assert.ok(entry.example.trim().length > 0, `${type} needs an example`);
  }
});

test("the dialog shows the format and example for a type with no guided builder", async () => {
  await act(async () => {
    render(
      <AddRecordDialog
        open={true}
        onOpenChange={noop}
        record={{ type: "MX", name: "@", content: "", ttl: 3600 }}
        onRecordChange={noop}
        onAdd={noop}
        zoneName="example.com"
      />,
    );
  });

  const content = screen.getByRole("textbox", { name: "Content" });
  const describedBy = content.getAttribute("aria-describedby");
  assert.ok(describedBy, "the free-text content field must reference the hint");

  const hint = document.getElementById(describedBy);
  assert.ok(hint);
  const text = (hint.textContent ?? "").replace(/\s+/g, " ");
  assert.match(text, /Format: <mail server hostname>/);
  assert.match(text, /Example: mail\.example\.com/);
  // The caveat is announced with the field, not hidden behind hover alone.
  assert.match(text, /Priority field/);
});

test("the format hint's help indicator is keyboard reachable", async () => {
  await act(async () => {
    render(
      <AddRecordDialog
        open={true}
        onOpenChange={noop}
        record={
          {
            type: "MX",
            name: "@",
            content: "",
            ttl: 3600,
          } as Partial<DNSRecord>
        }
        onRecordChange={noop}
        onAdd={noop}
        zoneName="example.com"
      />,
    );
  });

  const indicator = screen.getByRole("button", {
    name: "Help for MX content format",
  });
  assert.equal(indicator.tagName, "BUTTON");
  await act(async () => {
    (indicator as HTMLButtonElement).focus();
  });
  assert.equal(document.activeElement, indicator);
  assert.match(screen.getByRole("tooltip").textContent ?? "", /Priority field/);
});
