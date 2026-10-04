/**
 * Permission-policy, persona and protocol-capability state.
 *
 * Kept apart from `use-ai-chat.ts` because the lifecycles differ: chat state is
 * per conversation and event-driven, whereas these are global, read-mostly and
 * only change when the user saves something — the capability map does not even
 * do that, since it describes the build rather than a setting.
 *
 * Every hook here treats the backend as the authority. Nothing here derives a
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

import { normalizeAiProtocolCapabilities } from "@/lib/ai/capabilities";
import { TauriClient } from "@/lib/api/tauri-client";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import type {
  AiPermissions,
  AiPermissionsSnapshot,
  AiPersona,
  AiPersonaInput,
  AiProtocolCapabilities,
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

export interface UseAiPermissionsOptions {
  /**
   * Whether to read at all. `false` keeps the hook mounted but issues no
   * `ai_get_permissions` and reports no snapshot, so a caller that only needs
   * the catalog in one state (the tool notice, which only speaks when tool use
   * is on) does not pay a round trip in the other. Defaults to `true`, which
   * is what the permission settings want.
   */
  enabled?: boolean;
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

export function useAiPermissions({
  enabled = true,
}: UseAiPermissionsOptions = {}): UseAiPermissionsResult {
  const available = isDesktop();
  const active = available && enabled;
  const [snapshot, setSnapshot] = useState<AiPermissionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!active) {
      // Not reading any more, so stop reporting what the last read said: a
      // count left on screen after the thing it described stopped applying is
      // worse than no count.
      refreshVersionRef.current += 1;
      if (mountedRef.current) {
        setSnapshot(null);
        setLoadError(null);
        setLoading(false);
      }
      return;
    }
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
  }, [active, mountedRef]);

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

export interface UseAiProtocolCapabilitiesResult {
  /**
   * `null` until a read succeeds — and it stays `null` on failure, because the
   * alternative is a map the renderer made up, and a made-up map is exactly
   * the claim ("this parameter reaches the provider") that this command exists
   * to stop the UI from inventing.
   */
  capabilities: AiProtocolCapabilities | null;
  loading: boolean;
  loadError: unknown;
  available: boolean;
  refresh: () => Promise<void>;
}

/**
 * Which advanced generation parameters each protocol honours.
 *
 * Read once per mount and never written: it describes the build, not the
 * user's settings, so nothing in the UI can change it. A failure is reported
 * rather than smoothed over — see {@link UseAiProtocolCapabilitiesResult}.
 */
export function useAiProtocolCapabilities(): UseAiProtocolCapabilitiesResult {
  const available = isDesktop();
  const [capabilities, setCapabilities] =
    useState<AiProtocolCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const mountedRef = useMountedRef();
  const refreshVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!available) return;
    const version = ++refreshVersionRef.current;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await TauriClient.aiProtocolCapabilities();
      // The payload crosses IPC, so it is narrowed rather than trusted. A
      // shape that is not a map at all reads as "could not be read".
      const normalized = normalizeAiProtocolCapabilities(result);
      if (mountedRef.current && refreshVersionRef.current === version) {
        setCapabilities(normalized);
        setLoadError(
          normalized === null
            ? new Error("ai_protocol_capabilities returned an unusable shape")
            : null,
        );
      }
    } catch (error) {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setCapabilities(null);
        setLoadError(error);
      }
      reportAiFailure(error, "Read AI protocol capabilities");
    } finally {
      if (mountedRef.current && refreshVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [available, mountedRef]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { capabilities, loading, loadError, available, refresh };
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
