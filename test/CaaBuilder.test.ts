import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import {
  CaaBuilder,
  composeCAA,
  parseCAAContent,
} from "../src/components/dns/builders/CaaBuilder";
import type { RecordDraft } from "../src/components/dns/builders/types";

afterEach(() => {
  cleanup();
});

test("CAA serialization preserves quotes and backslashes through one boundary", () => {
  const logicalValue = String.raw`issuer\"quoted"\tail`;
  const serialized = composeCAA({
    flags: 0,
    tag: "issue",
    value: logicalValue,
  });

  assert.equal(serialized, String.raw`0 issue "issuer\\\"quoted\"\\tail"`);
  assert.equal(parseCAAContent(serialized).value, logicalValue);
});

test("CAA serialization safely represents control characters", () => {
  const logicalValue = "line1\nline2\r\u0000\u007f";
  const serialized = composeCAA({
    flags: 0,
    tag: "iodef",
    value: logicalValue,
  });

  assert.equal(serialized, String.raw`0 iodef "line1\010line2\013\000\127"`);
  assert.equal(serialized.includes("\n"), false);
  assert.equal(serialized.includes("\r"), false);
  assert.equal(parseCAAContent(serialized).value, logicalValue);
});

test("CAA serialization preserves spacing and numeric-looking backslashes", () => {
  assert.equal(
    composeCAA({ flags: 0, tag: "issue", value: "issuer  account=123" }),
    '0 issue "issuer  account=123"',
  );

  const logicalValue = String.raw`\010`;
  const serialized = composeCAA({
    flags: 0,
    tag: "issue",
    value: logicalValue,
  });
  assert.equal(serialized, String.raw`0 issue "\\010"`);
  assert.equal(parseCAAContent(serialized).value, logicalValue);
  assert.equal(parseCAAContent(String.raw`0 issue "\010"`).value, "\n");
});

test("CAA builder UI applies the single canonical serialization boundary", async () => {
  const logicalValue = String.raw`issuer\"quoted"\tail`;
  const content = composeCAA({
    flags: 0,
    tag: "issue",
    value: logicalValue,
  });
  const record: RecordDraft = { type: "CAA", name: "@", content };
  let changed: RecordDraft | undefined;

  await act(async () => {
    render(
      React.createElement(CaaBuilder, {
        record,
        zoneName: "example.com",
        onRecordChange: (next: RecordDraft) => {
          changed = next;
        },
      }),
    );
  });

  assert.ok(screen.getByDisplayValue(logicalValue));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Apply canonical to content" }),
    );
  });
  assert.equal(changed?.content, content);
});
