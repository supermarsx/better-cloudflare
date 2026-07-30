import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EncryptionSettingsDialog } from "../src/components/auth/EncryptionSettingsDialog";
import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  type EncryptionConfig,
} from "../src/types/dns";

afterEach(() => {
  cleanup();
});

const validSettings: EncryptionConfig = {
  iterations: MIN_PBKDF2_ITERATIONS,
  keyLength: 256,
  algorithm: "AES-GCM",
};

function renderDialog(
  settings: EncryptionConfig,
  onSettingsChange: (settings: EncryptionConfig) => void = () => {},
) {
  return render(
    <EncryptionSettingsDialog
      open
      onOpenChange={() => {}}
      settings={settings}
      onSettingsChange={onSettingsChange}
      onBenchmark={() => {}}
      onUpdate={() => {}}
      benchmarkResult={null}
      vaultEnabled={false}
      onVaultEnabledChange={() => {}}
    />,
  );
}

test("encryption settings expose only bounded PBKDF2 values", () => {
  const changes: EncryptionConfig[] = [];
  renderDialog(validSettings, (settings) => changes.push(settings));

  const input = screen.getByLabelText(/pbkdf2 iterations/i);
  assert.equal(input.getAttribute("min"), String(MIN_PBKDF2_ITERATIONS));
  assert.equal(input.getAttribute("max"), String(MAX_PBKDF2_ITERATIONS));
  assert.equal(
    screen.getByRole("button", { name: "Benchmark" }).disabled,
    false,
  );
  assert.equal(screen.getByRole("button", { name: "Update" }).disabled, false);

  fireEvent.change(input, {
    target: { value: String(MIN_PBKDF2_ITERATIONS - 1) },
  });
  fireEvent.change(input, {
    target: { value: String(MAX_PBKDF2_ITERATIONS + 1) },
  });
  assert.equal(changes.length, 0);

  fireEvent.change(input, {
    target: { value: String(MAX_PBKDF2_ITERATIONS) },
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].iterations, MAX_PBKDF2_ITERATIONS);
});

test("invalid or legacy settings cannot be benchmarked or persisted", () => {
  renderDialog({
    iterations: MAX_PBKDF2_ITERATIONS + 1,
    keyLength: 128,
    algorithm: "AES-CBC",
  });

  assert.equal(
    screen.getByRole("button", { name: "Benchmark" }).disabled,
    true,
  );
  assert.equal(screen.getByRole("button", { name: "Update" }).disabled, true);
  assert.equal(
    (screen.getByLabelText(/pbkdf2 iterations/i) as HTMLInputElement).value,
    String(MIN_PBKDF2_ITERATIONS),
  );
  assert.match(document.body.textContent ?? "", /AES-GCM/);
  assert.doesNotMatch(document.body.textContent ?? "", /128|192/);
});
