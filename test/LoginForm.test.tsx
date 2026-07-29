import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

import { LoginForm } from "../src/components/auth/LoginForm";
import { Toaster } from "../src/components/ui/toaster";
import { useLoginForm } from "../src/hooks/auth/use-login-form";
import { ServerClient } from "../src/lib/api/server-client";
import { TauriClient } from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function mockDesktopLoginBootstrap() {
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({
    vault_enabled: false,
  }));
  mock.method(TauriClient, "getApiKeys", async () => [
    {
      id: "desktop-key",
      label: "Desktop key",
      encrypted_key: "ciphertext",
    },
  ]);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: false,
    authenticationAvailable: false,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "Passkeys are temporarily unavailable.",
  }));
  mock.method(ServerClient, "biometricStatus", async () => ({
    available: false,
    biometricType: "none" as const,
  }));
}

test("LoginForm renders web login without embedded window chrome", async () => {
  render(<LoginForm onLogin={() => {}} desktop={false} />);
  const loginButton = screen
    .getAllByRole("button")
    .find(
      (btn) =>
        btn.className.includes("h-12") && btn.className.includes("text-lg"),
    );
  assert.ok(loginButton);
  assert.equal(screen.queryByTestId("auth-window-handle"), null);
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

test("useLoginForm prevents repeated login submissions while verification is pending", async () => {
  mockDesktopLoginBootstrap();
  mock.method(TauriClient, "decryptApiKey", async () => "desktop-secret");

  let resolveVerification: (value: boolean) => void = () => {};
  const pendingVerification = new Promise<boolean>((resolve) => {
    resolveVerification = resolve;
  });
  let verificationCalls = 0;
  mock.method(TauriClient, "verifyToken", async () => {
    verificationCalls += 1;
    return pendingVerification;
  });
  let loginCalls = 0;
  const view = renderHook(() =>
    useLoginForm(async () => {
      loginCalls += 1;
    }, true),
  );

  await waitFor(() => assert.equal(view.result.current.apiKeys.length, 1));
  act(() => {
    view.result.current.setSelectedKeyId("desktop-key");
    view.result.current.setPassword("password");
  });

  let firstLogin: Promise<void> = Promise.resolve();
  let repeatedLogin: Promise<void> = Promise.resolve();
  act(() => {
    firstLogin = view.result.current.handleLogin();
    repeatedLogin = view.result.current.handleLogin();
  });

  await waitFor(() => {
    assert.equal(view.result.current.isLoading, true);
    assert.equal(verificationCalls, 1);
  });

  resolveVerification(true);
  await act(async () => {
    await Promise.all([firstLogin, repeatedLogin]);
  });

  assert.equal(verificationCalls, 1);
  assert.equal(loginCalls, 1);
  assert.equal(view.result.current.isLoading, false);
});

test("useLoginForm reports a failed login only through the persistent redacted toast", async () => {
  mockDesktopLoginBootstrap();
  mock.method(TauriClient, "decryptApiKey", async () => {
    throw new Error(
      "Decryption failed: aead::Error token=desktop-secret-never-render",
    );
  });
  const view = renderHook(() => useLoginForm(() => {}, true));

  await waitFor(() => assert.equal(view.result.current.apiKeys.length, 1));
  act(() => {
    view.result.current.setSelectedKeyId("desktop-key");
    view.result.current.setPassword("password");
  });
  await act(async () => {
    await view.result.current.handleLogin();
  });
  render(<Toaster />);

  assert.equal("loginError" in view.result.current, false);
  assert.equal(screen.queryByTestId("login-error"), null);
  assert.equal(screen.getAllByText("Login could not be completed").length, 1);
  assert.match(document.body.textContent ?? "", /Decryption failed/);
  assert.match(document.body.textContent ?? "", /Diagnostic ID: REQ-/);
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /desktop-secret-never-render/,
  );
  assert.match(document.body.textContent ?? "", /\[redacted\]/);
});

test("useLoginForm keeps settings open when native persistence rejects", async () => {
  mockDesktopLoginBootstrap();
  mock.method(TauriClient, "updateEncryptionSettings", async () => {
    throw {
      kind: "timeout",
      message: "Could not persist encryption preferences",
      details: {
        operation: "update encryption settings",
        retryable: true,
        remediation: "Retry after checking the desktop service.",
      },
    };
  });
  const view = renderHook(() => useLoginForm(() => {}, true));

  await waitFor(() => assert.equal(view.result.current.apiKeys.length, 1));
  act(() => view.result.current.setShowSettings(true));
  await act(async () => {
    await view.result.current.handleUpdateSettings();
  });

  assert.equal(view.result.current.showSettings, true);
});

test("useLoginForm does not report a vault preference as enabled before persistence succeeds", async () => {
  mockDesktopLoginBootstrap();
  mock.method(storageManager, "getVaultEnabled", () => false);
  mock.method(TauriClient, "updatePreferences", async () => {
    throw new Error("preferences database is locked");
  });
  const view = renderHook(() => useLoginForm(() => {}, true));

  await waitFor(() => assert.equal(view.result.current.apiKeys.length, 1));
  assert.equal(view.result.current.vaultEnabled, false);

  await act(async () => {
    await view.result.current.setVaultEnabled(true);
  });

  assert.equal(view.result.current.vaultEnabled, false);
});
