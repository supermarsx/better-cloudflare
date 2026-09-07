import assert from "node:assert/strict";
import { test } from "node:test";

import { passkeyErrorMessage } from "../src/lib/auth/passkey-error";
import {
  failedPasskeyStatus,
  passkeyStatusState,
  passkeyStatusReason,
  INSECURE_ORIGIN_REASON,
  LEGACY_CREDENTIALS_REASON,
  NO_PLATFORM_AUTHENTICATOR_REASON,
  WEBVIEW_UNSUPPORTED_REASON,
} from "../src/lib/auth/passkey-status";
import type {
  WebauthnClientCapability,
  WebauthnClientProbe,
  WebauthnClientSignals,
} from "../src/lib/auth/webauthn";
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

/**
 * A probe result carrying `capability`, with signals that say nothing.
 *
 * The reducer only ever reads `capability` and — for the advisory detail —
 * passes the signals through `describeWebauthnSignals`, so an all-`null` set
 * keeps each case about the branch it is testing.
 */
function probe(
  capability: WebauthnClientCapability,
  signals: Partial<WebauthnClientSignals> = {},
): WebauthnClientProbe {
  return {
    capability,
    signals: {
      secureContext: null,
      publicKeyCredential: true,
      credentialsCreate: true,
      credentialsGet: true,
      platformAuthenticator: null,
      hybridTransport: null,
      passkeyPlatformAuthenticator: null,
      conditionalGet: null,
      source: "none",
      probeError: null,
      ...signals,
    },
  };
}

test("a shut backend gate reports the backend's own reason, whatever the client can do", () => {
  // The gate is the thing standing in the way, and only the backend knows
  // whether it is shut for verification or for a missing origin. Reporting a
  // webview limitation instead would send the user chasing a fix that is not
  // the problem.
  for (const capability of [
    "available",
    "no-platform-authenticator",
    "insecure-origin",
    "unsupported",
  ] as const) {
    assert.deepEqual(passkeyStatusState(gateShut, probe(capability)), {
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
    probe("available"),
  );
  assert.equal(state.kind, "unavailable");
  assert.match(passkeyStatusReason(state) ?? "", /sign in with your password/i);
});

test("a webview with no WebAuthn client is named as the cause, not the backend", () => {
  assert.deepEqual(passkeyStatusState(backendReady, probe("unsupported")), {
    kind: "unavailable",
    cause: "webview",
    reason: WEBVIEW_UNSUPPORTED_REASON,
    registration: false,
    legacyRecoveryAvailable: false,
  });
});

test("an insecure origin is separated from a webview that has no WebAuthn at all", () => {
  // Same symptom — no API — but only one of the two has a cause the user can
  // be told about, so they must not share a message.
  assert.deepEqual(passkeyStatusState(backendReady, probe("insecure-origin")), {
    kind: "unavailable",
    cause: "insecure-origin",
    reason: INSECURE_ORIGIN_REASON,
    registration: false,
    legacyRecoveryAvailable: false,
  });
});

test("no detected authenticator leaves both ceremonies on offer", () => {
  // The regression this pins: this state used to be `unavailable` with
  // `registration: false`, which disabled both passkey buttons whenever
  // isUserVerifyingPlatformAuthenticatorAvailable() said false. A security key
  // or a phone passkey answers no probe and works anyway, so withholding the
  // ceremony was never justified by what the probe actually knows.
  const state = passkeyStatusState(
    backendReady,
    probe("no-platform-authenticator", { platformAuthenticator: false }),
  );

  assert.equal(state.kind, "available");
  assert.equal(state.kind === "available" && state.registration, true);
  assert.equal(state.kind === "available" && state.authentication, true);
  assert.equal(
    state.kind === "available" && state.advisory?.cause,
    "no-platform-authenticator",
  );
  assert.equal(passkeyStatusReason(state), NO_PLATFORM_AUTHENTICATOR_REASON);
  // The advisory carries what the probe saw, so a user who is sure Hello is
  // enrolled has something to check rather than a flat contradiction.
  assert.match(
    (state.kind === "available" && state.advisory?.detail) || "",
    /built-in authenticator: no/,
  );
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
      probe("available"),
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

test("a working backend and a working client report availability with no advisory", () => {
  assert.deepEqual(passkeyStatusState(backendReady, probe("available")), {
    kind: "available",
    registration: true,
    authentication: true,
    legacyRecoveryAvailable: false,
    native: false,
    advisory: null,
  });
  assert.equal(
    passkeyStatusReason(passkeyStatusState(backendReady, probe("available"))),
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
      probe("available"),
    ),
    {
      kind: "available",
      registration: true,
      authentication: false,
      legacyRecoveryAvailable: false,
      native: false,
      advisory: null,
    },
  );
});

// ── The backend owns the ceremony ───────────────────────────────────────────
//
// On a platform with a native WebAuthn broker the ceremony runs in the backend,
// against the OS, and `navigator.credentials` is never called. Every finding
// the client probe reports then describes a client that will not run, so acting
// on any of it would be the original bug in a new place.

const nativeBackend: PasskeyStatus = { ...backendReady, nativeCeremony: true };

test("a native ceremony ignores a webview with no WebAuthn client at all", () => {
  // The macOS and Linux situation, and the one that used to be a flat refusal.
  // If the backend can run the ceremony, an absent webview client is beside
  // the point.
  const state = passkeyStatusState(nativeBackend, probe("unsupported"));

  assert.equal(state.kind, "available");
  assert.equal(state.kind === "available" && state.native, true);
  assert.equal(state.kind === "available" && state.registration, true);
  assert.equal(state.kind === "available" && state.authentication, true);
  assert.equal(passkeyStatusReason(state), null);
});

test("a native ceremony ignores an insecure origin too", () => {
  const state = passkeyStatusState(nativeBackend, probe("insecure-origin"));
  assert.equal(state.kind, "available");
  assert.equal(state.kind === "available" && state.native, true);
});

test("a native ceremony shows no authenticator advisory", () => {
  // The advisory describes what the *webview* client could see. Printing it
  // beside a button that opens the system credential picker would be telling
  // the user about the wrong thing.
  const state = passkeyStatusState(
    nativeBackend,
    probe("no-platform-authenticator", { platformAuthenticator: false }),
  );

  assert.equal(state.kind, "available");
  assert.equal(state.kind === "available" && state.advisory, null);
  assert.equal(passkeyStatusReason(state), null);
});

test("a native ceremony does not override the backend's own refusal", () => {
  // `nativeCeremony` says which client would run, not whether the relying
  // party will have it. A shut gate is still shut.
  assert.deepEqual(
    passkeyStatusState(
      { ...gateShut, nativeCeremony: true },
      probe("available"),
    ),
    {
      kind: "unavailable",
      cause: "backend",
      reason: "Platform authenticator is unavailable",
      registration: false,
      legacyRecoveryAvailable: true,
    },
  );
});

test("a native ceremony still reports legacy credentials that cannot sign in", () => {
  // Legacy records hold no public key. Which client runs the ceremony changes
  // nothing about that.
  const state = passkeyStatusState(
    {
      ...nativeBackend,
      authenticationAvailable: false,
      legacyCredentialsRequireReregistration: true,
    },
    probe("available"),
  );

  assert.equal(state.kind, "unavailable");
  assert.equal(
    state.kind === "unavailable" && state.cause,
    "legacy-credentials",
  );
  assert.equal(state.kind === "unavailable" && state.registration, true);
});

test("a build that predates the native field is read as having no native client", () => {
  // `nativeCeremony` is optional on the wire; `undefined` must not read as
  // true, or an older backend would be told to call a command it lacks.
  const state = passkeyStatusState(backendReady, probe("available"));
  assert.equal(state.kind === "available" && state.native, false);
});

test("every reason the UI can show is distinct from every other", () => {
  const reasons = new Set(
    [
      passkeyStatusState(gateShut, probe("available")),
      passkeyStatusState(backendReady, probe("unsupported")),
      passkeyStatusState(backendReady, probe("insecure-origin")),
      passkeyStatusState(backendReady, probe("no-platform-authenticator")),
      passkeyStatusState(
        {
          ...backendReady,
          authenticationAvailable: false,
          legacyCredentialsRequireReregistration: true,
        },
        probe("available"),
      ),
    ].map((state) => passkeyStatusReason(state)),
  );
  assert.equal(reasons.size, 5);
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
