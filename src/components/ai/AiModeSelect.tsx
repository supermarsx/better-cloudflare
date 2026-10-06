/**
 * The permission mode, changeable from inside the conversation.
 *
 * This is the one assistant setting you genuinely want to change mid-task —
 * "stop asking me" or, more often, "stop being able to touch anything" — and
 * walking to a settings screen to do it loses the thread you were in the
 * middle of. So it sits in the composer dock, directly above the message
 * input: what it decides is what happens when *this* message is sent, so it
 * belongs with the message rather than at the top of the surface, where a
 * scrolled conversation used to carry it out of sight.
 *
 * Three things it is careful about.
 *
 * **There is exactly one writer.** It saves through the same
 * `ai_set_permissions` path the settings screen uses, carrying the stored
 * per-tool overrides through untouched — a mode change must not silently
 * clear them. `useAiPermissions` keeps its instances in step, so this control
 * and that screen cannot report different modes, in either direction.
 *
 * **It states the consequence, from the shared table, without spending height
 * on it.** `readOnly` *denies* a write outright rather than prompting, which is
 * the one behaviour nobody guesses from the name, and switching to it mid-plan
 * will block steps that were runnable a moment ago. Both sentences come from
 * {@link AI_PERMISSION_MODE_COPY} rather than from a second copy here — and
 * both are now a `title` and an `aria-describedby` target rather than two
 * paragraphs under the control. Docked directly above the message input, those
 * paragraphs were about eight lines of permanent height in a 22rem sidebar,
 * which is height the transcript needs more. The information is relocated, not
 * dropped: hover reaches it, assistive technology is told about it as a
 * description of the control, and the per-option `title` carries each mode's
 * own consequence at the moment of choosing.
 *
 * Why not a description inside each dropdown option, which would be the better
 * placement: the shared `SelectItem` wraps *all* of its children in Radix's
 * `ItemText`, so anything added to an option is also what `SelectValue` paints
 * on the trigger — the whole paragraph would end up in the closed control.
 * Fixing that means changing `components/ui/select.tsx`, which this component
 * does not own.
 *
 * **It never shows a mode it has not read.** Until `ai_get_permissions`
 * answers there is no control, because a dropdown defaulted to `ask` would be
 * a claim about what the backend will do with the next tool call.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_PERMISSION_MODE_COPY,
  isAiPermissionMode,
} from "@/lib/ai/permissions";
import type { AiPermissionMode } from "@/types/ai";

import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";

export interface AiModeSelectProps {
  /** `null` until `ai_get_permissions` has answered. Renders nothing then. */
  mode: AiPermissionMode | null;
  /** An `ai_set_permissions` write is in flight. */
  saving: boolean;
  /**
   * Store a mode. The caller carries the existing per-tool overrides through;
   * this control never sees them, so it cannot drop them.
   */
  onChange: (mode: AiPermissionMode) => void;
  /** A DOM id prefix, so several instances cannot collide. */
  idPrefix: string;
}

export function AiModeSelect({
  mode,
  saving,
  onChange,
  idPrefix,
}: AiModeSelectProps) {
  const { t } = useI18n();
  if (mode === null) return null;

  const selectId = `${idPrefix}-mode`;
  const consequenceId = `${idPrefix}-mode-consequence`;
  const planWarningId = `${idPrefix}-mode-plan-warning`;
  const consequence = AI_PERMISSION_MODE_COPY.find(
    (entry) => entry.id === mode,
  )?.consequence;
  const consequenceText = consequence ? t(consequence, consequence) : null;
  // Only `readOnly` has it: a plan that was runnable a moment ago is not any
  // more, and its steps come back blocked rather than prompting.
  const planWarningText =
    mode === "readOnly"
      ? t(
          "A plan step that needs to change something will come back blocked while this is set, not ask you.",
          "A plan step that needs to change something will come back blocked while this is set, not ask you.",
        )
      : null;

  return (
    <section className="min-w-0" data-testid="ai-mode-select" data-mode={mode}>
      <Select
        value={mode}
        disabled={saving}
        onValueChange={(value) => {
          // A themed dropdown's handler is typed `(value: string) => void` and
          // the value comes from whichever item was rendered at the time, so
          // the string is narrowed before it can become a permission mode.
          // Junk is dropped rather than sent.
          if (isAiPermissionMode(value) && value !== mode) onChange(value);
        }}
      >
        <SelectTrigger
          id={selectId}
          // The name the visible label used to carry. It has to live somewhere
          // — a dropdown deciding what the assistant may do cannot be an
          // unnamed control — and an `aria-label` names it without spending a
          // line of the dock on a word the dropdown's own values already imply.
          aria-label={t(
            "What the assistant may do",
            "What the assistant may do",
          )}
          aria-describedby={
            planWarningText === null
              ? consequenceId
              : `${consequenceId} ${planWarningId}`
          }
          // Hover reaches what used to be printed underneath. Both sentences,
          // because this is the only place a sighted user can still read the
          // plan warning, and that is the consequence nobody guesses.
          title={[consequenceText, planWarningText].filter(Boolean).join(" ")}
          className={AI_SELECT_TRIGGER_CLASS}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={AI_SELECT_CONTENT_CLASS}>
          {AI_PERMISSION_MODE_COPY.map((entry) => (
            <SelectItem
              key={entry.id}
              value={entry.id}
              // Radix consumes `value`, so the chosen id never reaches the
              // DOM. Mirrored because which *value* an option carries is the
              // thing worth pinning: a label can be translated, an id cannot.
              data-value={entry.id}
              // Each option's own consequence, at the moment of choosing. A
              // `title` rather than visible text for the `ItemText` reason in
              // the file comment above.
              title={t(entry.consequence, entry.consequence)}
            >
              {t(entry.label, entry.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Not visible, not absent. `sr-only` keeps both sentences in the
          accessibility tree as the control's own description, so a screen
          reader still hears what the mode costs while the dock spends no
          height on it. */}
      <p
        id={consequenceId}
        className="sr-only"
        data-testid="ai-mode-consequence"
      >
        {consequenceText}
      </p>
      {planWarningText === null ? null : (
        <p
          id={planWarningId}
          className="sr-only"
          data-testid="ai-mode-plan-warning"
        >
          {planWarningText}
        </p>
      )}
    </section>
  );
}
