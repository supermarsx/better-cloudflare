import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { RecordRow } from "../src/components/dns/RecordRow";
import { TagChip } from "../src/components/tags/TagChip";
import { TagColorPicker } from "../src/components/tags/TagColorPicker";
import { TAG_COLOR_IDS } from "../src/components/tags/tag-colors";
import { storageManager } from "../src/lib/storage/storage";
import type { DNSRecord } from "../src/types/dns";

afterEach(() => {
  cleanup();
  storageManager.clearRecordTags(ZONE, RECORD.id);
  for (const tag of storageManager.getZoneTags(ZONE))
    storageManager.deleteTag(ZONE, tag);
});

const ZONE = "zone-1";

const RECORD: DNSRecord = {
  id: "rec-1",
  type: "A",
  name: "www",
  content: "203.0.113.10",
  ttl: 300,
  zone_id: ZONE,
  zone_name: "example.test",
  created_on: "",
  modified_on: "",
};

/**
 * The `.ui-tag` declarations the table chip has to undercut, read from the real
 * stylesheet rather than restated here -- if the base chip is restyled, this
 * test is what notices that "smaller in the table" stopped being true.
 */
function baseTagRule(): { fontSizePx: number; padding: string; raw: string } {
  const css = readFileSync(
    new URL("../src/index.css", import.meta.url),
    "utf8",
  );
  const match = /\n\s*\.ui-tag\s*\{([^}]*)\}/.exec(css);
  assert.ok(match, "src/index.css must still define a `.ui-tag` rule");
  const body = match[1];
  const fontSize = /font-size:\s*([\d.]+)rem/.exec(body);
  const padding = /padding:\s*([^;]+);/.exec(body);
  assert.ok(fontSize, "`.ui-tag` must declare a rem font-size");
  assert.ok(padding, "`.ui-tag` must declare a padding");
  return {
    fontSizePx: Number(fontSize[1]) * 16,
    padding: padding[1].trim(),
    raw: body,
  };
}

test("the table chip is smaller than the `.ui-tag` it overrides", () => {
  const base = baseTagRule();
  render(
    <>
      <TagChip colorId="blue">manager</TagChip>
      <TagChip colorId="blue" size="table">
        table
      </TagChip>
    </>,
  );

  const managed = screen.getByText("manager");
  const tabled = screen.getByText("table");

  // The manager chip sets no metrics at all, so it keeps the shipped size.
  assert.equal(managed.getAttribute("data-tag-size"), "default");
  assert.equal(managed.style.fontSize, "");
  assert.equal(managed.style.padding, "");

  assert.equal(tabled.getAttribute("data-tag-size"), "table");
  const tableFontPx = Number(/^([\d.]+)px$/.exec(tabled.style.fontSize)?.[1]);
  assert.ok(
    Number.isFinite(tableFontPx),
    `table chip must set a px font-size, got ${tabled.style.fontSize}`,
  );
  assert.ok(
    tableFontPx < base.fontSizePx,
    `table chip font ${tableFontPx}px must be under the base ${base.fontSizePx}px`,
  );

  const [tableY, tableX] = tabled.style.padding
    .split(/\s+/)
    .map((part) => Number(/^([\d.]+)px$/.exec(part)?.[1]));
  const [baseY, baseX] = base.padding
    .split(/\s+/)
    .map((part) => Number(/^([\d.]+)rem$/.exec(part)?.[1]) * 16);
  assert.ok(
    tableY < baseY && tableX < baseX,
    `table padding ${tableY}/${tableX}px must be under the base ${baseY}/${baseX}px`,
  );
});

test("the base `.ui-tag` size stays overridable from an inline style", () => {
  // This is the whole reason the metrics are inline styles: `.ui-tag` is emitted
  // after Tailwind's utilities in the same cascade layer, so only an inline
  // style (or an `!important` rule) can shrink it. An `!important` added to
  // `.ui-tag` would silently undo the table sizing, so pin that here.
  const base = baseTagRule();
  assert.ok(
    !/font-size:[^;]*!important/.test(base.raw),
    "`.ui-tag` font-size must stay overridable by an inline style",
  );
  assert.ok(
    !/padding:[^;]*!important/.test(base.raw),
    "`.ui-tag` padding must stay overridable by an inline style",
  );
});

test("a chip carries its resolved colour id onto the DOM", () => {
  render(
    <>
      {TAG_COLOR_IDS.map((id) => (
        <TagChip key={id} colorId={id}>
          {id}
        </TagChip>
      ))}
    </>,
  );
  for (const id of TAG_COLOR_IDS)
    assert.equal(screen.getByText(id).getAttribute("data-tag-color"), id);
});

test("the colour picker marks the current colour and reports the next one", () => {
  const picked: string[] = [];
  const { container } = render(
    <TagColorPicker
      value="blue"
      tagName="prod"
      onChange={(next) => picked.push(next)}
    />,
  );

  const swatches = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-tag-color-option]"),
  );
  assert.equal(swatches.length, TAG_COLOR_IDS.length);
  // Selection is announced, and shown by an outline rather than by colour alone.
  const selected = swatches.filter(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
  assert.deepEqual(
    selected.map((button) => button.getAttribute("data-tag-color-option")),
    ["blue"],
  );
  assert.ok(selected[0]?.style.outline.includes("hsl(var(--foreground))"));
  for (const button of swatches) {
    assert.ok((button.getAttribute("aria-label") ?? "").length > 0);
    assert.ok((button.getAttribute("title") ?? "").length > 0);
  }

  const green = container.querySelector<HTMLButtonElement>(
    '[data-tag-color-option="green"]',
  );
  assert.ok(green);
  fireEvent.click(green);
  assert.deepEqual(picked, ["green"]);
});

test("a record row renders its tags at table size, in their stored colours", () => {
  storageManager.addZoneTag(ZONE, "prod", "green");
  storageManager.setRecordTags(ZONE, RECORD.id, ["prod", "uncoloured"]);

  const { container } = render(
    <RecordRow
      zoneId={ZONE}
      zoneName="example.test"
      record={RECORD}
      columns={["type", "name", "content", "tags"]}
      isEditing={false}
      onEdit={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );

  const chips = Array.from(
    container.querySelectorAll<HTMLElement>("[data-tag-size]"),
  );
  assert.deepEqual(
    chips.map((chip) => chip.textContent),
    ["prod", "uncoloured"],
  );
  for (const chip of chips)
    assert.equal(chip.getAttribute("data-tag-size"), "table");
  assert.equal(chips[0]?.getAttribute("data-tag-color"), "green");
  // A tag with no stored colour still renders -- in the default colour.
  assert.equal(chips[1]?.getAttribute("data-tag-color"), "slate");
});

test("a row picks up a recolour dispatched while it is mounted", async () => {
  storageManager.addZoneTag(ZONE, "prod", "green");
  storageManager.setRecordTags(ZONE, RECORD.id, ["prod"]);

  const { container } = render(
    <RecordRow
      zoneId={ZONE}
      zoneName="example.test"
      record={RECORD}
      columns={["type", "name", "content", "tags"]}
      isEditing={false}
      onEdit={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );
  assert.equal(
    container.querySelector("[data-tag-size]")?.getAttribute("data-tag-color"),
    "green",
  );

  // The Tag manager recolours by writing the colour and letting
  // `StorageManager.dispatchRecordTagsChanged` announce it. The write is done
  // directly and the event raised by hand because this harness cannot carry the
  // real one: `node-test-env.ts` wraps `window.dispatchEvent` in a try/catch
  // that swallows failures, and jsdom rejects the Node-global `CustomEvent` the
  // storage layer constructs. So the payload below is the one a browser
  // delivers, built with jsdom's own constructor.
  storageManager.setTagColor(ZONE, "prod", "violet");
  const jsdomWindow = window as unknown as { CustomEvent: typeof CustomEvent };
  await act(async () => {
    window.dispatchEvent(
      new jsdomWindow.CustomEvent("record-tags-changed", {
        detail: { zoneId: ZONE, recordId: undefined },
      }),
    );
  });

  assert.equal(
    container.querySelector("[data-tag-size]")?.getAttribute("data-tag-color"),
    "violet",
  );
});
