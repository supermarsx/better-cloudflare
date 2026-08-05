import assert from "node:assert/strict";
import React from "react";
import { test, afterEach } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { AddRecordDialog } from "../src/components/dns/AddRecordDialog";
import type { DNSRecord } from "../src/types/dns";

const noop = () => {};

afterEach(() => {
  cleanup();
});

const validRecord = {
  type: "A" as const,
  name: "www.example.com",
  content: "1.1.1.1",
  ttl: 300,
};

test("AddRecordDialog preserves a prefilled DMARC draft when opening", async () => {
  const expectedContent =
    "v=DMARC1; p=none; rua=mailto:postmaster@example.com; fo=1";
  const initialRecord: Partial<DNSRecord> = {
    type: "TXT",
    name: "_dmarc.example.com",
    content: expectedContent,
    ttl: 3600,
    proxied: false,
  };
  let latestRecord = initialRecord;

  function Harness() {
    const [open, setOpen] = React.useState(false);
    const [record, setRecord] =
      React.useState<Partial<DNSRecord>>(initialRecord);
    return (
      <AddRecordDialog
        open={open}
        onOpenChange={setOpen}
        record={record}
        onRecordChange={(next) => {
          latestRecord = next;
          setRecord(next);
        }}
        onAdd={noop}
        zoneName="example.com"
      />
    );
  }

  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add Record" }));

  const dialog = await screen.findByRole("dialog", { name: "Add DNS Record" });
  const nameInput = dialog.querySelector<HTMLInputElement>(
    'input[placeholder="e.g., www or @ for root"]',
  );
  assert.ok(nameInput);
  assert.equal(nameInput.value, initialRecord.name);
  assert.equal(
    (
      screen.getByRole("textbox", {
        name: "TXT content",
      }) as HTMLTextAreaElement
    ).value,
    expectedContent,
  );
  assert.ok(dialog);
  assert.equal(latestRecord.type, "TXT");
  assert.equal(latestRecord.name, initialRecord.name);
  assert.equal(latestRecord.content, expectedContent);
  assert.equal(latestRecord.ttl, 3600);
});

test("AddRecordDialog keeps record creation single-flight and resets after resolution", async () => {
  let calls = 0;
  let resolveSubmission!: () => void;
  const submission = new Promise<void>((resolve) => {
    resolveSubmission = resolve;
  });

  await act(async () => {
    render(
      <AddRecordDialog
        open={true}
        onOpenChange={noop}
        record={validRecord}
        onRecordChange={noop}
        onAdd={() => {
          calls += 1;
          return submission;
        }}
        zoneName="example.com"
      />,
    );
  });

  const create = screen.getByRole("button", { name: "Create Record" });
  fireEvent.click(create);
  fireEvent.click(create);

  assert.equal(calls, 1);
  const pending = screen.getByRole("button", {
    name: "Creating DNS record...",
  });
  assert.equal((pending as HTMLButtonElement).disabled, true);
  assert.equal(pending.getAttribute("aria-busy"), "true");

  await act(async () => {
    resolveSubmission();
    await submission;
  });

  await waitFor(() => {
    const reset = screen.getByRole("button", { name: "Create Record" });
    assert.equal((reset as HTMLButtonElement).disabled, false);
    assert.equal(reset.getAttribute("aria-busy"), "false");
  });

  fireEvent.click(screen.getByRole("button", { name: "Create Record" }));
  assert.equal(calls, 2);
});

test("AddRecordDialog preserves the parent-controlled draft and resets after rejection", async () => {
  let calls = 0;
  let rejectSubmission!: (error: Error) => void;
  const rejectedSubmission = new Promise<void>((_resolve, reject) => {
    rejectSubmission = reject;
  });

  await act(async () => {
    render(
      <AddRecordDialog
        open={true}
        onOpenChange={noop}
        record={validRecord}
        onRecordChange={noop}
        onAdd={() => {
          calls += 1;
          return calls === 1 ? rejectedSubmission : Promise.resolve();
        }}
        zoneName="example.com"
      />,
    );
  });

  fireEvent.click(screen.getByRole("button", { name: "Create Record" }));
  assert.equal(calls, 1);

  await act(async () => {
    rejectSubmission(new Error("provider rejected the record"));
    await rejectedSubmission.catch(() => undefined);
  });

  await waitFor(() => {
    assert.ok(screen.getByRole("dialog"));
    const reset = screen.getByRole("button", { name: "Create Record" });
    assert.equal((reset as HTMLButtonElement).disabled, false);
    assert.equal(
      (screen.getByRole("textbox", { name: /Name/i }) as HTMLInputElement)
        .value,
      validRecord.name,
    );
  });

  fireEvent.click(screen.getByRole("button", { name: "Create Record" }));
  await waitFor(() => assert.equal(calls, 2));
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
