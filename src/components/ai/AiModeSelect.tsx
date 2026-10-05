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
 * **It states the consequence, from the shared table.** `readOnly` *denies* a
 * write outright rather than prompting, which is the one behaviour nobody
 * guesses from the name, and switching to it mid-plan will block steps that
 * were runnable a moment ago. The sentences come from
 * {@link AI_PERMISSION_MODE_COPY} rather than from a second copy here.
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
  const consequence = AI_PERMISSION_MODE_COPY.find(
    (entry) => entry.id === mode,
  )?.consequence;

  return (
    <section
      className="min-w-0 space-y-1"
      data-testid="ai-mode-select"
      data-mode={mode}
    >
      <label htmlFor={selectId} className="block text-xs font-medium">
        {t("What the assistant may do", "What the assistant may do")}
      </label>
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
        <SelectTrigger id={selectId} className={AI_SELECT_TRIGGER_CLASS}>
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
            >
              {t(entry.label, entry.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        role="note"
        data-testid="ai-mode-consequence"
        className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
      >
        {consequence ? t(consequence, consequence) : null}
      </p>
      {mode === "readOnly" ? (
        // The part that is specific to changing this mid-task rather than in
        // a settings screen: a plan that was runnable a moment ago is not any
        // more, and the steps will come back blocked rather than prompting.
        <p
          data-testid="ai-mode-plan-warning"
          className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
        >
          {t(
            "A plan step that needs to change something will come back blocked while this is set, not ask you.",
            "A plan step that needs to change something will come back blocked while this is set, not ask you.",
          )}
        </p>
      ) : null}
    </section>
  );
}
