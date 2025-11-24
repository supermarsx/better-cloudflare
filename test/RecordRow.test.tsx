import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { test } from "node:test";

import { RecordRow } from "../src/components/dns/RecordRow";
import type { DNSRecord } from "../src/types/dns";

const sample: DNSRecord = {
  id: "1",
  type: "A",
  name: "www",
  content: "1.2.3.4",
  ttl: 300,
  zone_id: "z",
  zone_name: "example.com",
  created_on: "",
  modified_on: "",
};

test("RecordRow renders display mode when not editing", () => {
  const tree = create(
    React.createElement(RecordRow, {
      record: sample,
      isEditing: false,
      onEdit: () => {},
      onSave: () => {},
      onCancel: () => {},
      onDelete: () => {},
    }),
  );
  const root = tree.root;
  // display mode should contain the record name
  const text = root
    .findAllByType("div")
    .map((n) =>
      n.children && typeof n.children[0] === "string"
        ? (n.children[0] as string)
        : null,
    )
    .filter(Boolean);
  assert.ok(text.length > 0);
});

test("RecordRow edit flow calls onSave with updated record", () => {
  let saved: DNSRecord | null = null;
  const onSave = (r: DNSRecord) => {
    saved = r;
  };
  const tree = create(
    React.createElement(RecordRow, {
      record: sample,
      isEditing: true,
      onEdit: () => {},
      onSave,
      onCancel: () => {},
      onDelete: () => {},
    }),
  );
  const root = tree.root;
  const inputs = root.findAllByType("input");
  // change name input (second input in form) if present
  if (inputs.length > 1) {
    act(() => inputs[1].props.onChange({ target: { value: "changed" } }));
    // click the save button (first button in edit view)
    const btns = root.findAllByType("button");
    assert.ok(btns.length >= 1, "expected at least one button");
    act(() => (btns[0].props.onClick as () => void)());
    assert.equal(saved?.name, "changed");
  } else {
    // ensure test is not silently passing
    assert.fail("editable inputs not found in RecordRow edit mode");
  }
});
