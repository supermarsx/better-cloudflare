import assert from "node:assert/strict";
import React, { useState } from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { DmarcBuilder } from "../src/components/dns/builders/DmarcBuilder";
import type { DNSRecord } from "../src/types/dns";

afterEach(() => cleanup());

function DmarcHarness() {
  const [record, setRecord] = useState<Partial<DNSRecord>>({
    type: "TXT",
    name: "_dmarc.example.com",
    content: "v=DMARC1; p=none; rua=mailto:dmarc@example.com;",
  });
  return (
    <DmarcBuilder
      record={record}
      onRecordChange={setRecord}
      zoneName="example.com"
    />
  );
}

test("DMARC controls expose labels and field-associated explanations", () => {
  render(<DmarcHarness />);

  const controls = [
    screen.getByRole("combobox", { name: "p= (policy)" }),
    screen.getByRole("textbox", { name: "rua= (aggregate reports)" }),
    screen.getByRole("textbox", { name: "ruf= (forensic reports)" }),
    screen.getByRole("combobox", { name: "adkim=" }),
    screen.getByRole("combobox", { name: "aspf=" }),
    screen.getByRole("spinbutton", { name: "pct=" }),
    screen.getByRole("combobox", { name: "sp= (subdomain policy)" }),
    screen.getByRole("textbox", { name: "fo= (optional)" }),
    screen.getByRole("spinbutton", { name: "ri= (optional)" }),
    screen.getByRole("combobox", { name: "rf= (optional)" }),
  ];

  for (const control of controls) {
    const descriptionId = control.getAttribute("aria-describedby");
    assert.ok(descriptionId, `${control.getAttribute("id")} needs help text`);
    const description = document.getElementById(descriptionId);
    assert.ok(description);
    assert.ok((description.textContent ?? "").trim().length > 20);
  }

  assert.equal(
    screen.getAllByRole("button", { name: /^Help for / }).length,
    controls.length,
  );
});

test("DMARC numeric controls expose safe input constraints", () => {
  render(<DmarcHarness />);

  const pct = screen.getByRole("spinbutton", { name: "pct=" });
  assert.equal(pct.getAttribute("min"), "0");
  assert.equal(pct.getAttribute("max"), "100");
  assert.equal(pct.getAttribute("step"), "1");

  const ri = screen.getByRole("spinbutton", { name: "ri= (optional)" });
  assert.equal(ri.getAttribute("min"), "1");
  assert.equal(ri.getAttribute("step"), "1");
});
