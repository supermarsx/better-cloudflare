/**
 * Contract test for the guided record builders.
 *
 * Every builder must (a) expose a pure `describe*` function returning a
 * BuilderSummary and (b) render the always-visible "What this record does"
 * summary, so a user who learns one builder recognises the next. Adding a new
 * builder without both is a failure here rather than a UI inconsistency found
 * later.
 */
import assert from "node:assert/strict";
import React, { useState } from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { RECORD_SUMMARY_TITLE } from "../src/components/dns/builders/BuilderField";
import type { RecordDraft } from "../src/components/dns/builders/types";
import type { DNSRecord } from "../src/types/dns";

import * as Afsdb from "../src/components/dns/builders/AfsdbBuilder";
import * as Aname from "../src/components/dns/builders/AnameBuilder";
import * as Apl from "../src/components/dns/builders/AplBuilder";
import * as Caa from "../src/components/dns/builders/CaaBuilder";
import * as Cert from "../src/components/dns/builders/CertBuilder";
import * as Dkim from "../src/components/dns/builders/DkimBuilder";
import * as Dmarc from "../src/components/dns/builders/DmarcBuilder";
import * as Dname from "../src/components/dns/builders/DnameBuilder";
import * as Dnskey from "../src/components/dns/builders/DnskeyBuilder";
import * as Ds from "../src/components/dns/builders/DsBuilder";
import * as Hinfo from "../src/components/dns/builders/HinfoBuilder";
import * as Loc from "../src/components/dns/builders/LocBuilder";
import * as Naptr from "../src/components/dns/builders/NaptrBuilder";
import * as Openpgpkey from "../src/components/dns/builders/OpenpgpkeyBuilder";
import * as Rp from "../src/components/dns/builders/RpBuilder";
import * as Smimea from "../src/components/dns/builders/SmimeaBuilder";
import * as Soa from "../src/components/dns/builders/SoaBuilder";
import * as Spf from "../src/components/dns/builders/SpfBuilder";
import * as Srv from "../src/components/dns/builders/SrvBuilder";
import * as Sshfp from "../src/components/dns/builders/SshfpBuilder";
import * as Svcb from "../src/components/dns/builders/SvcbBuilder";
import * as Tlsa from "../src/components/dns/builders/TlsaBuilder";
import * as Txt from "../src/components/dns/builders/TxtBuilder";
import * as Uri from "../src/components/dns/builders/UriBuilder";

afterEach(() => cleanup());

type BuilderProps = {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  zoneName?: string;
};
type BuilderModule = Record<string, unknown>;

type Case = {
  label: string;
  module: BuilderModule;
  component: string;
  type: DNSRecord["type"];
  name?: string;
  content?: string;
};

const CASES: Case[] = [
  { label: "AFSDB", module: Afsdb, component: "AfsdbBuilder", type: "AFSDB" },
  { label: "ANAME", module: Aname, component: "AnameBuilder", type: "ANAME" },
  {
    label: "APL",
    module: Apl,
    component: "AplBuilder",
    type: "APL",
    // APL renders one field group per prefix, so an empty record has no
    // controls at all; seed it so the per-entry help is actually exercised.
    content: "1:192.0.2.0/24 !1:192.0.2.128/25",
  },
  { label: "CAA", module: Caa, component: "CaaBuilder", type: "CAA" },
  { label: "CERT", module: Cert, component: "CertBuilder", type: "CERT" },
  {
    label: "DKIM",
    module: Dkim,
    component: "DkimBuilder",
    type: "TXT",
    name: "selector._domainkey",
    content: "v=DKIM1; k=rsa; p=MIIBIjANBg",
  },
  {
    label: "DMARC",
    module: Dmarc,
    component: "DmarcBuilder",
    type: "TXT",
    name: "_dmarc",
    content: "v=DMARC1; p=none;",
  },
  { label: "DNAME", module: Dname, component: "DnameBuilder", type: "DNAME" },
  {
    label: "DNSKEY",
    module: Dnskey,
    component: "DnskeyBuilder",
    type: "DNSKEY",
  },
  { label: "DS", module: Ds, component: "DsBuilder", type: "DS" },
  { label: "HINFO", module: Hinfo, component: "HinfoBuilder", type: "HINFO" },
  { label: "LOC", module: Loc, component: "LocBuilder", type: "LOC" },
  { label: "NAPTR", module: Naptr, component: "NaptrBuilder", type: "NAPTR" },
  {
    label: "OPENPGPKEY",
    module: Openpgpkey,
    component: "OpenpgpkeyBuilder",
    type: "OPENPGPKEY",
  },
  { label: "RP", module: Rp, component: "RpBuilder", type: "RP" },
  {
    label: "SMIMEA",
    module: Smimea,
    component: "SmimeaBuilder",
    type: "SMIMEA",
  },
  { label: "SOA", module: Soa, component: "SoaBuilder", type: "SOA" },
  {
    label: "SPF",
    module: Spf,
    component: "SpfBuilder",
    type: "TXT",
    content: "v=spf1 mx ~all",
  },
  { label: "SRV", module: Srv, component: "SrvBuilder", type: "SRV" },
  { label: "SSHFP", module: Sshfp, component: "SshfpBuilder", type: "SSHFP" },
  { label: "SVCB", module: Svcb, component: "SvcbBuilder", type: "SVCB" },
  { label: "TLSA", module: Tlsa, component: "TlsaBuilder", type: "TLSA" },
  { label: "TXT", module: Txt, component: "TxtBuilder", type: "TXT" },
  { label: "URI", module: Uri, component: "UriBuilder", type: "URI" },
];

function Harness({ testCase }: { testCase: Case }) {
  const [record, setRecord] = useState<RecordDraft>({
    type: testCase.type,
    name: testCase.name ?? "@",
    content: testCase.content ?? "",
    ttl: 3600,
  });
  const Builder = testCase.module[
    testCase.component
  ] as React.ComponentType<BuilderProps>;
  return (
    <Builder
      record={record}
      onRecordChange={setRecord}
      zoneName="example.com"
    />
  );
}

test("all 24 guided builders are covered by this contract", () => {
  assert.equal(CASES.length, 24);
  assert.equal(new Set(CASES.map((c) => c.label)).size, 24);
});

for (const testCase of CASES) {
  test(`${testCase.label} builder exports a pure describe function`, () => {
    const describers = Object.entries(testCase.module).filter(
      ([name, value]) =>
        name.startsWith("describe") && typeof value === "function",
    );
    assert.ok(
      describers.length > 0,
      `${testCase.component} must export a describe* function so its summary is testable without React`,
    );
  });

  test(`${testCase.label} builder renders the live record summary`, () => {
    render(<Harness testCase={testCase} />);
    const regions = screen.getAllByRole("region", {
      name: RECORD_SUMMARY_TITLE,
    });
    assert.equal(
      regions.length,
      1,
      `${testCase.component} must render exactly one summary`,
    );
    assert.ok(
      (regions[0]?.textContent ?? "").trim().length > 20,
      `${testCase.component} summary must not be empty`,
    );
  });

  test(`${testCase.label} builder gives every control help text`, () => {
    render(<Harness testCase={testCase} />);
    const indicators = screen.queryAllByRole("button", {
      name: /^Help for /,
    });
    assert.ok(
      indicators.length > 0,
      `${testCase.component} must expose at least one help indicator`,
    );

    for (const indicator of indicators) {
      assert.equal(indicator.tagName, "BUTTON");
      const tabIndex = indicator.getAttribute("tabindex");
      assert.ok(
        tabIndex === null || Number(tabIndex) >= 0,
        `${testCase.component} help indicators must stay in the tab order`,
      );
    }

    // Every field that names a help id must actually resolve to help text.
    const described = Array.from(
      document.querySelectorAll("[aria-describedby]"),
    ).filter((el) =>
      (el.getAttribute("aria-describedby") ?? "").includes("-help"),
    );
    assert.ok(
      described.length > 0,
      `${testCase.component} must associate help text with its controls`,
    );
    for (const el of described) {
      const id = el.getAttribute("aria-describedby") ?? "";
      const help = document.getElementById(id);
      assert.ok(help, `${testCase.component}: ${id} must exist`);
      assert.ok(
        (help.textContent ?? "").trim().length > 20,
        `${testCase.component}: ${id} must contain a real explanation`,
      );
    }
  });
}
