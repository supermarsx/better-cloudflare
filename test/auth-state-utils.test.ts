import assert from "node:assert/strict";
import { test } from "node:test";

import { passkeyErrorMessage } from "../src/lib/auth/passkey-error";
import {
  failedPasskeyStatus,
  unavailablePasskeyStatus,
} from "../src/lib/auth/passkey-status";

test("passkey errors preserve the most useful backend explanation", () => {
  assert.equal(
    passkeyErrorMessage("  hardware key is locked  "),
    "hardware key is locked",
  );
  assert.equal(
    passkeyErrorMessage({
      message: "  credential was revoked  ",
      detail: "less specific detail",
      error: "least specific error",
    }),
    "credential was revoked",
  );
  assert.equal(
    passkeyErrorMessage({ message: " ", detail: "user verification failed" }),
    "user verification failed",
  );
  assert.equal(
    passkeyErrorMessage({ message: 401, error: "authenticator unavailable" }),
    "authenticator unavailable",
  );
});

test("passkey errors use a safe actionable fallback for unusable values", () => {
  const fallback =
    "The passkey operation failed. Review the security status and try a supported recovery action.";

  assert.equal(passkeyErrorMessage(null), fallback);
  assert.equal(passkeyErrorMessage(new Error()), fallback);
  assert.equal(passkeyErrorMessage({ detail: "   " }), fallback);
  assert.equal(passkeyErrorMessage(403), fallback);
});

test("unavailable passkey state carries backend recovery requirements", () => {
  const status = unavailablePasskeyStatus({
    available: false,
    unavailableReason: "Platform authenticator is unavailable",
    legacyCredentialsRequireReregistration: true,
  } as Parameters<typeof unavailablePasskeyStatus>[0]);

  assert.deepEqual(status, {
    kind: "unavailable",
    reason: "Platform authenticator is unavailable",
    legacyRecoveryAvailable: true,
  });
});

test("failed passkey state always leaves legacy recovery available", () => {
  assert.deepEqual(
    failedPasskeyStatus({ detail: "Passkey challenge expired" }),
    {
      kind: "error",
      reason: "Passkey challenge expired",
      legacyRecoveryAvailable: true,
    },
  );
});
