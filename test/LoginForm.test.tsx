import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { LoginForm } from "../src/components/auth/LoginForm";
import { TauriClient } from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

test("LoginForm renders login button", async () => {
  render(<LoginForm onLogin={() => {}} desktop={false} />);
  const loginButton = screen
    .getAllByRole("button")
    .find(
      (btn) =>
        btn.className.includes("h-12") && btn.className.includes("text-lg"),
    );
  assert.ok(loginButton);
  await act(async () => {
    await Promise.resolve();
  });
});

test("LoginForm places visible window controls inside the desktop auth card", async () => {
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({}));
  mock.method(TauriClient, "getApiKeys", async () => []);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "Passkeys are temporarily unavailable.",
  }));

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
  await act(async () => {
    await Promise.resolve();
  });
});

test("LoginForm derives the unavailable passkey UI from the desktop capability", async () => {
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({}));
  mock.method(TauriClient, "getApiKeys", async () => [
    { id: "desktop-key", label: "Desktop key", encrypted_key: "ciphertext" },
  ]);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason:
      "Passkeys are temporarily unavailable because existing credentials lack verifiable registration material.",
  }));

  render(<LoginForm onLogin={() => {}} desktop />);

  await waitFor(() => {
    assert.ok(screen.getByRole("alert"));
    assert.equal(
      screen.queryByRole("button", { name: /register passkey/i }),
      null,
    );
    assert.equal(screen.queryByRole("button", { name: /use passkey/i }), null);
    assert.ok(screen.getByRole("button", { name: /review legacy passkeys/i }));
  });
});

test("LoginForm shows the passkey security notice and recovery path when status IPC fails", async () => {
  mock.method(console, "error", () => {});
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({}));
  mock.method(TauriClient, "getApiKeys", async () => [
    { id: "desktop-key", label: "Desktop key", encrypted_key: "ciphertext" },
  ]);
  mock.method(TauriClient, "getPasskeyStatus", async () => {
    throw new Error(
      "get_passkey_status unavailable: use legacy passkey recovery until the desktop service is restored.",
    );
  });

  render(<LoginForm onLogin={() => {}} desktop />);

  await waitFor(() => {
    assert.ok(screen.getByText("Desktop key"));
    assert.ok(screen.getByRole("alert"));
    assert.ok(
      screen.getByText(
        /use legacy passkey recovery until the desktop service is restored/i,
      ),
    );
    assert.ok(screen.getByRole("button", { name: /review legacy passkeys/i }));
    assert.equal(
      screen.queryByRole("button", { name: /register passkey/i }),
      null,
    );
    assert.equal(screen.queryByRole("button", { name: /use passkey/i }), null);
  });
});

test("LoginForm hides native window controls on the web", () => {
  render(<LoginForm onLogin={() => {}} desktop={false} />);

  assert.equal(screen.queryByTestId("auth-window-handle"), null);
  assert.equal(screen.queryByRole("button", { name: "Minimize window" }), null);
  assert.equal(screen.queryByRole("button", { name: "Toggle maximize" }), null);
  assert.equal(screen.queryByRole("button", { name: "Close window" }), null);
});

test("LoginForm ignores a stale web key load after switching to desktop", async () => {
  let resolveWebKeys: (
    keys: ReturnType<typeof storageManager.getApiKeys>,
  ) => void;
  const webKeys = new Promise<ReturnType<typeof storageManager.getApiKeys>>(
    (resolve) => {
      resolveWebKeys = resolve;
    },
  );

  mock.method(storageManager, "getApiKeys", () => webKeys as never);
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({}));
  mock.method(TauriClient, "getApiKeys", async () => [
    {
      id: "desktop-key",
      label: "Desktop key",
      encrypted_key: "desktop-ciphertext",
    },
  ]);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "Passkeys are temporarily unavailable.",
  }));

  const view = render(<LoginForm onLogin={() => {}} desktop={false} />);
  view.rerender(<LoginForm onLogin={() => {}} desktop />);

  await waitFor(() => {
    assert.ok(screen.getByText("Desktop key"));
  });

  resolveWebKeys([
    {
      id: "web-key",
      label: "Web key",
      encryptedKey: "web-ciphertext",
      salt: "salt",
      iv: "iv",
      iterations: 100000,
      keyLength: 256,
      algorithm: "AES-GCM",
      createdAt: new Date().toISOString(),
    },
  ]);

  await waitFor(() => {
    assert.ok(screen.getByText("Desktop key"));
    assert.equal(screen.queryByText("Web key"), null);
  });
});
