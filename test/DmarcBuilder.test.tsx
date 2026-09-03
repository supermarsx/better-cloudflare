import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import {
  buildDMARC,
  DMARC_PRESETS,
  dmarcPresetTagLine,
  DmarcBuilder,
} from "../src/components/dns/builders/DmarcBuilder";
import type { DmarcPresetValues } from "../src/components/dns/builders/DmarcBuilder";
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

/**
 * Harness that surfaces the record content, so a test can assert on what the
 * builder actually wrote rather than on its internal state.
 */
function PresetHarness({ initialContent }: { initialContent: string }) {
  const [record, setRecord] = useState<Partial<DNSRecord>>({
    type: "TXT",
    name: "_dmarc",
    content: initialContent,
  });
  return (
    <>
      <pre data-testid="content">{record.content}</pre>
      <DmarcBuilder
        record={record}
        onRecordChange={setRecord}
        zoneName="example.com"
      />
    </>
  );
}

function presetByName(name: string) {
  const preset = DMARC_PRESETS.find((entry) => entry.name === name);
  assert.ok(preset, `missing preset: ${name}`);
  return preset;
}

function recordFor(values: DmarcPresetValues, rua: string) {
  return buildDMARC({ ...values, rua, ruf: "", fo: "", rf: "", ri: undefined });
}

test("each DMARC preset builds its expected record string", () => {
  const rua = "mailto:dmarc@example.com";
  const expected: Record<string, string> = {
    "Strict enforcement": `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; pct=100; rua=${rua};`,
    Enforce: `v=DMARC1; p=reject; adkim=r; aspf=r; pct=100; rua=${rua};`,
    Quarantine: `v=DMARC1; p=quarantine; adkim=r; aspf=r; pct=100; rua=${rua};`,
    "Partial rollout": `v=DMARC1; p=quarantine; adkim=r; aspf=r; pct=25; rua=${rua};`,
    "Monitor only": `v=DMARC1; p=none; adkim=r; aspf=r; rua=${rua};`,
  };

  assert.equal(DMARC_PRESETS.length, Object.keys(expected).length);
  for (const [name, record] of Object.entries(expected)) {
    assert.equal(recordFor(presetByName(name).values, rua), record, name);
  }
});

test("presets run strictest to laxest and label their risk honestly", () => {
  assert.deepEqual(
    DMARC_PRESETS.map((preset) => preset.name),
    [
      "Strict enforcement",
      "Enforce",
      "Quarantine",
      "Partial rollout",
      "Monitor only",
    ],
  );

  // The enforcing end must say what enforcement costs, at the point of choice.
  assert.match(presetByName("Strict enforcement").consequence, /throw away/);
  assert.match(
    presetByName("Strict enforcement").consequence,
    /legitimate mail you have not yet authorised/,
  );
  assert.match(presetByName("Enforce").consequence, /throw away/);
  // ...and the lax end must not be presented as merely worse.
  assert.match(presetByName("Monitor only").consequence, /Nothing at all/);
  assert.match(
    presetByName("Monitor only").suitedFor,
    /correct starting point/,
  );
  assert.equal(presetByName("Monitor only").severity, "none");
  assert.equal(presetByName("Strict enforcement").severity, "high");
});

test("the displayed preset tag line matches the record the preset builds", () => {
  for (const preset of DMARC_PRESETS) {
    const line = dmarcPresetTagLine(preset.values);
    const record = recordFor(preset.values, "");
    assert.equal(record, `v=DMARC1; ${line};`, preset.name);
  }
});

test("preset risk and consequences are rendered at the point of choice", () => {
  render(<PresetHarness initialContent="v=DMARC1; p=none;" />);

  for (const preset of DMARC_PRESETS) {
    const button = screen.getByRole("button", {
      name: new RegExp(preset.name),
    });
    const text = (button.textContent ?? "").replace(/\s+/g, " ");
    assert.ok(text.includes(preset.risk), `${preset.name} needs a risk label`);
    assert.ok(
      text.includes(preset.consequence.replace(/\s+/g, " ")),
      `${preset.name} needs its consequence shown`,
    );
    assert.ok(text.includes(dmarcPresetTagLine(preset.values)));
  }

  // Strictest-first ordering must not read as best-first.
  const panel = screen.getByText("Policy presets").parentElement;
  assert.ok(panel);
  const panelText = (panel.textContent ?? "").replace(/\s+/g, " ");
  assert.match(panelText, /Strictest is not best/);
  // Monitor-only is pointless without a report address; say so while it is empty.
  assert.match(panelText, /No rua= address is set yet/);
});

test("choosing a preset writes its record and keeps every field editable", () => {
  render(
    <PresetHarness initialContent="v=DMARC1; p=none; rua=mailto:dmarc@example.com; sp=none;" />,
  );

  act(() => {
    screen.getByRole("button", { name: /Strict enforcement/ }).click();
  });
  act(() => {
    screen.getByRole("button", { name: "Build DMARC TXT" }).click();
  });

  assert.equal(
    screen.getByTestId("content").textContent,
    "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@example.com;",
  );

  // A preset is a starting point, not a mode: the fields it set stay editable,
  // and a second preset fully replaces the first rather than merging with it.
  act(() => {
    screen.getByRole("button", { name: /Monitor only/ }).click();
  });
  act(() => {
    screen.getByRole("button", { name: "Build DMARC TXT" }).click();
  });

  // sp=reject from the strict preset must not survive into monitor-only.
  assert.equal(
    screen.getByTestId("content").textContent,
    "v=DMARC1; p=none; adkim=r; aspf=r; rua=mailto:dmarc@example.com;",
  );
});

test("every DMARC option explains what it does and what going wrong looks like", () => {
  render(<DmarcHarness />);

  // Each field's explanation is the sr-only description its control points at.
  const expectations: Array<[string, string, RegExp]> = [
    ["combobox", "p= (policy)", /destroyed, not delayed/],
    ["textbox", "rua= (aggregate reports)", /publishing a policy blind/],
    ["textbox", "ruf= (forensic reports)", /treat the mailbox as sensitive/],
    ["combobox", "adkim=", /sign with their own domain/],
    ["combobox", "aspf=", /own bounce domain in the envelope/],
    ["spinbutton", "pct=", /the next weaker treatment/],
    ["combobox", "sp= (subdomain policy)", /bypasses your policy completely/],
    ["textbox", "fo= (optional)", /no effect unless ruf= is also set/],
    ["spinbutton", "ri= (optional)", /a request rather than a rule/],
    ["combobox", "rf= (optional)", /rarely supported/],
  ];

  for (const [role, name, consequence] of expectations) {
    const control = screen.getByRole(role, { name });
    const descriptionId = control.getAttribute("aria-describedby");
    assert.ok(descriptionId, `${name} needs help text`);
    const description = document.getElementById(descriptionId);
    assert.ok(description);
    assert.match(
      (description.textContent ?? "").replace(/\s+/g, " "),
      consequence,
    );
  }
});
