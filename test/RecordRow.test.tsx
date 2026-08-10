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

test("row actions stay discoverable for keyboard users", () => {
  const { container } = render(
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={sample}
      // The actions column is opt-in; the default layout reaches these actions
      // through the row context menu instead.
      columns={["type", "name", "content", "actions"]}
      isEditing={false}
      onEdit={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      onDelete={() => {}}
    />,
  );

  const trigger = container.querySelector<HTMLElement>(
    'button[aria-label="Record Actions"]',
  );
  assert.ok(trigger, "the actions trigger needs an accessible name");
  // Nothing removes it from the tab order, so it must not be invisible once
  // focused.
  assert.equal(trigger.hasAttribute("disabled"), false);
  assert.equal(trigger.getAttribute("tabindex"), null);

  const cell = trigger.closest<HTMLElement>("div.opacity-0");
  assert.ok(cell, "the actions cell is hidden until hover");
  for (const revealed of [
    "group-hover:opacity-100",
    "focus-within:opacity-100",
    "group-focus-within:opacity-100",
  ]) {
    assert.ok(
      cell.classList.contains(revealed),
      `actions cell should reveal itself via ${revealed}`,
    );
  }
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

/*
 * Inline structured content editors (SRV/TLSA/SSHFP/NAPTR).
 *
 * These record types render one input per RDATA field inside the row's content
 * cell, and the record assistant below renders its own copy of the same fields.
 * Every helper here scopes to the inline cell so the two are never confused.
 */

interface EditorHandle {
  container: HTMLElement;
  rerender: (record: DNSRecord) => void;
  getSaved: () => DNSRecord | null;
}

function renderEditor(record: DNSRecord): EditorHandle {
  let saved: DNSRecord | null = null;
  const view = (next: DNSRecord) => (
    <RecordRow
      zoneId="z"
      zoneName="example.com"
      record={next}
      isEditing={true}
      onEdit={() => {}}
      onSave={(r) => {
        saved = r as DNSRecord;
      }}
      onCancel={() => {}}
      onDelete={() => {}}
    />
  );
  const rendered = render(view(record));
  return {
    container: rendered.container,
    rerender: (next: DNSRecord) => rendered.rerender(view(next)),
    getSaved: () => saved,
  };
}

/** The row's own content cell, excluding the record assistant below it. */
function contentCell(container: HTMLElement): HTMLElement {
  const cell = container.querySelector<HTMLElement>(".col-span-4");
  assert.ok(cell, "expected the inline content cell to be rendered");
  return cell;
}

/** The row's own name input, excluding the assistant's name helpers. */
function nameInput(container: HTMLElement): HTMLInputElement {
  const cell = container.querySelector<HTMLElement>(".col-span-3");
  assert.ok(cell, "expected the inline name cell to be rendered");
  const input = cell.querySelector<HTMLInputElement>("input");
  assert.ok(input, "expected a name input");
  return input;
}

function subFieldInput(
  container: HTMLElement,
  label: string,
): HTMLInputElement {
  const matches = contentCell(container).querySelectorAll<HTMLInputElement>(
    `input[placeholder="${label}"]`,
  );
  assert.equal(matches.length, 1, `expected one inline "${label}" input`);
  return matches[0];
}

function save(container: HTMLElement): void {
  const button = Array.from(container.querySelectorAll("button")).find((node) =>
    /save/i.test(node.textContent ?? ""),
  );
  assert.ok(button, "expected a Save button");
  fireEvent.click(button);
}

interface BuilderCase {
  /** Record type under test. */
  type: string;
  name: string;
  content: string;
  /** Placeholder of the inline sub-field the test edits. */
  field: string;
  typed: string;
  /** Content the row must save after that single sub-field edit. */
  expected: string;
}

const builderCases: BuilderCase[] = [
  {
    type: "SRV",
    name: "_sip._tcp.example.com",
    content: "10 5 5060 sip.example.com",
    field: "port",
    typed: "5061",
    expected: "10 5 5061 sip.example.com",
  },
  {
    type: "TLSA",
    name: "_443._tcp.example.com",
    content: "3 1 1 abcdef",
    field: "selector",
    typed: "0",
    expected: "3 0 1 abcdef",
  },
  {
    type: "SSHFP",
    name: "ssh.example.com",
    content: "4 2 abc123",
    field: "fptype",
    typed: "1",
    expected: "4 1 abc123",
  },
  {
    type: "NAPTR",
    name: "n.example.com",
    content: '100 10 "U" "E2U+sip" "!^.*$!sip:x@example.com!" .',
    field: "order",
    typed: "200",
    expected: "200 10 U E2U+sip !^.*$!sip:x@example.com! .",
  },
];

for (const builder of builderCases) {
  const record = (): DNSRecord => ({
    ...sample,
    id: `${builder.type.toLowerCase()}-1`,
    type: builder.type,
    name: builder.name,
    content: builder.content,
  });

  test(`${builder.type}: editing one inline field saves the new value`, () => {
    const { container, getSaved } = renderEditor(record());
    fireEvent.change(subFieldInput(container, builder.field), {
      target: { value: builder.typed },
    });
    save(container);
    assert.equal(getSaved()?.content, builder.expected);
  });

  test(`${builder.type}: a name edit survives a later inline field edit`, () => {
    const { container, getSaved } = renderEditor(record());
    fireEvent.change(nameInput(container), { target: { value: "renamed" } });
    fireEvent.change(subFieldInput(container, builder.field), {
      target: { value: builder.typed },
    });
    save(container);
    assert.equal(getSaved()?.name, "renamed");
    assert.equal(getSaved()?.content, builder.expected);
  });

  test(`${builder.type}: an inline field edit survives a later name edit`, () => {
    const { container, getSaved } = renderEditor(record());
    fireEvent.change(subFieldInput(container, builder.field), {
      target: { value: builder.typed },
    });
    fireEvent.change(nameInput(container), { target: { value: "renamed" } });
    save(container);
    assert.equal(getSaved()?.name, "renamed");
    assert.equal(getSaved()?.content, builder.expected);
  });

  test(`${builder.type}: a comment edit survives a later inline field edit`, () => {
    const { container, getSaved } = renderEditor(record());
    const comment = container.querySelector("textarea");
    assert.ok(comment, "expected the comment textarea");
    fireEvent.change(comment, { target: { value: "ticket-42" } });
    fireEvent.change(subFieldInput(container, builder.field), {
      target: { value: builder.typed },
    });
    save(container);
    assert.equal(getSaved()?.comment, "ticket-42");
    assert.equal(getSaved()?.content, builder.expected);
  });
}

test("SRV: clearing one inline field leaves its siblings displayed", () => {
  const srv: DNSRecord = {
    ...sample,
    id: "srv-2",
    type: "SRV",
    name: "_sip._tcp.example.com",
    content: "10 5 5060 sip.example.com",
  };
  const { container } = renderEditor(srv);

  // A half-typed record no longer parses as four fields; the siblings must not
  // be blanked while the user is mid-edit.
  fireEvent.change(subFieldInput(container, "target"), {
    target: { value: "" },
  });
  assert.equal(subFieldInput(container, "priority").value, "10");
  assert.equal(subFieldInput(container, "weight").value, "5");
  assert.equal(subFieldInput(container, "port").value, "5060");
  assert.equal(subFieldInput(container, "target").value, "");

  fireEvent.change(subFieldInput(container, "target"), {
    target: { value: "sip2.example.com" },
  });
  assert.equal(subFieldInput(container, "port").value, "5060");
});

test("A record content edit is preserved (inline control path)", () => {
  const { container, getSaved } = renderEditor(sample);
  const content = contentCell(container).querySelector("input");
  assert.ok(content);
  fireEvent.change(content, { target: { value: "9.9.9.9" } });
  fireEvent.change(nameInput(container), { target: { value: "api" } });
  save(container);
  assert.equal(getSaved()?.content, "9.9.9.9");
  assert.equal(getSaved()?.name, "api");
});

test("an untouched row adopts a background record refresh", () => {
  const srv: DNSRecord = {
    ...sample,
    id: "srv-3",
    type: "SRV",
    name: "_sip._tcp.example.com",
    content: "10 5 5060 sip.example.com",
  };
  const { container, rerender, getSaved } = renderEditor(srv);

  // The auto-refresh poller hands back a fresh object for every record.
  rerender({ ...srv, content: "20 5 5060 sip.example.com" });
  assert.equal(subFieldInput(container, "priority").value, "20");

  save(container);
  assert.equal(getSaved()?.content, "20 5 5060 sip.example.com");
});

test("an in-flight edit outlives a background record refresh", () => {
  const srv: DNSRecord = {
    ...sample,
    id: "srv-4",
    type: "SRV",
    name: "_sip._tcp.example.com",
    content: "10 5 5060 sip.example.com",
  };
  const { container, rerender, getSaved } = renderEditor(srv);

  fireEvent.change(nameInput(container), {
    target: { value: "_sips._tcp.example.com" },
  });
  fireEvent.change(subFieldInput(container, "port"), {
    target: { value: "5061" },
  });

  // A refresh landing mid-edit is ignored: the draft the user can see is the
  // draft that gets saved, rather than being silently replaced under them.
  rerender({ ...srv, content: "10 5 5999 sip.example.com" });
  assert.equal(nameInput(container).value, "_sips._tcp.example.com");
  assert.equal(subFieldInput(container, "port").value, "5061");

  save(container);
  assert.equal(getSaved()?.name, "_sips._tcp.example.com");
  assert.equal(getSaved()?.content, "10 5 5061 sip.example.com");
});
