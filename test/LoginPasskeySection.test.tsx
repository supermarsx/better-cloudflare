import assert from "node:assert/strict";
import React from "react";
import { test } from "node:test";
import { create } from "react-test-renderer";

import { LoginPasskeySection } from "../src/components/auth/login-form/LoginPasskeySection";

test("LoginPasskeySection hides when no keys", () => {
  const r = create(
    React.createElement(LoginPasskeySection, {
      onRegister: () => {},
      onUsePasskey: () => {},
      onManagePasskeys: () => {},
      selectedKeyId: "",
      password: "",
      registerLoading: false,
      authLoading: false,
      hasKeys: false,
    }),
  );
  assert.equal(r.toJSON(), null);
});

test("LoginPasskeySection disables buttons when missing key/password", () => {
  const r = create(
    React.createElement(LoginPasskeySection, {
      onRegister: () => {},
      onUsePasskey: () => {},
      onManagePasskeys: () => {},
      selectedKeyId: "",
      password: "",
      registerLoading: false,
      authLoading: false,
      hasKeys: true,
    }),
  );
  const buttons = r.root.findAllByType("button");
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].props.disabled, true);
  assert.equal(buttons[1].props.disabled, true);
  assert.equal(buttons[2].props.disabled, true);
});

test("LoginPasskeySection enables actions when key selected", () => {
  const r = create(
    React.createElement(LoginPasskeySection, {
      onRegister: () => {},
      onUsePasskey: () => {},
      onManagePasskeys: () => {},
      selectedKeyId: "key1",
      password: "pw",
      registerLoading: false,
      authLoading: false,
      hasKeys: true,
    }),
  );
  const buttons = r.root.findAllByType("button");
  assert.equal(buttons[0].props.disabled, false);
  assert.equal(buttons[1].props.disabled, false);
  assert.equal(buttons[2].props.disabled, false);
});
