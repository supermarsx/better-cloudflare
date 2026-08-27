import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SpecialIpAuditFindings } from "../src/components/dns/SpecialIpAuditFindings";
import { findSpecialIpRecords } from "../src/lib/audit/domain-audit";
import type { DNSRecord } from "../src/types/dns";

function record(
  id: string,
  type: DNSRecord["type"],
  name: string,
  content: string,
): DNSRecord {
  return {
    id,
    type,
    name,
    content,
    ttl: 300,
    zone_id: "z",
    zone_name: "example.com",
    created_on: "",
    modified_on: "",
  };
}

const records: DNSRecord[] = [
  record("pub", "A", "www.example.com", "8.8.8.8"),
  record("lan", "A", "lan.example.com", "192.168.1.10"),
  record("loop", "A", "loop.example.com", "127.0.0.1"),
  record("v6", "AAAA", "v6.example.com", "fd00::1"),
];

afterEach(() => {
  cleanup();
});

test("findSpecialIpRecords keeps the record so the UI can point at it", () => {
  const a = findSpecialIpRecords(records, "A");
  assert.deepEqual(
    a.map((f) => [f.record.id, f.ip, f.issue]),
    [
      ["lan", "192.168.1.10", "RFC1918 private (192.168.0.0/16)"],
      ["loop", "127.0.0.1", "Loopback (127.0.0.0/8)"],
    ],
  );
  assert.ok(!a.some((f) => f.record.id === "pub"));
  const aaaa = findSpecialIpRecords(records, "AAAA");
  assert.deepEqual(
    aaaa.map((f) => f.record.id),
    ["v6"],
  );
});

test("each listed record gets a labelled Go to record button that reveals it", () => {
  const revealed: string[] = [];
  render(
    <SpecialIpAuditFindings
      findings={findSpecialIpRecords(records, "A")}
      onGoToRecord={(r) => revealed.push(r.id)}
    />,
  );

  const buttons = screen.getAllByRole("button", { name: /go to record/i });
  assert.equal(buttons.length, 2);
  assert.equal(
    buttons[0].getAttribute("aria-label"),
    "Go to record A lan.example.com",
  );
  assert.ok(screen.getByText("192.168.1.10"));

  fireEvent.click(buttons[1]);
  assert.deepEqual(revealed, ["loop"]);
});
