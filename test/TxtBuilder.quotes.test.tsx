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

import { TxtBuilder } from "../src/components/dns/builders/TxtBuilder";
import type { RecordDraft } from "../src/components/dns/builders/types";

afterEach(() => {
  cleanup();
});

const SPF = "v=spf1 include:_spf.example.com ~all";

async function renderTxtBuilder(content: string) {
  const changes: RecordDraft[] = [];
  const record: RecordDraft = { type: "TXT", name: "@", content };
  await act(async () => {
    render(
      React.createElement(TxtBuilder, {
        record,
        zoneName: "example.com",
        onRecordChange: (next: RecordDraft) => changes.push(next),
      }),
    );
  });
  return {
    changes,
    textarea: screen.getByRole("textbox", {
      name: "TXT content",
    }) as HTMLTextAreaElement,
    normalizeButton: screen.getByRole("button", { name: "Normalize quotes" }),
  };
}

test("leaving the TXT field balances and quotes the content", async () => {
  const { changes, textarea } = await renderTxtBuilder(SPF);

  await act(async () => {
    fireEvent.blur(textarea);
  });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].content, `"${SPF}"`);
});

test("leaving the TXT field repairs an unmatched quote", async () => {
  const { changes, textarea } = await renderTxtBuilder(`"${SPF}`);

  await act(async () => {
    fireEvent.blur(textarea);
  });

  assert.equal(changes[0]?.content, `"${SPF}"`);
});

test("already quoted content is left alone and the action is disabled", async () => {
  const { changes, textarea, normalizeButton } = await renderTxtBuilder(
    `"${SPF}"`,
  );

  assert.equal((normalizeButton as HTMLButtonElement).disabled, true);
  await act(async () => {
    fireEvent.blur(textarea);
  });
  assert.equal(changes.length, 0);
});

test("the normalize action splits content longer than 255 bytes", async () => {
  const value = "x".repeat(300);
  const { changes, normalizeButton } = await renderTxtBuilder(value);

  assert.equal((normalizeButton as HTMLButtonElement).disabled, false);
  await act(async () => {
    fireEvent.click(normalizeButton);
  });

  assert.equal(changes[0]?.content, `"${"x".repeat(255)}" "${"x".repeat(45)}"`);
  assert.ok(screen.getByText(/300 bytes are split into 2 strings/));
});

test("quoted content is still auto-detected as SPF", async () => {
  await renderTxtBuilder(`"${SPF}"`);
  assert.ok(screen.getByText("SPF builder"));
});

test("quoted content is still auto-detected as DMARC", async () => {
  await renderTxtBuilder('"v=DMARC1; p=none; rua=mailto:dmarc@example.com;"');
  assert.ok(screen.getByText("DMARC builder"));
});

test("multi-string content is auto-detected as DKIM", async () => {
  await renderTxtBuilder('"v=DKIM1; k=rsa; " "p=AAAA;"');
  assert.ok(screen.getByText("DKIM builder"));
});
