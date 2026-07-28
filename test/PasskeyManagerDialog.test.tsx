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
import type { PasskeyStatusState } from "../src/lib/auth/passkey-status";

const originalList = ServerClient.prototype.listPasskeys;
const originalDelete = ServerClient.prototype.deletePasskey;
const unavailableStatus: PasskeyStatusState = {
  kind: "unavailable",
  legacyRecoveryAvailable: true,
  reason:
    "Passkeys are temporarily unavailable because existing credentials lack verifiable registration material.",
};

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
      status={unavailableStatus}
    />,
  );
  await waitFor(() => assert.ok(screen.getByText(/No legacy passkeys found/i)));
  assert.ok(screen.getByRole("alert"));
});

test("PasskeyManagerDialog lists passkeys", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", counter: 1, label: "cred1", requiresReregistration: true },
    { id: "cred2", counter: 2, label: "cred2", requiresReregistration: true },
  ];
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
      status={unavailableStatus}
    />,
  );
  await waitFor(() => {
    assert.ok(screen.getByText("cred1"));
    assert.ok(screen.getByText("cred2"));
    assert.equal(screen.getAllByText(/Re-enrollment required/i).length, 2);
  });
});

test("PasskeyManagerDialog revokes passkeys", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", counter: 1, label: "cred1", requiresReregistration: true },
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
      status={unavailableStatus}
    />,
  );
  await waitFor(() => assert.ok(screen.getByText("cred1")));
  const remove = screen.getByRole("button", { name: /remove/i });
  fireEvent.click(remove);
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
      status={unavailableStatus}
    />,
  );
  await waitFor(() => assert.ok(screen.getByText(/No legacy passkeys found/i)));
});

test("PasskeyManagerDialog preserves structured backend errors during legacy removal", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", requiresReregistration: true },
  ];
  ServerClient.prototype.deletePasskey = async () => {
    throw {
      message:
        "Passkey authentication is disabled because stored registrations lack a server-verified public key",
    };
  };
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
      status={unavailableStatus}
    />,
  );
  await waitFor(() => assert.ok(screen.getByText("Legacy credential")));
  fireEvent.click(screen.getByRole("button", { name: /remove/i }));
  await waitFor(() => {
    assert.ok(
      screen.getByText(
        /stored registrations lack a server-verified public key/i,
      ),
    );
  });
});

test("PasskeyManagerDialog ignores a stale list after the key changes", async () => {
  let resolveFirst: (
    items: Awaited<ReturnType<ServerClient["listPasskeys"]>>,
  ) => void = () => {};
  let resolveSecond: (
    items: Awaited<ReturnType<ServerClient["listPasskeys"]>>,
  ) => void = () => {};
  const first = new Promise<Awaited<ReturnType<ServerClient["listPasskeys"]>>>(
    (resolve) => {
      resolveFirst = resolve;
    },
  );
  const second = new Promise<Awaited<ReturnType<ServerClient["listPasskeys"]>>>(
    (resolve) => {
      resolveSecond = resolve;
    },
  );

  ServerClient.prototype.listPasskeys = async function (id) {
    return id === "key-1" ? first : second;
  };

  const view = render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key-1"
      apiKey="token-1"
      status={unavailableStatus}
    />,
  );
  view.rerender(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key-2"
      apiKey="token-2"
      status={unavailableStatus}
    />,
  );

  resolveSecond([
    {
      id: "fresh",
      label: "Fresh credential",
      requiresReregistration: true,
    },
  ]);
  await waitFor(() => assert.ok(screen.getByText("Fresh credential")));

  resolveFirst([
    {
      id: "stale",
      label: "Stale credential",
      requiresReregistration: true,
    },
  ]);
  await Promise.resolve();

  assert.equal(screen.queryByText("Stale credential"), null);
  assert.ok(screen.getByText("Fresh credential"));
});

test("PasskeyManagerDialog aborts a pending list when closed and clears stale content", async () => {
  let resolveList: (
    items: Awaited<ReturnType<ServerClient["listPasskeys"]>>,
  ) => void = () => {};
  const pending = new Promise<
    Awaited<ReturnType<ServerClient["listPasskeys"]>>
  >((resolve) => {
    resolveList = resolve;
  });
  ServerClient.prototype.listPasskeys = async () => pending;

  const view = render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
      status={unavailableStatus}
    />,
  );
  await waitFor(() => {
    const loading = screen.getByRole("status");
    assert.match(loading.textContent ?? "", /loading legacy passkeys/i);
  });

  view.rerender(
    <PasskeyManagerDialog
      open={false}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
      status={unavailableStatus}
    />,
  );
  resolveList([
    {
      id: "late",
      label: "Late credential",
      requiresReregistration: true,
    },
  ]);
  await Promise.resolve();

  assert.equal(screen.queryByText("Late credential"), null);
});

test("PasskeyManagerDialog remove action is a non-submit button", async () => {
  ServerClient.prototype.listPasskeys = async () => [
    { id: "cred1", label: "Credential", requiresReregistration: true },
  ];
  render(
    <PasskeyManagerDialog
      open={true}
      onOpenChange={() => {}}
      id="key"
      apiKey="token"
      status={unavailableStatus}
    />,
  );

  const remove = await screen.findByRole("button", { name: /remove/i });
  assert.equal(remove.getAttribute("type"), "button");
});
