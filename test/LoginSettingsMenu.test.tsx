/**
 * The login screen's key and settings menu, which replaced the three-button
 * row under the password field.
 *
 * What is pinned here is what jsdom can actually observe: the trigger, the
 * item set, and the gating of key management on a selected key.
 *
 * What is deliberately *not* pinned here is the deferred handoff that opens
 * each dialog. Radix never fires `onSelect` under jsdom — a click on an item
 * closes the menu through its dismissable layer without selecting it — so a
 * test written here would pass on that unrelated close and would go on passing
 * with the handoff removed. It was written, checked against a mutant, and
 * deleted for exactly that reason. `e2e/login-key-management.spec.ts` drives
 * the real thing in a browser, including the focus assertions that are the
 * point of the handoff.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { LoginSettingsMenu } from "../src/components/auth/login-form/LoginSettingsMenu";
import type { ApiKey } from "../src/types/dns";

const selectedKey: ApiKey = {
  id: "key-1",
  label: "Primary",
  encryptedKey: "encrypted",
  salt: "salt",
  iv: "iv",
  iterations: 1,
  keyLength: 32,
  algorithm: "AES-GCM",
  createdAt: new Date().toISOString(),
};

const baseProps = {
  onAddKey: () => {},
  onSettings: () => {},
  onEditKey: () => {},
  onDeleteKey: () => {},
};

afterEach(() => {
  cleanup();
});

/**
 * Open the menu and return its items in document order.
 *
 * The items are matched by position and text rather than by accessible name:
 * once Radix has finished mounting its modal layer under jsdom, the computed
 * accessible name of everything inside the portal comes back empty, so a
 * `name:` query passes or fails depending on when it runs. Asserting the whole
 * item list is both stable and stricter — it catches an item appearing or
 * disappearing, which a per-item lookup would not.
 */
async function openMenu() {
  const trigger = screen.getByRole("button", { name: /keys and settings/i });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await waitFor(() =>
    assert.ok(screen.getAllByRole("menuitem", { hidden: true }).length > 0),
  );
  return screen.getAllByRole("menuitem", { hidden: true });
}

test("LoginSettingsMenu exposes one non-submit trigger", () => {
  render(
    <LoginSettingsMenu {...baseProps} hasKeys={false} selectedKey={null} />,
  );

  const trigger = screen.getByRole("button", { name: /keys and settings/i });
  // A submit button here would post the login form on every menu open, and an
  // icon-only button with no label would be unreachable by name at all.
  assert.equal(trigger.getAttribute("type"), "button");
});

test("LoginSettingsMenu carries every action the button row used to", async () => {
  const view = render(
    <LoginSettingsMenu {...baseProps} hasKeys={false} selectedKey={null} />,
  );

  const items = await openMenu();
  assert.deepEqual(
    items.map((item) => item.textContent),
    ["Add New Key", "Manage Key", "Settings"],
  );

  // Editing or deleting needs something to act on.
  assert.equal(items[1].getAttribute("aria-disabled"), "true");

  view.rerender(
    <LoginSettingsMenu
      {...baseProps}
      hasKeys={true}
      selectedKey={selectedKey}
    />,
  );
  assert.equal(
    screen
      .getAllByRole("menuitem", { hidden: true })[1]
      .getAttribute("aria-disabled"),
    null,
  );
});

test("LoginSettingsMenu reports its open state so the dock can hold itself open", async () => {
  const states: boolean[] = [];
  render(
    <LoginSettingsMenu
      {...baseProps}
      hasKeys={true}
      selectedKey={selectedKey}
      onOpenChange={(open) => states.push(open)}
    />,
  );

  await openMenu();
  assert.deepEqual(states, [true]);
});
