/**
 * End-to-end check that the plain-English record summary is reachable in the
 * real UI: the builders render inside AddRecordDialog's Content section, so
 * opening the dialog for a record type with a guided builder must surface the
 * summary and keep it in step with what the user types.
 */
import assert from "node:assert/strict";
import React from "react";
import { test, afterEach } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { AddRecordDialog } from "../src/components/dns/AddRecordDialog";
import { RECORD_SUMMARY_TITLE } from "../src/components/dns/builders/BuilderField";
import type { DNSRecord } from "../src/types/dns";

const noop = () => {};

afterEach(() => cleanup());

function Harness({ initial }: { initial: Partial<DNSRecord> }) {
  const [record, setRecord] = React.useState<Partial<DNSRecord>>(initial);
  return (
    <AddRecordDialog
      open={true}
      onOpenChange={noop}
      record={record}
      onRecordChange={setRecord}
      onAdd={noop}
      zoneName="example.com"
    />
  );
}

function summaryText() {
  const region = screen.getByRole("region", { name: RECORD_SUMMARY_TITLE });
  return (region.textContent ?? "").replace(/\s+/g, " ");
}

test("the dialog surfaces a plain-English DMARC summary that tracks typing", async () => {
  await act(async () => {
    render(
      <Harness
        initial={{
          type: "TXT",
          name: "_dmarc",
          content: "v=DMARC1; p=none; rua=mailto:dmarc@example.com;",
          ttl: 3600,
        }}
      />,
    );
  });

  const before = summaryText();
  assert.match(before, /no delivery change/);
  assert.match(before, /monitoring only/);
  assert.match(before, /aggregate reports to dmarc@example\.com/);

  const content = screen.getByRole("textbox", { name: "TXT content" });
  await act(async () => {
    fireEvent.change(content, {
      target: {
        value: "v=DMARC1; p=quarantine; pct=50; rua=mailto:x@example.test;",
      },
    });
  });

  const after = summaryText();
  assert.notEqual(after, before);
  assert.match(after, /quarantine half of the messages/);
  assert.match(after, /fail authentication/);
  assert.match(after, /aggregate reports to x@example\.test/);
});

test("the dialog surfaces an SPF summary for an SPF TXT record", async () => {
  await act(async () => {
    render(
      <Harness
        initial={{
          type: "TXT",
          name: "@",
          content: "v=spf1 ip4:192.0.2.0/24 -all",
          ttl: 3600,
        }}
      />,
    );
  });

  const text = summaryText();
  assert.match(text, /the IPv4 range 192\.0\.2\.0\/24/);
  assert.match(text, /rejected as a forgery \(fail\)/);
});

test("the dialog surfaces a summary for a non-TXT builder", async () => {
  await act(async () => {
    render(
      <Harness
        initial={{
          type: "SRV",
          name: "_sip._tcp",
          content: "10 60 5060 sip.example.com",
          ttl: 3600,
        }}
      />,
    );
  });

  assert.ok(screen.getByRole("region", { name: RECORD_SUMMARY_TITLE }));
  assert.ok(summaryText().length > 20);
});

test("help indicators inside the dialog stay keyboard reachable", async () => {
  await act(async () => {
    render(
      <Harness
        initial={{
          type: "TXT",
          name: "_dmarc",
          content: "v=DMARC1; p=none;",
          ttl: 3600,
        }}
      />,
    );
  });

  const indicators = screen.getAllByRole("button", { name: /^Help for / });
  assert.ok(indicators.length > 0);

  const first = indicators[0] as HTMLButtonElement;
  assert.equal(screen.queryByRole("tooltip"), null);
  await act(async () => {
    first.focus();
  });
  assert.equal(document.activeElement, first);
  assert.ok((screen.getByRole("tooltip").textContent ?? "").length > 20);
});
