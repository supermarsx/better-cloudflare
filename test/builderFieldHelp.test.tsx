import assert from "node:assert/strict";
import React, { useState } from "react";
import { act } from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, within } from "@testing-library/react";

import { RECORD_SUMMARY_TITLE } from "../src/components/dns/builders/BuilderField";
import { DmarcBuilder } from "../src/components/dns/builders/DmarcBuilder";
import { SpfBuilder } from "../src/components/dns/builders/SpfBuilder";
import type { DNSRecord } from "../src/types/dns";

afterEach(() => cleanup());

function summaryText() {
  const region = screen.getByRole("region", { name: RECORD_SUMMARY_TITLE });
  return (region.textContent ?? "").replace(/\s+/g, " ");
}

function Harness({
  initialContent,
  kind,
}: {
  initialContent: string;
  kind: "spf" | "dmarc";
}) {
  const [record, setRecord] = useState<Partial<DNSRecord>>({
    type: "TXT",
    name: kind === "dmarc" ? "_dmarc" : "@",
    content: initialContent,
  });
  const Builder = kind === "dmarc" ? DmarcBuilder : SpfBuilder;
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setRecord((prev) => ({
            ...prev,
            content:
              kind === "dmarc"
                ? "v=DMARC1; p=quarantine; pct=50; rua=mailto:x@example.test;"
                : "v=spf1 ip4:192.0.2.0/24 include:_spf.example.net -all",
          }))
        }
      >
        change values
      </button>
      <Builder
        record={record}
        onRecordChange={setRecord}
        zoneName="example.com"
      />
    </>
  );
}

test("SPF builder shows a live summary that updates as the record changes", () => {
  render(<Harness kind="spf" initialContent="v=spf1 mx ~all" />);

  const before = summaryText();
  assert.match(before, /the mail servers listed in this domain's MX records/);
  assert.match(
    before,
    /marked suspicious but usually still delivered \(softfail\)/,
  );

  act(() => {
    screen.getByRole("button", { name: "change values" }).click();
  });

  const after = summaryText();
  assert.notEqual(after, before);
  assert.match(after, /the IPv4 range 192\.0\.2\.0\/24/);
  assert.match(after, /_spf\.example\.net's own SPF record/);
  assert.match(after, /rejected as a forgery \(fail\)/);
});

test("DMARC builder shows a live summary that updates as the policy changes", () => {
  render(
    <Harness
      kind="dmarc"
      initialContent="v=DMARC1; p=none; rua=mailto:d@example.com;"
    />,
  );

  const before = summaryText();
  assert.match(before, /no delivery change/);
  assert.match(before, /monitoring only/);
  assert.match(before, /aggregate reports to d@example\.com/);

  act(() => {
    screen.getByRole("button", { name: "change values" }).click();
  });

  const after = summaryText();
  assert.notEqual(after, before);
  assert.match(after, /quarantine half of the messages/);
  assert.match(after, /aggregate reports to x@example\.test/);
});

test("the summary is a named region rather than a chatty live region", () => {
  render(<Harness kind="spf" initialContent="v=spf1 -all" />);
  const region = screen.getByRole("region", { name: RECORD_SUMMARY_TITLE });
  // A live region would be announced on every keystroke while the user types.
  assert.equal(region.getAttribute("aria-live"), null);
});

test("each builder field help indicator is keyboard focusable and reveals its tooltip", () => {
  render(<Harness kind="dmarc" initialContent="v=DMARC1; p=none;" />);

  const indicators = screen.getAllByRole("button", { name: /^Help for / });
  assert.ok(
    indicators.length >= 10,
    "every DMARC field needs a help indicator",
  );

  for (const indicator of indicators) {
    assert.equal(indicator.tagName, "BUTTON");
    assert.equal(indicator.getAttribute("type"), "button");
    assert.equal(indicator.hasAttribute("disabled"), false);
    // A negative tabindex would take the indicator out of the tab order.
    const tabIndex = indicator.getAttribute("tabindex");
    assert.ok(tabIndex === null || Number(tabIndex) >= 0);
  }

  const first = indicators[0] as HTMLButtonElement;
  assert.equal(screen.queryByRole("tooltip"), null);

  act(() => {
    first.focus();
  });

  assert.equal(document.activeElement, first);
  const tooltip = screen.getByRole("tooltip");
  assert.ok((tooltip.textContent ?? "").trim().length > 20);

  act(() => {
    first.blur();
  });
  assert.equal(screen.queryByRole("tooltip"), null);
});

test("SPF field help text is associated with its control via aria-describedby", () => {
  render(<Harness kind="spf" initialContent="v=spf1 mx ~all" />);

  const controls = [
    screen.getByRole("combobox", { name: "Qualifier" }),
    screen.getByRole("combobox", { name: "Mechanism" }),
    screen.getByRole("textbox", { name: "Value" }),
    screen.getByRole("textbox", { name: "Redirect (optional)" }),
  ];

  for (const control of controls) {
    const describedBy = control.getAttribute("aria-describedby");
    assert.ok(
      describedBy,
      `${control.getAttribute("id")} must reference help text`,
    );
    const description = document.getElementById(describedBy);
    assert.ok(description, `${describedBy} must exist in the document`);
    assert.ok(
      (description.textContent ?? "").trim().length > 20,
      "help text must actually explain the field",
    );
  }

  // The visible label and the help indicator refer to the same field.
  assert.ok(
    screen.getByRole("button", { name: "Help for Qualifier" }),
    "each labelled field carries a matching help indicator",
  );
});

test("the summary separates undeterminable effects from stated facts", () => {
  render(
    <Harness
      kind="spf"
      initialContent="v=spf1 include:_spf.example.net ~all"
    />,
  );
  const region = screen.getByRole("region", { name: RECORD_SUMMARY_TITLE });
  const items = within(region)
    .getAllByRole("listitem")
    .map((item) => (item.textContent ?? "").replace(/\s+/g, " "));
  assert.ok(
    items.some((item) => /can change without notice/.test(item)),
    "include: content must be reported as not knowable rather than guessed",
  );
});
