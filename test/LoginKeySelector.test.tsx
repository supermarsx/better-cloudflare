import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { LoginKeySelector } from "../src/components/auth/login-form/LoginKeySelector";
import type { ApiKey } from "../src/types/dns";

afterEach(() => {
  cleanup();
});

const noKeySelected = {
  apiKeys: [],
  selectedKeyId: "",
  onSelectKey: () => {},
  password: "",
  onPasswordChange: () => {},
  onLogin: () => {},
  isLoading: false,
};

const sampleKey: ApiKey = {
  id: "k1",
  label: "Key",
  encryptedKey: "enc",
  salt: "",
  iv: "",
  iterations: 1,
  keyLength: 32,
  algorithm: "AES-GCM",
  createdAt: new Date().toISOString(),
};

test("LoginKeySelector disables inputs when no keys", () => {
  render(<LoginKeySelector {...noKeySelected} />);
  const keySelector = screen.getByRole("combobox");
  const passwordInput = document.getElementById("password") as HTMLInputElement;
  const loginButton = screen
    .getAllByRole("button")
    .find(
      (btn) =>
        btn.className.includes("h-12") && btn.className.includes("text-lg"),
    );
  assert.equal(keySelector.hasAttribute("disabled"), true);
  assert.equal(passwordInput?.hasAttribute("disabled"), true);
  assert.ok(loginButton);
  const login = loginButton as HTMLButtonElement;
  assert.equal(login.hasAttribute("disabled"), true);
});

test("LoginKeySelector enables login when key + password set", () => {
  render(
    <LoginKeySelector
      apiKeys={[sampleKey]}
      selectedKeyId="k1"
      onSelectKey={() => {}}
      password="pw"
      onPasswordChange={() => {}}
      onLogin={() => {}}
      isLoading={false}
    />,
  );
  const login = screen.getByRole("button", { name: /login/i });
  assert.equal(login.hasAttribute("disabled"), false);
});
