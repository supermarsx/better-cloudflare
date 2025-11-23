import { useCallback, useMemo } from 'react';
import { ServerClient } from '../lib/server-client';
import type { SPFGraph } from '@/lib/spf';
import type { DNSRecord, Zone } from '../types/dns';

/**
 * React hook exposing a higher-level API for interacting with the
 * server-proxied Cloudflare endpoints.
 *
 * When `apiKey` is provided the hook returns functions bound to a
 * `ServerClient` instance. If not provided the functions will reject when
 * called, which the UI may use to surface an error.
 *
 * @param apiKey - API key or token used for server-authenticated requests
 * @param email - optional email associated with the API key
 * @returns an object containing asynchronous helper functions for zones and
 * DNS record operations.
 */
export function useCloudflareAPI(apiKey?: string, email?: string) {
  const api = useMemo(
    () => (apiKey ? new ServerClient(apiKey, undefined, email) : undefined),
    [apiKey, email],
  );

  // No-op placeholder to trigger build of use-cloudflare-api changes if needed.
  const verifyToken = useCallback(
    async (
      key: string = apiKey ?? '',
      keyEmail: string | undefined = email,
      signal?: AbortSignal,
    ) => {
      if (api) {
        await api.verifyToken(signal);
        return;
      }
      if (!key) return Promise.reject(new Error('API key not provided'));
      const client = new ServerClient(key, undefined, keyEmail);
      await client.verifyToken(signal);
    },
    [api, apiKey, email],
  );

  const getZones = useCallback(
    (signal?: AbortSignal): Promise<Zone[]> => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.getZones(signal);
    },
    [api],
  );

  const getDNSRecords = useCallback(
    (zoneId: string, page?: number, perPage?: number, signal?: AbortSignal): Promise<DNSRecord[]> => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.getDNSRecords(zoneId, page, perPage, signal);
    },
    [api],
  );

  const createDNSRecord = useCallback(
    (zoneId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.createDNSRecord(zoneId, record, signal);
    },
    [api],
  );

  const updateDNSRecord = useCallback(
    (zoneId: string, recordId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.updateDNSRecord(zoneId, recordId, record, signal);
    },
    [api],
  );

  const deleteDNSRecord = useCallback(
    (zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.deleteDNSRecord(zoneId, recordId, signal);
    },
    [api],
  );

  const bulkCreateDNSRecords = useCallback(
    (zoneId: string, records: Partial<DNSRecord>[], dryrun?: boolean, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.bulkCreateDNSRecords(zoneId, records, dryrun, signal);
    },
    [api],
  );

  const storeVaultSecret = useCallback((id: string, secret: string) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.storeVaultSecret(id, secret);
  }, [api]);

  const getVaultSecret = useCallback((id: string) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.getVaultSecret(id);
  }, [api]);

  const deleteVaultSecret = useCallback((id: string) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.deleteVaultSecret(id);
  }, [api]);

  const getPasskeyRegistrationOptions = useCallback((id: string) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.getPasskeyRegistrationOptions(id);
  }, [api]);

  const registerPasskey = useCallback((id: string, attestation: unknown) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.registerPasskey(id, attestation);
  }, [api]);

  const getPasskeyAuthOptions = useCallback((id: string) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.getPasskeyAuthOptions(id);
  }, [api]);

  const authenticatePasskey = useCallback((id: string, assertion: unknown) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.authenticatePasskey(id, assertion);
  }, [api]);

  const exportDNSRecords = useCallback((zoneId: string, format: 'json'|'csv'|'bind' = 'json', page?: number, perPage?: number) => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.exportDNSRecords(zoneId, format, page, perPage);
  }, [api]);

  const simulateSPF = useCallback((domain: string, ip: string): Promise<{ result: string; reasons: string[]; lookups: number }> => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.simulateSPF(domain, ip);
  }, [api]);

  const getSPFGraph = useCallback((domain: string): Promise<SPFGraph> => {
    if (!api) return Promise.reject(new Error('API key not provided'));
    return api.getSPFGraph(domain);
  }, [api]);

  return {
      simulateSPF,
      getSPFGraph,
    verifyToken,
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    deleteDNSRecord,
    bulkCreateDNSRecords,
    storeVaultSecret,
    getVaultSecret,
    deleteVaultSecret,
    getPasskeyRegistrationOptions,
    registerPasskey,
    getPasskeyAuthOptions,
    authenticatePasskey,
    exportDNSRecords,
  };
}
