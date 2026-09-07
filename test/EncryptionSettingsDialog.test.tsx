/**
 * The key-maintenance half of the settings dialog.
 *
 * "Review legacy passkeys" and "Remove Vault Secret" used to sit on the login
 * card. They are rare, one-off actions and one of them is destructive, so they
 * moved in here — which makes this the file that has to prove they are still
 * offered, still gated, and still explain themselves.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { EncryptionSettingsDialog } from "../src/components/auth/EncryptionSettingsDialog";
import type { EncryptionConfig } from "../src/types/dns";

afterEach(() => {
  cleanup();
});

const settings: EncryptionConfig = {
  iterations: 100_000,
  keyLength: 256,
  algorithm: "AES-GCM",
};

function renderDialog(
  overrides: Partial<
    React.ComponentProps<typeof EncryptionSettingsDialog>
  > = {},
) {
  const props: React.ComponentProps<typeof EncryptionSettingsDialog> = {
    open: true,
    onOpenChange: () => {},
    settings,
    onSettingsChange: () => {},
    onBenchmark: () => {},
    onUpdate: () => {},
    benchmarkResult: null,
    vaultEnabled: true,
    onVaultEnabledChange: () => {},
    onRemoveVaultSecret: () => {},
    onManagePasskeys: () => {},
    legacyRecoveryAvailable: true,
    canUseSelectedKey: true,
    ...overrides,
  };
  return render(<EncryptionSettingsDialog {...props} />);
}

test("EncryptionSettingsDialog offers both maintenance actions for a usable key", () => {
  let managed = 0;
  let removed = 0;
  renderDialog({
    onManagePasskeys: () => {
      managed += 1;
    },
    onRemoveVaultSecret: () => {
      removed += 1;
    },
  });

  const review = screen.getByRole("button", {
    name: /review legacy passkeys/i,
  });
  const remove = screen.getByRole("button", { name: /remove vault secret/i });
  assert.equal(review.hasAttribute("disabled"), false);
  assert.equal(remove.hasAttribute("disabled"), false);

  review.click();
  remove.click();
  assert.equal(managed, 1);
  assert.equal(removed, 1);
});

test("EncryptionSettingsDialog disables maintenance without a decryptable key", () => {
  // Both actions decrypt the selected key before they can do anything, so
  // offering them live without a password would only produce a failure toast.
  renderDialog({ canUseSelectedKey: false });

  assert.equal(
    screen
      .getByRole("button", { name: /review legacy passkeys/i })
      .hasAttribute("disabled"),
    true,
  );
  assert.equal(
    screen
      .getByRole("button", { name: /remove vault secret/i })
      .hasAttribute("disabled"),
    true,
  );
  assert.ok(screen.getByText(/select a key and enter its password/i));
});

test("EncryptionSettingsDialog hides legacy review when there is nothing to review", () => {
  renderDialog({ legacyRecoveryAvailable: false });

  assert.equal(
    screen.queryByRole("button", { name: /review legacy passkeys/i }),
    null,
  );
  // Vault removal is not conditional on it — the secret can be there either way.
  assert.ok(screen.getByRole("button", { name: /remove vault secret/i }));
});

test("EncryptionSettingsDialog keeps vault removal reachable once the vault is off", () => {
  // Hiding this when the preference is off was the trap: it is the only
  // control that deletes a secret the app already wrote, and switching the
  // vault off does not erase it.
  renderDialog({ vaultEnabled: false });

  assert.ok(screen.getByRole("button", { name: /remove vault secret/i }));
  assert.match(
    screen.getByTestId("vault-disabled-notice").textContent ?? "",
    /remains in the system keychain/,
  );
});

test("EncryptionSettingsDialog shows no vault warning while the vault is on", () => {
  renderDialog({ vaultEnabled: true });

  assert.equal(screen.queryByTestId("vault-disabled-notice"), null);
});
