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

/**
 * How each choice is described, in offer order.
 *
 * Shared because the preference is offered in two places — the workspace's
 * Session settings and the assistant's own Behaviour section — and two copies of
 * these sentences would drift. The strings are English source text that each
 * call site passes through `t()`, which is the same arrangement
 * `AI_SETTINGS_SECTIONS` uses; they are already in the locale catalogues under
 * exactly these keys, so moving them here does not orphan a translation.
 *
 * `hint` names the consequence a user cannot guess from the label — what the
 * dock does to a narrow window, and how the bubble is dismissed — so the
 * difference between the three is readable without trying them. `saved` is what
 * a confirmation says afterwards.
 */
export const AI_ASSISTANT_PRESENTATION_OPTIONS: readonly {
  id: AiAssistantPresentation;
  label: string;
  hint: string;
  saved: string;
}[] = [
  {
    id: "panel",
    label: "Workspace tab",
    hint: "Opens as its own tab alongside zones and settings.",
    saved: "Assistant opens as a workspace tab.",
  },
  {
    id: "sidebar",
    label: "Docked sidebar",
    hint: "Stays beside the workspace while you move between tabs. In a narrow window it slides over the workspace instead of shrinking it.",
    saved: "Assistant docked beside the workspace.",
  },
  {
    id: "bubble",
    label: "Floating bubble",
    hint: "A button in the corner that opens a small chat window over the workspace. Escape closes it.",
    saved: "Assistant floats over the workspace.",
  },
] as const;

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
