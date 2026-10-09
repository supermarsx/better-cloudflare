/**
 * "Find a setting" in the real settings screen.
 *
 * Three different jobs here, and they are deliberately in one file because
 * they share one expensive render:
 *
 *  1. the search box behaves like a combobox a keyboard can drive;
 *  2. choosing a result opens the owning subtab and reveals the row — or says
 *     why it cannot, for the rows that only exist under a condition;
 *  3. the rows that actually reach the DOM carry the ids and the labels the
 *     registry claims they do.
 *
 * (3) is the DOM-side half of `settingsSearch.registry.test.ts`. That suite
 * reads the component's source, which is complete but one step removed from
 * what a user sees; this one reads the rendered output, which is the real
 * thing but only covers the rows a given state renders. Together they close
 * over each other: the source cannot claim an id the DOM does not carry, and
 * the DOM cannot carry a label the registry does not know.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { DNSManager } from "../src/components/dns/DNSManager";
import { SettingsSearch } from "../src/components/dns/SettingsSearch";
import {
  SETTINGS_SUBTABS,
  findSettingsEntry,
} from "../src/components/dns/settings-search";
import {
  TauriClient,
  type McpServerStatus,
  type TauriZone,
} from "../src/lib/api/tauri-client";
import { storageManager } from "../src/lib/storage/storage";
import { useEnglishLocale } from "./i18n-ready";

const originalFetch = globalThis.fetch;
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

const ZONE = {
  id: "zone-1",
  name: "example.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

function createMcpStatus(): McpServerStatus {
  return {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    url: "http://127.0.0.1:8787/mcp",
    enabledTools: [],
    tools: [],
    lastError: null,
  };
}

/** Elements `scrollIntoView` was called on, in order. */
let scrolled: Element[] = [];

function mockRuntime(): void {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  scrolled = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function scrollIntoViewSpy(this: Element) {
      scrolled.push(this);
    },
  });

  const preferences: Record<string, unknown> = {
    reopen_last_tabs: true,
    reopen_zone_tabs: { [ZONE.id]: true },
    last_open_tabs: [ZONE.id],
    last_zone: ZONE.id,
    last_active_tab: `${ZONE.id}|records`,
  };

  mock.method(TauriClient, "getPreferences", async () => preferences);
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => []);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/**
 * Open the Session settings tab and return the search box.
 *
 * Clicked until the panel is actually showing, rather than once: preferences
 * hydrate asynchronously and the tab-restore effect re-activates the tab they
 * name, which takes the activation back off a settings tab opened before that
 * landed. Retrying the click keeps this independent of that timing.
 */
async function openSettings(): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: "Settings" });
  await waitFor(() => {
    fireEvent.click(button);
    assert.ok(
      screen.queryByTestId("settings-search"),
      "the Session settings tab did not open",
    );
  });
  return screen.getByTestId("settings-search");
}

function searchInput(): HTMLInputElement {
  return screen.getByRole("combobox", {
    name: "Find a setting",
  }) as HTMLInputElement;
}

function typeQuery(query: string): void {
  fireEvent.change(searchInput(), { target: { value: query } });
}

/**
 * The search result list.
 *
 * Scoped queries throughout, because this harness flattens `createPortal` and
 * so every closed themed `Select` on the settings screen leaves its own
 * `role="option"` items in the document (see `test/radix-select.ts`). A bare
 * `getAllByRole("option")` would be answering about those.
 */
function resultList(): HTMLElement {
  return screen.getByTestId("settings-search-results");
}

function options(): HTMLElement[] {
  return within(resultList()).queryAllByRole("option");
}

function optionIds(): string[] {
  return options().map(
    (option) => option.getAttribute("data-setting-result") ?? "",
  );
}

function activeOption(): HTMLElement {
  return within(resultList()).getByRole("option", { selected: true });
}

async function findOptions(): Promise<HTMLElement[]> {
  await waitFor(() => assert.ok(options().length > 0));
  return options();
}

/** The subtab nav button for a subtab, by its registered label. */
function subtabButton(id: string): HTMLElement {
  const descriptor = SETTINGS_SUBTABS.find((subtab) => subtab.id === id);
  assert.ok(descriptor, `no such subtab: ${id}`);
  const toolbar = screen.getByRole("toolbar", {
    name: "Session settings sections",
  });
  return within(toolbar).getByRole("button", { name: descriptor.label });
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  }
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

test("the search field is labelled and starts closed", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const box = await openSettings();

  const input = searchInput();
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-autocomplete"), "list");
  // `aria-controls` must resolve, closed or not.
  const listboxId = input.getAttribute("aria-controls");
  assert.ok(listboxId);
  // `assert.ok` on the comparison, never `assert.equal` on two DOM nodes: a
  // failing node comparison makes `assert` deep-inspect two jsdom elements,
  // which exhausts the test process's memory instead of printing a diff.
  assert.ok(
    document.getElementById(listboxId) === resultList(),
    "aria-controls must name the result listbox",
  );
  assert.equal(options().length, 0);
  // Nothing is announced before the user has typed.
  assert.equal(within(box).getByRole("status").textContent, "");
});

test("typing lists matching settings and announces how many", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const box = await openSettings();

  typeQuery("idle");
  await findOptions();

  assert.equal(searchInput().getAttribute("aria-expanded"), "true");
  assert.ok(optionIds().includes("auto-logout-idle"));

  const announced = within(box).getByRole("status").textContent ?? "";
  assert.match(announced, /\d+ settings? match/u);

  // The breadcrumb tells the user which subtab the setting lives in.
  assert.match(activeOption().textContent ?? "", /General/u);
});

test("a search with no hits says so rather than going quiet", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  const box = await openSettings();

  typeQuery("zzzzz-not-a-setting");
  const empty = await screen.findByTestId("settings-search-empty");
  assert.match(empty.textContent ?? "", /No settings match/u);
  assert.equal(searchInput().getAttribute("aria-expanded"), "false");
  assert.match(
    within(box).getByRole("status").textContent ?? "",
    /No settings match/u,
  );
});

test("the arrow keys move the active option and Enter takes it", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("export");
  await waitFor(() => assert.ok(options().length > 1));

  const input = searchInput();
  const first = input.getAttribute("aria-activedescendant");
  assert.ok(first);

  fireEvent.keyDown(input, { key: "ArrowDown" });
  const second = searchInput().getAttribute("aria-activedescendant");
  assert.notEqual(second, first);
  assert.equal(
    activeOption().id,
    second,
    "aria-activedescendant must name the option marked selected",
  );

  fireEvent.keyDown(input, { key: "ArrowUp" });
  assert.equal(searchInput().getAttribute("aria-activedescendant"), first);

  // Enter takes the active option: the query clears and a subtab is chosen.
  const chosen = optionIds()[0];
  fireEvent.keyDown(searchInput(), { key: "Enter" });
  await waitFor(() => assert.equal(searchInput().value, ""));
  const entry = findSettingsEntry(chosen);
  assert.ok(entry);
  assert.equal(subtabButton(entry.subtab).getAttribute("data-active"), "true");
});

test("Escape clears the query", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("idle");
  await findOptions();
  fireEvent.keyDown(searchInput(), { key: "Escape" });
  await waitFor(() => assert.equal(searchInput().value, ""));
  assert.equal(options().length, 0);
});

test("the clear button empties the query and keeps focus in the field", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("idle");
  fireEvent.click(
    await screen.findByRole("button", { name: "Clear settings search" }),
  );
  await waitFor(() => assert.equal(searchInput().value, ""));
  assert.ok(
    document.activeElement === searchInput(),
    "clearing must leave the caret in the search field",
  );
});

test("choosing a result opens its subtab and reveals the row", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  // A setting on a subtab that is not the one currently open.
  assert.equal(subtabButton("mcp").getAttribute("data-active"), "false");
  typeQuery("bind host");
  const [option] = await findOptions();
  assert.equal(option.getAttribute("data-setting-result"), "mcp-bind-host");
  fireEvent.click(option);

  await waitFor(() =>
    assert.equal(subtabButton("mcp").getAttribute("data-active"), "true"),
  );
  const row = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      '[data-setting-id="mcp-bind-host"]',
    );
    assert.ok(found, "the MCP bind host row must render");
    return found;
  });

  // Scrolled to, flashed, and the caret put on the first control in the row.
  await waitFor(() => assert.ok(scrolled.includes(row)));
  assert.equal(row.getAttribute("data-revealed"), "true");
  assert.ok(
    row.contains(document.activeElement),
    "focus must land inside the revealed row",
  );
  // The search closes so the result list cannot cover the row it revealed.
  assert.equal(searchInput().value, "");
  assert.equal(options().length, 0);
});

test("the flash is removed again, so it reads as a flash", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("loader timeout");
  fireEvent.click((await findOptions())[0]);
  const row = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      '[data-setting-id="loader-timeout"]',
    );
    assert.ok(found);
    return found;
  });
  assert.equal(row.getAttribute("data-revealed"), "true");
  await waitFor(() => assert.equal(row.hasAttribute("data-revealed"), false), {
    timeout: 4_000,
  });
});

test("a row that is not currently rendered says what it needs", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  // The custom DoH endpoint exists only while the request mode is DoH, which
  // it is not by default. The jump must explain itself rather than appearing
  // to do nothing.
  typeQuery("custom doh endpoint");
  fireEvent.click((await findOptions())[0]);

  await waitFor(() =>
    assert.equal(subtabButton("topology").getAttribute("data-active"), "true"),
  );
  const notice = await screen.findByTestId("settings-jump-notice");
  assert.match(notice.textContent ?? "", /Custom DoH endpoint/u);
  assert.match(notice.textContent ?? "", /DNS-over-HTTPS/u);
  assert.ok(
    document.querySelector(
      '[data-setting-id="topology-custom-doh-endpoint"]',
    ) === null,
    "the row must still be absent — the notice is instead of it, not as well",
  );
});

test("the notice goes once the user navigates for themselves", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("custom doh endpoint");
  fireEvent.click((await findOptions())[0]);
  await screen.findByTestId("settings-jump-notice");

  // Advice about the Topology subtab has no business following the user to
  // another one.
  fireEvent.click(subtabButton("general"));
  await waitFor(() =>
    assert.ok(
      screen.queryByTestId("settings-jump-notice") === null,
      "the jump notice must not outlive the subtab it was about",
    ),
  );
});

test("leaving a subtab cancels a reveal rather than arming it", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("loader timeout");
  fireEvent.click((await findOptions())[0]);
  await waitFor(() => {
    const row = document.querySelector('[data-setting-id="loader-timeout"]');
    assert.equal(row?.getAttribute("data-revealed"), "true");
  });

  // Walk away mid-flash and come straight back. The row must be quiet: a
  // reveal left pending would fire whenever the user next happened to open
  // this subtab, which reads as a glitch rather than an answer.
  fireEvent.click(subtabButton("topology"));
  await waitFor(() =>
    assert.equal(subtabButton("topology").getAttribute("data-active"), "true"),
  );
  fireEvent.click(subtabButton("general"));
  const row = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      '[data-setting-id="loader-timeout"]',
    );
    assert.ok(found, "the loader timeout row must be back");
    return found;
  });
  assert.equal(row.hasAttribute("data-revealed"), false);
});

test("a Columns result jumps to the right column toggle", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  typeQuery("proxy column");
  const found = await findOptions();
  const option = found.find((candidate) =>
    /Columns/u.test(candidate.textContent ?? ""),
  );
  assert.ok(option, "a Columns result must be offered");
  fireEvent.click(option);

  await waitFor(() =>
    assert.equal(subtabButton("columns").getAttribute("data-active"), "true"),
  );
  const toggle = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      '[data-testid="column-group-dnsRecords"] [data-column-id="proxied"]',
    );
    assert.ok(found, "the DNS records proxy column toggle must render");
    return found;
  });
  await waitFor(() => assert.ok(scrolled.includes(toggle)));
  assert.ok(toggle.contains(document.activeElement));
});

test("the subtab nav renders exactly the registered subtabs", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  const toolbar = screen.getByRole("toolbar", {
    name: "Session settings sections",
  });
  const labels = Array.from(toolbar.querySelectorAll("button")).map((button) =>
    (button.textContent ?? "").trim(),
  );
  assert.deepEqual(
    labels,
    SETTINGS_SUBTABS.map((subtab) => subtab.label),
    "the nav and the search breadcrumbs must name the subtabs identically",
  );
});

test("every rendered settings row is in the registry, with its own label", async () => {
  await useEnglishLocale();
  mockRuntime();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();

  let checked = 0;
  for (const subtab of SETTINGS_SUBTABS) {
    fireEvent.click(subtabButton(subtab.id));
    await waitFor(() =>
      assert.equal(subtabButton(subtab.id).getAttribute("data-active"), "true"),
    );

    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="grid gap-3 px-4 py-3"]'),
    );
    for (const row of rows) {
      const id = row.getAttribute("data-setting-id");
      assert.ok(
        id,
        `a rendered ${subtab.id} settings row carries no data-setting-id: ${(row.textContent ?? "").slice(0, 60)}`,
      );
      const entry = findSettingsEntry(id);
      assert.ok(entry, `rendered row ${id} is not in the registry`);
      assert.equal(
        entry.subtab,
        subtab.id,
        `${id} renders on ${subtab.id} but the registry says ${entry.subtab}`,
      );
      const label = (
        row.querySelector(".font-medium")?.textContent ?? ""
      ).trim();
      assert.equal(
        label,
        entry.label,
        `${id} renders the label ${JSON.stringify(label)} but search matches ${JSON.stringify(entry.label)}`,
      );
      checked += 1;
    }
  }

  // The desktop default state renders most of the index; a collapse to a
  // handful would make the loop above pass without checking anything.
  assert.ok(
    checked >= 30,
    `only ${checked} settings rows were rendered across every subtab`,
  );
});

test("the search icon's positioning context holds the field and nothing that grows", () => {
  // A layout bug that jsdom cannot measure, pinned structurally instead.
  //
  // The icon and the clear button are `absolute … top-1/2`, so they centre on
  // whichever ancestor establishes the positioning context. That used to be
  // the component's outer `relative`, which also contains the "no settings
  // match" paragraph — and that paragraph is in normal flow, so a search with
  // no results made the box taller and dropped both overlays to the middle of
  // the whole thing instead of the middle of the input.
  //
  // So the invariant is not "the icon is centred" but "the thing it centres on
  // cannot change height": the nearest positioned ancestor must contain the
  // input and must not contain the results list or the empty-state message.
  render(
    <SettingsSearch
      query=""
      onQueryChange={() => {}}
      onPick={() => {}}
      desktop
    />,
  );

  const root = screen.getByTestId("settings-search");
  const icon = root.querySelector("svg");
  assert.ok(icon, "the search field should render its icon");

  let context: HTMLElement | null = icon.parentElement;
  while (context && !context.className.includes("relative")) {
    context = context.parentElement;
  }
  assert.ok(context, "the icon should have a positioned ancestor");

  assert.ok(
    context.querySelector("input"),
    "the icon's positioning context must contain the input it sits in",
  );
  assert.ok(
    context.querySelector('[data-testid="settings-search-results"]') === null,
    "the results list must sit outside the icon's positioning context",
  );
  assert.ok(
    context !== root,
    "the outer container also holds the empty-state message, which grows; the field needs its own context",
  );
});
