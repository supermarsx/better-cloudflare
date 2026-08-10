/**
 * Zone comparison semantics.
 *
 * The panel compares two zones that, by definition, have different names. Every
 * assertion here exists because keying records by their fully-qualified name
 * made `identical` and `different` unreachable: `www.origin.example` and
 * `www.target.test` are the same record wearing two suffixes.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  computeZoneDiff,
  ZoneCompare,
  type ZoneDiffEntry,
} from "../src/components/dns/ZoneCompare";
import type { DNSRecord, Zone } from "../src/types/dns";

const LEFT_ZONE: Zone = {
  id: "zone-left",
  name: "origin.example",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
};

const RIGHT_ZONE: Zone = {
  id: "zone-right",
  name: "target.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
};

let recordCounter = 0;

function record(
  zone: Zone,
  overrides: Partial<DNSRecord> & Pick<DNSRecord, "type" | "name" | "content">,
): DNSRecord {
  return {
    id: `record-${++recordCounter}`,
    ttl: 300,
    proxied: false,
    zone_id: zone.id,
    zone_name: zone.name,
    created_on: "2026-08-06T10:00:00Z",
    modified_on: "2026-08-06T10:01:00Z",
    ...overrides,
  };
}

/** Build a record in `origin.example`, the "current" zone. */
function left(
  overrides: Partial<DNSRecord> & Pick<DNSRecord, "type" | "name" | "content">,
): DNSRecord {
  return record(LEFT_ZONE, overrides);
}

/** Build a record in `target.test`. */
function right(
  overrides: Partial<DNSRecord> & Pick<DNSRecord, "type" | "name" | "content">,
): DNSRecord {
  return record(RIGHT_ZONE, overrides);
}

function diff(
  leftRecords: DNSRecord[],
  rightRecords: DNSRecord[],
): ZoneDiffEntry[] {
  return computeZoneDiff(
    leftRecords,
    rightRecords,
    LEFT_ZONE.name,
    RIGHT_ZONE.name,
  );
}

function kinds(entries: ZoneDiffEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

afterEach(() => {
  cleanup();
});

test("records that differ only by their zone suffix compare as identical", () => {
  const entries = diff(
    [
      left({ type: "A", name: "www.origin.example", content: "203.0.113.10" }),
      left({
        type: "CNAME",
        name: "app.origin.example",
        content: "edge.origin.example",
      }),
      left({
        type: "MX",
        name: "origin.example",
        content: "mx.origin.example",
        priority: 10,
      }),
    ],
    [
      right({ type: "A", name: "www.target.test", content: "203.0.113.10" }),
      right({
        type: "CNAME",
        name: "app.target.test",
        content: "edge.target.test",
      }),
      right({
        type: "MX",
        name: "target.test",
        content: "mx.target.test",
        priority: 10,
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["same", "same", "same"]);
});

test("the apex is compared as the apex, however it is spelled", () => {
  const entries = diff(
    [left({ type: "A", name: "@", content: "203.0.113.1" })],
    [right({ type: "A", name: "target.test", content: "203.0.113.1" })],
  );

  assert.deepEqual(kinds(entries), ["same"]);
  // ...and the apex must not collide with a subdomain of the same content.
  const apexVsLabel = diff(
    [left({ type: "A", name: "origin.example", content: "203.0.113.1" })],
    [right({ type: "A", name: "www.target.test", content: "203.0.113.1" })],
  );
  assert.deepEqual(kinds(apexVsLabel).sort(), ["only-left", "only-right"]);
});

test("a record differing only in content is one 'different' row, not two one-sided rows", () => {
  const entries = diff(
    [left({ type: "A", name: "www.origin.example", content: "203.0.113.10" })],
    [right({ type: "A", name: "www.target.test", content: "198.51.100.10" })],
  );

  assert.deepEqual(kinds(entries), ["different"]);
  assert.equal(entries[0]?.left?.content, "203.0.113.10");
  assert.equal(entries[0]?.right?.content, "198.51.100.10");
});

test("a TTL difference is surfaced as 'different' rather than folded into the key", () => {
  const entries = diff(
    [
      left({
        type: "A",
        name: "www.origin.example",
        content: "203.0.113.10",
        ttl: 300,
      }),
    ],
    [
      right({
        type: "A",
        name: "www.target.test",
        content: "203.0.113.10",
        ttl: 3600,
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["different"]);
  assert.equal(entries[0]?.left?.ttl, 300);
  assert.equal(entries[0]?.right?.ttl, 3600);
});

test("a proxy difference is surfaced as 'different'", () => {
  const entries = diff(
    [
      left({
        type: "A",
        name: "www.origin.example",
        content: "203.0.113.10",
        proxied: true,
      }),
    ],
    [
      right({
        type: "A",
        name: "www.target.test",
        content: "203.0.113.10",
        proxied: false,
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["different"]);
});

test("a record present in one zone only is reported on the correct side", () => {
  const entries = diff(
    [left({ type: "TXT", name: "only-here.origin.example", content: "v=x" })],
    [right({ type: "TXT", name: "only-there.target.test", content: "v=y" })],
  );

  const onlyLeft = entries.find((entry) => entry.kind === "only-left");
  const onlyRight = entries.find((entry) => entry.kind === "only-right");
  assert.equal(entries.length, 2);
  assert.equal(onlyLeft?.left?.name, "only-here.origin.example");
  assert.equal(onlyLeft?.right, undefined);
  assert.equal(onlyRight?.right?.name, "only-there.target.test");
  assert.equal(onlyRight?.left, undefined);
});

test("in-zone hostname references inside content are matched across zones", () => {
  // Every one of these payload shapes is rewritten by the copy path; the diff
  // reuses it rather than re-deriving a weaker version.
  const entries = diff(
    [
      left({
        type: "CNAME",
        name: "app.origin.example",
        content: "edge.origin.example",
      }),
      left({
        type: "SRV",
        name: "_sip._tcp.origin.example",
        content: "10 5 5060 sip.origin.example",
      }),
      left({
        type: "NS",
        name: "sub.origin.example",
        content: "ns1.origin.example",
      }),
      left({
        type: "TXT",
        name: "origin.example",
        content: "v=spf1 include:spf.origin.example ~all",
      }),
    ],
    [
      right({
        type: "CNAME",
        name: "app.target.test",
        content: "edge.target.test",
      }),
      right({
        type: "SRV",
        name: "_sip._tcp.target.test",
        content: "10 5 5060 sip.target.test",
      }),
      right({
        type: "NS",
        name: "sub.target.test",
        content: "ns1.target.test",
      }),
      right({
        type: "TXT",
        name: "target.test",
        content: "v=spf1 include:spf.target.test ~all",
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["same", "same", "same", "same"]);
});

test("a CNAME pointing at an external domain is matched verbatim, never rewritten", () => {
  const external = diff(
    [
      left({
        type: "CNAME",
        name: "cdn.origin.example",
        content: "edge.vendor.net",
      }),
    ],
    [
      right({
        type: "CNAME",
        name: "cdn.target.test",
        content: "edge.vendor.net",
      }),
    ],
  );
  assert.deepEqual(kinds(external), ["same"]);
});

test("an external reference that happens to name the other zone does not falsely match", () => {
  // Left points *out* at target.test; right points at its own zone. Projecting
  // the left zone onto the right one would collapse these into a false
  // "identical" and hide a real difference.
  const entries = diff(
    [
      left({
        type: "CNAME",
        name: "cdn.origin.example",
        content: "cdn.target.test",
      }),
    ],
    [
      right({
        type: "CNAME",
        name: "cdn.target.test",
        content: "cdn.target.test",
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["different"]);
});

test("content that cannot be confidently normalized is never reported identical", () => {
  // An unparseable SPF policy (a /999 prefix length) makes the rewriter bail
  // out, so the in-zone reference survives. Reporting these as identical would
  // let someone skip copying a record they actually needed.
  const entries = diff(
    [
      left({
        type: "TXT",
        name: "origin.example",
        content: "v=spf1 a:origin.example/999 ~all",
      }),
    ],
    [
      right({
        type: "TXT",
        name: "target.test",
        content: "v=spf1 a:target.test/999 ~all",
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["different"]);
});

test("an unrewritable in-zone reference is not identical even when the raw text matches", () => {
  // Byte-identical content, but the left record names its own zone and the
  // right one does not. That is a real inconsistency, so it stays "different".
  const entries = diff(
    [
      left({
        type: "TXT",
        name: "note.origin.example",
        content: "owner=admin@origin.example",
      }),
    ],
    [
      right({
        type: "TXT",
        name: "note.target.test",
        content: "owner=admin@origin.example",
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["different"]);
});

test("all three classifications are reachable in a single comparison", () => {
  const entries = diff(
    [
      left({ type: "A", name: "www.origin.example", content: "203.0.113.10" }),
      left({ type: "A", name: "api.origin.example", content: "203.0.113.11" }),
      left({ type: "TXT", name: "origin.example", content: "left-only" }),
    ],
    [
      right({ type: "A", name: "www.target.test", content: "203.0.113.10" }),
      right({ type: "A", name: "api.target.test", content: "198.51.100.11" }),
      right({ type: "AAAA", name: "target.test", content: "2001:db8::1" }),
    ],
  );

  const counted = kinds(entries).reduce<Record<string, number>>(
    (totals, kind) => ({ ...totals, [kind]: (totals[kind] ?? 0) + 1 }),
    {},
  );
  assert.deepEqual(counted, {
    same: 1,
    different: 1,
    "only-left": 1,
    "only-right": 1,
  });
});

test("duplicate records at the same owner pair up rather than cross-matching", () => {
  const entries = diff(
    [
      left({
        type: "MX",
        name: "origin.example",
        content: "mx1.origin.example",
        priority: 10,
      }),
      left({
        type: "MX",
        name: "origin.example",
        content: "mx2.origin.example",
        priority: 20,
      }),
    ],
    [
      right({
        type: "MX",
        name: "target.test",
        content: "mx1.target.test",
        priority: 10,
      }),
      right({
        type: "MX",
        name: "target.test",
        content: "mx2.target.test",
        priority: 20,
      }),
    ],
  );

  assert.deepEqual(kinds(entries), ["same", "same"]);
});

interface RenderOptions {
  columns?: readonly string[];
  leftRecords?: DNSRecord[];
  rightRecords?: DNSRecord[];
}

const DEFAULT_LEFT = [
  left({ type: "A", name: "www.origin.example", content: "203.0.113.10" }),
  left({
    type: "CNAME",
    name: "app.origin.example",
    content: "edge.origin.example",
  }),
  left({
    type: "A",
    name: "api.origin.example",
    content: "203.0.113.11",
    ttl: 300,
  }),
  left({ type: "TXT", name: "left-only.origin.example", content: "left" }),
];

const DEFAULT_RIGHT = [
  right({ type: "A", name: "www.target.test", content: "203.0.113.10" }),
  right({
    type: "CNAME",
    name: "app.target.test",
    content: "edge.target.test",
  }),
  right({
    type: "A",
    name: "api.target.test",
    content: "203.0.113.11",
    ttl: 3600,
  }),
  right({ type: "TXT", name: "right-only.target.test", content: "right" }),
];

async function renderCompare(options: RenderOptions = {}) {
  const leftRecords = options.leftRecords ?? DEFAULT_LEFT;
  const rightRecords = options.rightRecords ?? DEFAULT_RIGHT;
  const view = render(
    <ZoneCompare
      zones={[LEFT_ZONE, RIGHT_ZONE]}
      currentZoneId={LEFT_ZONE.id}
      defaultCompareZoneId={RIGHT_ZONE.id}
      columns={options.columns}
      getDNSRecords={async (zoneId) =>
        zoneId === LEFT_ZONE.id ? leftRecords : rightRecords
      }
    />,
  );

  const button = await screen.findByRole("button", { name: "Compare" });
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  await screen.findByTestId("zone-compare-table");
  return view;
}

function rowKinds(): string[] {
  return Array.from(document.querySelectorAll("[data-diff-row]")).map(
    (row) => row.getAttribute("data-diff-row") ?? "",
  );
}

test("the panel classifies records across differently named zones", async () => {
  await renderCompare();

  await waitFor(() => assert.ok(screen.getByText("2 identical")));
  assert.ok(screen.getByText("1 different"));
  assert.ok(screen.getByText("1 only in origin.example"));
  assert.ok(screen.getByText("1 only in target.test"));

  // Identical rows are collapsed until asked for.
  assert.deepEqual(rowKinds().sort(), ["different", "only-left", "only-right"]);
  fireEvent.click(screen.getByRole("button", { name: "Show identical" }));
  await waitFor(() =>
    assert.equal(rowKinds().filter((kind) => kind === "same").length, 2),
  );
});

test("a matched pair shows both sides of the setting that differs", async () => {
  await renderCompare();

  const differentRow = document.querySelector('[data-diff-row="different"]');
  assert.ok(differentRow, "the TTL mismatch must render a 'different' row");
  assert.match(differentRow.textContent ?? "", /300 → 3600/u);
});

test("the zone compare column selection still drives the table", async () => {
  await renderCompare({ columns: ["status", "type", "name"] });

  const table = screen.getByTestId("zone-compare-table");
  const header = table.firstElementChild;
  assert.ok(header);
  assert.deepEqual(
    Array.from(header.children).map((cell) => cell.textContent?.trim()),
    ["Status", "Type", "Name"],
  );

  // Required columns are forced back in even when a stored list omits them.
  cleanup();
  await renderCompare({ columns: ["ttl"] });
  const restored = screen.getByTestId("zone-compare-table").firstElementChild;
  assert.ok(restored);
  assert.deepEqual(
    Array.from(restored.children).map((cell) => cell.textContent?.trim()),
    ["Status", "Type", "Name", "TTL"],
  );
});
