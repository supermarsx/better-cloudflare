/**
 * The assistant's tool posture, stated in the open.
 *
 * Tool dispatch works. `bc_mcp::tools::execute_tool_with_grants` is public, the
 * executor holds a real grant handle, and the two permission layers — the
 * assistant's own policy and the application's canonical MCP grants — compose
 * as an intersection at the dispatch boundary. The agent loop advertises only
 * the tools that pass both (`ToolExecutor::usable_definitions`, called from
 * `bc-ai-agent/src/agent.rs`), so enabling tool use cannot produce a doomed
 * call: with nothing usable the model is simply offered no tools and chats.
 *
 * That is why this component gates nothing. It reports, and the composer does
 * not consult it. The one thing it must not do is guess — whether any tool can
 * run depends on the MCP grants, which no `ai_*` command exposes, so every
 * number here comes from the backend's own {@link AiToolAvailability} and
 * nothing is rendered until that has arrived.
 *
 * There is deliberately no error branch. Neither read that feeds this can
 * surface a failure to it: `useAiConfig` reports a failed `ai_get_config` to
 * the runtime error channel and exposes no error of its own, and a failed
 * `ai_get_permissions` is already reported, with a retry, by the Tools &
 * permissions section that owns that catalog. An unresolved read therefore
 * renders nothing here rather than an alert nobody could act on.
 */
import { useI18n } from "@/hooks/use-i18n";
import type { AiToolAvailability } from "@/types/ai";

/**
 * `checking` — agent config has not been read yet, so whether tool use is on
 *   is still unknown. Chat is unaffected either way.
 * `on` — tool use is enabled; what it amounts to is {@link AiToolAvailability}.
 * `off` — tool use is disabled, so no tool runs whatever the policy says.
 */
export type AiToolPosture = "checking" | "on" | "off";

export interface AiToolNoticeProps {
  posture: AiToolPosture;
  /**
   * From `ai_get_permissions`. `null` while the read is outstanding, or when
   * nothing asked for it — the counts are never inferred, so an unloaded
   * availability renders nothing rather than a plausible zero.
   */
  availability?: AiToolAvailability | null;
}

export function AiToolNotice({
  posture,
  availability = null,
}: AiToolNoticeProps) {
  const { t } = useI18n();

  // `dispatchAvailable` is the backend's own verdict on whether a UI should
  // still be advertising tools, so it is read rather than re-derived from the
  // counts; the counts only explain which of the two layers is empty.
  const unusable =
    posture === "on" && availability?.dispatchAvailable === false;

  return (
    <div data-testid="ai-tool-notice" data-state={posture}>
      {posture === "off" ? (
        <p role="note" className="text-xs text-muted-foreground">
          {t(
            "Tool use is off, so the assistant can read and discuss but will not change anything in your account.",
            "Tool use is off, so the assistant can read and discuss but will not change anything in your account.",
          )}
        </p>
      ) : null}

      {unusable && availability ? (
        // Informational, not an error: tool use being on with nothing granted
        // is a normal setup state, and chatting works regardless. Which of the
        // two layers is empty decides which settings screen to name, because
        // sending someone to the wrong one is worse than saying nothing.
        <p
          role="note"
          data-testid="ai-tool-none-usable"
          className="rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs break-words [overflow-wrap:anywhere]"
        >
          {availability.grantedToolCount === 0
            ? t(
                "Tool use is on, but the app grants the assistant none of its {{registered}} tools, so it has none to use. Grants live in the app's MCP server settings; the assistant's own rules are under Tools & permissions.",
                {
                  registered: availability.registeredToolCount,
                  defaultValue: `Tool use is on, but the app grants the assistant none of its ${availability.registeredToolCount} tools, so it has none to use. Grants live in the app's MCP server settings; the assistant's own rules are under Tools & permissions.`,
                },
              )
            : t(
                "Tool use is on, but the assistant's own permissions refuse all {{granted}} of the {{registered}} tools the app grants it, so it has none to use. Change that under Tools & permissions.",
                {
                  granted: availability.grantedToolCount,
                  registered: availability.registeredToolCount,
                  defaultValue: `Tool use is on, but the assistant's own permissions refuse all ${availability.grantedToolCount} of the ${availability.registeredToolCount} tools the app grants it, so it has none to use. Change that under Tools & permissions.`,
                },
              )}
        </p>
      ) : null}

      {posture === "on" && availability && !unusable ? (
        <p
          role="note"
          data-testid="ai-tool-usable"
          className="text-xs text-muted-foreground"
        >
          {t(
            "Tool use is on: the assistant can use {{usable}} of the {{registered}} tools in this app. Which ones, and whether each asks first, is listed under Tools & permissions.",
            {
              usable: availability.usableToolCount,
              registered: availability.registeredToolCount,
              defaultValue: `Tool use is on: the assistant can use ${availability.usableToolCount} of the ${availability.registeredToolCount} tools in this app. Which ones, and whether each asks first, is listed under Tools & permissions.`,
            },
          )}
        </p>
      ) : null}
    </div>
  );
}
