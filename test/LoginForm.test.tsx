import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LoginForm } from "../src/components/auth/LoginForm";
import { TauriClient } from "../src/lib/api/tauri-client";

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

test("LoginForm renders login button", () => {
  render(<LoginForm onLogin={() => {}} desktop={false} />);
  const loginButton = screen
    .getAllByRole("button")
    .find(
      (btn) =>
        btn.className.includes("h-12") && btn.className.includes("text-lg"),
    );
  assert.ok(loginButton);
});

test("LoginForm places visible window controls inside the desktop auth card", async () => {
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({}));
  mock.method(TauriClient, "getApiKeys", async () => []);

  render(<LoginForm onLogin={() => {}} desktop />);

  await waitFor(() => {
    const card = screen.getByTestId("auth-card");
    const handle = screen.getByTestId("auth-window-handle");

    assert.equal(handle.parentElement, card);
    assert.equal(card.firstElementChild, handle);
    assert.ok(screen.getByRole("button", { name: "Minimize window" }));
    assert.ok(screen.getByRole("button", { name: "Toggle maximize" }));
    assert.ok(screen.getByRole("button", { name: "Close window" }));
  });
});

test("LoginForm hides native window controls on the web", () => {
  render(<LoginForm onLogin={() => {}} desktop={false} />);

  assert.equal(screen.queryByTestId("auth-window-handle"), null);
  assert.equal(screen.queryByRole("button", { name: "Minimize window" }), null);
  assert.equal(screen.queryByRole("button", { name: "Toggle maximize" }), null);
  assert.equal(screen.queryByRole("button", { name: "Close window" }), null);
});
