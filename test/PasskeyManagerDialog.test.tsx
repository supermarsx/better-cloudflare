import assert from "node:assert/strict";
import React from "react";
import { test, afterEach } from "node:test";
import { act, create } from "react-test-renderer";

import PasskeyManagerDialog from "../src/components/auth/PasskeyManagerDialog";
import { ServerClient } from "../src/lib/server-client";

const originalList = ServerClient.prototype.listPasskeys;
const originalDelete = ServerClient.prototype.deletePasskey;
const originalConsoleWarn = console.warn;

afterEach(() => {
  ServerClient.prototype.listPasskeys = originalList;
  ServerClient.prototype.deletePasskey = originalDelete;
  console.warn = originalConsoleWarn;
});

test("PasskeyManagerDialog renders empty state", async () => {
  ServerClient.prototype.listPasskeys = async () => [];
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(PasskeyManagerDialog, {
        open: true,
        onOpenChange: () => {},
        id: "key",
        apiKey: "token",
      }),
    );
  });
  const json = JSON.stringify(renderer!.toJSON());
  assert.match(json, /No passkeys registered/i);
  ServerClient.prototype.listPasskeys = originalList;
});

test("PasskeyManagerDialog lists passkeys", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", counter: 1 },
    { id: "cred2", counter: 2 },
  ];
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(PasskeyManagerDialog, {
        open: true,
        onOpenChange: () => {},
        id: "key",
        apiKey: "token",
      }),
    );
  });
  const json = JSON.stringify(renderer!.toJSON());
  assert.match(json, /cred1/);
  assert.match(json, /cred2/);
  ServerClient.prototype.listPasskeys = originalList;
});

test("PasskeyManagerDialog revokes passkeys", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", counter: 1 },
  ];
  let deleted: string | null = null;
  ServerClient.prototype.deletePasskey = async (_id, cid) => {
    deleted = cid;
  };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(PasskeyManagerDialog, {
        open: true,
        onOpenChange: () => {},
        id: "key",
        apiKey: "token",
      }),
    );
  });
  const buttons = renderer!.root.findAllByType("button");
  const revoke = buttons.find((b) =>
    String(b.children).toLowerCase().includes("revoke"),
  );
  assert.ok(revoke);
  await act(async () => {
    revoke!.props.onClick();
  });
  assert.equal(deleted, "cred1");
  ServerClient.prototype.listPasskeys = originalList;
});

test("PasskeyManagerDialog handles list error", async () => {
  ServerClient.prototype.listPasskeys = async () => {
    throw new Error("fail");
  };
  console.warn = () => {};
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(PasskeyManagerDialog, {
        open: true,
        onOpenChange: () => {},
        id: "key",
        apiKey: "token",
      }),
    );
  });
  const json = JSON.stringify(renderer!.toJSON());
  assert.match(json, /Failed to list passkeys/i);
  ServerClient.prototype.listPasskeys = originalList;
  console.warn = originalConsoleWarn;
});
