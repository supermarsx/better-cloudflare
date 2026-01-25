import assert from "node:assert/strict";
import React from "react";
import { test } from "node:test";
import { create } from "react-test-renderer";

import { LoginActionButtons } from "../src/components/auth/login-form/LoginActionButtons";

test("LoginActionButtons highlights add key when no keys", () => {
  const r = create(
    React.createElement(LoginActionButtons, {
      onAddKey: () => {},
      onSettings: () => {},
      hasKeys: false,
    }),
  );
  const buttons = r.root.findAllByType("button");
  const addBtn = buttons.find((b) =>
    String(b.children).includes("Add New Key"),
  );
  assert.ok(addBtn);
  assert.match(addBtn!.props.className, /animate-pulse/);
});

test("LoginActionButtons uses secondary styling when keys exist", () => {
  const r = create(
    React.createElement(LoginActionButtons, {
      onAddKey: () => {},
      onSettings: () => {},
      hasKeys: true,
    }),
  );
  const buttons = r.root.findAllByType("button");
  const addBtn = buttons.find((b) =>
    String(b.children).includes("Add New Key"),
  );
  assert.ok(addBtn);
  assert.match(addBtn!.props.className, /bg-black/);
});
