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
