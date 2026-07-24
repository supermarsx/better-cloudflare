import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

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

afterEach(() => {
  cleanup();
});

test("RecordRow renders display mode when not editing", () => {
  render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={sample}
      isEditing={false}
      onEdit={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );
  const rowText = screen.getByText("www");
  assert.ok(rowText);
});

test("RecordRow edit flow calls onSave with updated record", async () => {
  let saved: DNSRecord | null = null;
  render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={sample}
      isEditing={true}
      onEdit={() => {}}
      onSave={(r) => {
        saved = r;
      }}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );
  const nameInput = screen.getByDisplayValue("www");
  fireEvent.change(nameInput, { target: { value: "changed" } });
  const saveButton = screen.getByRole("button", { name: /save/i });
  fireEvent.click(saveButton);
  assert.equal(saved?.name, "changed");
});
