import assert from "node:assert/strict";
import React from "react";
import { test } from "node:test";
import { create } from "react-test-renderer";

import { LoginKeySelector } from "../src/components/auth/login-form/LoginKeySelector";

test("LoginKeySelector disables inputs when no keys", () => {
  const r = create(
    React.createElement(LoginKeySelector, {
      apiKeys: [],
      selectedKeyId: "",
      onSelectKey: () => {},
      onEditKey: () => {},
      onDeleteKey: () => {},
      password: "",
      onPasswordChange: () => {},
      onLogin: () => {},
      isLoading: false,
    }),
  );
  const inputs = r.root.findAllByType("input");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].props.disabled, true);
  const buttons = r.root.findAllByType("button");
  const login = buttons.find((b) => String(b.children).includes("Login"));
  assert.ok(login);
  assert.equal(login!.props.disabled, true);
});

test("LoginKeySelector enables login when key + password set", () => {
  const r = create(
    React.createElement(LoginKeySelector, {
      apiKeys: [
        {
          id: "k1",
          label: "Key",
          encryptedKey: "enc",
          salt: "",
          iv: "",
          iterations: 1,
          keyLength: 32,
          algorithm: "AES-256-GCM",
          createdAt: new Date().toISOString(),
        },
      ],
      selectedKeyId: "k1",
      onSelectKey: () => {},
      onEditKey: () => {},
      onDeleteKey: () => {},
      password: "pw",
      onPasswordChange: () => {},
      onLogin: () => {},
      isLoading: false,
    }),
  );
  const buttons = r.root.findAllByType("button");
  const login = buttons.find((b) => String(b.children).includes("Login"));
  assert.ok(login);
  assert.equal(login!.props.disabled, false);
});
