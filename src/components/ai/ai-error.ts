/**
 * Flatten an AI command rejection into something renderable.
 *
 * Tauri rejects with the serialized `AiCommandError` value itself rather than
 * an `Error`, so the structured form is the common case. The backend has
 * already passed `message` through `sanitize_error_text`, so it is safe to
 * display — it never carries an API key.
 *
 * `use-ai-chat.ts` keeps an equivalent private helper for the failures it owns;
 * this one exists for the failures the panel owns directly (provider
 * configuration, export, delete), which never reach the hook.
 */
import { isAiCommandError } from "@/types/ai";

export interface AiDisplayError {
  message: string;
  /** Operator-facing next step, when the backend supplied one. */
  remediation?: string;
  /** Whether offering a "Try again" action makes sense. */
  retryable: boolean;
}

export function describeAiError(
  error: unknown,
  fallback: string,
): AiDisplayError {
  if (isAiCommandError(error)) {
    return {
      message: error.message,
      remediation: error.details.remediation,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message, retryable: false };
  }
  if (typeof error === "string" && error.length > 0) {
    return { message: error, retryable: false };
  }
  return { message: fallback, retryable: false };
}
