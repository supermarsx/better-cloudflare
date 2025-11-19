import { useCallback, useMemo } from 'react';
import { ServerClient } from '../lib/server-client';
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
    (zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> => {
      if (!api) return Promise.reject(new Error('API key not provided'));
      return api.getDNSRecords(zoneId, signal);
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

  return {
    verifyToken,
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    deleteDNSRecord,
  };
}
