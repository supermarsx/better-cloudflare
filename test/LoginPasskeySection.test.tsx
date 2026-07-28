import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { LoginPasskeySection } from "../src/components/auth/login-form/LoginPasskeySection";
import type { PasskeyStatus } from "../src/lib/api/tauri-client";

const unavailableStatus: PasskeyStatus = {
  registrationAvailable: false,
  authenticationAvailable: false,
  legacyCredentialsRequireReregistration: true,
  unavailableReason:
    "Passkeys are temporarily unavailable because existing credentials lack verifiable registration material.",
};

afterEach(() => {
  cleanup();
});

test("LoginPasskeySection hides when no keys", () => {
  const { container } = render(
    <LoginPasskeySection
      onManagePasskeys={() => {}}
      selectedKeyId=""
      password=""
      hasKeys={false}
      status={unavailableStatus}
    />,
  );
  assert.equal(container.firstChild, null);
});

test("LoginPasskeySection shows the unavailable notice and disables only legacy recovery without a key", () => {
  render(
    <LoginPasskeySection
      onManagePasskeys={() => {}}
      selectedKeyId=""
      password=""
      hasKeys={true}
      status={unavailableStatus}
    />,
  );
  assert.ok(screen.getByRole("alert"));
  assert.ok(screen.getByText(/lack verifiable registration material/i));
  assert.equal(
    screen.queryByRole("button", { name: /register passkey/i }),
    null,
  );
  assert.equal(screen.queryByRole("button", { name: /use passkey/i }), null);
  assert.equal(
    screen
      .getByRole("button", { name: /review legacy passkeys/i })
      .hasAttribute("disabled"),
    true,
  );
});

test("LoginPasskeySection keeps legacy recovery reachable when a key is selected", () => {
  let managed = false;
  render(
    <LoginPasskeySection
      onManagePasskeys={() => {
        managed = true;
      }}
      selectedKeyId="key1"
      password="pw"
      hasKeys={true}
      status={unavailableStatus}
    />,
  );
  const recovery = screen.getByRole("button", {
    name: /review legacy passkeys/i,
  });
  assert.equal(recovery.hasAttribute("disabled"), false);
  recovery.click();
  assert.equal(managed, true);
});
