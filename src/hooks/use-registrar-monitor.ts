/**
 * React hook for registrar monitoring.
 *
 * Provides a higher-level API for the UI to interact with registrar
 * monitoring commands. All actual API calls go through ServerClient →
 * TauriClient → Rust backend, where the backend handles credentials and
 * HTTP requests. The hook only manages UI state.
 */
import { useCallback, useMemo, useState } from "react";
import { ServerClient } from "@/lib/server-client";
import type {
  DomainInfo,
  DomainHealthCheck,
  RegistrarCredential,
  RegistrarProvider,
} from "@/types/registrar";

export interface UseRegistrarMonitorResult {
  /** All configured registrar credentials (metadata only). */
  credentials: RegistrarCredential[];
  /** Domains fetched from all registrars. */
  domains: DomainInfo[];
  /** Health check results for monitored domains. */
  healthChecks: DomainHealthCheck[];
  /** Whether a loading operation is in progress. */
  isLoading: boolean;
  /** Last error message, if any. */
  error: string | null;

  // ─── Actions ────────────────────────────────────────────────────────
  /** Add a new registrar credential (backend stores secrets). */
  addCredential: (params: {
    provider: RegistrarProvider;
    label: string;
    apiKey: string;
    apiSecret?: string;
    username?: string;
    email?: string;
    extra?: Record<string, string>;
  }) => Promise<string>;

  /** Delete a registrar credential. */
  deleteCredential: (credentialId: string) => Promise<void>;

  /** Verify a registrar credential is accepted. */
  verifyCredential: (credentialId: string) => Promise<boolean>;

  /** Refresh the list of credentials. */
  refreshCredentials: () => Promise<void>;

  /** Fetch domains for a single credential. */
  listDomains: (credentialId: string) => Promise<DomainInfo[]>;

  /** Fetch domains from ALL configured credentials. */
  refreshAllDomains: () => Promise<void>;

  /** Run health checks on all domains. */
  runHealthChecks: () => Promise<void>;

  /** Run health check for a single domain. */
  runHealthCheck: (
    credentialId: string,
    domain: string,
  ) => Promise<DomainHealthCheck>;

  /** Clear the error state. */
  clearError: () => void;
}

/**
 * Hook that connects the registry monitoring UI to the backend.
 *
 * @param apiKey - the current user's Cloudflare API key (used for ServerClient)
 * @param email - optional email for key+email auth
 */
export function useRegistrarMonitor(
  apiKey?: string,
  email?: string,
): UseRegistrarMonitorResult {
  const api = useMemo(
    () => (apiKey ? new ServerClient(apiKey, undefined, email) : undefined),
    [apiKey, email],
  );

  const [credentials, setCredentials] = useState<RegistrarCredential[]>([]);
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [healthChecks, setHealthChecks] = useState<DomainHealthCheck[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const withLoading = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      setIsLoading(true);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const addCredential = useCallback(
    async (params: {
      provider: RegistrarProvider;
      label: string;
      apiKey: string;
      apiSecret?: string;
      username?: string;
      email?: string;
      extra?: Record<string, string>;
    }): Promise<string> => {
      if (!api) throw new Error("Not authenticated");
      return withLoading(async () => {
        const id = await api.addRegistrarCredential(
          params.provider,
          params.label,
          params.apiKey,
          params.apiSecret,
          params.username,
          params.email,
          params.extra,
        );
        // Refresh credentials list
        const creds = (await api.listRegistrarCredentials()) as RegistrarCredential[];
        setCredentials(creds);
        return id;
      });
    },
    [api, withLoading],
  );

  const deleteCredential = useCallback(
    async (credentialId: string): Promise<void> => {
      if (!api) throw new Error("Not authenticated");
      return withLoading(async () => {
        await api.deleteRegistrarCredential(credentialId);
        const creds = (await api.listRegistrarCredentials()) as RegistrarCredential[];
        setCredentials(creds);
      });
    },
    [api, withLoading],
  );

  const verifyCredential = useCallback(
    async (credentialId: string): Promise<boolean> => {
      if (!api) throw new Error("Not authenticated");
      return api.verifyRegistrarCredential(credentialId);
    },
    [api],
  );

  const refreshCredentials = useCallback(async (): Promise<void> => {
    if (!api) return;
    return withLoading(async () => {
      const creds = (await api.listRegistrarCredentials()) as RegistrarCredential[];
      setCredentials(creds);
    });
  }, [api, withLoading]);

  const listDomains = useCallback(
    async (credentialId: string): Promise<DomainInfo[]> => {
      if (!api) throw new Error("Not authenticated");
      return (await api.registrarListDomains(credentialId)) as DomainInfo[];
    },
    [api],
  );

  const refreshAllDomains = useCallback(async (): Promise<void> => {
    if (!api) return;
    return withLoading(async () => {
      const allDomains = (await api.registrarListAllDomains()) as DomainInfo[];
      setDomains(allDomains);
    });
  }, [api, withLoading]);

  const runHealthChecks = useCallback(async (): Promise<void> => {
    if (!api) return;
    return withLoading(async () => {
      const checks = (await api.registrarHealthCheckAll()) as DomainHealthCheck[];
      setHealthChecks(checks);
    });
  }, [api, withLoading]);

  const runHealthCheck = useCallback(
    async (
      credentialId: string,
      domain: string,
    ): Promise<DomainHealthCheck> => {
      if (!api) throw new Error("Not authenticated");
      return (await api.registrarHealthCheck(
        credentialId,
        domain,
      )) as DomainHealthCheck;
    },
    [api],
  );

  return {
    credentials,
    domains,
    healthChecks,
    isLoading,
    error,
    addCredential,
    deleteCredential,
    verifyCredential,
    refreshCredentials,
    listDomains,
    refreshAllDomains,
    runHealthChecks,
    runHealthCheck,
    clearError,
  };
}
