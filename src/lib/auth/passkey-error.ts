function recordErrorMessage(
  error: Record<string, unknown>,
): string | undefined {
  for (const key of ["message", "detail", "error"]) {
    if (typeof error[key] === "string" && error[key].trim()) {
      return error[key].trim();
    }
  }
  return undefined;
}

/** Retain the backend's security explanation instead of replacing it with a generic toast. */
export function passkeyErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof error === "object" && error !== null) {
    const message = recordErrorMessage(error as Record<string, unknown>);
    if (message) return message;
  }
  return "The passkey operation failed. Review the security status and try a supported recovery action.";
}

/**
 * The `DOMException` name a WebAuthn ceremony failed with, if it failed in the
 * client at all.
 *
 * The name is the only part that identifies the failure. A `DOMException`'s
 * `message` does **not** contain it — Chromium's `NotAllowedError` reads "The
 * operation either timed out or was not allowed." and nothing more — so the
 * substring matching this replaces could never have fired for any of the
 * client-side cases it claimed to cover.
 *
 * Backend errors arrive as plain strings or records over IPC and have no
 * `name` worth reading, so those return `null` and fall through to the
 * backend's own explanation.
 */
export function webauthnErrorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.endsWith("Error") ? name : null;
}

/**
 * What to tell the user about a ceremony that did not complete.
 *
 * This matters more than it used to. The client probe no longer withholds the
 * buttons when it cannot see an authenticator, so a user with only a security
 * key — or on a webview that under-reports Windows Hello — now reaches a real
 * ceremony, and this message is the whole of what they learn from it.
 *
 * `null` when the failure is not one of the named client-side cases, so the
 * caller can fall back to the backend's own text rather than paper over it.
 */
export function webauthnCeremonyMessage(
  error: unknown,
  ceremony: "register" | "authenticate",
): string | null {
  const registering = ceremony === "register";

  switch (webauthnErrorName(error)) {
    case "NotAllowedError":
      // Chromium reports a dismissed prompt and an expired one identically, so
      // the message must cover both rather than accusing the user of cancelling.
      return registering
        ? "Registration was dismissed, timed out, or refused by your device. If no prompt appeared, no authenticator was reachable — try a security key, or your phone."
        : "Sign-in was dismissed, timed out, or refused by your device. If no prompt appeared, none of this key's passkeys are available on this device.";

    case "InvalidStateError":
      // Only reachable through excludeCredentials, and only on registration.
      return registering
        ? "This authenticator already has a passkey for this API key. Use it to sign in, or remove the existing passkey first."
        : null;

    case "NotSupportedError":
      return "Your device could not provide a passkey of a type this app accepts.";

    case "SecurityError":
      return "The browser refused the ceremony for this window's origin. Passkeys need a secure context.";

    case "AbortError":
      return registering
        ? "Registration was cancelled before it finished."
        : "Sign-in was cancelled before it finished.";

    case "ConstraintError":
      return "Your device could not satisfy the user-verification this app requires. A device PIN, fingerprint or face unlock must be set up on the authenticator.";

    case "UnknownError":
      return registering
        ? "Your device could not complete the registration and did not say why. Trying a different authenticator usually works."
        : "Your device could not complete the sign-in and did not say why.";

    default:
      return null;
  }
}
