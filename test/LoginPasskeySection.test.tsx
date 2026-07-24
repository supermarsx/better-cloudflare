import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { LoginPasskeySection } from "../src/components/auth/login-form/LoginPasskeySection";

afterEach(() => {
  cleanup();
});

test("LoginPasskeySection hides when no keys", () => {
  const { container } = render(
    <LoginPasskeySection
      onRegister={() => {}}
      onUsePasskey={() => {}}
      onManagePasskeys={() => {}}
      selectedKeyId=""
      password=""
      registerLoading={false}
      authLoading={false}
      hasKeys={false}
    />,
  );
  assert.equal(container.firstChild, null);
});

test("LoginPasskeySection disables buttons when missing key/password", () => {
  render(
    <LoginPasskeySection
      onRegister={() => {}}
      onUsePasskey={() => {}}
      onManagePasskeys={() => {}}
      selectedKeyId=""
      password=""
      registerLoading={false}
      authLoading={false}
      hasKeys={true}
    />,
  );
  const buttons = screen.getAllByRole("button");
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].hasAttribute("disabled"), true);
  assert.equal(buttons[1].hasAttribute("disabled"), true);
  assert.equal(buttons[2].hasAttribute("disabled"), true);
});

test("LoginPasskeySection enables actions when key selected", () => {
  render(
    <LoginPasskeySection
      onRegister={() => {}}
      onUsePasskey={() => {}}
      onManagePasskeys={() => {}}
      selectedKeyId="key1"
      password="pw"
      registerLoading={false}
      authLoading={false}
      hasKeys={true}
    />,
  );
  const buttons = screen.getAllByRole("button");
  assert.equal(buttons[0].hasAttribute("disabled"), false);
  assert.equal(buttons[1].hasAttribute("disabled"), false);
  assert.equal(buttons[2].hasAttribute("disabled"), false);
});

test("LoginPasskeySection shows loading labels", () => {
  render(
    <LoginPasskeySection
      onRegister={() => {}}
      onUsePasskey={() => {}}
      onManagePasskeys={() => {}}
      selectedKeyId="key1"
      password="pw"
      registerLoading={true}
      authLoading={true}
      hasKeys={true}
    />,
  );
  assert.ok(screen.getByText(/Registering/i));
  assert.ok(screen.getByText(/Authenticating/i));
});
