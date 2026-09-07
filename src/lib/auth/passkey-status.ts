import type { PasskeyStatus } from "@/lib/api/tauri-client";
import { passkeyErrorMessage } from "@/lib/auth/passkey-error";
import {
  describeWebauthnSignals,
  type WebauthnClientProbe,
} from "@/lib/auth/webauthn";

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
 *   client at all. Not a fault and not configurable — the remedy is a
 *   different platform, or a password.
 * - `"insecure-origin"` — the WebAuthn API is absent *and* this is not a
 *   secure context, which is the specific reason it is absent. The standing
 *   situation on macOS and Linux, where Tauri serves an opaque
 *   `tauri://localhost` origin.
 * - `"legacy-credentials"` — the passkeys on file predate verified
 *   registration, so they cannot be used to sign in. Registration is still
 *   open, and re-enrolling is the way out.
 *
 * Note what is *not* here any more: the absence of a platform authenticator.
 * That is now {@link PasskeyAdvisory} — see it for why.
 */
export type PasskeyUnavailableCause =
  "backend" | "webview" | "insecure-origin" | "legacy-credentials";

/**
 * Something worth warning about that is **not** a reason to withhold the
 * button.
 *
 * `"no-platform-authenticator"` used to be an unavailable cause, and that was
 * a bug with real consequences: it disabled both passkey buttons whenever
 * `isUserVerifyingPlatformAuthenticatorAvailable()` returned false. That call
 * reports only *built-in* authenticators, so a USB security key, an NFC key,
 * and a passkey on the user's phone were all treated as "no authenticator on
 * this device" — while the relying party would have accepted every one of
 * them. Worse, the same call returns false on webviews where a platform
 * authenticator does in fact work, which stranded users who had Windows Hello
 * enrolled and working.
 *
 * The probe cannot see a roaming authenticator and never will: there is no API
 * that reports one before a ceremony starts. So the honest design is to say
 * what was detected, offer the ceremony anyway, and let a real failure carry
 * the real reason.
 */
export interface PasskeyAdvisory {
  cause: "no-platform-authenticator";
  reason: string;
  /** What the probe actually saw, for a user who needs to check something. */
  detail: string | null;
}

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
      /** Non-null when the ceremony is offered with a caveat attached. */
      advisory: PasskeyAdvisory | null;
      /**
       * Whether the ceremony will run in the backend, against the operating
       * system's own authenticator broker, rather than in this webview.
       *
       * The UI says so, because it changes what the user is about to see: the
       * system credential picker rather than the browser's, and with it
       * security keys and phone passkeys that the webview client could not
       * reach here.
       */
      native: boolean;
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

export const INSECURE_ORIGIN_REASON =
  "This window is not a secure context, so the browser withholds WebAuthn entirely. Passkeys cannot be used here. Sign in with your password instead.";

export const NO_PLATFORM_AUTHENTICATOR_REASON =
  "No built-in authenticator was detected on this device. You can still register and sign in with a security key, or with a passkey on your phone — and if Windows Hello or Touch ID is set up, it may work even though it was not reported. Try it; a real failure will say what went wrong.";

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
 *
 * Exactly one client-side cause still withholds the ceremony — the webview
 * having no WebAuthn client, in either of its two spellings — and even that is
 * skipped when the backend reports it can run the ceremony itself, since then
 * no webview client is involved at all. Everything the probe reports about
 * *authenticators* is advice, because none of it can rule out a roaming key.
 */
export function passkeyStatusState(
  status: PasskeyStatus,
  client: WebauthnClientProbe,
): PasskeyStatusState {
  const legacyRecoveryAvailable = status.legacyCredentialsRequireReregistration;
  // When the backend runs the ceremony, every client-side finding below
  // describes a client that will not be used. Reporting them anyway would be
  // the original bug in a new place: withholding a working button on evidence
  // about something else entirely.
  const native = status.nativeCeremony === true;

  if (!status.registrationAvailable && !status.authenticationAvailable) {
    return {
      kind: "unavailable",
      cause: "backend",
      reason: status.unavailableReason.trim() || UNEXPLAINED_BACKEND_REASON,
      registration: false,
      legacyRecoveryAvailable,
    };
  }

  if (
    !native &&
    (client.capability === "unsupported" ||
      client.capability === "insecure-origin")
  ) {
    const insecure = client.capability === "insecure-origin";
    return {
      kind: "unavailable",
      cause: insecure ? "insecure-origin" : "webview",
      reason: insecure ? INSECURE_ORIGIN_REASON : WEBVIEW_UNSUPPORTED_REASON,
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
    native,
    advisory:
      !native && client.capability === "no-platform-authenticator"
        ? {
            cause: "no-platform-authenticator",
            reason: NO_PLATFORM_AUTHENTICATOR_REASON,
            detail: describeWebauthnSignals(client.signals),
          }
        : null,
  };
}

/**
 * The explanation to show the user, or `null` when there is nothing to say.
 *
 * An `available` state with an advisory still has something to say, so this
 * returns the advisory's own text. Narrowing the union in one place keeps every
 * consumer from having to.
 */
export function passkeyStatusReason(
  state: PasskeyStatusState | null,
): string | null {
  if (!state) return null;
  if (state.kind === "available") return state.advisory?.reason ?? null;
  return state.reason;
}

export function failedPasskeyStatus(error: unknown): PasskeyStatusState {
  return {
    kind: "error",
    reason: passkeyErrorMessage(error),
    legacyRecoveryAvailable: true,
  };
}
