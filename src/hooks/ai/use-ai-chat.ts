import { useCallback, useEffect, useRef, useState } from "react";
import { TauriClient, type UnlistenFn } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import {
  isAiCommandError,
  type AgentConfig,
  type AgentEvent,
  type AiProviderProfile,
  type AiProviderProfileInput,
  type Conversation,
  type ConversationMeta,
  type Model,
  type Preset,
} from "@/types/ai";

/**
 * How long a run may go without any `ai:event` before the composer unlocks
 * itself. The backend has no heartbeat, so a forwarder that dies mid-turn
 * (`ai_commands.rs:655-663` breaks its loop on the first emit failure) would
 * otherwise leave `streaming` true forever. Generous enough that a slow first
 * token on a cold provider does not trip it.
 */
export const AI_STREAM_WATCHDOG_MS = 90_000;

/** Shown when the watchdog fires. */
export const AI_STREAM_STALLED_MESSAGE = "The assistant stopped responding.";

/** A failure worth showing the user, flattened from either failure channel. */
export interface AiChatError {
  message: string;
  /** Operator-facing next step, when the backend supplied one. */
  remediation?: string;
  /** Whether offering a "Try again" action makes sense. */
  retryable: boolean;
}

/** The one `AgentEvent` variant that pauses a turn pending user action. */
export type AiToolApproval = Extract<
  AgentEvent,
  { type: "toolApprovalRequired" }
>;

function reportAiFailure(error: unknown, label: string): void {
  reportRuntimeError(error, { source: "runtime", label });
}

/**
 * Flatten a rejection into something renderable. Tauri rejects with the
 * serialized `AiCommandError` itself rather than an `Error`, so the structured
 * form is the common case and `retryable` comes straight from the backend.
 */
function toChatError(error: unknown, fallback: string): AiChatError {
  if (isAiCommandError(error)) {
    return {
      message: error.message,
      remediation: error.details.remediation,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, retryable: false };
  }
  if (typeof error === "string" && error.length > 0) {
    return { message: error, retryable: false };
  }
  return { message: fallback, retryable: false };
}

function useMountedRef() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

// ─── Provider hooks ────────────────────────────────────────────────────────

/**
 * The configured provider profiles, and the CRUD over them.
 *
 * Every mutation re-reads the list rather than patching it locally: the backend
 * normalizes an input (it resolves the protocol's default base URL, and decides
 * what `hasApiKey` is now), so the stored profile is not necessarily the one
 * that was sent.
 */
export function useAiProviders() {
  const available = isDesktop();
  const [providers, setProviders] = useState<AiProviderProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  /**
   * Resolves even when the read fails: the failure is recorded in `loadError`
   * for the settings screen to render, so an unreadable list shows a reason and
   * a retry rather than an empty list that looks like "no providers yet".
   */
  const refresh = useCallback(async () => {
    if (!available) return;
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiListProviders();
      if (mountedRef.current && refreshVersionRef.current === version) {
        setProviders(result);
        setLoadError(null);
      }
    } catch (error) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setProviders([]);
        setLoadError(error);
      }
      reportAiFailure(error, "Refresh AI providers");
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Save and verify in one call — the backend health-checks before storing, so
   * a rejection here means the provider does not work. The key is held in RAM
   * only and is gone after a restart.
   *
   * Resolves with the stored profile (`null` off desktop) so a caller can seed
   * its form from what was actually kept rather than from what it sent.
   */
  const configure = useCallback(
    async (
      profile: AiProviderProfileInput,
    ): Promise<AiProviderProfile | null> => {
      if (!available) return null;
      const stored = await TauriClient.aiConfigureProvider(profile);
      await refresh();
      return stored;
    },
    [available, refresh],
  );

  /** Forget a profile and its stored key. Rejects on refusal. */
  const remove = useCallback(
    async (id: string) => {
      if (!available) return;
      await TauriClient.aiDeleteProvider(id);
      await refresh();
    },
    [available, refresh],
  );

  const testProvider = useCallback(
    async (id: string): Promise<Model[]> => {
      if (!available) return [];
      return TauriClient.aiTestProvider(id);
    },
    [available],
  );

  const listModels = useCallback(
    async (id: string): Promise<Model[]> => {
      if (!available) return [];
      return TauriClient.aiListModels(id);
    },
    [available],
  );

  return {
    providers,
    loading,
    loadError,
    available,
    refresh,
    configure,
    remove,
    testProvider,
    listModels,
  };
}

// ─── Agent config hooks ────────────────────────────────────────────────────

/**
 * Bumped by every successful `ai_set_config`, so that instances of
 * {@link useAiConfig} in different component trees cannot disagree.
 *
 * There are two now: the assistant surface reads the config for its tool
 * posture and its default provider, and the settings screen — which lives in
 * the workspace's own Settings workspace, not inside the assistant — writes
 * it. They share no parent, so without this a user could turn tool use off in
 * Settings and have the open assistant keep reporting it on until something
 * remounted.
 *
 * A module-level counter rather than a shared store, deliberately: the backend
 * remains the single source of the config, each instance re-*reads* it, and
 * nothing here caches a value one component wrote for another to trust. It is
 * the same arrangement `useToast` uses for a different reason, and it adds no
 * second persistence path.
 */
let agentConfigRevision = 0;
const agentConfigListeners = new Set<(revision: number) => void>();

function announceAgentConfigWrite(): void {
  agentConfigRevision += 1;
  for (const listener of agentConfigListeners) listener(agentConfigRevision);
}

export function useAiConfig() {
  const available = isDesktop();
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [revision, setRevision] = useState(agentConfigRevision);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!available) return;
    const version = ++refreshVersionRef.current;
    const result = await TauriClient.aiGetConfig();
    if (mountedRef.current && refreshVersionRef.current === version) {
      setConfig(result);
    }
  }, [available, mountedRef]);

  useEffect(() => {
    agentConfigListeners.add(setRevision);
    return () => {
      agentConfigListeners.delete(setRevision);
    };
  }, []);

  useEffect(() => {
    void refresh().catch((error) =>
      reportAiFailure(error, "Refresh AI configuration"),
    );
    // `revision` is a trigger, not a value this reads: another instance has
    // written the config and this one's copy is stale.
  }, [refresh, revision]);

  const update = useCallback(
    async (newConfig: AgentConfig) => {
      if (!available) return;
      await TauriClient.aiSetConfig(newConfig);
      // The local copy first, so the form it was typed in does not blink
      // through a round trip, then every instance — this one included —
      // re-reads. Reading back is the more correct of the two: the backend
      // normalizes, so what was stored is not necessarily what was sent.
      if (mountedRef.current) setConfig(newConfig);
      announceAgentConfigWrite();
    },
    [available, mountedRef],
  );

  return { config, available, refresh, update };
}

// ─── Conversation hooks ────────────────────────────────────────────────────

/** Manage conversations (CRUD). */
export function useAiConversations() {
  const available = isDesktop();
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!available) return;
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiListConversations();
      if (mountedRef.current && refreshVersionRef.current === version) {
        setConversations(result);
      }
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, mountedRef]);

  useEffect(() => {
    void refresh().catch((error) =>
      reportAiFailure(error, "Refresh AI conversations"),
    );
  }, [refresh]);

  /**
   * Resolves `null` off desktop, where there is no backend to create in.
   * `provider` is an {@link AiProviderProfile.id}.
   */
  const create = useCallback(
    async (
      provider: string,
      model: string,
      title?: string,
      systemPrompt?: string,
    ): Promise<ConversationMeta | null> => {
      if (!available) return null;
      const meta = await TauriClient.aiCreateConversation(
        provider,
        model,
        title,
        systemPrompt,
      );
      await refresh();
      return meta;
    },
    [available, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!available) return;
      await TauriClient.aiDeleteConversation(id);
      await refresh();
    },
    [available, refresh],
  );

  const setTitle = useCallback(
    async (id: string, title: string) => {
      if (!available) return;
      await TauriClient.aiSetConversationTitle(id, title);
      await refresh();
    },
    [available, refresh],
  );

  /**
   * Point a conversation at a persona, or back at the configured one.
   *
   * Rejects on refusal, so the caller can show the backend's own message: a
   * switch is refused outright while a turn is running, and a persona that was
   * deleted since the list was read no longer exists to be chosen.
   */
  const setPersona = useCallback(
    async (id: string, personaId: string | null) => {
      if (!available) return;
      await TauriClient.aiSetConversationPersona(id, personaId);
      await refresh();
    },
    [available, refresh],
  );

  /** Point a conversation at a provider profile and a model, together. */
  const setProvider = useCallback(
    async (id: string, provider: string, model: string) => {
      if (!available) return;
      await TauriClient.aiSetConversationProvider(id, provider, model);
      await refresh();
    },
    [available, refresh],
  );

  return {
    conversations,
    loading,
    available,
    refresh,
    create,
    remove,
    setTitle,
    setPersona,
    setProvider,
  };
}

// ─── Chat hook ─────────────────────────────────────────────────────────────

export interface UseAiChatOptions {
  /** Override the stall watchdog, primarily for tests. */
  watchdogMs?: number;
}

/**
 * Hook for interacting with a specific conversation.
 * Handles sending messages, streaming events, tool approval, and cancellation.
 *
 * Streaming text is accumulated into `streamText` and rendered as a
 * provisional bubble below the persisted transcript. On `turnComplete` the
 * authoritative message exists in `ai_get_conversation`, so the buffer is
 * cleared — but only *after* the refresh settles, otherwise the transcript
 * blanks for the duration of the round trip. On `cancelled` and `error` the
 * backend never persists the partial text (it only stamps a status onto the
 * empty pending message, `agent.rs:296-309`), so the buffer is deliberately
 * kept: it is the only copy of what the user already read.
 */
export function useAiChat(
  conversationId: string | null,
  options: UseAiChatOptions = {},
) {
  const available = isDesktop();
  const watchdogMs = options.watchdogMs ?? AI_STREAM_WATCHDOG_MS;
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [pendingApproval, setPendingApproval] = useState<AiToolApproval | null>(
    null,
  );
  const [error, setError] = useState<AiChatError | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  /** (Re)start the stall timer. Every inbound event for this run pushes it out. */
  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      watchdogRef.current = null;
      if (!mountedRef.current) return;
      setStreaming(false);
      setError({ message: AI_STREAM_STALLED_MESSAGE, retryable: true });
    }, watchdogMs);
  }, [clearWatchdog, mountedRef, watchdogMs]);

  useEffect(() => clearWatchdog, [clearWatchdog]);

  /** Load the full conversation. Resolves `true` when state was updated from a live read. */
  const loadConversation = useCallback(async (): Promise<boolean> => {
    const version = ++refreshVersionRef.current;
    if (!conversationId || !available) {
      if (mountedRef.current) setConversation(null);
      return false;
    }
    try {
      const conv = await TauriClient.aiGetConversation(conversationId);
      if (!mountedRef.current || refreshVersionRef.current !== version) {
        return false;
      }
      setConversation(conv);
      return true;
    } catch (loadError) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setConversation(null);
      }
      reportAiFailure(loadError, "Load AI conversation");
      return false;
    }
  }, [available, conversationId, mountedRef]);

  const refresh = useCallback(async () => {
    await loadConversation();
  }, [loadConversation]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  // Switching conversations must not carry another run's stream state over.
  useEffect(() => {
    clearWatchdog();
    setStreaming(false);
    setStreamText("");
    setPendingApproval(null);
    setError(null);
  }, [conversationId, clearWatchdog]);

  /**
   * Settle a finished turn: refresh first, then drop the provisional buffer
   * only if the refresh actually produced the authoritative transcript.
   */
  const settleTurn = useCallback(
    async (clearBuffer: boolean) => {
      const loaded = await loadConversation();
      if (clearBuffer && loaded && mountedRef.current) setStreamText("");
    },
    [loadConversation, mountedRef],
  );

  // Listen for agent events.
  useEffect(() => {
    if (!conversationId || !available) return;

    let cancelled = false;

    const setup = async () => {
      const unlisten = await TauriClient.onAiEvent((payload) => {
        if (cancelled) return;
        // One global channel carries every conversation; filter our own out.
        if (payload.conversationId !== conversationId) return;

        switch (payload.type) {
          case "textDelta":
            armWatchdog();
            setStreamText((prev) => prev + payload.text);
            break;
          case "toolCallStart":
          case "toolCallComplete":
          case "usageUpdate":
            // Not terminal, but proof of life: push the stall timer out.
            armWatchdog();
            break;
          case "toolApprovalRequired":
            // The turn stops here and waits for the user, so the watchdog must
            // stand down — an unanswered prompt is not a stall.
            clearWatchdog();
            setStreaming(false);
            setPendingApproval(payload);
            break;
          case "turnComplete":
            clearWatchdog();
            setStreaming(false);
            void settleTurn(true);
            break;
          case "error":
            clearWatchdog();
            setStreaming(false);
            setError({ message: payload.error, retryable: false });
            void settleTurn(false);
            break;
          case "cancelled":
            clearWatchdog();
            setStreaming(false);
            void settleTurn(false);
            break;
        }
      });

      if (!cancelled) {
        unlistenRef.current = unlisten;
      } else {
        try {
          unlisten();
        } catch (unlistenError) {
          reportAiFailure(unlistenError, "Dispose stale AI event listener");
        }
      }
    };

    void setup().catch((setupError) =>
      reportAiFailure(setupError, "Subscribe to AI agent events"),
    );

    return () => {
      cancelled = true;
      try {
        unlistenRef.current?.();
      } catch (unlistenError) {
        reportAiFailure(unlistenError, "Unsubscribe from AI agent events");
      }
      unlistenRef.current = null;
    };
  }, [available, conversationId, armWatchdog, clearWatchdog, settleTurn]);

  /**
   * `providerId` is optional: omitted, the backend uses the conversation's own
   * provider and then `AgentConfig.defaultProviderId`. Passing it lets the
   * caller override for this turn without rewriting the conversation.
   */
  const sendMessage = useCallback(
    async (text: string, providerId?: string | null) => {
      if (!available) return;
      if (!conversationId) throw new Error("No conversation selected");

      setStreaming(true);
      setStreamText("");
      setPendingApproval(null);
      setError(null);
      // Armed before the call: `ai_send_message` only *starts* the turn, so a
      // reply that never arrives is exactly the case this guards.
      armWatchdog();

      try {
        await TauriClient.aiSendMessage(conversationId, text, providerId);
      } catch (sendError) {
        clearWatchdog();
        if (mountedRef.current) {
          setStreaming(false);
          setStreamText("");
          setError(toChatError(sendError, "The message could not be sent."));
        }
        reportAiFailure(sendError, "Send AI chat message");
        throw sendError;
      }
    },
    [available, armWatchdog, clearWatchdog, conversationId, mountedRef],
  );

  /**
   * Resume a paused turn. Retained for completeness — tool dispatch is denied
   * at a crate boundary in this build, so no UI should offer this.
   */
  const approveToolCall = useCallback(
    async (toolCallId: string) => {
      if (!available || !conversationId) return;
      const previousApproval = pendingApproval;
      setPendingApproval(null);
      setStreaming(true);
      armWatchdog();
      try {
        await TauriClient.aiApproveToolCall(conversationId, toolCallId);
      } catch (approveError) {
        clearWatchdog();
        if (mountedRef.current) {
          setStreaming(false);
          setPendingApproval(previousApproval);
          setError(
            toChatError(approveError, "The tool call could not be approved."),
          );
        }
        reportAiFailure(approveError, "Approve AI tool call");
        throw approveError;
      }
    },
    [
      available,
      armWatchdog,
      clearWatchdog,
      conversationId,
      mountedRef,
      pendingApproval,
    ],
  );

  const cancel = useCallback(async () => {
    if (!available || !conversationId) return;
    try {
      await TauriClient.aiCancelGeneration(conversationId);
    } catch (cancelError) {
      reportAiFailure(cancelError, "Cancel AI generation");
      throw cancelError;
    }
  }, [available, conversationId]);

  /** Resolves `null` off desktop. Rejects if the 8 MiB ceiling is exceeded. */
  const exportConversation = useCallback(async (): Promise<string | null> => {
    if (!available) return null;
    if (!conversationId) throw new Error("No conversation selected");
    return TauriClient.aiExportConversation(conversationId);
  }, [available, conversationId]);

  const dismissError = useCallback(() => setError(null), []);

  return {
    conversation,
    streaming,
    streamText,
    pendingApproval,
    error,
    available,
    refresh,
    sendMessage,
    approveToolCall,
    cancel,
    exportConversation,
    dismissError,
  };
}

// ─── Presets hook ──────────────────────────────────────────────────────────

/** Load available agent persona presets. */
export function useAiPresets() {
  const available = isDesktop();
  const [presets, setPresets] = useState<Preset[]>([]);
  const mountedRef = useMountedRef();

  useEffect(() => {
    if (!available) return;
    void TauriClient.aiListPresets()
      .then((nextPresets) => {
        if (mountedRef.current) setPresets(nextPresets);
      })
      .catch((error) => {
        reportAiFailure(error, "Load AI presets");
        if (mountedRef.current) setPresets([]);
      });
  }, [available, mountedRef]);

  const getPreset = useCallback(
    async (id: string): Promise<Preset | null> => {
      if (!available) return null;
      return TauriClient.aiGetPreset(id);
    },
    [available],
  );

  return { presets, available, getPreset };
}
