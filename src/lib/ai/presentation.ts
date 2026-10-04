/**
 * Where the assistant appears.
 *
 * One assistant implementation, three chromes:
 *
 * - `panel` — the workspace tab it has always been. Scrolls with the workspace.
 * - `sidebar` — docked beside the workspace, persistent across tab switches.
 * - `bubble` — a floating, dismissible surface over the workspace.
 *
 * The value is a user preference, so it arrives from `localStorage` and from a
 * session settings profile, both of which can hold anything. Everything that
 * reads one goes through {@link normalizeAiAssistantPresentation}, so an
 * unrecognised value lands on the tab that existed before this choice did
 * rather than on a blank workspace.
 */
export type AiAssistantPresentation = "panel" | "sidebar" | "bubble";

/** Every presentation, in the order the settings UI offers them. */
export const AI_ASSISTANT_PRESENTATIONS: readonly AiAssistantPresentation[] = [
  "panel",
  "sidebar",
  "bubble",
] as const;

/** The presentation an install with no stored preference gets. */
export const DEFAULT_AI_ASSISTANT_PRESENTATION: AiAssistantPresentation =
  "panel";

export function isAiAssistantPresentation(
  value: unknown,
): value is AiAssistantPresentation {
  return (
    typeof value === "string" &&
    (AI_ASSISTANT_PRESENTATIONS as readonly string[]).includes(value)
  );
}

export function normalizeAiAssistantPresentation(
  value: unknown,
): AiAssistantPresentation {
  return isAiAssistantPresentation(value)
    ? value
    : DEFAULT_AI_ASSISTANT_PRESENTATION;
}
