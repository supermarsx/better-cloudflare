/**
 * The destination half of the expiry call to action.
 *
 * An expiry notice sends the user here about one name, so the workspace has to
 * single that name out on arrival, hand the target back so it can be sent again
 * later, and — when the provider is one the app can actually reach — offer the
 * renewal link. When the name is not among the configured registrar's domains
 * it has to say so, because the alternative is an empty card that reads as a
 * broken link.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RegistryMonitor } from "../src/components/registrar/RegistryMonitor";
import type { UseRegistrarMonitorResult } from "../src/hooks/registrar/use-registrar-monitor";
import i18n from "../src/i18n";
import type { DomainInfo, RegistrarProvider } from "../src/types/registrar";

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

function domain(name: string, registrar: RegistrarProvider): DomainInfo {
  return {
    domain: name,
    registrar,
    status: "active",
    created_at: "2025-01-01T00:00:00.000Z",
    expires_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    nameservers: { current: ["ada.ns.cloudflare.com"], is_custom: false },
    locks: { transfer_lock: true, auto_renew: false },
    dnssec: { enabled: true },
    privacy: { enabled: true },
  };
}

function monitor(domains: DomainInfo[]): UseRegistrarMonitorResult {
  return {
    credentials: [
      {
        id: "credential-1",
        provider: domains[0]?.registrar ?? "cloudflare",
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

test("a focus domain seeds the search, opens that row, and is handed back", () => {
  const handled: number[] = [];
  render(
    <RegistryMonitor
      monitor={monitor([
        domain("labs.test", "porkbun"),
        domain("other.test", "porkbun"),
      ])}
      focusDomain="labs.test"
      onFocusHandled={() => handled.push(1)}
    />,
  );

  const search = screen.getByRole("textbox");
  assert.equal((search as HTMLInputElement).value, "labs.test");
  // Filtered down to the one name the notice was about.
  assert.ok(screen.getByText("labs.test"));
  assert.equal(screen.queryByText("other.test"), null);
  // Its details are open, so the renewal link is visible without another click.
  assert.ok(
    screen.getByRole("button", {
      name: "Renew labs.test at Porkbun (porkbun.com)",
    }),
  );
  assert.deepEqual(
    handled,
    [1],
    "the target is applied once and handed back so it can be set again",
  );
});

test("the focus target matches the registrar's own spelling of the domain", () => {
  render(
    <RegistryMonitor
      monitor={monitor([domain("Labs.TEST", "porkbun")])}
      focusDomain="labs.test."
      onFocusHandled={() => {}}
    />,
  );

  assert.ok(
    screen.getByRole("button", {
      name: "Renew Labs.TEST at Porkbun (porkbun.com)",
    }),
    "a case or trailing-dot difference must not leave the row collapsed",
  );
});

test("no focus target leaves the search empty and every row collapsed", () => {
  render(
    <RegistryMonitor monitor={monitor([domain("labs.test", "porkbun")])} />,
  );

  assert.equal((screen.getByRole("textbox") as HTMLInputElement).value, "");
  assert.equal(screen.queryByTestId("registrar-site-link"), null);
});

test("expanding a row by hand still offers the renewal link", () => {
  render(
    <RegistryMonitor monitor={monitor([domain("labs.test", "godaddy")])} />,
  );

  fireEvent.click(screen.getByText("labs.test"));
  const link = screen.getByRole("button", {
    name: "Renew labs.test at GoDaddy (www.godaddy.com)",
  });
  assert.equal(
    link.getAttribute("data-registrar-url"),
    "https://www.godaddy.com/",
  );

  // And collapses again, taking the link with it.
  fireEvent.click(screen.getByText("labs.test"));
  assert.equal(screen.queryByTestId("registrar-site-link"), null);
});

test("a provider with no known site gets no link, not a guessed one", () => {
  render(
    <RegistryMonitor
      monitor={monitor([domain("labs.test", "google")])}
      focusDomain="labs.test"
      onFocusHandled={() => {}}
    />,
  );

  // The row is open — the rest of its details are there — but no link.
  assert.ok(screen.getByText("Nameservers"));
  assert.equal(screen.queryByTestId("registrar-site-link"), null);
});

test("arriving about a domain no registrar lists says so instead of nothing", () => {
  render(
    <RegistryMonitor
      monitor={monitor([domain("other.test", "porkbun")])}
      focusDomain="labs.test"
      onFocusHandled={() => {}}
    />,
  );

  assert.equal(
    screen.getByTestId("registry-no-matches").textContent,
    "No domain matches labs.test.",
  );
  assert.equal(screen.queryByTestId("registrar-site-link"), null);
});
