import type { PasskeyStatus } from "@/lib/api/tauri-client";
import { passkeyErrorMessage } from "@/lib/auth/passkey-error";
import type { WebauthnClientCapability } from "@/lib/auth/webauthn";

/**
 * Why passkeys cannot be used right now.
 *
 * These are four genuinely different situations with four different remedies,
 * and collapsing them into one "passkeys unavailable" message tells the user
 * nothing they can act on:
 *
 * - `"backend"` — the relying party itself reports no capability: the
 *   verification gate is shut, or the RP could not be configured for this
 *   session. Nothing the user does on this machine changes it; the reason text
 *   comes from the backend, which knows which of those it is.
 * - `"webview"` — the backend is willing but this webview has no WebAuthn
 *   client. That is the standing situation on macOS and Linux, where Tauri
 *   serves an opaque `tauri://localhost` origin. Not a fault and not
 *   configurable — the remedy is a different platform, or a password.
 * - `"no-authenticator"` — everything works, but this machine has no
 *   user-verifying platform authenticator enrolled. Enrolling one fixes it.
 * - `"legacy-credentials"` — the passkeys on file predate verified
 *   registration, so they cannot be used to sign in. Registration is still
 *   open, and re-enrolling is the way out.
 */
export type PasskeyUnavailableCause =
  "backend" | "webview" | "no-authenticator" | "legacy-credentials";

/**
 * What the login UI knows about passkeys, combining the relying party's own
 * capability report with this webview's client probe.
 *
 * `error` retains a safe, actionable IPC failure reason while leaving legacy
 * credential recovery available.
 */
export type PasskeyStatusState =
  | {
      kind: "available";
      registration: boolean;
      authentication: boolean;
      legacyRecoveryAvailable: boolean;
    }
  | {
      kind: "unavailable";
      cause: PasskeyUnavailableCause;
      reason: string;
      /**
       * Whether enrolling a new passkey may still be attempted. True only for
       * `"legacy-credentials"`, where re-enrolling is the remedy and must not
       * be blocked by the very state it fixes.
       */
      registration: boolean;
      legacyRecoveryAvailable: boolean;
    }
  | {
      kind: "error";
      reason: string;
      legacyRecoveryAvailable: true;
    };

export const WEBVIEW_UNSUPPORTED_REASON =
  "This platform's webview does not provide WebAuthn, so passkeys cannot be used in this app. Sign in with your password instead.";

export const NO_AUTHENTICATOR_REASON =
  "No passkey authenticator is set up on this device. Enrol Windows Hello, Touch ID, or a device passcode, then try again.";

export const LEGACY_CREDENTIALS_REASON =
  "Your existing passkeys were enrolled before verified registration and can no longer be used to sign in. Register a new passkey to replace them.";

/**
 * Fallback for a backend that reports unavailability without saying why. The
 * Rust side always sends a reason, so this only guards against an empty string
 * reaching the UI as a blank alert.
 */
const UNEXPLAINED_BACKEND_REASON =
  "Passkeys are unavailable in this build. Sign in with your password.";

/**
 * Reduce the backend capability report and the client probe to the single state
 * the UI should show.
 *
 * Order matters. The backend is consulted first: when the relying party can do
 * nothing, saying so is more useful than reporting a webview limitation the
 * user cannot act on either, and the backend's own reason is the specific one.
 * Only once the backend is willing do the client-side causes become the thing
 * standing in the way.
 */
export function passkeyStatusState(
  status: PasskeyStatus,
  client: WebauthnClientCapability,
): PasskeyStatusState {
  const legacyRecoveryAvailable = status.legacyCredentialsRequireReregistration;

  if (!status.registrationAvailable && !status.authenticationAvailable) {
    return {
      kind: "unavailable",
      cause: "backend",
      reason: status.unavailableReason.trim() || UNEXPLAINED_BACKEND_REASON,
      registration: false,
      legacyRecoveryAvailable,
    };
  }

  if (client === "unsupported") {
    return {
      kind: "unavailable",
      cause: "webview",
      reason: WEBVIEW_UNSUPPORTED_REASON,
      registration: false,
      legacyRecoveryAvailable,
    };
  }

  if (client === "no-authenticator") {
    return {
      kind: "unavailable",
      cause: "no-authenticator",
      reason: NO_AUTHENTICATOR_REASON,
      registration: false,
      legacyRecoveryAvailable,
    };
  }

  if (!status.authenticationAvailable && legacyRecoveryAvailable) {
    return {
      kind: "unavailable",
      cause: "legacy-credentials",
      reason: LEGACY_CREDENTIALS_REASON,
      registration: status.registrationAvailable,
      legacyRecoveryAvailable,
    };
  }

  return {
    kind: "available",
    registration: status.registrationAvailable,
    authentication: status.authenticationAvailable,
    legacyRecoveryAvailable,
  };
}

/**
 * The explanation to show the user, or `null` when passkeys are usable and
 * there is nothing to explain. Narrowing the union in one place keeps every
 * consumer from having to.
 */
export function passkeyStatusReason(
  state: PasskeyStatusState | null,
): string | null {
  if (!state) return null;
  return state.kind === "available" ? null : state.reason;
}

export function failedPasskeyStatus(error: unknown): PasskeyStatusState {
  return {
    kind: "error",
    reason: passkeyErrorMessage(error),
    legacyRecoveryAvailable: true,
  };
}
