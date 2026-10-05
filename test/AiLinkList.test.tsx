/**
 * Links the assistant offers, and where a click actually goes.
 *
 * Three things are pinned, and all three are about a destination that came
 * from a model.
 *
 * **External links go through the validated opener.** The web path must open a
 * new context with `noopener,noreferrer` and nothing but an `https:` URL; the
 * desktop path routes through the Tauri shell, which is why the control is a
 * `<button>` and not an anchor. This is the same contract
 * `test/RegistrarSiteLink.test.tsx` holds the renewal hand-off to.
 *
 * **In-app links use the host's own navigation.** No `window.location`, no
 * `href`, no router — the same callbacks the expiry notice and the inbox use.
 *
 * **A target that does not check out produces no control.** Not a disabled
 * one, and not the raw target as copyable text: either would still be an
 * invitation to go where the app has refused to take anybody. The resolver is
 * tested exhaustively in `test/aiPlan.contract.test.ts`; what is tested here
 * is that the component honours it.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AiLinkList } from "../src/components/ai/AiLinkList";
import { AI_LINK_LIMITS, type AiLinkNavigation } from "../src/lib/ai/links";
import type { AiLink } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const KNOWN_ZONE = "zoneaaaa1111";

interface Nav extends AiLinkNavigation {
  zones: string[];
  records: string[];
  domains: string[];
  zoneTabs: string[];
  workspaces: string[];
}

function navigation(knownZoneIds: readonly string[] = [KNOWN_ZONE]): Nav {
  const zones: string[] = [];
  const records: string[] = [];
  const domains: string[] = [];
  const zoneTabs: string[] = [];
  const workspaces: string[] = [];
  return {
    knownZoneIds,
    openZone: (zoneId) => zones.push(zoneId),
    revealRecord: (zoneId, recordId) => records.push(`${zoneId}/${recordId}`),
    openZoneTab: (zoneId, tab) => zoneTabs.push(`${zoneId}/${tab}`),
    openDomainRegistry: (domain) => domains.push(domain),
    openWorkspace: (workspace) => workspaces.push(workspace),
    zones,
    records,
    domains,
    zoneTabs,
    workspaces,
  };
}

const originalOpen = window.open;

/** Records `window.open` arguments; the web path is what jsdom can exercise. */
function captureOpens(): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  window.open = ((...args: unknown[]) => {
    calls.push(args);
    return null;
  }) as typeof window.open;
  return { calls };
}

/** `openExternalUrl` validates before opening, so the call is microtasks away. */
async function settleOpener(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function assertAbsent(node: Element | null, label: string): void {
  assert.ok(node === null, `expected no ${label}`);
}

function links(...entries: AiLink[]): AiLink[] {
  return entries;
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
  window.open = originalOpen;
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

// ── External ───────────────────────────────────────────────────────────────

test("an external link opens through the validated opener, with noopener", async () => {
  const opens = captureOpens();
  render(
    <AiLinkList
      links={links({
        kind: "external",
        label: "Cloudflare SPF docs",
        target: "https://developers.cloudflare.com/dns/spf/",
      })}
      navigation={navigation()}
    />,
  );

  const button = screen.getByTestId("ai-link");
  // A button, not an anchor: the desktop build has to route the URL through
  // the Tauri shell, which an anchor cannot do.
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  fireEvent.click(button);
  await settleOpener();

  assert.deepEqual(opens.calls, [
    [
      "https://developers.cloudflare.com/dns/spf/",
      "_blank",
      "noopener,noreferrer",
    ],
  ]);
});

test("the accessible name of an external link names the host it opens", () => {
  render(
    <AiLinkList
      links={links({
        kind: "external",
        label: "the SPF guide",
        target: "https://developers.cloudflare.com/dns/spf/",
      })}
      navigation={navigation()}
    />,
  );
  // The destination must never be a surprise — the rule `RegistrarSiteLink`
  // applies, for the same reason, except that here the label came from a model.
  assert.ok(
    screen.getByRole("button", {
      name: "Open the SPF guide in your browser (developers.cloudflare.com)",
    }),
  );
});

test("an external link works with no host navigation wired at all", async () => {
  // It needs nothing from the host, unlike every in-app kind.
  const opens = captureOpens();
  render(
    <AiLinkList
      links={links({
        kind: "external",
        label: "Docs",
        target: "https://example.com/docs",
      })}
    />,
  );
  fireEvent.click(screen.getByTestId("ai-link"));
  await settleOpener();
  assert.deepEqual(opens.calls, [
    ["https://example.com/docs", "_blank", "noopener,noreferrer"],
  ]);
});

// ── In-app ─────────────────────────────────────────────────────────────────

test("an in-app link navigates through the host's own callbacks", () => {
  const nav = navigation();
  render(
    <AiLinkList
      links={links(
        { kind: "zone", label: "example.com", target: KNOWN_ZONE },
        {
          kind: "record",
          label: "the MX record",
          target: `${KNOWN_ZONE}/rec_1-abc`,
        },
        {
          kind: "domainRegistry",
          label: "example.com registration",
          target: "example.com",
        },
        { kind: "workspace", label: "Registry", target: "registry" },
      )}
      navigation={nav}
    />,
  );

  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="ai-link"]'),
  );
  assert.deepEqual(
    buttons.map((node) => node.dataset.kind),
    ["zone", "record", "domainRegistry", "workspace"],
  );
  for (const button of buttons) fireEvent.click(button);

  assert.deepEqual(nav.zones, [KNOWN_ZONE]);
  assert.deepEqual(nav.records, [`${KNOWN_ZONE}/rec_1-abc`]);
  assert.deepEqual(nav.domains, ["example.com"]);
  assert.deepEqual(nav.workspaces, ["registry"]);
  // The destination pinned on the control is the *resolved* one, never the
  // string the model supplied.
  assert.equal(buttons[2].dataset.destination, "example.com");
});

test("an in-app link with no host navigation renders no control", () => {
  // An inert button would be worse than none, and the count says one went.
  render(
    <AiLinkList
      links={links({ kind: "zone", label: "example.com", target: KNOWN_ZONE })}
    />,
  );
  assertAbsent(screen.queryByTestId("ai-link"), "control with no host wiring");
  assert.match(
    screen.getByTestId("ai-link-dropped").textContent ?? "",
    /One link was left out/,
  );
});

test("a zone this account does not have renders no control", () => {
  const nav = navigation([KNOWN_ZONE]);
  render(
    <AiLinkList
      links={links({
        kind: "zone",
        label: "somebody else's zone",
        target: "zonebbbb2222",
      })}
      navigation={nav}
    />,
  );
  assertAbsent(screen.queryByTestId("ai-link"), "control for an unknown zone");
  assert.deepEqual(nav.zones, []);
});

// ── Targets that do not check out ──────────────────────────────────────────

test("a non-https or traversal target renders no control", () => {
  const nav = navigation();
  render(
    <AiLinkList
      links={links(
        { kind: "external", label: "Run it", target: "javascript:alert(1)" },
        { kind: "external", label: "Plaintext", target: "http://example.com/" },
        { kind: "external", label: "Local file", target: "file:///etc/passwd" },
        {
          kind: "record",
          label: "Up a level",
          target: `${KNOWN_ZONE}/../../secrets`,
        },
        { kind: "domainRegistry", label: "Dots", target: "../example.com" },
        { kind: "workspace", label: "Nowhere", target: "../settings" },
      )}
      navigation={nav}
    />,
  );

  const list = screen.getByTestId("ai-link-list");
  assert.equal(list.dataset.usable, "0");
  assert.equal(list.dataset.dropped, "6");
  assertAbsent(screen.queryByTestId("ai-link"), "control for a bad target");
  // And the raw target is nowhere on screen: showing it would still be an
  // invitation to copy it somewhere that does follow it.
  for (const target of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "../../secrets",
  ]) {
    assert.ok(
      !(list.textContent ?? "").includes(target),
      `${target} must not be rendered`,
    );
  }
  assert.match(
    screen.getByTestId("ai-link-dropped").textContent ?? "",
    /6 links were left out/,
  );
});

test("a bad target among good ones drops only itself", () => {
  const nav = navigation();
  render(
    <AiLinkList
      links={links(
        { kind: "zone", label: "example.com", target: KNOWN_ZONE },
        { kind: "external", label: "Run it", target: "javascript:alert(1)" },
      )}
      navigation={nav}
    />,
  );
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="ai-link"]'),
  );
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].dataset.kind, "zone");
  assert.equal(screen.getByTestId("ai-link-list").dataset.dropped, "1");
});

test("a label too long for the backend to have stored renders no control", () => {
  render(
    <AiLinkList
      links={links({
        kind: "external",
        label: "x".repeat(AI_LINK_LIMITS.labelBytes + 1),
        target: "https://example.com/",
      })}
      navigation={navigation()}
    />,
  );
  assertAbsent(
    screen.queryByTestId("ai-link"),
    "control for an over-long label",
  );
});

test("more links than one offer may carry are cut to the ceiling", () => {
  // The backend refuses an offer over `MAX_LINKS_PER_OFFER`, so a longer list
  // did not come from the offer path — and a model filling the panel with
  // controls is what that bound exists to stop.
  render(
    <AiLinkList
      links={Array.from(
        { length: AI_LINK_LIMITS.maxLinks + 4 },
        (_, index) => ({
          kind: "external" as const,
          label: `Link ${index}`,
          target: `https://example.com/${index}`,
        }),
      )}
      navigation={navigation()}
    />,
  );
  assert.equal(
    document.querySelectorAll('[data-testid="ai-link"]').length,
    AI_LINK_LIMITS.maxLinks,
  );
  assert.equal(screen.getByTestId("ai-link-list").dataset.dropped, String(4));
});

test("an empty offer renders nothing, heading included", () => {
  render(<AiLinkList links={[]} navigation={navigation()} heading="Places" />);
  assertAbsent(screen.queryByTestId("ai-link-list"), "list for no links");
});
