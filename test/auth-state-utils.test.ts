import assert from "node:assert/strict";
import { test } from "node:test";

import { passkeyErrorMessage } from "../src/lib/auth/passkey-error";
import {
  failedPasskeyStatus,
  passkeyStatusState,
  passkeyStatusReason,
  LEGACY_CREDENTIALS_REASON,
  NO_AUTHENTICATOR_REASON,
  WEBVIEW_UNSUPPORTED_REASON,
} from "../src/lib/auth/passkey-status";
import type { PasskeyStatus } from "../src/lib/api/tauri-client";

const gateShut: PasskeyStatus = {
  registrationAvailable: false,
  authenticationAvailable: false,
  legacyCredentialsRequireReregistration: true,
  unavailableReason: "Platform authenticator is unavailable",
};

const backendReady: PasskeyStatus = {
  registrationAvailable: true,
  authenticationAvailable: true,
  legacyCredentialsRequireReregistration: false,
  unavailableReason: "",
};

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

test("a shut backend gate reports the backend's own reason, whatever the client can do", () => {
  // The gate is the thing standing in the way, and only the backend knows
  // whether it is shut for verification or for a missing origin. Reporting a
  // webview limitation instead would send the user chasing a fix that is not
  // the problem.
  for (const client of [
    "available",
    "no-authenticator",
    "unsupported",
  ] as const) {
    assert.deepEqual(passkeyStatusState(gateShut, client), {
      kind: "unavailable",
      cause: "backend",
      reason: "Platform authenticator is unavailable",
      registration: false,
      legacyRecoveryAvailable: true,
    });
  }
});

test("a backend that reports unavailability without a reason still says something actionable", () => {
  const state = passkeyStatusState(
    { ...gateShut, unavailableReason: "   " },
    "available",
  );
  assert.equal(state.kind, "unavailable");
  assert.match(passkeyStatusReason(state) ?? "", /sign in with your password/i);
});

test("a webview with no WebAuthn client is named as the cause, not the backend", () => {
  assert.deepEqual(passkeyStatusState(backendReady, "unsupported"), {
    kind: "unavailable",
    cause: "webview",
    reason: WEBVIEW_UNSUPPORTED_REASON,
    registration: false,
    legacyRecoveryAvailable: false,
  });
});

test("a device with no enrolled authenticator gets the enrolment message", () => {
  assert.deepEqual(passkeyStatusState(backendReady, "no-authenticator"), {
    kind: "unavailable",
    cause: "no-authenticator",
    reason: NO_AUTHENTICATOR_REASON,
    registration: false,
    legacyRecoveryAvailable: false,
  });
});

test("legacy-only credentials block sign-in but leave registration open", () => {
  // Registration is the way out of this state, so it must not be gated by the
  // state it fixes.
  assert.deepEqual(
    passkeyStatusState(
      {
        registrationAvailable: true,
        authenticationAvailable: false,
        legacyCredentialsRequireReregistration: true,
        unavailableReason: "",
      },
      "available",
    ),
    {
      kind: "unavailable",
      cause: "legacy-credentials",
      reason: LEGACY_CREDENTIALS_REASON,
      registration: true,
      legacyRecoveryAvailable: true,
    },
  );
});

test("a working backend and a working client report availability", () => {
  assert.deepEqual(passkeyStatusState(backendReady, "available"), {
    kind: "available",
    registration: true,
    authentication: true,
    legacyRecoveryAvailable: false,
  });
  assert.equal(
    passkeyStatusReason(passkeyStatusState(backendReady, "available")),
    null,
  );
});

test("registration-only availability without legacy records is still available", () => {
  assert.deepEqual(
    passkeyStatusState(
      {
        registrationAvailable: true,
        authenticationAvailable: false,
        legacyCredentialsRequireReregistration: false,
        unavailableReason: "",
      },
      "available",
    ),
    {
      kind: "available",
      registration: true,
      authentication: false,
      legacyRecoveryAvailable: false,
    },
  );
});

test("the four unavailable causes each carry a distinct message", () => {
  const reasons = new Set(
    [
      passkeyStatusState(gateShut, "available"),
      passkeyStatusState(backendReady, "unsupported"),
      passkeyStatusState(backendReady, "no-authenticator"),
      passkeyStatusState(
        {
          ...backendReady,
          authenticationAvailable: false,
          legacyCredentialsRequireReregistration: true,
        },
        "available",
      ),
    ].map((state) => passkeyStatusReason(state)),
  );
  assert.equal(reasons.size, 4);
  assert.ok(!reasons.has(null));
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
