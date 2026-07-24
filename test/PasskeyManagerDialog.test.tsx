import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

import PasskeyManagerDialog from "../src/components/auth/PasskeyManagerDialog";
import { ServerClient } from "../src/lib/api/server-client";

const originalList = ServerClient.prototype.listPasskeys;
const originalDelete = ServerClient.prototype.deletePasskey;

afterEach(() => {
  ServerClient.prototype.listPasskeys = originalList;
  ServerClient.prototype.deletePasskey = originalDelete;
  cleanup();
});

test("PasskeyManagerDialog renders empty state", async () => {
  ServerClient.prototype.listPasskeys = async () => [];
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
    />,
  );
  await waitFor(() => assert.ok(screen.getByText(/No passkeys registered/i)));
});

test("PasskeyManagerDialog lists passkeys", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", counter: 1, label: "cred1" },
    { id: "cred2", counter: 2, label: "cred2" },
  ];
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
    />,
  );
  await waitFor(() => {
    assert.ok(screen.getByText("cred1"));
    assert.ok(screen.getByText("cred2"));
  });
});

test("PasskeyManagerDialog revokes passkeys", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", counter: 1, label: "cred1" },
  ];
  let deleted: string | null = null;
  ServerClient.prototype.deletePasskey = async (_id, cid) => {
    deleted = cid;
  };
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
    />,
  );
  await waitFor(() => assert.ok(screen.getByText("cred1")));
  const revoke = screen.getByRole("button", { name: /revoke/i });
  fireEvent.click(revoke);
  await waitFor(() => assert.equal(deleted, "cred1"));
});

test("PasskeyManagerDialog handles list error", async () => {
  ServerClient.prototype.listPasskeys = async () => {
    throw new Error("fail");
  };
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
    />,
  );
  await waitFor(() => assert.ok(screen.getByText(/No passkeys registered/i)));
});
