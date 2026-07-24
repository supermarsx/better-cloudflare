import assert from "node:assert/strict";
import React from "react";
import { test, afterEach } from "node:test";
import { act, render, screen, cleanup } from "@testing-library/react";

import { AddRecordDialog } from "../src/components/dns/AddRecordDialog";

const noop = () => {};

afterEach(() => {
  cleanup();
});

test("AddRecordDialog renders TLSA fields", async () => {
  const record = { type: "TLSA", name: "test", content: "1 2 3 abc" };
  await act(async () => {
    render(
      <AddRecordDialog
        open={true}
        onOpenChange={noop}
        record={record}
        onRecordChange={noop}
        onAdd={noop}
        zoneName="example.com"
      />,
    );
  });

  const nameInput = screen.getByRole("textbox", { name: /Name/i });
  const tlsaDataField = screen.getByPlaceholderText(/hex/i);
  assert.ok(nameInput !== null);
  assert.ok(tlsaDataField !== null);
});
