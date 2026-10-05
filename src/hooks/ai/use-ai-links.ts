/**
 * The places the assistant is pointing at.
 *
 * Links belong to the **conversation**, not to a plan, a step or a run: the
 * model offers a set through its own `link_offer` tool and each offer replaces
 * the last, so there is one list per conversation and it is "where to look
 * now" rather than a growing history.
 *
 * Like plans, links emit no event — `AgentEvent` belongs to a generation turn
 * — so an offer made during a turn is picked up by re-reading when the
 * transcript changes. That is what `revision` is for, and it is the same
 * arrangement `useAiPlan` uses for the same reason.
 *
 * A failed read reports `[]` **and** the failure. The empty list is what the
 * UI renders, and the failure is why: "the assistant is pointing at nothing"
 * and "we could not ask" look identical on screen otherwise, and only one of
 * them is a reason to retry.
 *
 * Desktop only, like every other `ai_*` call.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import type { AiLink } from "@/types/ai";

export interface UseAiLinksOptions {
  /**
   * Changes whenever the transcript does, so an offer the model made during a
   * turn is picked up. Any value works; only inequality is used.
   */
  revision?: string | number | null;
}

export interface UseAiLinksResult {
  /** Unvalidated as far as this hook is concerned — `resolveAiLink` decides. */
  links: AiLink[];
  loading: boolean;
  loadError: unknown;
  available: boolean;
  refresh: () => Promise<void>;
}

export function useAiLinks(
  conversationId: string | null,
  options: UseAiLinksOptions = {},
): UseAiLinksResult {
  const available = isDesktop();
  const revision = options.revision ?? null;
  const [links, setLinks] = useState<AiLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const mountedRef = useRef(true);
  const refreshVersionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const version = ++refreshVersionRef.current;
    if (!conversationId || !available) {
      if (mountedRef.current) {
        setLinks([]);
        setLoadError(null);
        setLoading(false);
      }
      return;
    }
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiGetLinks(conversationId);
      if (mountedRef.current && refreshVersionRef.current === version) {
        // A payload that is not an array at all reads as "no links", not as a
        // crash: the command answers `[]` for a conversation with none, so an
        // unusable shape is the same user-visible state with a logged reason.
        setLinks(Array.isArray(result) ? result : []);
        setLoadError(null);
      }
    } catch (readError) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLinks([]);
        setLoadError(readError);
      }
      reportRuntimeError(readError, {
        source: "runtime",
        label: "Read AI assistant links",
      });
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, conversationId]);

  useEffect(() => {
    void refresh();
    // `revision` is a deliberate extra trigger, not a value this reads: an
    // offer made during a turn arrives with no event of its own.
  }, [refresh, revision]);

  return { links, loading, loadError, available, refresh };
}
