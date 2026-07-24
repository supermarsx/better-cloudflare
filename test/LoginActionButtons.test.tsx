import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { LoginActionButtons } from "../src/components/auth/login-form/LoginActionButtons";
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

test("LoginActionButtons highlights add key when no keys", () => {
  render(
    <LoginActionButtons {...baseProps} hasKeys={false} selectedKey={null} />,
  );
  const addBtn = screen.getByRole("button", { name: /add new key/i });
  assert.ok(/h-10/.test(addBtn.className));
});

test("LoginActionButtons uses secondary styling when keys exist", () => {
  render(
    <LoginActionButtons
      {...baseProps}
      hasKeys={true}
      selectedKey={selectedKey}
    />,
  );
  const addBtn = screen.getByRole("button", { name: /add new key/i });
  assert.ok(/h-9/.test(addBtn.className));
});
