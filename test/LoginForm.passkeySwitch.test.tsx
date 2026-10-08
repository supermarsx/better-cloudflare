/**
 * The passkey feature switch, at the only screen that offers passkeys.
 *
 * `storageManager.getPasskeysEnabled()` defaults to on, so the first thing
 * these pin is that an existing install is unchanged: with nothing stored, the
 * login form offers both ceremonies exactly as it did. The rest pin what "off"
 * means, and it is absence rather than refusal — there are two doors to
 * passkeys on this screen and both have to be shut:
 *
 *  1. `LoginPasskeySection`, which carries "Register passkey" and "Use
 *     passkey". A disabled-looking button here would be the worst outcome: it
 *     tells the user passkeys exist and then fails.
 *  2. The Encryption Settings dialog's "Review legacy passkeys" entry, which is
 *     the way into `PasskeyManagerDialog` and the credential listing behind it.
 *     `LoginForm` closes it by withholding the passkey status from
 *     `LoginDialogs`, and that dialog is rendered directly here rather than
 *     reached through the login screen. Reaching it for real means selecting an
 *     item in a Radix dropdown whose handler is deferred to `onCloseAutoFocus`
 *     and then a `requestAnimationFrame`; nothing in this repo drives that
 *     under jsdom, and a test that did would be measuring the dropdown. So the
 *     door's own rule — no status, no entry — is pinned here, and `LoginForm`
 *     passing `null` is composition rather than an end-to-end assertion.
 *
 * Nothing here asserts that a boolean was stored. The storage round-trip is the
 * easy half and says nothing about whether the ceremony is still reachable.
 *
 * Absence is `assert.ok(node === null, …)` throughout, never
 * `assert.equal(node, null)`: the latter deep-inspects a jsdom element on
 * failure and can take the worker — and the rest of the batch — with it.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LoginForm } from "../src/components/auth/LoginForm";
import { LoginDialogs } from "../src/components/auth/login-form/LoginDialogs";
import { ServerClient } from "../src/lib/api/server-client";
import { TauriClient } from "../src/lib/api/tauri-client";
import type { PasskeyStatusState } from "../src/lib/auth/passkey-status";
import { storageManager } from "../src/lib/storage/storage";

afterEach(() => {
  cleanup();
  mock.restoreAll();
  // The switch is a module-singleton preference, so it is put back by hand
  // rather than left for the next file in the batch to inherit.
  storageManager.setPasskeysEnabled(true);
});

/**
 * A desktop login screen whose relying party can run both ceremonies.
 *
 * `nativeCeremony: true` matters: it is what makes `passkeyStatusState` ignore
 * this webview's WebAuthn probe, which under jsdom reports no client at all and
 * would otherwise withhold the buttons for a reason that has nothing to do with
 * the switch being tested.
 */
function mockWorkingPasskeys() {
  mock.method(TauriClient, "getEncryptionSettings", async () => ({
    iterations: 100000,
    keyLength: 256,
    algorithm: "AES-GCM",
  }));
  mock.method(TauriClient, "getPreferences", async () => ({
    vault_enabled: true,
  }));
  mock.method(TauriClient, "getApiKeys", async () => [
    { id: "desktop-key", label: "Desktop key", encrypted_key: "ciphertext" },
  ]);
  mock.method(TauriClient, "getPasskeyStatus", async () => ({
    registrationAvailable: true,
    authenticationAvailable: true,
    legacyCredentialsRequireReregistration: true,
    unavailableReason: "",
    nativeCeremony: true,
    nativeClient: "Windows Hello",
  }));
  mock.method(ServerClient, "biometricStatus", async () => ({
    available: false,
    biometricType: "none" as const,
  }));
}

test("absent means on: the login form offers both passkey ceremonies", async () => {
  mockWorkingPasskeys();
  render(<LoginForm onLogin={() => {}} desktop />);

  await waitFor(() => {
    assert.ok(screen.getByText("Passkey security status"));
    assert.ok(screen.getByRole("button", { name: /register passkey/i }));
    assert.ok(screen.getByRole("button", { name: /use passkey/i }));
  });
});

test("passkeys off removes the section, not merely its buttons", async () => {
  storageManager.setPasskeysEnabled(false);
  mockWorkingPasskeys();
  render(<LoginForm onLogin={() => {}} desktop />);

  // Wait for the screen to finish loading, so this is not asserting absence
  // against a form that has not rendered its sections yet.
  await waitFor(() => assert.ok(screen.getByText("Desktop key")));

  assert.ok(
    screen.queryByText("Passkey security status") === null,
    "the passkey section must be absent, not present and empty",
  );
  assert.ok(
    screen.queryByRole("button", { name: /register passkey/i }) === null,
    "no registration ceremony may be startable while passkeys are off",
  );
  assert.ok(
    screen.queryByRole("button", { name: /use passkey/i }) === null,
    "and no authentication ceremony either",
  );
});

const AVAILABLE_STATUS: PasskeyStatusState = {
  kind: "available",
  registration: true,
  authentication: true,
  legacyRecoveryAvailable: true,
  advisory: null,
  native: true,
};

/** `LoginDialogs` with the settings dialog open and nothing else going on. */
function renderDialogs(passkeyStatus: PasskeyStatusState | null) {
  return render(
    <LoginDialogs
      showAddKey={false}
      setShowAddKey={() => {}}
      newKeyLabel=""
      setNewKeyLabel={() => {}}
      newApiKey=""
      setNewApiKey={() => {}}
      newEmail=""
      setNewEmail={() => {}}
      newPassword=""
      setNewPassword={() => {}}
      handleAddKey={() => {}}
      showSettings
      setShowSettings={() => {}}
      encryptionSettings={{
        iterations: 100000,
        keyLength: 256,
        algorithm: "AES-GCM",
      }}
      setEncryptionSettings={() => {}}
      handleBenchmark={() => {}}
      handleUpdateSettings={() => {}}
      benchmarkResult={null}
      vaultEnabled
      setVaultEnabled={() => {}}
      handleRemoveVaultSecret={() => {}}
      handleManagePasskeys={() => {}}
      canUseSelectedKey
      showManagePasskeys={false}
      setShowManagePasskeys={() => {}}
      selectedKeyId="desktop-key"
      passkeyViewKey=""
      passkeyViewEmail={undefined}
      setPasskeyViewKey={() => {}}
      setPasskeyViewEmail={() => {}}
      passkeyStatus={passkeyStatus}
      showEditKey={false}
      setShowEditKey={() => {}}
      editLabel=""
      setEditLabel={() => {}}
      editEmail=""
      setEditEmail={() => {}}
      currentPassword=""
      setCurrentPassword={() => {}}
      editPassword=""
      setEditPassword={() => {}}
      handleUpdateKey={() => {}}
    />,
  );
}

test("the second door: a withheld status hides the way into passkey management", async () => {
  // Control first, or the absence below proves only that the button is hard to
  // find: with a status, the entry is there.
  renderDialogs(AVAILABLE_STATUS);
  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: /review legacy passkeys/i })),
  );
  cleanup();

  // `LoginForm` passes `null` here while the switch is off, which is what shuts
  // the door `PasskeyManagerDialog` sits behind.
  renderDialogs(null);
  await waitFor(() => assert.ok(screen.getByText(/OS vault/i)));
  assert.ok(
    screen.queryByRole("button", { name: /review legacy passkeys/i }) === null,
    "with no passkey status there must be no entry to passkey management",
  );
});
