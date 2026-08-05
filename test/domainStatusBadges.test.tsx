import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import {
  DnsWorkspaceTabs,
  type DnsWorkspaceTabItem,
} from "../src/components/dns/DnsWorkspaceTabs";
import { RegistryMonitor } from "../src/components/registrar/RegistryMonitor";
import type { UseRegistrarMonitorResult } from "../src/hooks/registrar/use-registrar-monitor";
import i18n from "../src/i18n";
import type { DomainInfo } from "../src/types/registrar";

async function waitForI18nInitialization(): Promise<void> {
  if (i18n.isInitialized) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      i18n.off("initialized", onInitialized);
      reject(new Error("Timed out waiting for i18n initialization"));
    }, 5_000);
    const onInitialized = () => {
      clearTimeout(timeout);
      resolve();
    };
    i18n.on("initialized", onInitialized);
  });
}

beforeEach(async () => {
  await waitForI18nInitialization();
});

afterEach(() => {
  cleanup();
});

test("zone tabs hide normalized active statuses and retain every other status", () => {
  const items: DnsWorkspaceTabItem[] = [
    { id: "active", label: "Active domain", kind: "zone", status: "active" },
    {
      id: "normalized-active",
      label: "Normalized active domain",
      kind: "zone",
      status: "  AcTiVe  ",
    },
    { id: "pending", label: "Pending domain", kind: "zone", status: "pending" },
    {
      id: "future",
      label: "Future domain",
      kind: "zone",
      status: "provisioning-next",
    },
  ];

  render(
    <DnsWorkspaceTabs
      items={items}
      activeId="active"
      closeOnMiddleClick={false}
      onActivate={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
      onMoveToEnd={() => {}}
    />,
  );

  assert.equal(screen.queryByText(/^\s*active\s*$/i), null);
  assert.ok(screen.getByText("pending"));
  assert.ok(screen.getByText("provisioning-next"));
});

function domain(domainName: string, status: string): DomainInfo {
  return {
    domain: domainName,
    registrar: "cloudflare",
    status: status as DomainInfo["status"],
    created_at: "2025-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    nameservers: { current: ["ada.ns.cloudflare.com"], is_custom: false },
    locks: { transfer_lock: true, auto_renew: true },
    dnssec: { enabled: true },
    privacy: { enabled: true },
  };
}

function registrarMonitor(domains: DomainInfo[]): UseRegistrarMonitorResult {
  return {
    credentials: [
      {
        id: "credential-1",
        provider: "cloudflare",
        label: "Primary registrar",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    domains,
    healthChecks: [],
    isLoading: false,
    error: null,
    addCredential: async () => "credential-2",
    deleteCredential: async () => {},
    verifyCredential: async () => true,
    refreshCredentials: async () => {},
    listDomains: async () => [],
    refreshAllDomains: async () => {},
    runHealthChecks: async () => {},
    runHealthCheck: async (_credentialId, domainName) => ({
      domain: domainName,
      status: "healthy",
      checks: [],
      checked_at: "2026-01-01T00:00:00.000Z",
    }),
    clearError: () => {},
  };
}

test("registry rows hide normalized active statuses and retain every other status", () => {
  render(
    <RegistryMonitor
      monitor={registrarMonitor([
        domain("active.example", "active"),
        domain("normalized-active.example", "  AcTiVe  "),
        domain("pending.example", "pending"),
        domain("future.example", "provisioning-next"),
      ])}
    />,
  );

  assert.equal(screen.queryByText(/^\s*active\s*$/i), null);
  assert.ok(screen.getByText("pending"));
  assert.ok(screen.getByText("provisioning-next"));
});
