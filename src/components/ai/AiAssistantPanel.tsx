/**
 * The AI assistant.
 *
 * This is the *only* assistant implementation. The tab, the dock and the
 * floating bubble are three chromes around this one component — see
 * `AiAssistantSurface` — so the conversation and its event subscription exist
 * once no matter where the user put them. `presentation` changes sizing,
 * scrolling and whether a dismiss affordance exists; it changes nothing about
 * what the assistant can do.
 *
 * **The assistant does not contain its own settings.** They are the
 * "Assistant" section of the app's Settings workspace — the same
 * `AiSettingsPanel`, re-hosted — so this component is the chat and nothing
 * else: no Chat/Settings view switch, no provider CRUD, and no writes to the
 * agent config. It still *reads* that config, for its tool posture and its
 * default provider, and `useAiConfig` keeps every instance in step so this
 * screen and the settings screen cannot disagree about what is in force.
 *
 * Tool state never gates chat. Dispatch works, and the agent loop advertises
 * only tools that pass both permission layers, so enabling tool use cannot
 * produce a doomed call — with nothing usable the model is offered no tools and
 * chats normally. `AiToolNotice` therefore reports the posture and the backend's
 * own availability counts; the composer does not consult it. A pending tool
 * call is still shown read-only: `ai_approve_tool_call` exists but this panel
 * does not offer it yet, and there is no per-tool reject command at all, so
 * "Stop this run" is the only way out of one. See `AiTranscript`.
 *
 * **The layout is a chat, not a document.** The panel is a bounded flex column
 * in every chrome: the conversation scrolls in the space that is left, and the
 * things the user acts *with* — the permission mode and the composer — sit in a
 * dock below it that does not scroll. A composer that lived at the end of the
 * scrolled content was pushed further down by every message and had to be
 * scrolled back to, which is the one control in here that must never be out of
 * reach. The tab has no definite height from its host, so it takes a share of
 * the viewport; the dock and the bubble are already sized by their chrome.
 *
 * Desktop only: every `ai_*` command is a Tauri command and
 * `server-client.ts` has no HTTP fallback for any of them.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

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
import { useAiLinks } from "@/hooks/ai/use-ai-links";
import { useAiPlan } from "@/hooks/ai/use-ai-plan";
import { useAiPermissions } from "@/hooks/ai/use-ai-settings";
import { useI18n } from "@/hooks/use-i18n";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { AiLinkNavigation } from "@/lib/ai/links";
import type { AiPermissionMode } from "@/types/ai";
import type { AiAssistantPresentation } from "@/lib/ai/presentation";
import { withObjectUrl } from "@/lib/runtime/resource-scope";
import { cn } from "@/lib/utils";

import { AiComposer } from "./AiComposer";
import { AiConversationList, aiConversationTabId } from "./AiConversationList";
import { AiLinkList } from "./AiLinkList";
import { AiModeSelect } from "./AiModeSelect";
import { AiPlanView } from "./AiPlanView";
import type { AiSettingsSection } from "./AiSettingsPanel";
import { AiToolNotice, type AiToolPosture } from "./AiToolNotice";
import { AiTranscript } from "./AiTranscript";
import { describeAiError } from "./ai-error";

export type { AiSettingsSection };

export interface AiAssistantPanelProps {
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
   * Opens the application's MCP tool permissions.
   *
   * A blocked plan step whose `refusal.source` is `mcpGrants` can only be
   * fixed there, and nothing under `ai_*` can change those grants — so the
   * assistant can point at the screen but cannot own it. Absent when the host
   * has no such screen, in which case the refusal still names the layer and
   * offers no button; an inert one would be worse than none.
   */
  onOpenMcpPermissions?: () => void;
  /**
   * Opens the app's Settings workspace on the assistant's own settings, at a
   * named section.
   *
   * The assistant no longer contains its settings — they are the "Assistant"
   * section of the app's Settings workspace — so the one place that needs to
   * reach them, a blocked plan step pointing at Tools & permissions, now goes
   * through the host. Absent when the host has no such screen, in which case
   * the refusal still names the layer and offers no button.
   */
  onOpenAssistantSettings?: (section: AiSettingsSection) => void;
  /**
   * How to follow a link the assistant offers, and the zone ids a zone or
   * record link is checked against.
   *
   * These are the host's existing navigation callbacks — the same ones behind
   * the expiry notice's "Check registration" and the inbox's "Go to record" —
   * so there is no second navigation path. Absent when the host does not own
   * the workspace: in-app links then render no control, while `external` links
   * still work because they need nothing from the host.
   */
  linkNavigation?: AiLinkNavigation;
  /**
   * Overrides the hook's stall watchdog. Exists so a test can reach the
   * stalled-run branch without waiting 90 s; production never passes it.
   */
  watchdogMs?: number;
}

export function AiAssistantPanel({
  presentation = "panel",
  onDismiss,
  onOpenMcpPermissions,
  onOpenAssistantSettings,
  linkNavigation,
  watchdogMs,
}: AiAssistantPanelProps = {}) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  // Scoped per instance: the dock and a workspace tab can both be mounted in
  // the same document while the placement is mid-change.
  const modeId = useId();
  /**
   * Scopes the conversation tab ids and names the region they control.
   *
   * The tabs are in `AiConversationList` and the region is the scroll area
   * below, so the two halves of the `aria-controls`/`aria-labelledby` pair are
   * in different components and the ids have to be minted somewhere both can
   * reach. Here, because this is what owns both.
   */
  const tabsId = useId();
  const transcriptPanelId = `${tabsId}-panel`;

  /**
   * The dock and the bubble are handed a height by their chrome; the tab is
   * not. Everything that differs between them follows from that: how the card
   * gets a bottom edge, how much padding it can afford, and whether the
   * standing explanation in the header is worth its height.
   */
  const framed = presentation !== "panel";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newProvider, setNewProvider] = useState<string | null>(null);
  const [modelByProvider, setModelByProvider] = useState<
    Record<string, string>
  >({});
  const [creating, setCreating] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
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
  /**
   * The conversation's plan.
   *
   * `revision` is the transcript's own timestamp because a plan has no event
   * of its own: the model proposes one through its `plan_propose` tool during
   * a turn, which appends to the transcript and emits nothing a plan reader
   * could subscribe to. Re-reading when the transcript changes is what makes a
   * newly proposed plan appear without a refresh.
   */
  const plan = useAiPlan(selectedId, {
    revision: chat.conversation?.updatedAt ?? null,
  });
  /**
   * The places the assistant is pointing at. Same lifecycle as the plan and
   * for the same reason: `link_offer` is a tool the model calls during a turn,
   * and it emits no event either.
   */
  const links = useAiLinks(selectedId, {
    revision: chat.conversation?.updatedAt ?? null,
  });

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
   * What the notice reports — not a gate. The old `blocked` posture is gone:
   * tool use being on is not an error condition, so an unread config means
   * "unknown", never "locked". A panel opening still does not write agent
   * config, which is why the unknown state is simply reported.
   */
  const posture: AiToolPosture =
    agentConfig.config === null
      ? "checking"
      : agentConfig.config.toolsEnabled
        ? "on"
        : "off";

  /**
   * The availability the notice speaks from, read only while tool use is on.
   *
   * It has to come from the backend: the catalog describes the assistant's own
   * policy, but a dispatch is also gated on the application's MCP grants, which
   * no `ai_*` command exposes. With tool use off there is nothing to report and
   * the read is skipped, so an assistant that never turns tools on never issues
   * `ai_get_permissions` from the chat view at all.
   */
  const toolPermissions = useAiPermissions({ enabled: posture === "on" });

  /**
   * Change the permission mode from inside the conversation.
   *
   * The stored per-tool overrides are carried through: a mode change must not
   * silently clear an override the user set in the settings screen. `save`
   * re-reads afterwards, because `ai_set_permissions` answers with the policy
   * and not with the catalog's new effective values.
   */
  const handleModeChange = useCallback(
    (mode: AiPermissionMode) => {
      const snapshot = toolPermissions.snapshot;
      if (!snapshot) return;
      setPanelError(null);
      void toolPermissions
        .save({ mode, tools: snapshot.tools })
        .catch((error) => {
          setPanelError(
            describeAiError(
              error,
              t(
                "The assistant's mode could not be changed.",
                "The assistant's mode could not be changed.",
              ),
            ).message,
          );
        });
    },
    [t, toolPermissions],
  );

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

  /**
   * Retitle a conversation.
   *
   * Rejects on refusal so the row can show the backend's own message: a
   * title is bounded in UTF-8 bytes, so one that looks short can still be
   * too long, and that ceiling is user-configurable.
   */
  const handleRename = useCallback(
    async (id: string, title: string) => {
      await conversations.setTitle(id, title);
    },
    [conversations],
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

  /**
   * The conversation's own scroll container, and whether to follow it.
   *
   * It exists because the composer is pinned below this region rather than
   * living at the end of it, so the transcript has somewhere to grow that is
   * not "downwards, past the input". The cost of that is a new message landing
   * below the fold, so the region follows its own tail — but only while the
   * user is already at the bottom: yanking someone back down while they are
   * reading an earlier answer is worse than not following at all.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    // Slack, because "at the bottom" is rarely an exact equality: fractional
    // line boxes and a zoomed window both leave a sub-pixel remainder.
    atBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= 32;
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || !atBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [chat.conversation, chat.streamText, chat.streaming]);

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

  /**
   * The only two things that can stop a message being sent: nowhere to send it,
   * and nothing to send it with. Tool state is deliberately absent — it is not
   * an error condition, and the agent loop offers the model no tools when none
   * are usable, so a chat with tool use on is just a chat.
   */
  const composerDisabled = selectedId === null || activeProvider === null;
  const composerReason = t(
    "Select a conversation, or start a new one.",
    "Select a conversation, or start a new one.",
  );

  // A stalled run and a rejected command both surface as `chat.error`, but they
  // need different offers: resending after a stall would duplicate a user
  // message the backend already persisted.
  const stalled = chat.error?.message === AI_STREAM_STALLED_MESSAGE;

  /** Whether the strip below renders a tablist at all. */
  const hasConversationTabs = conversations.conversations.length > 0;

  return (
    <Card
      className={cn(
        "flex flex-col border-border/60 bg-card/70",
        // The chrome decides where the bottom edge is. A framed surface hands
        // the panel a definite height to fill; the workspace tab hands it
        // none, and a card that grows with its transcript has no bottom edge
        // for a composer to be anchored to — so the tab claims a share of the
        // viewport instead, with a floor for short windows.
        framed ? "h-full min-h-0" : "h-[70dvh] min-h-[28rem]",
      )}
      data-testid="ai-panel"
      data-presentation={presentation}
    >
      <CardHeader className={cn("shrink-0 space-y-3", framed && "p-4")}>
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
      </CardHeader>
      <CardContent
        className={cn(
          // One column: a conversation that scrolls, then a dock that does
          // not. `min-h-0` is what lets the scroll region actually shrink —
          // without it a flex item refuses to go below its content height, the
          // column grows instead, and the dock leaves the bottom of the card.
          "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden",
          framed && "p-4 pt-0",
        )}
      >
        {/* The tab strip, pinned above the scroll region — the mirror of the
            composer dock below it. Inside the scroll region it travelled with
            the transcript, so switching conversation meant scrolling back up
            to find the switch; a tab strip that scrolls away is not a tab
            strip. One row, whatever the conversation count: it scrolls
            sideways rather than wrapping. */}
        <div className="shrink-0" data-testid="ai-conversation-dock">
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
            onRename={handleRename}
            idPrefix={tabsId}
            panelId={transcriptPanelId}
            compact={framed}
          />
        </div>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          id={transcriptPanelId}
          data-testid="ai-conversation-scroll"
          // The region the tabs above control. Only a `tabpanel` when there is
          // a tablist to own it: with no conversations there are no tabs, and
          // a panel nothing points at would be a claim about a relationship
          // that does not exist.
          role={hasConversationTabs ? "tabpanel" : undefined}
          aria-labelledby={
            hasConversationTabs && selectedId !== null
              ? aiConversationTabId(tabsId, selectedId)
              : undefined
          }
          className="scrollbar-themed min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto"
        >
          <AiToolNotice
            posture={posture}
            availability={toolPermissions.snapshot?.availability ?? null}
          />
          {/* The plan sits above the transcript, not below it, and the
                reason is the point of the whole screen: a blocked step has to
                be visible *before* the plan is approved, and the transcript
                grows without bound underneath it. It renders nothing at all
                when the conversation has no plan, so a chat that never
                proposes one costs no height — which is what lets the same
                component serve the tab, the 22rem dock and the 26rem bubble
                unchanged. */}
          <AiPlanView
            plan={plan.plan}
            summary={plan.summary}
            summaryError={plan.summaryError}
            loading={plan.loading}
            loadError={plan.loadError}
            busy={plan.busy}
            error={plan.error}
            compact={framed}
            onApprove={() => void plan.approve()}
            onRun={() => void plan.run()}
            onRunStep={(stepId) => void plan.runStep(stepId)}
            onApproveStep={(stepId) => void plan.approveStep(stepId)}
            onCancel={() => void plan.cancel()}
            onDelete={() => void plan.remove()}
            onRetry={() => void plan.refresh()}
            onDismissError={plan.dismissError}
            onOpenAssistantTools={
              onOpenAssistantSettings
                ? () => onOpenAssistantSettings("tools")
                : undefined
            }
            onOpenMcpPermissions={onOpenMcpPermissions}
          />
          {/* Where the assistant is pointing. A separate block from the
                plan because links are a property of the conversation, not of
                a plan or a step: the model offers a set and each offer
                replaces the last, so this is "where to look now". Renders
                nothing when it is pointing nowhere. */}
          <AiLinkList
            links={links.links}
            navigation={linkNavigation}
            heading={t("Places to look", "Places to look")}
            context="conversation"
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
        </div>

        {/* The dock: everything the user acts *with*, held at the bottom edge
            of the surface. It is a sibling of the scroll region rather than its
            last child, so no amount of conversation can push it down or scroll
            it out of reach. */}
        <div
          data-testid="ai-composer-dock"
          className="shrink-0 space-y-2 border-t border-border/60 pt-3"
        >
          {/* Both banners are here rather than above the transcript for the
              same reason the composer is: they report what just happened to
              the thing the user is holding, and at the top of a long
              conversation they would be reported off-screen — including the
              "Try again" that is the only offer after a failed send. */}
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

          {/* The mode, changeable without leaving the conversation, and
              directly above the input it governs — it answers "what will
              happen if I send this?", which is a question about the message
              being typed and not about the screen in general. Only while tool
              use is on: with it off every tool is denied whatever the mode
              says, so offering the choice there would imply it decided
              something. That is also the gate on the permission read, so an
              assistant with tools off still issues no `ai_get_permissions`. */}
          {posture === "on" ? (
            <AiModeSelect
              mode={toolPermissions.snapshot?.mode ?? null}
              saving={toolPermissions.saving}
              onChange={handleModeChange}
              idPrefix={modeId}
            />
          ) : null}

          <AiComposer
            disabled={composerDisabled}
            disabledReason={composerReason}
            streaming={chat.streaming}
            onSend={handleSend}
            onStop={handleStop}
          />
        </div>
      </CardContent>
    </Card>
  );
}
