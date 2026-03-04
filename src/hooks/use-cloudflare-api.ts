import { useCallback, useMemo } from "react";
import { ServerClient } from "../lib/api/server-client";
import type { EmailRoutingRuleInput } from "../lib/api/tauri-client";
import type { SPFGraph } from "@/lib/dns/spf";
import type { DNSRecord, Zone, ZoneSetting } from "../types/dns";

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
      key: string = apiKey ?? "",
      keyEmail: string | undefined = email,
      signal?: AbortSignal,
    ) => {
      if (api) {
        await api.verifyToken(signal);
        return;
      }
      if (!key) return Promise.reject(new Error("API key not provided"));
      const client = new ServerClient(key, undefined, keyEmail);
      await client.verifyToken(signal);
    },
    [api, apiKey, email],
  );

  const getZones = useCallback(
    (signal?: AbortSignal): Promise<Zone[]> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getZones(signal);
    },
    [api],
  );

  const getDNSRecords = useCallback(
    (
      zoneId: string,
      page?: number,
      perPage?: number,
      signal?: AbortSignal,
    ): Promise<DNSRecord[]> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getDNSRecords(zoneId, page, perPage, signal);
    },
    [api],
  );

  const createDNSRecord = useCallback(
    (
      zoneId: string,
      record: Partial<DNSRecord>,
      signal?: AbortSignal,
    ): Promise<DNSRecord> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.createDNSRecord(zoneId, record, signal);
    },
    [api],
  );

  const updateDNSRecord = useCallback(
    (
      zoneId: string,
      recordId: string,
      record: Partial<DNSRecord>,
      signal?: AbortSignal,
    ): Promise<DNSRecord> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.updateDNSRecord(zoneId, recordId, record, signal);
    },
    [api],
  );

  const deleteDNSRecord = useCallback(
    (zoneId: string, recordId: string, signal?: AbortSignal): Promise<void> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteDNSRecord(zoneId, recordId, signal);
    },
    [api],
  );

  const bulkCreateDNSRecords = useCallback(
    (
      zoneId: string,
      records: Partial<DNSRecord>[],
      dryrun?: boolean,
      signal?: AbortSignal,
    ) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.bulkCreateDNSRecords(zoneId, records, dryrun, signal);
    },
    [api],
  );

  const storeVaultSecret = useCallback(
    (id: string, secret: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.storeVaultSecret(id, secret);
    },
    [api],
  );

  const getVaultSecret = useCallback(
    (id: string, token?: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getVaultSecret(id, token);
    },
    [api],
  );

  const deleteVaultSecret = useCallback(
    (id: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteVaultSecret(id);
    },
    [api],
  );

  const getPasskeyRegistrationOptions = useCallback(
    (id: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getPasskeyRegistrationOptions(id);
    },
    [api],
  );

  const registerPasskey = useCallback(
    (id: string, attestation: unknown) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.registerPasskey(id, attestation);
    },
    [api],
  );

  const getPasskeyAuthOptions = useCallback(
    (id: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getPasskeyAuthOptions(id);
    },
    [api],
  );

  const authenticatePasskey = useCallback(
    (id: string, assertion: unknown) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.authenticatePasskey(id, assertion);
    },
    [api],
  );

  const listPasskeys = useCallback(
    (id: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.listPasskeys(id);
    },
    [api],
  );

  const deletePasskey = useCallback(
    (id: string, cid: string) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deletePasskey(id, cid);
    },
    [api],
  );

  const exportDNSRecords = useCallback(
    (
      zoneId: string,
      format: "json" | "csv" | "bind" = "json",
      page?: number,
      perPage?: number,
    ) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.exportDNSRecords(zoneId, format, page, perPage);
    },
    [api],
  );

  const purgeCache = useCallback(
    (
      zoneId: string,
      payload: { purge_everything?: boolean; files?: string[] },
      signal?: AbortSignal,
    ): Promise<unknown> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.purgeCache(zoneId, payload, signal);
    },
    [api],
  );

  const getZoneSetting = useCallback(
    <T = unknown>(
      zoneId: string,
      settingId: string,
      signal?: AbortSignal,
    ): Promise<ZoneSetting<T>> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getZoneSetting<T>(zoneId, settingId, signal);
    },
    [api],
  );

  const updateZoneSetting = useCallback(
    <T = unknown>(
      zoneId: string,
      settingId: string,
      value: T,
      signal?: AbortSignal,
    ): Promise<ZoneSetting<T>> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.updateZoneSetting<T>(zoneId, settingId, value, signal);
    },
    [api],
  );

  const getDnssec = useCallback(
    (zoneId: string, signal?: AbortSignal): Promise<unknown> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getDnssec(zoneId, signal);
    },
    [api],
  );

  const updateDnssec = useCallback(
    (
      zoneId: string,
      payload: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.updateDnssec(zoneId, payload, signal);
    },
    [api],
  );

  const simulateSPF = useCallback(
    (
      domain: string,
      ip: string,
    ): Promise<{ result: string; reasons: string[]; lookups: number }> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.simulateSPF(domain, ip);
    },
    [api],
  );

  const getSPFGraph = useCallback(
    (domain: string): Promise<SPFGraph> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return (api.getSPFGraph(domain) as Promise<SPFGraph>);
    },
    [api],
  );

  const registrarListAllDomains = useCallback(
    (): Promise<unknown[]> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.registrarListAllDomains();
    },
    [api],
  );

  const registrarHealthCheckAll = useCallback(
    (): Promise<unknown[]> => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.registrarHealthCheckAll();
    },
    [api],
  );

  // ── Analytics ─────────────────────────────────────────────────────────────

  const getZoneAnalytics = useCallback(
    (zoneId: string, since?: string, until?: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getZoneAnalytics(zoneId, since, until, signal);
    },
    [api],
  );

  const getDnsAnalytics = useCallback(
    (zoneId: string, since?: string, until?: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getDnsAnalytics(zoneId, since, until, signal);
    },
    [api],
  );

  // ── Firewall / WAF ───────────────────────────────────────────────────────

  const getFirewallRules = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getFirewallRules(zoneId, signal);
    },
    [api],
  );

  const createFirewallRule = useCallback(
    (zoneId: string, rule: { action: string; description?: string; filter: { expression: string } }, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.createFirewallRule(zoneId, rule, signal);
    },
    [api],
  );

  const updateFirewallRule = useCallback(
    (zoneId: string, ruleId: string, rule: { action: string; description?: string; filter: { expression: string } }, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.updateFirewallRule(zoneId, ruleId, rule, signal);
    },
    [api],
  );

  const deleteFirewallRule = useCallback(
    (zoneId: string, ruleId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteFirewallRule(zoneId, ruleId, signal);
    },
    [api],
  );

  const getIpAccessRules = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getIpAccessRules(zoneId, signal);
    },
    [api],
  );

  const createIpAccessRule = useCallback(
    (zoneId: string, mode: string, ip: string, notes?: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.createIpAccessRule(zoneId, mode, ip, notes, signal);
    },
    [api],
  );

  const deleteIpAccessRule = useCallback(
    (zoneId: string, ruleId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteIpAccessRule(zoneId, ruleId, signal);
    },
    [api],
  );

  const getWafRulesets = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getWafRulesets(zoneId, signal);
    },
    [api],
  );

  // ── Workers ───────────────────────────────────────────────────────────────

  const getWorkerRoutes = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getWorkerRoutes(zoneId, signal);
    },
    [api],
  );

  const createWorkerRoute = useCallback(
    (zoneId: string, pattern: string, script: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.createWorkerRoute(zoneId, pattern, script, signal);
    },
    [api],
  );

  const deleteWorkerRoute = useCallback(
    (zoneId: string, routeId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteWorkerRoute(zoneId, routeId, signal);
    },
    [api],
  );

  // ── Email Routing ─────────────────────────────────────────────────────────

  const getEmailRoutingSettings = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getEmailRoutingSettings(zoneId, signal);
    },
    [api],
  );

  const getEmailRoutingRules = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getEmailRoutingRules(zoneId, signal);
    },
    [api],
  );

  const createEmailRoutingRule = useCallback(
    (zoneId: string, rule: EmailRoutingRuleInput, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.createEmailRoutingRule(zoneId, rule, signal);
    },
    [api],
  );

  const deleteEmailRoutingRule = useCallback(
    (zoneId: string, ruleId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteEmailRoutingRule(zoneId, ruleId, signal);
    },
    [api],
  );

  // ── Page Rules ────────────────────────────────────────────────────────────

  const getPageRules = useCallback(
    (zoneId: string, signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.getPageRules(zoneId, signal);
    },
    [api],
  );

  // ── Bulk Operations ───────────────────────────────────────────────────────

  const deleteBulkDnsRecords = useCallback(
    (zoneId: string, recordIds: string[], signal?: AbortSignal) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.deleteBulkDnsRecords(zoneId, recordIds, signal);
    },
    [api],
  );

  // ── DNS Propagation ───────────────────────────────────────────────────────

  const checkDnsPropagation = useCallback(
    (domain: string, recordType: string, extraResolvers?: string[]) => {
      if (!api) return Promise.reject(new Error("API key not provided"));
      return api.checkDnsPropagation(domain, recordType, extraResolvers);
    },
    [api],
  );

  return {
    simulateSPF,
    getSPFGraph,
    registrarListAllDomains,
    registrarHealthCheckAll,
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
    listPasskeys,
    deletePasskey,
    exportDNSRecords,
    purgeCache,
    getZoneSetting,
    updateZoneSetting,
    getDnssec,
    updateDnssec,
    // Analytics
    getZoneAnalytics,
    getDnsAnalytics,
    // Firewall / WAF
    getFirewallRules,
    createFirewallRule,
    updateFirewallRule,
    deleteFirewallRule,
    getIpAccessRules,
    createIpAccessRule,
    deleteIpAccessRule,
    getWafRulesets,
    // Workers
    getWorkerRoutes,
    createWorkerRoute,
    deleteWorkerRoute,
    // Email Routing
    getEmailRoutingSettings,
    getEmailRoutingRules,
    createEmailRoutingRule,
    deleteEmailRoutingRule,
    // Page Rules
    getPageRules,
    // Bulk
    deleteBulkDnsRecords,
    // Propagation
    checkDnsPropagation,
  };
}
