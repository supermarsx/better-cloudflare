import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import type {
  AgentConfig,
  AgentEvent,
  Conversation,
  ConversationMeta,
  Model,
  Preset,
  ProviderConfig,
  ProviderKind,
  ProviderStatus,
} from "@/types/ai";

function reportAiFailure(error: unknown, label: string): void {
  reportRuntimeError(error, { source: "runtime", label });
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

/** List all providers and their configuration status. */
export function useAiProviders() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await invoke<ProviderStatus[]>("ai_list_providers");
      if (mountedRef.current && refreshVersionRef.current === version) {
        setProviders(result);
      }
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh().catch((error) =>
      reportAiFailure(error, "Refresh AI providers"),
    );
  }, [refresh]);

  const configure = useCallback(
    async (config: ProviderConfig) => {
      await invoke("ai_configure_provider", { config });
      await refresh();
    },
    [refresh],
  );

  const testProvider = useCallback(
    async (kind: ProviderKind): Promise<Model[]> => {
      return invoke<Model[]>("ai_test_provider", { kind });
    },
    [],
  );

  const listModels = useCallback(
    async (kind: ProviderKind): Promise<Model[]> => {
      return invoke<Model[]>("ai_list_models", { kind });
    },
    [],
  );

  return { providers, loading, refresh, configure, testProvider, listModels };
}

// ─── Agent config hooks ────────────────────────────────────────────────────

/** Read and update agent configuration. */
export function useAiConfig() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    const result = await invoke<AgentConfig>("ai_get_config");
    if (mountedRef.current && refreshVersionRef.current === version) {
      setConfig(result);
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh().catch((error) =>
      reportAiFailure(error, "Refresh AI configuration"),
    );
  }, [refresh]);

  const update = useCallback(
    async (newConfig: AgentConfig) => {
      await invoke("ai_set_config", { config: newConfig });
      if (mountedRef.current) setConfig(newConfig);
    },
    [mountedRef],
  );

  return { config, refresh, update };
}

// ─── Conversation hooks ────────────────────────────────────────────────────

/** Manage conversations (CRUD). */
export function useAiConversations() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await invoke<ConversationMeta[]>("ai_list_conversations");
      if (mountedRef.current && refreshVersionRef.current === version) {
        setConversations(result);
      }
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh().catch((error) =>
      reportAiFailure(error, "Refresh AI conversations"),
    );
  }, [refresh]);

  const create = useCallback(
    async (
      provider: ProviderKind,
      model: string,
      title?: string,
      systemPrompt?: string,
    ): Promise<ConversationMeta> => {
      const meta = await invoke<ConversationMeta>("ai_create_conversation", {
        provider,
        model,
        title: title ?? null,
        systemPrompt: systemPrompt ?? null,
      });
      await refresh();
      return meta;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await invoke("ai_delete_conversation", { id });
      await refresh();
    },
    [refresh],
  );

  const setTitle = useCallback(
    async (id: string, title: string) => {
      await invoke("ai_set_conversation_title", { id, title });
      await refresh();
    },
    [refresh],
  );

  return { conversations, loading, refresh, create, remove, setTitle };
}

// ─── Chat hook ─────────────────────────────────────────────────────────────

/**
 * Hook for interacting with a specific conversation.
 * Handles sending messages, streaming events, tool approval, and cancellation.
 */
export function useAiChat(conversationId: string | null) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [pendingApproval, setPendingApproval] = useState<AgentEvent | null>(
    null,
  );
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  // Load the full conversation
  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    if (!conversationId) {
      if (mountedRef.current) setConversation(null);
      return;
    }
    try {
      const conv = await invoke<Conversation>("ai_get_conversation", {
        id: conversationId,
      });
      if (mountedRef.current && refreshVersionRef.current === version) {
        setConversation(conv);
      }
    } catch (error) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setConversation(null);
      }
      reportAiFailure(error, "Load AI conversation");
    }
  }, [conversationId, mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for agent events
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;

    const setup = async () => {
      const unlisten = await listen<AgentEvent>("ai:event", (event) => {
        if (cancelled) return;
        const payload = event.payload;

        if (payload.conversationId !== conversationId) return;

        switch (payload.type) {
          case "textDelta":
            setStreamText((prev) => prev + payload.text);
            break;
          case "toolApprovalRequired":
            setPendingApproval(payload);
            break;
          case "turnComplete":
            setStreaming(false);
            setStreamText("");
            void refresh();
            break;
          case "error":
            setStreaming(false);
            setStreamText("");
            void refresh();
            break;
          case "cancelled":
            setStreaming(false);
            setStreamText("");
            void refresh();
            break;
        }
      });

      if (!cancelled) {
        unlistenRef.current = unlisten;
      } else {
        try {
          unlisten();
        } catch (error) {
          reportAiFailure(error, "Dispose stale AI event listener");
        }
      }
    };

    void setup().catch((error) =>
      reportAiFailure(error, "Subscribe to AI agent events"),
    );

    return () => {
      cancelled = true;
      try {
        unlistenRef.current?.();
      } catch (error) {
        reportAiFailure(error, "Unsubscribe from AI agent events");
      }
      unlistenRef.current = null;
    };
  }, [conversationId, refresh]);

  // Send a message
  const sendMessage = useCallback(
    async (text: string, provider: ProviderKind) => {
      if (!conversationId) throw new Error("No conversation selected");

      setStreaming(true);
      setStreamText("");
      setPendingApproval(null);

      try {
        await invoke("ai_send_message", {
          conversationId,
          text,
          provider,
        });
      } catch (error) {
        if (mountedRef.current) {
          setStreaming(false);
          setStreamText("");
        }
        reportAiFailure(error, "Send AI chat message");
        throw error;
      }
    },
    [conversationId, mountedRef],
  );

  // Approve a tool call
  const approveToolCall = useCallback(
    async (toolCallId: string) => {
      if (!conversationId) return;
      const previousApproval = pendingApproval;
      setPendingApproval(null);
      try {
        await invoke("ai_approve_tool_call", { conversationId, toolCallId });
      } catch (error) {
        if (mountedRef.current) setPendingApproval(previousApproval);
        reportAiFailure(error, "Approve AI tool call");
        throw error;
      }
    },
    [conversationId, mountedRef, pendingApproval],
  );

  // Cancel generation
  const cancel = useCallback(async () => {
    if (!conversationId) return;
    try {
      await invoke("ai_cancel_generation", { conversationId });
    } catch (error) {
      reportAiFailure(error, "Cancel AI generation");
      throw error;
    }
  }, [conversationId]);

  // Export conversation
  const exportConversation = useCallback(async (): Promise<string> => {
    if (!conversationId) throw new Error("No conversation selected");
    return invoke<string>("ai_export_conversation", { id: conversationId });
  }, [conversationId]);

  return {
    conversation,
    streaming,
    streamText,
    pendingApproval,
    refresh,
    sendMessage,
    approveToolCall,
    cancel,
    exportConversation,
  };
}

// ─── Presets hook ──────────────────────────────────────────────────────────

/** Load available agent persona presets. */
export function useAiPresets() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const mountedRef = useMountedRef();

  useEffect(() => {
    void invoke<Preset[]>("ai_list_presets")
      .then((nextPresets) => {
        if (mountedRef.current) setPresets(nextPresets);
      })
      .catch((error) => {
        reportAiFailure(error, "Load AI presets");
        if (mountedRef.current) setPresets([]);
      });
  }, [mountedRef]);

  const getPreset = useCallback(async (id: string): Promise<Preset> => {
    return invoke<Preset>("ai_get_preset", { id });
  }, []);

  return { presets, getPreset };
}
