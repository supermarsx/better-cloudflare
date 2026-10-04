/**
 * Permission-policy and persona state.
 *
 * Kept apart from `use-ai-chat.ts` because the lifecycles differ: chat state is
 * per conversation and event-driven, whereas these two are global, read-mostly
 * and only change when the user saves something.
 *
 * Both hooks treat the backend as the authority. Nothing here derives a
 * permission or invents a persona id: a mutation is sent, and the state that
 * follows is whatever the backend reports afterwards. A write to the permission
 * policy therefore costs two round trips — `ai_set_permissions` stores the
 * policy and returns *only* the policy, so the catalog's new effective values
 * have to be re-read rather than computed from the mode locally.
 *
 * Desktop only, like every other `ai_*` call: `isDesktop()` gates each one and
 * there is no HTTP fallback.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import type {
  AiPermissions,
  AiPermissionsSnapshot,
  AiPersona,
  AiPersonaInput,
} from "@/types/ai";

function reportAiFailure(error: unknown, label: string): void {
  reportRuntimeError(error, { source: "runtime", label });
}

/** `false` once unmounted, so a late resolution cannot set state. */
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

export interface UseAiPermissionsResult {
  /** `null` until a read succeeds; never a locally fabricated default. */
  snapshot: AiPermissionsSnapshot | null;
  loading: boolean;
  saving: boolean;
  /** Why the policy could not be read. The component renders it. */
  loadError: unknown;
  available: boolean;
  refresh: () => Promise<void>;
  /** Store a policy, then re-read the catalog it resolves over. Rejects on failure. */
  save: (next: AiPermissions) => Promise<void>;
}

export function useAiPermissions(): UseAiPermissionsResult {
  const available = isDesktop();
  const [snapshot, setSnapshot] = useState<AiPermissionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!available) return;
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiGetPermissions();
      if (mountedRef.current && refreshVersionRef.current === version) {
        setSnapshot(result);
        setLoadError(null);
      }
    } catch (error) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        // Deliberately not falling back to a default policy: a made-up mode
        // would be a claim about what the backend will do with a tool call.
        setSnapshot(null);
        setLoadError(error);
      }
      reportAiFailure(error, "Read AI tool permissions");
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (next: AiPermissions) => {
      if (!available) return;
      if (mountedRef.current) setSaving(true);
      try {
        await TauriClient.aiSetPermissions(next);
        // The stored policy comes back from the write, but the *effective*
        // per-tool values do not, so the catalog has to be re-read.
        await refresh();
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [available, mountedRef, refresh],
  );

  return {
    snapshot,
    loading,
    saving,
    loadError,
    available,
    refresh,
    save,
  };
}

export interface UseAiPersonasResult {
  personas: AiPersona[];
  loading: boolean;
  loadError: unknown;
  available: boolean;
  refresh: () => Promise<void>;
  /** Resolves with the created persona, or `null` off desktop. */
  create: (persona: AiPersonaInput) => Promise<AiPersona | null>;
  update: (id: string, persona: AiPersonaInput) => Promise<AiPersona | null>;
  remove: (id: string) => Promise<void>;
}

export function useAiPersonas(): UseAiPersonasResult {
  const available = isDesktop();
  const [personas, setPersonas] = useState<AiPersona[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!available) return;
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiListPersonas();
      if (mountedRef.current && refreshVersionRef.current === version) {
        setPersonas(result);
        setLoadError(null);
      }
    } catch (error) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setPersonas([]);
        setLoadError(error);
      }
      reportAiFailure(error, "List AI personas");
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (persona: AiPersonaInput) => {
      if (!available) return null;
      const created = await TauriClient.aiCreatePersona(persona);
      await refresh();
      return created;
    },
    [available, refresh],
  );

  const update = useCallback(
    async (id: string, persona: AiPersonaInput) => {
      if (!available) return null;
      const updated = await TauriClient.aiUpdatePersona(id, persona);
      await refresh();
      return updated;
    },
    [available, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!available) return;
      await TauriClient.aiDeletePersona(id);
      await refresh();
    },
    [available, refresh],
  );

  return {
    personas,
    loading,
    loadError,
    available,
    refresh,
    create,
    update,
    remove,
  };
}
