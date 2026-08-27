/**
 * Documentation screenshot harness.
 *
 *   npm run screenshots
 *
 * Drives the real app in Chromium with a stubbed `window.__TAURI_INTERNALS__`
 * (the same mechanism `e2e/authenticated-workspace.spec.ts` uses) so every
 * screen renders from seeded, entirely fictional data - no Cloudflare account,
 * no credentials, no network calls.
 *
 * Output: `docs/screenshots/<theme>/<screen>.png`, capped at
 * `OUTPUT_MAX_WIDTH` (see below) and palette-compressed on write - never the
 * raw `deviceScaleFactor: 2` capture. Capturing at 2x and downscaling on write
 * is deliberate supersampling (better anti-aliasing than capturing at 1x),
 * not an accident to compress after the fact. Do not point `page.screenshot`
 * at `path:` directly; always route through `writeOptimizedPng` below, or a
 * future run will silently reintroduce tens of MB of oversized PNGs.
 *
 * The harness is deliberately loud. A screen that cannot be reached, a Tauri
 * command the stub does not answer, or an uncaught page error fails the run and
 * the partial PNG is deleted, because a silently broken screenshot in a README
 * is worse than a missing one.
 */

import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { readRunningDevServer } from "./dev-port.mjs";
import { startNextDev } from "./dev-server.mjs";

import {
  DEMO_IMPORT_JSON,
  DEMO_NOTIFICATIONS,
  DEMO_NOTIFICATION_SETTINGS,
  DEMO_NOTIFICATION_STATUS,
  DEMO_NOTIFICATION_ZONE_SUMMARY,
  type DemoNotification,
} from "../e2e/fixtures/demo-panels.js";
import {
  createDemoSeed,
  DEMO_API_KEYS,
  DEMO_DECRYPTED_TOKEN,
  DEMO_PASSWORD,
  DEMO_ZONES,
  type DemoSeed,
} from "../e2e/fixtures/demo-workspace.js";

const SEED_IMPORT_JSON = DEMO_IMPORT_JSON;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const OUTPUT_ROOT = path.join(REPO_ROOT, "docs", "screenshots");

/** Wide enough that the 1152px (`max-w-6xl`) workspace never feels cramped. */
const VIEWPORT = { width: 1440, height: 960 };
const DEVICE_SCALE_FACTOR = 2;

/**
 * README images render at roughly 720px wide. Writing PNGs at `VIEWPORT.width`
 * (1440) keeps them a crisp 2x for that display without shipping the raw
 * `DEVICE_SCALE_FACTOR: 2` capture (2880px wide, ~3x oversampled) into git
 * history. Capturing at 2x and downscaling with a high-quality filter is
 * supersampling: the written PNG is sharper than a native 1x capture, not a
 * degraded version of one.
 */
const OUTPUT_MAX_WIDTH = VIEWPORT.width;

/**
 * Palette PNG (libimagequant via sharp) instead of full RGB. These are flat,
 * few-color UI screenshots, not photos, so 256-color quantization at this
 * quality is visually indistinguishable while cutting file size by roughly
 * 5x on top of the resize. Verified by eye against the lossless encode on the
 * records table, the topology graph, and the add-record dialog before this
 * was adopted - re-check those three if this ever looks blurry or banded.
 */
const PNG_ENCODE_OPTIONS: sharp.PngOptions = {
  compressionLevel: 9,
  effort: 10,
  adaptiveFiltering: true,
  palette: true,
  quality: 90,
  colors: 256,
  dither: 1.0,
};

/** `sunset` is the app default and the theme the README leads with. */
const THEMES = [
  { id: "sunset", dir: "dark" },
  { id: "light", dir: "light" },
] as const;

/** The hero shot also gets an OLED variant; the full set is not repeated. */
const OLED_THEME = { id: "oled", dir: "oled" } as const;
const OLED_SCREENS = new Set(["dns-records-table"]);

type ThemeSpec = { id: string; dir: string };

// ---------------------------------------------------------------------------
// Native (Tauri) stub
// ---------------------------------------------------------------------------

/**
 * Installs the fake desktop bridge. Everything here runs inside the page, so it
 * may only close over the structured-cloneable `seed` argument.
 */
/** Seed plus the notifications inbox (t9); lives beside `DemoSeed` so `demo-workspace.ts` stays untouched. */
type StubSeed = DemoSeed & {
  notifications: DemoNotification[];
  notificationStatus: typeof DEMO_NOTIFICATION_STATUS;
  notificationSettings: typeof DEMO_NOTIFICATION_SETTINGS;
  notificationZoneSummary: typeof DEMO_NOTIFICATION_ZONE_SUMMARY;
};

async function installDesktopStub(page: Page, seed: DemoSeed) {
  // tsx/esbuild rewrites named functions through a `__name` helper that does
  // not exist in the page realm; shim it before any transpiled init script runs.
  await page.addInitScript(() => {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.__name ??= (target: unknown) => target;
  });

  const stubSeed: StubSeed = {
    ...seed,
    notifications: DEMO_NOTIFICATIONS,
    notificationStatus: DEMO_NOTIFICATION_STATUS,
    notificationSettings: DEMO_NOTIFICATION_SETTINGS,
    notificationZoneSummary: DEMO_NOTIFICATION_ZONE_SUMMARY,
  };

  await page.addInitScript((data: StubSeed) => {
    type Callback = (...args: unknown[]) => unknown;
    type NativeCall = { command: string; args?: Record<string, unknown> };

    const callbacks = new Map<number, Callback>();
    const calls: NativeCall[] = [];
    const unhandled: NativeCall[] = [];
    let callbackId = 0;

    Object.defineProperty(window, "__nativeCalls", {
      configurable: true,
      value: calls,
    });
    Object.defineProperty(window, "__unhandledNativeCalls", {
      configurable: true,
      value: unhandled,
    });

    try {
      window.localStorage.setItem("theme", data.theme);
      // Record tags are local-only, so they are seeded straight into the
      // browser store the app reads them from.
      window.localStorage.setItem(
        data.browserStorageKey,
        JSON.stringify(data.browserStorage),
      );
    } catch {
      /* storage is unavailable; the preference stub still applies the theme */
    }

    // `@tauri-apps/api/event` reaches for this when an unlisten handle is
    // dropped. Without it React teardown throws and the app shows a crash toast.
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: () => {} },
    });

    const mcpStatus = (enabledTools: string[]) => ({
      running: true,
      host: "127.0.0.1",
      port: 8788,
      url: "http://127.0.0.1:8788/mcp",
      enabledTools,
      tools: data.mcpTools.map((tool) => ({
        ...tool,
        enabled: enabledTools.includes(tool.name),
      })),
      lastError: null,
    });
    let enabledMcpTools = data.mcpEnabledTools.slice();

    // Mutable inbox so mark/archive/dismiss are reflected by the next list.
    const inbox = data.notifications.map((item) => ({ ...item }));
    let notificationSettings: Record<string, unknown> = {
      ...data.notificationSettings,
    };
    let notificationsPaused = false;
    const unreadCount = () =>
      inbox.filter((item) => !item.readAt && !item.archivedAt).length;
    const notificationStatus = () => ({
      ...data.notificationStatus,
      paused: notificationsPaused,
      unread: unreadCount(),
    });
    const idList = (value: unknown): string[] =>
      Array.isArray(value) ? value.map(String) : [];

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        callbacks,
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { windowLabel: "main", label: "main" },
        },
        transformCallback(callback: Callback, once = false) {
          callbackId += 1;
          const id = callbackId;
          callbacks.set(
            id,
            once
              ? (...args: unknown[]) => {
                  callbacks.delete(id);
                  return callback(...args);
                }
              : callback,
          );
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        runCallback(id: number, payload: unknown) {
          callbacks.get(id)?.(payload);
        },
        async invoke(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<unknown> {
          calls.push({ command, args });

          switch (command) {
            // --- identity / session ------------------------------------
            case "get_api_keys":
              return data.apiKeys;
            case "get_encryption_settings":
              return {
                iterations: 310000,
                key_length: 256,
                algorithm: "AES-GCM",
              };
            case "update_encryption_settings":
              return undefined;
            case "benchmark_encryption":
              return data.encryptionBenchmark;
            case "decrypt_api_key":
              return data.decryptedToken;
            case "verify_token":
              return true;
            case "get_passkey_status":
              return {
                registrationAvailable: false,
                authenticationAvailable: false,
                legacyCredentialsRequireReregistration: false,
                unavailableReason:
                  "Passkeys are disabled in this documentation build.",
              };
            case "list_passkeys":
              return [];
            case "biometric_status":
              return { available: false, biometricType: "none" };
            case "biometric_has_secret":
              return false;

            // --- preferences -------------------------------------------
            case "get_preferences":
              return {
                theme: data.theme,
                locale: "en",
                last_zone: data.primaryZoneId,
                default_per_page: 50,
                confirm_logout: true,
                confirmLogout: true,
                vault_enabled: false,
                topology_resolver_mode: "dns",
                topologyResolverMode: "dns",
                mcp_server_enabled: true,
                mcp_enabled_tools: enabledMcpTools,
              };
            case "update_preferences":
            case "update_preference_fields":
              return undefined;

            // --- zones and records --------------------------------------
            case "get_zones":
              return data.zones;
            case "get_dns_records": {
              const zoneId = String(args?.zoneId ?? data.primaryZoneId);
              return data.recordsByZone[zoneId] ?? [];
            }
            case "get_dnssec":
              return data.dnssec;
            case "get_zone_setting": {
              const settingId = String(args?.settingId ?? "");
              return (
                data.zoneSettings[settingId] ?? {
                  id: settingId,
                  value: "on",
                  editable: true,
                  modified_on: data.modifiedOn,
                }
              );
            }
            case "update_zone_setting":
              return { id: String(args?.settingId ?? ""), value: args?.value };
            case "get_page_rules":
              return [];
            case "purge_cache":
              return { id: "purge-demo" };

            // --- analytics / firewall / workers / email ------------------
            case "get_zone_analytics":
              return data.zoneAnalytics;
            case "get_dns_analytics":
              return data.dnsAnalytics;
            case "get_firewall_rules":
              return data.firewallRules;
            case "get_ip_access_rules":
              return data.ipAccessRules;
            case "get_waf_rulesets":
              return data.wafRulesets;
            case "get_worker_routes":
              return data.workerRoutes;
            case "get_email_routing_settings":
              return data.emailRoutingSettings;
            case "get_email_routing_rules":
              return data.emailRoutingRules;

            // --- topology / propagation / spf ---------------------------
            case "resolve_topology_batch":
              return data.topologyBatch;
            case "check_dns_propagation":
              return data.propagation;
            case "parse_spf":
              return data.spfParse;
            case "simulate_spf":
              return data.spfSimulation;
            case "spf_graph":
              return data.spfGraph;

            // --- audit ---------------------------------------------------
            case "get_audit_entries":
              return data.auditEntries;
            case "run_domain_audit":
              return data.domainAudit;

            // --- registrar ------------------------------------------------
            case "list_registrar_credentials":
              return data.registrarCredentials;
            case "registrar_list_all_domains":
              return data.registrarDomains;
            case "registrar_health_check_all":
              return data.registrarHealth;

            // --- import / export helpers ---------------------------------
            case "parse_csv_records":
              return data.parsedImportRecords;
            case "parse_bind_zone":
              return data.parsedImportRecords;
            case "validate_dns_record":
              return { valid: true, errors: [], warnings: [] };
            case "records_to_json":
            case "records_to_csv":
            case "records_to_bind":
            case "export_dns_records":
            case "export_audit_entries":
              return "";
            case "create_dns_record":
            case "update_dns_record":
              return { ...(args?.record as object), id: "demo-record" };
            case "delete_dns_record":
            case "delete_bulk_dns_records":
            case "save_audit_entries":
            case "clear_audit_entries":
              return undefined;
            case "create_bulk_dns_records":
              return { created: [], skipped: [] };
            case "save_topology_asset":
              return "C:/demo/harborline.test-topology.svg";

            // --- MCP -------------------------------------------------------
            case "mcp_get_server_status":
            case "mcp_start_server":
              return mcpStatus(enabledMcpTools);
            case "mcp_stop_server":
              return { ...mcpStatus(enabledMcpTools), running: false };
            case "mcp_set_enabled_tools":
              enabledMcpTools = Array.isArray(args?.enabledTools)
                ? (args.enabledTools as string[])
                : [];
              return mcpStatus(enabledMcpTools);

            // --- notifications (t9) --------------------------------------
            case "notifications_start":
            case "notifications_status":
            case "notifications_check_now":
            case "notifications_reconfigure":
              return notificationStatus();
            case "notifications_stop":
            case "notifications_reset_state":
              return undefined;
            case "notifications_pause":
              notificationsPaused = true;
              return notificationStatus();
            case "notifications_resume":
              notificationsPaused = false;
              return notificationStatus();
            case "notifications_list": {
              const query = (args?.query ?? {}) as {
                scope?: string;
                kind?: string;
                zoneId?: string;
                limit?: number;
              };
              const scope = query.scope ?? "all";
              return inbox
                .filter((item) =>
                  scope === "archived"
                    ? !!item.archivedAt
                    : scope === "unread"
                      ? !item.readAt && !item.archivedAt
                      : !item.archivedAt,
                )
                .filter((item) => !query.kind || item.kind === query.kind)
                .filter((item) => !query.zoneId || item.zoneId === query.zoneId)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, query.limit ?? 200)
                .map((item) => ({ ...item }));
            }
            case "notifications_unread_count":
              return unreadCount();
            case "notifications_mark_read": {
              const ids = idList(args?.ids);
              const read = args?.read !== false;
              let affected = 0;
              for (const item of inbox) {
                if (!ids.includes(item.id)) continue;
                item.readAt = read ? (item.readAt ?? data.modifiedOn) : null;
                affected += 1;
              }
              return affected;
            }
            case "notifications_mark_all_read": {
              let affected = 0;
              for (const item of inbox) {
                if (item.readAt || item.archivedAt) continue;
                item.readAt = data.modifiedOn;
                affected += 1;
              }
              return affected;
            }
            case "notifications_archive": {
              const ids = idList(args?.ids);
              let affected = 0;
              for (const item of inbox) {
                if (!ids.includes(item.id) || item.archivedAt) continue;
                item.archivedAt = data.modifiedOn;
                item.readAt ??= data.modifiedOn;
                affected += 1;
              }
              return affected;
            }
            case "notifications_unarchive": {
              const ids = idList(args?.ids);
              let affected = 0;
              for (const item of inbox) {
                if (!ids.includes(item.id) || !item.archivedAt) continue;
                item.archivedAt = null;
                affected += 1;
              }
              return affected;
            }
            case "notifications_archive_all_read": {
              let affected = 0;
              for (const item of inbox) {
                if (!item.readAt || item.archivedAt) continue;
                item.archivedAt = data.modifiedOn;
                affected += 1;
              }
              return affected;
            }
            case "notifications_dismiss": {
              const ids = idList(args?.ids);
              const before = inbox.length;
              for (let index = inbox.length - 1; index >= 0; index -= 1) {
                if (ids.includes(inbox[index].id)) inbox.splice(index, 1);
              }
              return before - inbox.length;
            }
            case "notifications_clear_archived": {
              const before = inbox.length;
              for (let index = inbox.length - 1; index >= 0; index -= 1) {
                if (inbox[index].archivedAt) inbox.splice(index, 1);
              }
              return before - inbox.length;
            }
            case "notifications_get_settings":
              return notificationSettings;
            case "notifications_update_settings":
              notificationSettings = {
                ...notificationSettings,
                ...((args?.settings as Record<string, unknown> | undefined) ??
                  {}),
              };
              return notificationSettings;
            case "notifications_zone_summary":
              return data.notificationZoneSummary;

            // --- window / event plugins -----------------------------------
            case "plugin:window|is_always_on_top":
            case "plugin:window|is_maximized":
            case "plugin:window|is_minimized":
              return false;
            case "plugin:window|is_focused":
              return true;
            case "plugin:event|listen":
              return 1;
            case "plugin:event|unlisten":
              return undefined;

            default: {
              if (command.startsWith("plugin:window|")) return undefined;
              const call = { command, args };
              unhandled.push(call);
              throw new Error(`Unhandled Tauri command: ${command}`);
            }
          }
        },
        convertFileSrc(filePath: string) {
          return `asset://localhost/${encodeURIComponent(filePath)}`;
        },
      },
    });
  }, stubSeed);
}

/**
 * Presentation-only trimming: hides the Next.js dev overlay and the transient
 * toast stack so a screenshot captures the screen, not the moment.
 */
async function applyCaptureStyles(page: Page) {
  await page.addStyleTag({
    content: `
      nextjs-portal { display: none !important; }
      [data-toast-viewport] { display: none !important; }
      /* Hover tooltips are pointer state, not part of the screen. */
      .ui-tooltip, [role="tooltip"] { display: none !important; }
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      /* Caret blink shows up as a random 1px artifact between runs. */
      * { caret-color: transparent !important; }
    `,
  });
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

class ScreenUnreachableError extends Error {
  constructor(screen: string, reason: string) {
    super(`Screen "${screen}" could not be staged: ${reason}`);
    this.name = "ScreenUnreachableError";
  }
}

async function requireVisible(page: Page, selector: string, what: string) {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(`expected ${what} (${selector}) to be visible, it was not`);
  }
  return locator;
}

async function assertNoUnhandledNativeCalls(page: Page) {
  const unhandled = await page.evaluate(
    () =>
      (
        window as Window & {
          __unhandledNativeCalls?: Array<{ command: string }>;
        }
      ).__unhandledNativeCalls ?? [],
  );
  if (unhandled.length > 0) {
    const names = [...new Set(unhandled.map((call) => call.command))];
    throw new Error(
      `the stub did not answer these native commands: ${names.join(", ")}. ` +
        `Add them to the invoke switch in scripts/capture-screenshots.ts.`,
    );
  }
}

/**
 * The stub's decrypted "token" is a placeholder, but a screenshot that leaked it
 * would prove the app can render a decrypted credential. Fail rather than ship.
 */
async function assertNoSecretOnScreen(page: Page) {
  const leaked = await page.evaluate(
    (secret) => document.body.innerText.includes(secret),
    DEMO_DECRYPTED_TOKEN,
  );
  if (leaked) {
    throw new Error(
      "the decrypted API token was rendered on screen; refusing to write the PNG",
    );
  }
}

// ---------------------------------------------------------------------------
// Shared navigation
// ---------------------------------------------------------------------------

async function login(page: Page) {
  const keySelect = page.getByRole("combobox", { name: "API Key" });
  await keySelect.waitFor({ state: "visible", timeout: 20_000 });
  await keySelect.click();
  await page.getByRole("option", { name: DEMO_API_KEYS[0].label }).click();
  await page.locator("#password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await requireVisible(
    page,
    '[data-testid="authenticated-app-shell"]',
    "the authenticated app shell",
  );
  await requireVisible(
    page,
    '[data-testid="dns-records-table"]',
    "the DNS records table",
  );
}

/** Clicks one of the zone workspace action segments (Records, Topology, ...). */
async function openActionSegment(page: Page, label: string) {
  const segment = page
    .getByTestId("dns-workspace-scroll-region")
    .locator("button.ui-segment", { hasText: new RegExp(`^${label}$`) })
    .first();
  await segment.click();
  await page.waitForTimeout(400);
}

/** Opens one of the global workspaces from the top command bar. */
async function openCommandBarWorkspace(page: Page, ariaLabel: string) {
  await page
    .getByTestId("app-command-bar")
    .getByRole("button", { name: ariaLabel, exact: true })
    .click();
  await page.waitForTimeout(500);
}

/** Opens an extra zone workspace tab from the bottom zone picker. */
/**
 * Opens the Topology panel on the primary zone, switches the graph to
 * `mode` and waits for that graph's `firstSubgraph` cluster to render before
 * opening the full-window view. The primary zone is used on purpose: unlike
 * the full DNS graph it carries the whole email story (two MX hosts, SPF,
 * DKIM, DMARC, MTA-STS, TLS-RPT, autodiscovery and Email Routing rules) and
 * the Worker routes, and the email and services graphs are compact enough to
 * fit a window at a readable scale.
 */
async function openTopologyGraphMode(
  page: Page,
  mode: "email" | "services",
  firstSubgraph: string,
) {
  await openActionSegment(page, "Topology");
  await page
    .locator('[data-testid="dns-topology-record-loading"]')
    .waitFor({ state: "hidden", timeout: 30_000 })
    .catch(() => undefined);
  await page
    .locator(".topology-svg-wrapper svg")
    .first()
    .waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId(`topology-graph-mode-${mode}`).first().click();
  await requireVisible(
    page,
    `.topology-svg-wrapper svg g.cluster[id$="-${firstSubgraph}"]`,
    `the ${mode} graph's "${firstSubgraph}" subgraph`,
  );
  await page
    .getByRole("button", { name: "Full window", exact: true })
    .first()
    .click();
  await page.waitForTimeout(4000);

  const mermaidNodes = await page
    .locator(".topology-svg-wrapper svg g.node")
    .count();
  if (mermaidNodes < 5) {
    throw new ScreenUnreachableError(
      `zone-topology-${mode}`,
      `the Mermaid ${mode} graph rendered only ${mermaidNodes} nodes`,
    );
  }
}

async function openZoneTab(page: Page, zoneName: string, status = "active") {
  await page
    .getByTestId("dns-connection-bar")
    .getByRole("combobox", { name: "Domain/Zone" })
    .click();
  await page
    .getByRole("option", { name: `${zoneName} (${status})`, exact: true })
    .click();
  await page.waitForTimeout(400);
}

/** Settings sub-tab: General, Columns, Topology, Audit, MCP, Profiles. */
async function openSettingsSubtab(page: Page, label: string) {
  await page
    .getByRole("toolbar", { name: "Session settings sections" })
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.waitForTimeout(300);
}

async function settle(page: Page, extraMs = 500) {
  // `next dev` keeps an HMR socket open, so network idle may never arrive; it
  // is a best-effort settle, not a gate.
  await page
    .waitForLoadState("networkidle", { timeout: 4_000 })
    .catch(() => undefined);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.waitForTimeout(extraMs);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

interface Screen {
  /** kebab-case output file name, without the extension. */
  name: string;
  /** One line describing what the shot shows; printed in the run summary. */
  caption: string;
  /** `false` for the login screen. */
  authenticated?: boolean;
  /** Stage the screen. Throw with a clear message when it cannot be reached. */
  stage: (page: Page) => Promise<void>;
  /**
   * Optional framing. Used where a full-window capture would bury the subject
   * (for example the tab strip).
   */
  clip?: {
    /** Element the crop is anchored to. */
    selector: string;
    /** Horizontal/vertical padding around the element, in CSS pixels. */
    padding?: number;
    /** Start the crop at the top of the window instead of the element. */
    fromTop?: boolean;
    /** Extra pixels kept below the element. */
    extraBottom?: number;
  };
}

/** Opens every demo zone as a workspace tab, then returns to the primary one. */
async function openAllZoneTabs(page: Page) {
  for (const zone of DEMO_ZONES.slice(1)) {
    await openZoneTab(page, zone.name);
  }
  await page
    .getByRole("tablist", { name: "DNS workspaces" })
    .getByRole("tab", { name: DEMO_ZONES[0].name, exact: true })
    .click();
  await page.waitForTimeout(500);
}

async function requireRecordRows(page: Page, screen: string, minimum = 10) {
  await requireVisible(
    page,
    '[data-testid="dns-records-table"]',
    "the records table",
  );
  const rows = await page.locator("[data-record-row]").count();
  if (rows < minimum) {
    throw new ScreenUnreachableError(
      screen,
      `only ${rows} record rows rendered; expected at least ${minimum}`,
    );
  }
}

const SCREENS: Screen[] = [
  {
    name: "login",
    caption: "Encrypted API key vault and login",
    authenticated: false,
    stage: async (page) => {
      await requireVisible(page, '[data-testid="auth-card"]', "the login card");
      await page.getByRole("combobox", { name: "API Key" }).click();
      await page.getByRole("option", { name: DEMO_API_KEYS[0].label }).click();
      await page.locator("#password").fill(DEMO_PASSWORD);
      await page.locator("#password").blur();
    },
  },
  {
    name: "encryption-settings",
    caption: "PBKDF2 / AES-GCM key derivation settings",
    authenticated: false,
    stage: async (page) => {
      await requireVisible(page, '[data-testid="auth-card"]', "the login card");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await requireVisible(
        page,
        '[role="dialog"][aria-label="Encryption Settings"], [role="dialog"]:has-text("Encryption Settings")',
        "the encryption settings dialog",
      );
      await page
        .getByRole("button", { name: "Benchmark", exact: true })
        .click();
      await page
        .getByText(/Last benchmark:/)
        .waitFor({ state: "visible", timeout: 10_000 });
    },
  },
  {
    name: "dns-records-table",
    caption: "The DNS records table for a zone workspace",
    stage: async (page) => {
      await openAllZoneTabs(page);
      await requireRecordRows(page, "dns-records-table");
    },
  },
  {
    name: "workspace-tabs",
    caption: "Reorderable zone workspace tabs, mid-drag",
    stage: async (page) => {
      await openAllZoneTabs(page);
      await requireRecordRows(page, "workspace-tabs");

      // The tab strip uses HTML5 drag-and-drop, which Playwright's mouse API
      // does not synthesize. Dispatch the events directly so the drop indicator
      // renders exactly as it does for a real drag.
      const staged = await page.evaluate(() => {
        const wrappers = Array.from(
          document.querySelectorAll<HTMLElement>("[data-tab-id]"),
        );
        if (wrappers.length < 3) return false;
        const source = wrappers[0];
        const target = wrappers[2];
        const transfer = new DataTransfer();
        source.dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
        );
        const box = target.getBoundingClientRect();
        target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: box.right - 4,
            clientY: box.top + box.height / 2,
          }),
        );
        return true;
      });
      if (!staged) {
        throw new ScreenUnreachableError(
          "workspace-tabs",
          "fewer than three workspace tabs were open",
        );
      }
      await requireVisible(
        page,
        '[data-testid="dns-tab-drop-indicator"]',
        "the tab drop indicator",
      );
    },
    clip: {
      selector: '[data-testid="dns-workspace-tab-bar"]',
      fromTop: true,
      extraBottom: 180,
    },
  },
  {
    name: "record-row-context-menu",
    caption: "Right-click actions on a DNS record row",
    stage: async (page) => {
      await openAllZoneTabs(page);
      await requireRecordRows(page, "record-row-context-menu");
      const row = page.locator("[data-record-row]").nth(4);
      await row.click({ button: "right" });
      await requireVisible(
        page,
        '[role="menu"] [data-record-action="edit"]',
        "the record context menu",
      );
    },
  },
  {
    name: "bulk-edit-bar",
    caption: "Bulk actions across several selected records",
    stage: async (page) => {
      await openAllZoneTabs(page);
      await requireRecordRows(page, "bulk-edit-bar");
      for (const index of [2, 3, 5, 8, 9]) {
        await page.getByLabel("Select record").nth(index).check();
      }
      await requireVisible(
        page,
        'button:has-text("Deselect All")',
        "the bulk edit bar",
      );
      await page
        .getByText(/\d+ records selected/)
        .first()
        .waitFor({ state: "visible" });
    },
  },
  {
    name: "add-record-dialog",
    caption: "Add-record dialog with the guided DMARC builder",
    stage: async (page) => {
      await requireRecordRows(page, "add-record-dialog");
      await page
        .getByRole("button", { name: "Add Record", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Add DNS Record" });
      await dialog.waitFor({ state: "visible", timeout: 10_000 });

      await dialog.getByRole("combobox").first().click();
      await page.getByRole("option", { name: "TXT (text)" }).click();
      await page.waitForTimeout(300);

      const helper = dialog
        .locator("label", { hasText: "TXT helper" })
        .locator("xpath=following::*[@role='combobox'][1]");
      await helper.click();
      await page.getByRole("option", { name: "DMARC", exact: true }).click();
      await dialog
        .getByText("p= (policy)")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await dialog.getByLabel("Name").first().fill("_dmarc");
    },
  },
  {
    name: "column-picker",
    caption: "Per-table column visibility in Settings",
    stage: async (page) => {
      await openCommandBarWorkspace(page, "Settings");
      await openSettingsSubtab(page, "Columns");
      await requireVisible(
        page,
        '[data-testid="settings-columns-panel"]',
        "the column picker",
      );
      await requireVisible(
        page,
        '[data-testid="column-group-dnsRecords"]',
        "the DNS records column group",
      );
    },
  },
  {
    name: "settings",
    caption: "Session settings",
    stage: async (page) => {
      await openCommandBarWorkspace(page, "Settings");
      await openSettingsSubtab(page, "General");
      await requireVisible(
        page,
        'text="Session settings"',
        "the settings panel",
      );
    },
  },
  {
    name: "mcp-tool-permissions",
    caption: "Per-tool permissions for the local MCP server",
    stage: async (page) => {
      await openCommandBarWorkspace(page, "Settings");
      await openSettingsSubtab(page, "MCP");
      await requireVisible(
        page,
        'h3:has-text("MCP tool permissions")',
        "the MCP tool permission list",
      );
      const parked = await page
        .locator('[data-testid="mcp-permissions-parking"] h3')
        .count();
      if (parked > 0) {
        throw new ScreenUnreachableError(
          "mcp-tool-permissions",
          "the MCP panel is still parked in its hidden portal host",
        );
      }
    },
  },
  {
    name: "audit-log",
    caption: "Desktop audit log of sensitive actions",
    stage: async (page) => {
      await openCommandBarWorkspace(page, "Audit log");
      await requireVisible(page, 'text="Audit log"', "the audit workspace");
      await page
        .getByText("dns.record.update")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
    },
  },
  {
    name: "notifications",
    caption:
      "Notifications inbox with an expiry notice and an external record change",
    stage: async (page) => {
      // The bell's name carries the unread count ("Notifications, 2 unread").
      await page
        .getByTestId("app-command-bar")
        .getByRole("button", { name: /^Notifications/ })
        .click();
      await requireVisible(
        page,
        '[data-testid="notifications-inbox"]',
        "the notifications inbox",
      );
      await page
        .getByText("harborline-labs.test expires in 3 days")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
    },
  },
  {
    name: "registry-monitor",
    caption: "Registrar inventory with expiry and lock health",
    stage: async (page) => {
      await openCommandBarWorkspace(page, "Registry Monitoring");
      await requireVisible(
        page,
        'text="Registry Monitoring"',
        "the registry monitor",
      );
      await page
        .getByText("harborline.test", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
      // The refresh control is icon-only with no accessible name, so it has to
      // be matched structurally.
      await page.locator("button:has(svg.lucide-refresh-cw)").first().click();
      await page.waitForTimeout(1500);
    },
  },
  {
    name: "tag-manager",
    caption: "Local record tags across zones",
    stage: async (page) => {
      await openCommandBarWorkspace(page, "Tags");
      await requireVisible(page, 'text="Tag manager"', "the tag manager");
    },
  },
  {
    name: "import-export",
    caption: "Import and export records as JSON, CSV or BIND",
    stage: async (page) => {
      await openActionSegment(page, "Import/Export");
      await requireVisible(
        page,
        'text="Import Records"',
        "the import/export workspace",
      );
      await page.getByRole("button", { name: "Import", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Import DNS Records" });
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      const textarea = dialog.getByRole("textbox");
      await textarea.fill(SEED_IMPORT_JSON);
      // `fill` leaves the caret at the end; show the top of the payload instead.
      await textarea.evaluate((element) => {
        element.scrollTop = 0;
      });
    },
  },
  {
    name: "import-preview",
    caption: "Dry-run preview of a parsed import",
    stage: async (page) => {
      await openActionSegment(page, "Import/Export");
      await page.getByRole("button", { name: "Import", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Import DNS Records" });
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      await dialog.getByRole("textbox").fill(SEED_IMPORT_JSON);
      await dialog
        .getByRole("button", { name: "Import Records", exact: true })
        .click();
      await requireVisible(
        page,
        '[data-testid="import-preview-row"]',
        "the import preview rows",
      );
      await requireVisible(
        page,
        '[data-testid="import-preview-rejection"]',
        "the rejected-records notice",
      );
    },
  },
  {
    name: "zone-compare",
    caption: "Side-by-side difference between two zones",
    stage: async (page) => {
      await openActionSegment(page, "Compare");
      const panel = page.getByTestId("dns-workspace-scroll-region");
      await panel.getByRole("combobox").last().click();
      await page
        .getByRole("option", { name: "shipwright.test", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "Compare", exact: true })
        .last()
        .click();
      await requireVisible(
        page,
        '[data-testid="zone-compare-table"]',
        "the zone comparison table",
      );
    },
  },
  {
    name: "zone-topology",
    caption: "Rendered DNS topology graph, full window",
    stage: async (page) => {
      // The primary zone has 35 records; even grouped into area subgraphs the
      // dagre layout only fits a window-sized screenshot at roughly 15%, which
      // is not legible. A smaller zone renders the same feature at a readable
      // scale.
      await openZoneTab(page, "shipwright.test");
      await openActionSegment(page, "Topology");
      await page
        .locator('[data-testid="dns-topology-record-loading"]')
        .waitFor({ state: "hidden", timeout: 30_000 })
        .catch(() => undefined);
      await requireVisible(
        page,
        '[data-testid="topology-graph-node"]',
        "the topology graph model",
      );
      await page
        .locator(".topology-svg-wrapper svg")
        .first()
        .waitFor({ state: "visible", timeout: 45_000 });
      await page
        .getByRole("button", { name: "Full window", exact: true })
        .first()
        .click();
      await page.waitForTimeout(4000);

      const mermaidNodes = await page
        .locator(".topology-svg-wrapper svg g.node")
        .count();
      if (mermaidNodes < 5) {
        throw new ScreenUnreachableError(
          "zone-topology",
          `the Mermaid graph rendered only ${mermaidNodes} nodes`,
        );
      }
    },
  },
  {
    name: "zone-topology-email",
    caption:
      "Email graph: inbound MX, authentication, transport policy, client autodiscovery and Email Routing",
    stage: async (page) => {
      await openTopologyGraphMode(page, "email", "inbound");
    },
  },
  {
    name: "zone-topology-services",
    caption:
      "Services graph: proxied and DNS-only hostnames, their targets and addresses, and Worker routes",
    stage: async (page) => {
      await openTopologyGraphMode(page, "services", "proxied");
    },
  },
  {
    name: "propagation-checker",
    caption: "Propagation across eight public resolvers",
    stage: async (page) => {
      await openActionSegment(page, "Propagation");
      await page.getByPlaceholder("example.com").fill("www.harborline.test");
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await requireVisible(
        page,
        '[data-testid="propagation-resolver-row"]',
        "the resolver results",
      );
      const rows = await page
        .locator('[data-testid="propagation-resolver-row"]')
        .count();
      if (rows < 4) {
        throw new ScreenUnreachableError(
          "propagation-checker",
          `only ${rows} resolver rows rendered`,
        );
      }
    },
  },
  {
    name: "analytics-panel",
    caption: "Zone traffic, bandwidth and threat analytics",
    stage: async (page) => {
      await openActionSegment(page, "Analytics");
      await requireVisible(page, 'h3:has-text("Zone Analytics")', "analytics");
      await requireVisible(
        page,
        '[data-testid="analytics-timeseries-row"]',
        "the analytics timeseries",
      );
    },
  },
  {
    name: "firewall-panel",
    caption: "Firewall rules, IP access rules and WAF rulesets",
    stage: async (page) => {
      await openActionSegment(page, "Firewall");
      await requireVisible(
        page,
        'h3:has-text("Firewall")',
        "the firewall panel",
      );
      await page
        .getByText("(ip.src in {192.0.2.0/24})")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    },
  },
  {
    name: "workers-panel",
    caption: "Cloudflare Worker routes bound to the zone",
    stage: async (page) => {
      await openActionSegment(page, "Workers");
      await requireVisible(
        page,
        'h3:has-text("Worker Routes")',
        "the workers panel",
      );
      await page
        .getByText("api.harborline.test/v2/*")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    },
  },
  {
    name: "email-routing-panel",
    caption: "Email routing rules and forwarding targets",
    stage: async (page) => {
      await openActionSegment(page, "Email");
      await requireVisible(
        page,
        'h3:has-text("Email Routing")',
        "the email routing panel",
      );
      await page
        .getByText("support@harborline.test")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
    },
  },
  {
    name: "zone-settings",
    caption: "Per-zone Cloudflare settings",
    stage: async (page) => {
      await openActionSegment(page, "Zone Settings");
      await page.waitForTimeout(1500);
      await requireVisible(
        page,
        '[data-testid="dns-workspace-scroll-region"]',
        "the zone settings panel",
      );
    },
  },
  {
    name: "ssl-tls",
    caption: "TLS and HTTPS behaviour for the zone",
    stage: async (page) => {
      await openActionSegment(page, "SSL/TLS");
      await page.waitForTimeout(1500);
      await requireVisible(
        page,
        '[data-testid="dns-workspace-scroll-region"]',
        "the SSL/TLS panel",
      );
    },
  },
  {
    name: "cache",
    caption: "Cache purge and Cloudflare caching controls",
    stage: async (page) => {
      await openActionSegment(page, "Cache");
      await page.waitForTimeout(1500);
      await requireVisible(
        page,
        '[data-testid="dns-workspace-scroll-region"]',
        "the cache panel",
      );
    },
  },
  {
    name: "domain-audit",
    caption: "DNS best-practice audit for the zone",
    stage: async (page) => {
      await openActionSegment(page, "Audits");
      await page.waitForTimeout(1500);
      await requireVisible(
        page,
        '[data-testid="dns-workspace-scroll-region"]',
        "the domain audit panel",
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface CaptureResult {
  file: string;
  bytes: number;
  width: number;
  height: number;
}

async function captureScreen(
  browser: Browser,
  theme: ThemeSpec,
  screen: Screen,
  baseUrl: string,
): Promise<CaptureResult> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    reducedMotion: "reduce",
    colorScheme: theme.id === "light" ? "light" : "dark",
    locale: "en-US",
    timezoneId: "UTC",
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const outputDir = path.join(OUTPUT_ROOT, theme.dir);
  const file = path.join(outputDir, `${screen.name}.png`);

  try {
    await installDesktopStub(page, createDemoSeed(theme.id));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await applyCaptureStyles(page);
    await settle(page, 300);

    if (screen.authenticated !== false) await login(page);
    await screen.stage(page);
    await applyCaptureStyles(page);
    await settle(page, 600);

    await assertNoUnhandledNativeCalls(page);
    await assertNoSecretOnScreen(page);
    if (pageErrors.length > 0) {
      throw new Error(`uncaught page error(s): ${pageErrors.join(" | ")}`);
    }

    await mkdir(outputDir, { recursive: true });
    let raw: Buffer;
    if (screen.clip) {
      const box = await page
        .locator(screen.clip.selector)
        .first()
        .boundingBox();
      if (!box) {
        throw new Error(
          `the clip target ${screen.clip.selector} has no layout box, so the shot cannot be framed`,
        );
      }
      const pad = screen.clip.padding ?? 0;
      const top = screen.clip.fromTop ? 0 : Math.max(0, box.y - pad);
      const bottom = box.y + box.height + pad + (screen.clip.extraBottom ?? 0);
      raw = await page.screenshot({
        animations: "disabled",
        clip: {
          x: Math.max(0, box.x - pad),
          y: top,
          width: Math.min(VIEWPORT.width, box.width + pad * 2),
          height: Math.min(VIEWPORT.height, bottom) - top,
        },
      });
    } else {
      raw = await page.screenshot({ animations: "disabled" });
    }

    const bytes = await writeOptimizedPng(raw, file);
    if (bytes < (screen.clip ? 1_000 : 4_000)) {
      throw new Error(
        `wrote a suspiciously small PNG (${bytes} bytes); the screen was probably blank`,
      );
    }
    const { width, height } = await readPngSize(file);
    return { file, bytes, width, height };
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  } finally {
    await context.close();
  }
}

/**
 * Downscales the raw `deviceScaleFactor: 2` capture to `OUTPUT_MAX_WIDTH` with
 * a high-quality resampler, palette-compresses it (see `PNG_ENCODE_OPTIONS`),
 * and writes it to `file`. Returns the written byte size.
 */
async function writeOptimizedPng(raw: Buffer, file: string): Promise<number> {
  const optimized = await sharp(raw)
    .resize({
      width: OUTPUT_MAX_WIDTH,
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true,
    })
    .png(PNG_ENCODE_OPTIONS)
    .toBuffer();
  await writeFile(file, optimized);
  return optimized.length;
}

/** Reads width/height straight out of the PNG IHDR chunk. */
async function readPngSize(file: string) {
  const bytes = await readFile(file);
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) {
    throw new Error(`${file} is not a readable PNG`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * Points the run at a dev server, starting one only when it has to.
 *
 * Nothing here guesses a port. An explicit `SCREENSHOT_BASE_URL` wins; a dev
 * server that is already running is joined at the port it published; otherwise
 * one is started and the harness adopts the port Next.js *actually* bound (see
 * `scripts/dev-server.mjs`), so there is no reserve-then-hope handoff to race.
 *
 * It stays as loud as it was: a server that never answers fails the run.
 */
async function resolveBaseUrl(): Promise<{
  baseUrl: string;
  stop?: () => void;
}> {
  const configured = process.env.SCREENSHOT_BASE_URL?.trim();
  if (configured) {
    if (await waitForServer(configured, 1)) return { baseUrl: configured };

    // An explicit address is a pin, not a hint: start Next on exactly that port
    // and refuse to run if it lands anywhere else.
    const requested = Number.parseInt(new URL(configured).port || "80", 10);
    process.stdout.write(`Starting the dev server for ${configured}...\n`);
    const pinned = await startNextDev({
      basePort: requested,
      pinned: true,
    });
    if (!(await waitForServer(configured, 180_000))) {
      pinned.stop();
      throw new Error(
        `the dev server never became reachable at ${configured}. ` +
          'Start it with "npm run dev" and re-run.',
      );
    }
    return { baseUrl: configured, stop: pinned.stop };
  }

  const running = await readRunningDevServer();
  if (running && (await waitForServer(running.url, 1))) {
    process.stdout.write(`Reusing the dev server at ${running.url}...\n`);
    return { baseUrl: running.url };
  }

  process.stdout.write("Starting a dev server on the first free port...\n");
  const dev = await startNextDev();
  if (!(await waitForServer(dev.url, 180_000))) {
    dev.stop();
    throw new Error(
      `the dev server never became reachable at ${dev.url}. ` +
        'Start it with "npm run dev" and re-run.',
    );
  }
  process.stdout.write(`Dev server ready at ${dev.url}.\n`);
  return { baseUrl: dev.url, stop: dev.stop };
}

async function main() {
  const only = process.argv
    .filter((arg) => arg.startsWith("--only="))
    .flatMap((arg) => arg.slice("--only=".length).split(","))
    .filter(Boolean);
  const themeFilter = process.argv
    .filter((arg) => arg.startsWith("--theme="))
    .flatMap((arg) => arg.slice("--theme=".length).split(","))
    .filter(Boolean);

  const screens = only.length
    ? SCREENS.filter((screen) => only.includes(screen.name))
    : SCREENS;
  if (only.length && screens.length !== only.length) {
    const known = SCREENS.map((screen) => screen.name).join(", ");
    throw new Error(`--only matched no screen. Known screens: ${known}`);
  }

  // Started only once the run is known to be valid, so a bad `--only` cannot
  // leave a dev server behind.
  const { baseUrl, stop: stopDevServer } = await resolveBaseUrl();

  const jobs: Array<{ theme: ThemeSpec; screen: Screen }> = [];
  for (const theme of THEMES) {
    if (themeFilter.length && !themeFilter.includes(theme.id)) continue;
    for (const screen of screens) jobs.push({ theme, screen });
  }
  if (!themeFilter.length || themeFilter.includes(OLED_THEME.id)) {
    for (const screen of screens) {
      if (OLED_SCREENS.has(screen.name)) {
        jobs.push({ theme: OLED_THEME, screen });
      }
    }
  }

  const browser = await chromium.launch();
  const results: CaptureResult[] = [];
  const failures: Array<{ job: string; reason: string }> = [];

  try {
    for (const { theme, screen } of jobs) {
      const label = `${theme.dir}/${screen.name}`;
      try {
        const result = await captureScreen(browser, theme, screen, baseUrl);
        results.push(result);
        process.stdout.write(
          `  ok   ${label.padEnd(38)} ${(result.bytes / 1024).toFixed(0)} KB\n`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ job: label, reason });
        process.stdout.write(`  FAIL ${label.padEnd(38)} ${reason}\n`);
      }
    }
  } finally {
    await browser.close();
    stopDevServer?.();
  }

  process.stdout.write(
    `\n${results.length} screenshot(s) written to ${path.relative(REPO_ROOT, OUTPUT_ROOT)}\n`,
  );

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} screen(s) FAILED:\n`);
    for (const failure of failures) {
      process.stdout.write(`  - ${failure.job}: ${failure.reason}\n`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
