import { useCallback, useMemo } from 'react';
import type { DNSRecord, Zone } from '../types/dns';

export function useCloudflareAPI(apiKey?: string, email?: string) {
  const baseHeaders = useMemo(() => {
    if (!apiKey) return undefined;
    const h = new Headers();
    if (email) {
      h.set('X-Auth-Key', apiKey);
      h.set('X-Auth-Email', email);
    } else {
      h.set('Authorization', `Bearer ${apiKey}`);
    }
    h.set('Content-Type', 'application/json');
    return h;
  }, [apiKey, email]);

  const verifyToken = useCallback(
    async (
      key: string = apiKey ?? '',
      keyEmail: string | undefined = email,
      signal?: AbortSignal,
    ) => {
      const headers = new Headers();
      if (keyEmail) {
        headers.set('X-Auth-Key', key);
        headers.set('X-Auth-Email', keyEmail);
      } else {
        headers.set('Authorization', `Bearer ${key}`);
      }
      headers.set('Content-Type', 'application/json');
      const res = await fetch('/api/verify-token', {
        method: 'POST',
        headers,
        signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    },
    [apiKey, email],
  );

  const getZones = useCallback(
    (signal?: AbortSignal): Promise<Zone[]> => {
      if (!baseHeaders) return Promise.reject(new Error('API key not provided'));
      return fetch('/api/zones', { headers: baseHeaders, signal })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => data.result as Zone[]);
    },
    [baseHeaders],
  );

  const getDNSRecords = useCallback(
    (zoneId: string, signal?: AbortSignal): Promise<DNSRecord[]> => {
      if (!baseHeaders) return Promise.reject(new Error('API key not provided'));
      return fetch(`/api/zones/${zoneId}/dns_records`, { headers: baseHeaders, signal })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => data.result as DNSRecord[]);
    },
    [baseHeaders],
  );

  const createDNSRecord = useCallback(
    (zoneId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> => {
      if (!baseHeaders) return Promise.reject(new Error('API key not provided'));
      return fetch(`/api/zones/${zoneId}/dns_records`, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(record),
        signal,
      })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => data.result as DNSRecord);
    },
    [baseHeaders],
  );

  const updateDNSRecord = useCallback(
    (zoneId: string, recordId: string, record: Partial<DNSRecord>, signal?: AbortSignal): Promise<DNSRecord> => {
      if (!baseHeaders) return Promise.reject(new Error('API key not provided'));
      return fetch(`/api/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'PUT',
        headers: baseHeaders,
        body: JSON.stringify(record),
        signal,
      })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => data.result as DNSRecord);
    },
    [baseHeaders],
  );

  const deleteDNSRecord = useCallback(
    (zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> => {
      if (!baseHeaders) return Promise.reject(new Error('API key not provided'));
      return fetch(`/api/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'DELETE',
        headers: baseHeaders,
        signal,
      }).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      });
    },
    [baseHeaders],
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
