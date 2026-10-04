/**
 * The AI assistant.
 *
 * This is the *only* assistant implementation. The tab, the dock and the
 * floating bubble are three chromes around this one component — see
 * `AiAssistantSurface` — so the conversation, its event subscription and its
 * settings exist once no matter where the user put them. `presentation` changes
 * sizing, scrolling and whether a dismiss affordance exists; it changes nothing
 * about what the assistant can do.
 *
 * Chat is tool-free by design. Tool dispatch is denied at a crate boundary
 * (`bc_mcp::tools::execute_tool` always returns an error and the real
 * dispatcher is `pub(crate)`), so this panel never offers an approve action —
 * it turns tool use off instead, which makes the whole broken path unreachable
 * rather than merely hidden. See `AiToolNotice` and `AiTranscript`. The
 * permission settings describe what the desktop service would decide; they do
 * not claim the dispatch path is open.
 *
 * Desktop only: every `ai_*` command is a Tauri command and
 * `server-client.ts` has no HTTP fallback for any of them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, X } from "lucide-react";
import {
  AI_STREAM_STALLED_MESSAGE,
  useAiChat,
  useAiConfig,
  useAiConversations,
  useAiProviders,
} from "@/hooks/ai/use-ai-chat";
import { useI18n } from "@/hooks/use-i18n";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { AiAssistantPresentation } from "@/lib/ai/presentation";
import { withObjectUrl } from "@/lib/runtime/resource-scope";
import { cn } from "@/lib/utils";
import type { AgentConfig, AiProviderProfileInput } from "@/types/ai";

import { AiComposer } from "./AiComposer";
import { AiConversationList } from "./AiConversationList";
import { AiSettingsPanel, type AiSettingsSection } from "./AiSettingsPanel";
import { AiToolNotice, type AiToolPosture } from "./AiToolNotice";
import { AiTranscript } from "./AiTranscript";
import { describeAiError } from "./ai-error";

export type AiAssistantView = "chat" | "settings";

export type { AiSettingsSection };

export interface AiAssistantPanelProps {
  initialView?: AiAssistantView;
  /**
   * Which chrome to wear. `panel` is the workspace tab and the default, so
   * every existing call site keeps the layout it had.
   */
  presentation?: AiAssistantPresentation;
  /**
   * Renders a dismiss affordance in the header. Omitted for the tab, which is
   * closed by the workspace tab bar instead.
   */
  onDismiss?: () => void;
  /**
   * Overrides the hook's stall watchdog. Exists so a test can reach the
   * stalled-run branch without waiting 90 s; production never passes it.
   */
  watchdogMs?: number;
}

export function AiAssistantPanel({
  initialView = "chat",
  presentation = "panel",
  onDismiss,
  watchdogMs,
}: AiAssistantPanelProps = {}) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();

  /** The tab scrolls with the workspace; the dock and bubble scroll inside. */
  const framed = presentation !== "panel";

  const [view, setView] = useState<AiAssistantView>(initialView);
  // Held here rather than inside the settings panel so that flipping to Chat
  // and back does not throw away which section the user was reading.
  const [settingsSection, setSettingsSection] =
    useState<AiSettingsSection>("providers");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newProvider, setNewProvider] = useState<string | null>(null);
  const [modelByProvider, setModelByProvider] = useState<
    Record<string, string>
  >({});
  const [creating, setCreating] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [disablingTools, setDisablingTools] = useState(false);
  const [savingAgentConfig, setSavingAgentConfig] = useState(false);
  const [lastSent, setLastSent] = useState<string | null>(null);
  // There is no reject command and `ai_cancel_generation` does not clear
  // `pending_tool_calls`, so a stopped run would otherwise leave its approval
  // card on screen until the next send. Dismissing it locally is the honest
  // outcome of "Stop this run"; nothing is approved either way.
  const [dismissedApprovalId, setDismissedApprovalId] = useState<string | null>(
    null,
  );

  const providers = useAiProviders();
  const agentConfig = useAiConfig();
  const conversations = useAiConversations();
  const chat = useAiChat(selectedId, watchdogMs ? { watchdogMs } : {});

  const configuredProviders = providers.providers;
  const defaultProviderId = agentConfig.config?.defaultProviderId ?? null;

  // Keep the new-conversation provider on something that is actually usable:
  // a profile can be deleted while this panel is open, and the configured
  // default can name one that no longer exists.
  useEffect(() => {
    setNewProvider((current) => {
      if (
        current !== null &&
        configuredProviders.some((entry) => entry.id === current)
      ) {
        return current;
      }
      if (
        defaultProviderId !== null &&
        configuredProviders.some((entry) => entry.id === defaultProviderId)
      ) {
        return defaultProviderId;
      }
      return configuredProviders[0]?.id ?? null;
    });
  }, [configuredProviders, defaultProviderId]);

  // Land on the most recent conversation rather than an empty transcript.
  useEffect(() => {
    if (selectedId !== null) return;
    const first = conversations.conversations[0];
    if (first) setSelectedId(first.id);
  }, [conversations.conversations, selectedId]);

  /**
   * The model for a new conversation defaults to the one the chosen provider
   * was configured with, and an override is remembered per provider — two
   * profiles on the same protocol will not serve the same model names.
   */
  const newModel = newProvider
    ? (modelByProvider[newProvider] ??
      configuredProviders.find((entry) => entry.id === newProvider)?.model ??
      "")
    : "";
  const setNewModel = useCallback(
    (value: string) => {
      if (!newProvider) return;
      setModelByProvider((prev) => ({ ...prev, [newProvider]: value }));
    },
    [newProvider],
  );

  /**
   * Fail closed: until the agent config has actually been read, the posture is
   * unknown and the composer stays locked. A panel opening must not silently
   * mutate global agent config, so turning tools off is an explicit action.
   */
  const posture: AiToolPosture =
    agentConfig.config === null
      ? "checking"
      : agentConfig.config.toolsEnabled
        ? "blocked"
        : "ready";

  const handleDisableTools = useCallback(() => {
    const current = agentConfig.config;
    if (!current) return;
    setDisablingTools(true);
    setPreflightError(null);
    void agentConfig
      .update({ ...current, toolsEnabled: false })
      .catch((error) => {
        setPreflightError(
          describeAiError(
            error,
            t(
              "Tool use could not be disabled.",
              "Tool use could not be disabled.",
            ),
          ).message,
        );
      })
      .finally(() => setDisablingTools(false));
  }, [agentConfig, t]);

  const handleRetryPreflight = useCallback(() => {
    setPreflightError(null);
    void agentConfig.refresh().catch((error) => {
      setPreflightError(
        describeAiError(
          error,
          t(
            "The assistant's tool settings could not be read.",
            "The assistant's tool settings could not be read.",
          ),
        ).message,
      );
    });
  }, [agentConfig, t]);

  /**
   * The persona lives in agent config, not in the persona list, so selecting
   * one is an `ai_set_config` write. The whole config is carried through: a
   * partial write would reset whatever the other sections last stored.
   */
  const handlePersonaSelect = useCallback(
    (personaId: string | null) => {
      const current = agentConfig.config;
      if (!current) return;
      setSavingAgentConfig(true);
      setPanelError(null);
      void agentConfig
        .update({ ...current, personaId })
        .catch((error) => {
          setPanelError(
            describeAiError(
              error,
              t(
                "The persona could not be selected.",
                "The persona could not be selected.",
              ),
            ).message,
          );
        })
        .finally(() => setSavingAgentConfig(false));
    },
    [agentConfig, t],
  );

  /**
   * The default provider is agent config too, for the same reason the persona
   * is: exactly one profile can be the default, which a flag per profile could
   * not guarantee.
   */
  const handleDefaultProviderSelect = useCallback(
    (providerId: string | null) => {
      const current = agentConfig.config;
      if (!current) return;
      if (current.defaultProviderId === providerId) return;
      setSavingAgentConfig(true);
      setPanelError(null);
      void agentConfig
        .update({ ...current, defaultProviderId: providerId })
        .catch((error) => {
          setPanelError(
            describeAiError(
              error,
              t(
                "The default provider could not be set.",
                "The default provider could not be set.",
              ),
            ).message,
          );
        })
        .finally(() => setSavingAgentConfig(false));
    },
    [agentConfig, t],
  );

  /** Rejects on refusal so the form can show the backend's own message. */
  const handleAgentConfigSave = useCallback(
    async (next: AgentConfig) => {
      await agentConfig.update(next);
    },
    [agentConfig],
  );

  /** Rejects on refusal so the provider form can show the backend's message. */
  const handleProviderSave = useCallback(
    (profile: AiProviderProfileInput) => providers.configure(profile),
    [providers],
  );

  const handleProviderDelete = useCallback(
    (id: string) => providers.remove(id),
    [providers],
  );

  // `refresh` records its own failure in `providers.loadError`, so the retry
  // needs no second error channel of its own.
  const handleRefreshProviders = useCallback(() => {
    void providers.refresh();
  }, [providers]);

  const handleCreate = useCallback(() => {
    if (!newProvider) return;
    const model = newModel.trim();
    if (model.length === 0) return;
    setCreating(true);
    setPanelError(null);
    void conversations
      .create(newProvider, model)
      .then((meta) => {
        if (meta) setSelectedId(meta.id);
      })
      .catch((error) => {
        setPanelError(
          describeAiError(
            error,
            t(
              "The conversation could not be created.",
              "The conversation could not be created.",
            ),
          ).message,
        );
      })
      .finally(() => setCreating(false));
  }, [conversations, newModel, newProvider, t]);

  const handleDelete = useCallback(
    (id: string) => {
      setPanelError(null);
      void conversations
        .remove(id)
        .then(() => {
          setSelectedId((current) => (current === id ? null : current));
        })
        .catch((error) => {
          setPanelError(
            describeAiError(
              error,
              t(
                "The conversation could not be deleted.",
                "The conversation could not be deleted.",
              ),
            ).message,
          );
        });
    },
    [conversations, t],
  );

  const handleExport = useCallback(() => {
    if (!selectedId) return;
    setPanelError(null);
    void chat
      .exportConversation()
      .then((payload) => {
        if (payload === null) return;
        const blob = new Blob([payload], { type: "application/json" });
        withObjectUrl(blob, (url) => {
          const link = document.createElement("a");
          link.href = url;
          link.download = `ai-conversation-${selectedId}.json`;
          document.body.append(link);
          try {
            link.click();
          } finally {
            link.remove();
          }
        });
      })
      .catch((error) => {
        // The 8 MiB ceiling is a hard error, not a truncation; the backend's
        // message names the limit and the actual size.
        setPanelError(
          describeAiError(
            error,
            t(
              "The conversation could not be exported.",
              "The conversation could not be exported.",
            ),
          ).message,
        );
      });
  }, [chat, selectedId, t]);

  const activeMeta = useMemo(
    () =>
      conversations.conversations.find((entry) => entry.id === selectedId) ??
      null,
    [conversations.conversations, selectedId],
  );
  const activeProvider =
    chat.conversation?.provider ?? activeMeta?.provider ?? null;

  const handleSend = useCallback(
    (text: string) => {
      if (!activeProvider) return;
      setLastSent(text);
      setPanelError(null);
      setDismissedApprovalId(null);
      // The hook already records the failure in `chat.error`; the rethrow is
      // its contract, not a second thing to report.
      void chat.sendMessage(text, activeProvider).catch(() => {});
    },
    [activeProvider, chat],
  );

  const handleStop = useCallback(() => {
    setDismissedApprovalId(chat.pendingApproval?.toolCallId ?? null);
    void chat.cancel().catch((error) => {
      setPanelError(
        describeAiError(
          error,
          t("The run could not be stopped.", "The run could not be stopped."),
        ).message,
      );
    });
  }, [chat, t]);

  const dismissButton = onDismiss ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={t("Close assistant", "Close assistant")}
      onClick={onDismiss}
    >
      <X aria-hidden="true" className="h-4 w-4" />
    </Button>
  ) : null;

  if (!chat.available) {
    return (
      <Card
        className={cn(
          "border-border/60 bg-card/70",
          framed && "flex h-full min-h-0 flex-col",
        )}
        data-testid="ai-panel"
        data-presentation={presentation}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <CardTitle className="text-lg">
            {t("Assistant", "Assistant")}
          </CardTitle>
          {dismissButton}
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t(
            "The assistant is only available in the desktop app.",
            "The assistant is only available in the desktop app.",
          )}
        </CardContent>
      </Card>
    );
  }

  const composerDisabled =
    posture !== "ready" || selectedId === null || activeProvider === null;
  const composerReason =
    posture === "blocked"
      ? t(
          "Disable tool use to start chatting.",
          "Disable tool use to start chatting.",
        )
      : posture === "checking"
        ? t(
            "Checking the assistant's tool settings…",
            "Checking the assistant's tool settings…",
          )
        : t(
            "Select a conversation, or start a new one.",
            "Select a conversation, or start a new one.",
          );

  // A stalled run and a rejected command both surface as `chat.error`, but they
  // need different offers: resending after a stall would duplicate a user
  // message the backend already persisted.
  const stalled = chat.error?.message === AI_STREAM_STALLED_MESSAGE;

  return (
    <Card
      className={cn(
        "border-border/60 bg-card/70",
        framed && "flex h-full min-h-0 flex-col",
      )}
      data-testid="ai-panel"
      data-presentation={presentation}
    >
      <CardHeader className={cn("space-y-3", framed && "shrink-0 p-4")}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className={framed ? "text-base" : "text-lg"}>
              {t("Assistant", "Assistant")}
            </CardTitle>
            {/* The dock and the bubble pay for every header row in transcript
                height, so the standing explanation is kept for the tab only.
                The same claim is restated by `AiToolNotice` in every chrome. */}
            {framed ? null : (
              <CardDescription className="mt-1">
                {t(
                  "Chat with a configured model. The assistant cannot change anything in your account.",
                  "Chat with a configured model. The assistant cannot change anything in your account.",
                )}
              </CardDescription>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={selectedId === null}
              aria-label={t("Export conversation", "Export conversation")}
              onClick={handleExport}
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
            {dismissButton}
          </div>
        </div>
        <div
          role="toolbar"
          aria-label={t("Assistant views", "Assistant views")}
          className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
        >
          <button
            type="button"
            className="ui-segment"
            data-active={view === "chat"}
            aria-pressed={view === "chat"}
            onClick={() => setView("chat")}
          >
            {t("Chat", "Chat")}
          </button>
          <button
            type="button"
            className="ui-segment"
            data-active={view === "settings"}
            aria-pressed={view === "settings"}
            onClick={() => setView("settings")}
          >
            {t("Settings", "Settings")}
          </button>
        </div>
      </CardHeader>
      <CardContent
        className={cn(
          "space-y-4",
          framed &&
            "scrollbar-themed min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4 pt-0",
        )}
      >
        <AiToolNotice
          posture={posture}
          busy={disablingTools}
          error={preflightError}
          onDisableTools={handleDisableTools}
          onRetry={handleRetryPreflight}
        />

        {panelError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {panelError}
          </p>
        ) : null}

        {chat.error ? (
          <div
            role="alert"
            data-testid="ai-error"
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <p>{chat.error.message}</p>
            {chat.error.remediation ? <p>{chat.error.remediation}</p> : null}
            <div className="flex flex-wrap gap-2">
              {stalled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void chat.refresh()}
                >
                  {t("Reload conversation", "Reload conversation")}
                </Button>
              ) : chat.error.retryable && lastSent ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleSend(lastSent)}
                >
                  {t("Try again", "Try again")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={chat.dismissError}
              >
                {t("Dismiss", "Dismiss")}
              </Button>
            </div>
          </div>
        ) : null}

        {view === "settings" ? (
          /* One section is mounted at a time: the permission catalog and the
             persona list are separate commands, and reading them because a
             provider form is open would be a round trip the user did not ask
             for. */
          <AiSettingsPanel
            section={settingsSection}
            onSectionChange={setSettingsSection}
            compact={framed}
            providers={providers.providers}
            providersLoading={providers.loading}
            providersError={providers.loadError}
            onRefreshProviders={handleRefreshProviders}
            onSaveProvider={handleProviderSave}
            onDeleteProvider={handleProviderDelete}
            config={agentConfig.config}
            configBusy={savingAgentConfig}
            onSaveConfig={handleAgentConfigSave}
            onSelectPersona={handlePersonaSelect}
            onSetDefaultProvider={handleDefaultProviderSelect}
          />
        ) : (
          <div className="space-y-4">
            <AiConversationList
              conversations={conversations.conversations}
              selectedId={selectedId}
              loading={conversations.loading}
              configuredProviders={configuredProviders}
              provider={newProvider}
              model={newModel}
              creating={creating}
              onProviderChange={setNewProvider}
              onModelChange={setNewModel}
              onCreate={handleCreate}
              onSelect={setSelectedId}
              onDelete={handleDelete}
            />
            <AiTranscript
              conversation={chat.conversation}
              streaming={chat.streaming}
              streamText={chat.streamText}
              incomplete={!chat.streaming && chat.streamText.length > 0}
              pendingApproval={
                chat.pendingApproval &&
                chat.pendingApproval.toolCallId !== dismissedApprovalId
                  ? chat.pendingApproval
                  : null
              }
              onStopRun={handleStop}
              reducedMotion={reducedMotion}
            />
            <AiComposer
              disabled={composerDisabled}
              disabledReason={composerReason}
              streaming={chat.streaming}
              onSend={handleSend}
              onStop={handleStop}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
