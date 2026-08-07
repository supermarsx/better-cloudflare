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

const originalWindowOpen = window.open;

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
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

test("Ctrl/Meta click and Ctrl/Meta+Enter open the record owner without editing", () => {
  const opened: string[] = [];
  let edits = 0;
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;

  render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={sample}
      isEditing={false}
      onEdit={() => {
        edits += 1;
      }}
      onSave={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );

  const name = screen.getByText("www");
  const row = name.closest('[role="button"]');
  assert.ok(row);

  fireEvent.click(name, { button: 0, ctrlKey: true });
  fireEvent.click(name, { button: 0, metaKey: true });
  fireEvent.keyDown(row, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(row, { key: "Enter", metaKey: true });

  assert.deepEqual(opened, [
    "https://www.example.com/",
    "https://www.example.com/",
    "https://www.example.com/",
    "https://www.example.com/",
  ]);
  assert.equal(edits, 0);
});

test("ordinary edit and selection controls remain isolated from browser opening", () => {
  const opened: string[] = [];
  let edits = 0;
  let selected = false;
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;

  render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={sample}
      isEditing={false}
      onEdit={() => {
        edits += 1;
      }}
      onSave={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
      onSelectChange={(next) => {
        selected = next;
      }}
    />,
  );

  const name = screen.getByText("www");
  const row = name.closest('[role="button"]');
  assert.ok(row);
  fireEvent.click(name);
  fireEvent.doubleClick(row);
  fireEvent.click(screen.getByLabelText("Select record"), {
    button: 0,
    ctrlKey: true,
  });

  assert.equal(edits, 1);
  assert.equal(selected, true);
  assert.deepEqual(opened, []);
});

test("RecordRow normalizes character-string content on save", () => {
  const txtRecord: DNSRecord = {
    ...sample,
    id: "txt-1",
    type: "TXT",
    name: "_dmarc",
    content: 'v=DMARC1; p=none"',
  };
  let saved: DNSRecord | null = null;
  render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={txtRecord}
      isEditing={true}
      onEdit={() => {}}
      onSave={(r) => {
        saved = r as DNSRecord;
      }}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  // The unmatched quote is repaired into a valid quoted <character-string>.
  assert.equal(saved?.content, '"v=DMARC1; p=none"');
});

test("RecordRow leaves non character-string content untouched on save", () => {
  let saved: DNSRecord | null = null;
  render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={{ ...sample, type: "CNAME", content: "edge.example.com" }}
      isEditing={true}
      onEdit={() => {}}
      onSave={(r) => {
        saved = r as DNSRecord;
      }}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /save/i }));
  assert.equal(saved?.content, "edge.example.com");
});
