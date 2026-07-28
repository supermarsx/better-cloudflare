import type { PasskeyStatus } from "@/lib/api/tauri-client";
import { passkeyErrorMessage } from "@/lib/auth/passkey-error";

/**
 * Fail-closed state shown by the login UI when passkeys cannot be used.
 * `error` retains a safe, actionable IPC failure reason while leaving legacy
 * credential recovery available.
 */
export type PasskeyStatusState =
  | {
      kind: "unavailable";
      reason: string;
      legacyRecoveryAvailable: boolean;
    }
  | {
      kind: "error";
      reason: string;
      legacyRecoveryAvailable: true;
    };

export function unavailablePasskeyStatus(
  status: PasskeyStatus,
): PasskeyStatusState {
  return {
    kind: "unavailable",
    reason: status.unavailableReason,
    legacyRecoveryAvailable: status.legacyCredentialsRequireReregistration,
  };
}

export function failedPasskeyStatus(error: unknown): PasskeyStatusState {
  return {
    kind: "error",
    reason: passkeyErrorMessage(error),
    legacyRecoveryAvailable: true,
  };
}
