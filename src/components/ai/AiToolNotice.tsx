/**
 * The assistant's tool posture, stated in the open.
 *
 * Tool calls cannot execute in this build: `bc_mcp::tools::execute_tool`
 * unconditionally returns `Err("Tool dispatch denied: explicit canonical
 * permission grants are required.")`, and the real dispatcher
 * (`execute_tool_with_grants`) is `pub(crate)`, so `bc-ai-tools` cannot reach
 * it. That is a compile-level boundary, not a setting.
 *
 * `AgentConfig::default()` nonetheless starts with `tools_enabled: true`, so a
 * fresh agent would offer the model tool definitions it can never run. Rather
 * than silently rewriting global agent config when a panel mounts, the panel
 * reads the config, and — if tools are on — blocks the composer behind this
 * banner and one explicit button.
 */
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";

/**
 * `checking` — the agent config has not been read yet, so the posture is
 * unknown and chat stays locked (fail closed).
 * `blocked` — tools are enabled and must be turned off before chatting.
 * `ready` — tools are off; the unreachable dispatch path cannot be entered.
 */
export type AiToolPosture = "checking" | "blocked" | "ready";

export interface AiToolNoticeProps {
  posture: AiToolPosture;
  /** A "Disable tool use" call is in flight. */
  busy?: boolean;
  /** Why the agent config could not be read or written. */
  error?: string | null;
  onDisableTools: () => void;
  onRetry: () => void;
}

export function AiToolNotice({
  posture,
  busy = false,
  error = null,
  onDisableTools,
  onRetry,
}: AiToolNoticeProps) {
  const { t } = useI18n();

  return (
    <div data-testid="ai-tool-warning" data-state={posture}>
      {posture === "blocked" ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>
            {t(
              "The assistant is set to offer tools, but tools cannot run in this build — every tool call would fail. Disable tool use to start chatting.",
              "The assistant is set to offer tools, but tools cannot run in this build — every tool call would fail. Disable tool use to start chatting.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onDisableTools}
          >
            {busy
              ? t("Disabling tool use…", "Disabling tool use…")
              : t("Disable tool use", "Disable tool use")}
          </Button>
        </div>
      ) : null}

      {posture === "checking" ? (
        error ? (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <p>
              {t(
                "The assistant's tool settings could not be read, so chat stays locked.",
                "The assistant's tool settings could not be read, so chat stays locked.",
              )}
            </p>
            <p>{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t("Try again", "Try again")}
            </Button>
          </div>
        ) : (
          <p
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {t(
              "Checking the assistant's tool settings…",
              "Checking the assistant's tool settings…",
            )}
          </p>
        )
      ) : null}

      {posture === "ready" ? (
        <p role="note" className="text-xs text-muted-foreground">
          {t(
            "Tool use is unavailable in this build. The assistant can read and discuss, but cannot change anything in your account.",
            "Tool use is unavailable in this build. The assistant can read and discuss, but cannot change anything in your account.",
          )}
        </p>
      ) : null}
    </div>
  );
}
