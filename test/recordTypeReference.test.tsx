/**
 * The in-app record type reference.
 *
 * The reference is a teaching surface, so the tests that matter are the ones
 * that stop it drifting: every type must appear, every format and example it
 * prints must be byte-identical to `builders/record-formats.ts`, and the split
 * between types the Add Record dialog offers by default and types that need
 * "show unsupported" must be visible rather than implied.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { RecordTypeReference } from "../src/components/docs/RecordTypeReference";
import {
  availabilityOf,
  buildRecordReference,
  filterRecordReference,
} from "../src/components/docs/record-reference";
import {
  RECORD_DOCS,
  RECORD_FORMATS,
  RECORD_FORMAT_OMISSIONS,
} from "../src/components/dns/builders/record-formats";
import {
  CLOUDFLARE_SUPPORTED_RECORD_TYPES,
  RECORD_TYPES,
  type RecordType,
} from "../src/types/dns";

afterEach(() => cleanup());

async function renderReference(initialType: RecordType | "" = "") {
  await act(async () => {
    render(<RecordTypeReference initialType={initialType} />);
  });
}

/** Every rendered entry card, keyed by the type it documents. */
function renderedEntries(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const node of screen.queryAllByTestId("record-reference-entry")) {
    const type = node.getAttribute("data-record-type");
    if (type) map.set(type, node);
  }
  return map;
}

function searchBox(): HTMLInputElement {
  return screen.getByRole("searchbox") as HTMLInputElement;
}

async function search(term: string) {
  await act(async () => {
    fireEvent.change(searchBox(), { target: { value: term } });
  });
}

/** Collapse whitespace so assertions do not depend on JSX line breaks. */
function text(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/gu, " ").trim();
}

test("the reference renders one entry for every supported record type", async () => {
  await renderReference();

  const entries = renderedEntries();
  assert.equal(entries.size, RECORD_TYPES.length);
  assert.deepEqual(
    [...entries.keys()].sort(),
    [...RECORD_TYPES].sort(),
    "every type in RECORD_TYPES must have a card",
  );
});

test("every entry explains what the record is for", async () => {
  await renderReference();

  for (const [type, node] of renderedEntries()) {
    const purpose = RECORD_DOCS[type as RecordType].purpose;
    assert.ok(purpose.length > 40, `${type} purpose is too thin to be useful`);
    assert.ok(
      text(node).includes(purpose.replace(/\s+/gu, " ")),
      `${type} card must show its purpose`,
    );
  }
});

test("every rendered format and example is exactly what record-formats.ts holds", async () => {
  await renderReference();

  const entries = renderedEntries();
  for (const [type, entry] of Object.entries(RECORD_FORMATS)) {
    assert.ok(entry, `${type} format entry missing`);
    const node = entries.get(type);
    assert.ok(node, `${type} must be rendered`);
    const rendered = text(node);
    // Byte-identical: the reference must never paraphrase the example that the
    // Add Record dialog puts in front of the user.
    assert.ok(
      rendered.includes(entry.format.replace(/\s+/gu, " ")),
      `${type} must render its exact format string`,
    );
    assert.ok(
      rendered.includes(entry.example.replace(/\s+/gu, " ")),
      `${type} must render its exact example`,
    );
  }
});

test("types with no stated format show the recorded reason instead of a guess", async () => {
  await renderReference();

  const entries = renderedEntries();
  const omitted = Object.keys(RECORD_FORMAT_OMISSIONS);
  assert.ok(omitted.length > 0, "the omission list is the point of this test");

  for (const type of omitted) {
    const node = entries.get(type);
    assert.ok(node, `${type} must still be listed`);
    const reason = RECORD_FORMAT_OMISSIONS[type as RecordType] ?? "";
    assert.ok(
      text(node).includes(reason.replace(/\s+/gu, " ")),
      `${type} must state why it has no example`,
    );
  }

  // And exactly those cards carry the "no example" block: no other type is
  // silently left without one.
  const omissionBlocks = screen.queryAllByTestId("record-reference-omission");
  assert.equal(omissionBlocks.length, omitted.length);
});

test("the default-versus-opt-in split is marked on every entry and explained once", async () => {
  await renderReference();

  const defaults = new Set<string>(CLOUDFLARE_SUPPORTED_RECORD_TYPES);
  for (const [type, node] of renderedEntries()) {
    const marked = node.getAttribute("data-availability");
    assert.equal(
      marked,
      defaults.has(type) ? "default" : "opt-in",
      `${type} availability marker`,
    );
    // The marker is not attribute-only: each card carries a visible badge.
    const badge = node.querySelector(
      '[data-testid="record-reference-availability"]',
    );
    assert.ok(badge, `${type} needs a visible availability badge`);
    assert.ok(text(badge).length > 0, `${type} badge must not be empty`);
  }

  const defaultBadges = screen
    .getAllByTestId("record-reference-entry")
    .filter((node) => node.getAttribute("data-availability") === "default");
  assert.equal(defaultBadges.length, CLOUDFLARE_SUPPORTED_RECORD_TYPES.length);

  // The legend names both states, so an opt-in badge is never a dead end.
  const body = text(document.body);
  assert.match(body, /by default/i);
  // Named exactly as the toggle is named, so the pointer is followable.
  assert.match(body, /Unsupported record types/i);
});

test("search narrows by type code, by purpose and by example content", async () => {
  await renderReference();

  await search("CAA");
  let shown = [...renderedEntries().keys()];
  assert.ok(shown.includes("CAA"));
  assert.ok(shown.length < RECORD_TYPES.length, "search must narrow the list");

  // A word from the prose, not from the type code.
  await search("reverse");
  shown = [...renderedEntries().keys()];
  assert.ok(shown.includes("PTR"), "PTR is the reverse-lookup record");

  // A fragment of a worked example.
  await search("v=spf1");
  shown = [...renderedEntries().keys()];
  assert.deepEqual(shown.sort(), ["SPF", "TXT"]);

  // Clearing restores everything.
  await search("");
  assert.equal(renderedEntries().size, RECORD_TYPES.length);
});

test("search is case-insensitive, conjunctive, and reports finding nothing", async () => {
  await renderReference();

  // "validity" alone also matches nothing else, but the pair is the point:
  // both terms have to land on the same entry.
  await search("validity window");
  const shown = [...renderedEntries().keys()];
  assert.deepEqual(shown, ["RRSIG"], "both terms must match the same entry");

  await search("mx");
  assert.ok([...renderedEntries().keys()].includes("MX"));

  await search("zzz-not-a-record");
  assert.equal(renderedEntries().size, 0);
  assert.ok(screen.getByTestId("record-reference-empty"));
});

test("opening the reference at a type highlights that entry without filtering", async () => {
  await renderReference("CAA");

  const entries = renderedEntries();
  assert.equal(
    entries.size,
    RECORD_TYPES.length,
    "a deep link must not hide the other types",
  );

  const highlighted = screen
    .getAllByTestId("record-reference-entry")
    .filter((node) => node.hasAttribute("data-highlighted"));
  assert.equal(highlighted.length, 1);
  assert.equal(highlighted[0].getAttribute("data-record-type"), "CAA");
});

test("standard types link to an rfc-editor.org reference; provider types say they have none", async () => {
  await renderReference();

  for (const type of RECORD_TYPES) {
    const refs = RECORD_DOCS[type].rfcs;
    if (type === "ALIAS" || type === "ANAME") {
      assert.deepEqual(
        refs,
        [],
        `${type} is provider-specific, not an RFC type`,
      );
      continue;
    }
    assert.ok(refs.length > 0, `${type} must cite at least one RFC`);
    for (const ref of refs) {
      assert.match(ref.url, /^https:\/\/www\.rfc-editor\.org\/rfc\/rfc\d+/u);
      assert.match(ref.label, /^RFC \d+$/u);
      if (ref.section) assert.ok(ref.url.endsWith(`#section-${ref.section}`));
    }
  }

  const aliasCard = renderedEntries().get("ALIAS");
  assert.ok(aliasCard);
  assert.match(text(aliasCard), /no RFC defines it/i);

  // RFC links are buttons, not bare anchors: the desktop build has to route
  // external navigation through the shell opener.
  assert.equal(document.querySelectorAll("a[href^='http']").length, 0);
});

test("buildRecordReference reads its content from the shared tables", () => {
  const entries = buildRecordReference();
  assert.equal(entries.length, RECORD_TYPES.length);

  for (const entry of entries) {
    const format = RECORD_FORMATS[entry.type];
    assert.equal(entry.format, format?.format);
    assert.equal(entry.example, format?.example);
    assert.equal(entry.purpose, RECORD_DOCS[entry.type].purpose);
    assert.equal(
      entry.offeredByDefault,
      CLOUDFLARE_SUPPORTED_RECORD_TYPES.includes(entry.type),
    );
    assert.equal(
      availabilityOf(entry),
      entry.offeredByDefault ? "default" : "opt-in",
    );
    // A type either has both a format and an example, or a stated reason.
    if (!entry.format) {
      assert.ok(entry.omissionReason, `${entry.type} needs a stated reason`);
    }
  }
});

test("filterRecordReference matches every term and matches nothing on nonsense", () => {
  const entries = buildRecordReference();

  assert.equal(filterRecordReference(entries, "   ").length, entries.length);
  assert.deepEqual(
    filterRecordReference(entries, "rfc 2782").map((entry) => entry.type),
    ["SRV"],
  );
  // Whitespace-insensitive RFC search: "rfc2782" finds it too.
  assert.deepEqual(
    filterRecordReference(entries, "rfc2782").map((entry) => entry.type),
    ["SRV"],
  );
  assert.deepEqual(filterRecordReference(entries, "srv mx"), []);
  // A blank query is "show me everything", not "show me nothing".
  assert.equal(filterRecordReference(entries, "").length, entries.length);
});

test("DNSManager exposes the reference as a zone view", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/components/dns/DNSManager.tsx"),
    "utf8",
  );
  // Wired as a real ACTION_TABS entry so it inherits the tablist's roving
  // focus rather than inventing its own navigation.
  assert.match(source, /id: "reference",\s*\n\s*label: "Reference",/u);
  assert.match(source, /actionTab === "reference"/u);
  assert.match(source, /<RecordTypeReference initialType=/u);
});
