/**
 * The settings surfaces that landed with their data layers and no UI: the
 * re-hosted notification settings, update checking, the recycle bin, About and
 * Diagnostics.
 *
 * `settingsSearch.registry.test.ts` already proves every row here is indexed
 * and `DNSManager.settingsSearch.test.tsx` proves the rows reach the DOM with
 * the ids they claim. Neither says whether a control *does* anything, which is
 * what this suite is for — and, for three of these settings, whether what the
 * row says about itself is true:
 *
 *  - an `unknownVersion` update check must not read as a problem;
 *  - `includeUserData` must stay off until asked, and say what it reveals;
 *  - and a report already on screen must not survive a change to the rule it
 *    was built under, or the preview would disagree with the copy button.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, mock, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { DNSManager } from "../src/components/dns/DNSManager";
import { SETTINGS_SUBTABS } from "../src/components/dns/settings-search";
import { resetNotificationSettingsCache } from "../src/hooks/dns/use-notification-settings";
import {
  TauriClient,
  type McpServerStatus,
  type NotificationServiceStatus,
  type TauriZone,
  type UpdateCheck,
} from "../src/lib/api/tauri-client";
import { clampNotificationSettings } from "../src/lib/notifications/notification-settings";
import { storageManager } from "../src/lib/storage/storage";

import { useEnglishLocale } from "./i18n-ready";
import { enableThemedSelectEnvironment } from "./radix-select";

const originalFetch = globalThis.fetch;

const ZONE = {
  id: "zone-1",
  name: "example.test",
  status: "active",
  paused: false,
  type: "full",
  development_mode: 0,
} satisfies TauriZone;

const NOTIFICATION_STATUS: NotificationServiceStatus = {
  running: true,
  enabled: true,
  paused: false,
  quietHoursActive: false,
  zonesTracked: 1,
  unread: 0,
};

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

/** What `update_check` answered, and what it was asked. */
interface UpdateProbe {
  calls: boolean[];
  reply: UpdateCheck;
  /** Whether the call rejects, the way an offline or rate-limited host does. */
  fail: boolean;
}

interface RuntimeOptions {
  update?: Partial<UpdateCheck>;
  /**
   * Whether a completed check is already on the clock.
   *
   * Defaults to "just now", which makes the automatic check not due — so a
   * test about the *manual* path sees only the calls it made itself. A test
   * about the scheduler passes `null` for a profile that has never checked.
   */
  lastCheckedAt?: string | null;
  /** `false` renders the web build, where the check must not be attempted. */
  desktop?: boolean;
  /**
   * Make `update_check` reject from the first call.
   *
   * Set here rather than on the returned probe because the automatic check
   * fires during the mount: a flag flipped after `renderSettings` resolves
   * would be flipped after the call it was meant to govern.
   */
  fail?: boolean;
}

function mockRuntime(options: RuntimeOptions = {}): UpdateProbe {
  if (options.desktop !== false) {
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  }
  enableThemedSelectEnvironment();
  const stamp =
    options.lastCheckedAt === undefined
      ? new Date().toISOString()
      : options.lastCheckedAt;
  if (stamp !== null) storageManager.setUpdateCheckLastCheckedAt(stamp);

  const preferences: Record<string, unknown> = { last_zone: ZONE.id };
  mock.method(TauriClient, "getPreferences", async () => preferences);
  mock.method(TauriClient, "updatePreferences", async () => {});
  mock.method(TauriClient, "getZones", async () => [ZONE]);
  mock.method(TauriClient, "getDNSRecords", async () => []);
  mock.method(TauriClient, "getAuditEntries", async () => []);
  mock.method(TauriClient, "getMcpServerStatus", async () => createMcpStatus());
  mock.method(TauriClient, "setMcpEnabledTools", async () => createMcpStatus());
  mock.method(TauriClient, "startMcpServer", async () => createMcpStatus());
  mock.method(TauriClient, "stopMcpServer", async () => createMcpStatus());

  // The notification settings panel and the host's own status read.
  mock.method(TauriClient, "notificationsGetSettings", async () =>
    clampNotificationSettings({}),
  );
  mock.method(
    TauriClient,
    "notificationsUpdateSettings",
    async (settings: unknown) => clampNotificationSettings(settings),
  );
  mock.method(TauriClient, "notificationsStatus", async () =>
    structuredClone(NOTIFICATION_STATUS),
  );
  mock.method(TauriClient, "notificationsList", async () => []);
  mock.method(TauriClient, "notificationsUnreadCount", async () => 0);
  mock.method(TauriClient, "notificationsZoneSummary", async () => []);
  mock.method(TauriClient, "notificationsStart", async () =>
    structuredClone(NOTIFICATION_STATUS),
  );
  mock.method(TauriClient, "notificationsStop", async () => {});
  mock.method(TauriClient, "onNotificationsChanged", async () => () => {});

  const probe: UpdateProbe = {
    calls: [],
    fail: options.fail === true,
    reply: {
      current: "26.13",
      latest: {
        tag: "26.14",
        url: "https://github.com/supermarsx/better-cloudflare/releases/tag/26.14",
        publishedAt: "2026-09-01T00:00:00Z",
        prerelease: false,
      },
      status: "updateAvailable",
      checkedAt: "2026-09-04T00:00:00Z",
      ...(options.update ?? {}),
    },
  };
  mock.method(
    TauriClient,
    "checkForUpdate",
    async (includePrereleases: boolean) => {
      probe.calls.push(includePrereleases);
      if (probe.fail) throw new Error("GitHub rate limit exceeded");
      return probe.reply;
    },
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return probe;
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
  resetNotificationSettingsCache();
  storageManager.clearSettings();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete (globalThis as { fetch?: typeof fetch }).fetch;
});

/**
 * Open the Session settings tab.
 *
 * Clicked until the panel shows rather than once: preferences hydrate
 * asynchronously and the tab-restore effect re-activates the tab they name,
 * which can take the activation back off a settings tab opened too early.
 */
async function openSettings(): Promise<void> {
  const button = await screen.findByRole("button", { name: "Settings" });
  await waitFor(() => {
    fireEvent.click(button);
    assert.ok(
      screen.queryByTestId("settings-search"),
      "the Session settings tab did not open",
    );
  });
}

function subtabButton(id: string): HTMLElement {
  const descriptor = SETTINGS_SUBTABS.find((subtab) => subtab.id === id);
  assert.ok(descriptor, `no such subtab: ${id}`);
  return within(
    screen.getByRole("toolbar", { name: "Session settings sections" }),
  ).getByRole("button", { name: descriptor.label });
}

async function openSubtab(id: string): Promise<void> {
  fireEvent.click(subtabButton(id));
  await waitFor(() =>
    assert.equal(subtabButton(id).getAttribute("data-active"), "true"),
  );
}

function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-setting-id="${id}"]`,
  );
  assert.ok(found, `the ${id} row is not rendered`);
  return found;
}

/**
 * Pick an option from one themed dropdown on a screen that has several.
 *
 * `test/radix-select.ts` finds the open listbox with
 * `document.querySelector('[role="listbox"]')`, which is right for a surface
 * with a single dropdown. It is not right here: the harness flattens
 * `createPortal`, so a *closed* `Select` leaves its items inline too, and the
 * settings screen renders a dozen of them — the first listbox in the document
 * is almost never the one just opened. This scopes to the listbox the trigger
 * names through `aria-controls`, which Radix sets only while that one dropdown
 * is open, so it is also an assertion that the dropdown really opened.
 */
async function pickOption(trigger: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
  });
  const contentId = trigger.getAttribute("aria-controls");
  assert.ok(
    contentId,
    `the dropdown did not open (state: ${trigger.getAttribute("data-state")})`,
  );
  const listbox = document.getElementById(contentId);
  assert.ok(listbox, "the opened dropdown has no listbox in the document");
  const option = Array.from(
    listbox.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((candidate) => candidate.dataset.value === value);
  assert.ok(option, `the dropdown offers no option with value ${value}`);
  await act(async () => {
    fireEvent.click(option);
  });
}

async function renderSettings(
  options: RuntimeOptions = {},
): Promise<UpdateProbe> {
  await useEnglishLocale();
  const probe = mockRuntime(options);
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();
  return probe;
}

// ── The re-hosted notification settings ─────────────────────────────────────

test("the Notifications subtab hosts the notification settings panel", async () => {
  await renderSettings();
  await openSubtab("notifications");

  // The same panel the Notifications tab used to show behind its Settings
  // segment — its own section nav and its first section, not a rebuild.
  assert.ok(await screen.findByTestId("notifications-settings-host"));
  assert.ok(
    screen.getByRole("toolbar", { name: "Notification settings sections" }),
  );
  await screen.findByTestId("notifications-settings-service");
});

test("searching for a notification setting lands on its section", async () => {
  // The payoff of moving these into Settings. "Quiet hours" is a Delivery
  // control whose row lives in `NotificationsSettingsDelivery.tsx`, so the
  // index can only name the section — and naming it has to be enough to get
  // the user there, on the right section rather than the panel's default.
  await renderSettings();
  fireEvent.change(screen.getByRole("combobox", { name: "Find a setting" }), {
    target: { value: "quiet hours" },
  });

  const results = await screen.findByTestId("settings-search-results");
  const option = await waitFor(() => {
    const found = within(results)
      .queryAllByRole("option")
      .find(
        (candidate) =>
          candidate.getAttribute("data-setting-result") ===
          "notifications-delivery",
      );
    assert.ok(found, "search must offer the Delivery section");
    return found;
  });
  fireEvent.click(option);

  await waitFor(() =>
    assert.equal(
      subtabButton("notifications").getAttribute("data-active"),
      "true",
    ),
  );
  // Delivery, not the panel's own default of Service.
  await screen.findByTestId("notifications-settings-quiet-hours");
  assert.ok(
    screen.queryByTestId("notifications-settings-service") === null,
    "the jump must open the section it promised, not the default one",
  );
});

test("the chosen notification section survives a trip to another subtab", async () => {
  await renderSettings();
  await openSubtab("notifications");
  const sections = screen.getByRole("toolbar", {
    name: "Notification settings sections",
  });
  fireEvent.click(within(sections).getByRole("button", { name: "Expiry" }));
  await screen.findByTestId("notifications-settings-milestones");

  // This subtab unmounts the panel, so the section has to be held outside it.
  await openSubtab("general");
  await openSubtab("notifications");
  await screen.findByTestId("notifications-settings-milestones");
});

// ── Update checking ─────────────────────────────────────────────────────────

test("Check now asks the host, carrying the pre-release preference", async () => {
  const probe = await renderSettings();
  await openSubtab("about");

  fireEvent.click(
    within(row("update-check-status")).getByRole("button", {
      name: "Check now",
    }),
  );
  await waitFor(() => assert.deepEqual(probe.calls, [false]));
  await waitFor(() =>
    assert.match(
      screen.getByTestId("update-check-outcome").textContent ?? "",
      /26\.14 is available/u,
    ),
  );

  // Turning pre-releases on re-asks under the new rule, and must not leave
  // the previous answer standing in the meantime.
  fireEvent.click(within(row("update-check-prereleases")).getByRole("switch"));
  await waitFor(() =>
    assert.match(
      screen.getByTestId("update-check-outcome").textContent ?? "",
      /Not checked yet/u,
    ),
  );
  fireEvent.click(
    within(row("update-check-status")).getByRole("button", {
      name: "Check now",
    }),
  );
  await waitFor(() => assert.deepEqual(probe.calls, [false, true]));
});

test("an unstamped build does not read as a problem", async () => {
  await renderSettings({
    update: { current: null, latest: null, status: "unknownVersion" },
  });
  await openSubtab("about");
  fireEvent.click(
    within(row("update-check-status")).getByRole("button", {
      name: "Check now",
    }),
  );

  const outcome = await waitFor(() => {
    const node = screen.getByTestId("update-check-outcome");
    assert.equal(node.getAttribute("data-status"), "unknownVersion");
    return node;
  });
  // It says what happened: there is no tag to compare, which is true of every
  // build made from a checkout.
  assert.match(outcome.textContent ?? "", /no release tag/u);
  assert.match(outcome.textContent ?? "", /made from a checkout/u);
  // And it does not imply the build is behind, or that anything went wrong.
  assert.doesNotMatch(
    outcome.textContent ?? "",
    /out of date|outdated|available|unknown version|error|failed/iu,
    "an unstamped build is not out of date and is not a failure",
  );
  assert.ok(
    within(row("update-check-status")).queryByRole("alert") === null,
    "nothing in this row may be announced as an alert",
  );
});

test("with update checking off, Check now is disabled and nothing is asked", async () => {
  const probe = await renderSettings();
  await openSubtab("about");

  fireEvent.click(within(row("update-check-enabled")).getByRole("switch"));
  const button = within(row("update-check-status")).getByRole("button", {
    name: "Check now",
  });
  await waitFor(() => assert.equal(button.hasAttribute("disabled"), true));
  assert.match(
    screen.getByTestId("update-check-outcome").textContent ?? "",
    /Update checking is off/u,
  );

  fireEvent.click(button);
  assert.deepEqual(probe.calls, [], "a disabled check must send nothing");
  assert.equal(storageManager.getUpdateCheckEnabled(), false);
});

test("the check interval persists through the storage manager", async () => {
  await renderSettings();
  await openSubtab("about");
  await pickOption(
    within(row("update-check-interval")).getByRole("combobox"),
    "72",
  );
  await waitFor(() =>
    assert.equal(storageManager.getUpdateCheckIntervalHours(), 72),
  );
});

// ── The automatic check ─────────────────────────────────────────────────────
//
// `storageManager.isUpdateCheckDue()` owns the decision and is tested against
// its own edge cases in `storageManager.test.ts`. These are about the half
// that lives here: that a launch acts on it, that a completed check is
// recorded so the interval means something across restarts, and — the part
// that is easy to get wrong in the helpful direction — that a failure is
// completely silent.

test("a profile that has never checked checks at launch, unprompted", async () => {
  const probe = await renderSettings({ lastCheckedAt: null });
  await waitFor(() => assert.deepEqual(probe.calls, [false]));

  // Recorded, so the next launch does not check again straight away: without
  // the stamp the interval would measure from launch and every launch would
  // check, which is the setting reading as a cadence and behaving as "always".
  const stamp = storageManager.getUpdateCheckLastCheckedAt();
  assert.ok(stamp, "a completed check must be stamped");
  assert.ok(Date.now() - Date.parse(stamp) < 60_000);

  // And the answer is waiting on the About subtab without anyone clicking.
  await openSubtab("about");
  await waitFor(() =>
    assert.match(
      screen.getByTestId("update-check-outcome").textContent ?? "",
      /26\.14 is available/u,
    ),
  );
});

test("a check inside the interval is not repeated at launch", async () => {
  const probe = await renderSettings({
    lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  // One hour ago, against the 24-hour default.
  await openSubtab("about");
  await screen.findByTestId("update-check-outcome");
  assert.deepEqual(probe.calls, [], "nothing was due, so nothing went out");
});

test("a failed automatic check says nothing at all", async () => {
  // The conditions that make this fail — offline, a captive portal, GitHub
  // rate-limiting an unauthenticated caller — are ones the user either already
  // knows about or cannot act on, for a request they never asked for.
  const probe = await renderSettings({ lastCheckedAt: null, fail: true });
  await waitFor(() => assert.deepEqual(probe.calls, [false]));
  await waitFor(() =>
    assert.ok(storageManager.getUpdateCheckLastCheckedAt() !== null),
  );

  await openSubtab("about");
  const outcome = await screen.findByTestId("update-check-outcome");
  assert.equal(outcome.getAttribute("data-status"), "");
  assert.equal(outcome.textContent, "Not checked yet.");
  assert.ok(
    within(row("update-check-status")).queryByRole("alert") === null,
    "a background failure must not be announced",
  );
});

test("a refusal is stamped, so it costs one request per interval", async () => {
  // The failure path writes the stamp in `finally` for this reason: a rate
  // limit that left the check "still due" would turn into a retry loop against
  // the endpoint that just refused.
  const probe = await renderSettings({ lastCheckedAt: null, fail: true });
  await waitFor(() => assert.deepEqual(probe.calls, [false]));
  const stamp = await waitFor(() => {
    const value = storageManager.getUpdateCheckLastCheckedAt();
    assert.ok(value);
    return value;
  });
  assert.ok(Date.now() - Date.parse(stamp) < 60_000);
});

test("the web build never attempts the check", async () => {
  await useEnglishLocale();
  const probe = mockRuntime({ lastCheckedAt: null, desktop: false });
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  // `update_check` is a Tauri command; there is no host to ask.
  await screen.findByRole("button", { name: "Settings" });
  assert.deepEqual(probe.calls, []);
});

test("a manual check resets the clock rather than inviting another", async () => {
  // Ten hours ago, inside the 24-hour default, so the launch attempt declines
  // and the only check in this test is the one the user asks for.
  const stale = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  const probe = await renderSettings({ lastCheckedAt: stale });
  await openSubtab("about");
  assert.deepEqual(probe.calls, []);

  fireEvent.click(
    within(row("update-check-status")).getByRole("button", {
      name: "Check now",
    }),
  );
  await waitFor(() => assert.deepEqual(probe.calls, [false]));

  // The manual path writes the same stamp the scheduler does, so the scheduler
  // does not follow the user's own check with one of its own a minute later.
  await waitFor(() => {
    const after = storageManager.getUpdateCheckLastCheckedAt();
    assert.ok(after);
    assert.ok(
      Date.parse(after) > Date.parse(stale),
      "a check the user ran must move the clock",
    );
    assert.ok(Date.now() - Date.parse(after) < 60_000);
  });
});

test("turning on pre-releases does not force a check of its own", async () => {
  const probe = await renderSettings();
  await openSubtab("about");
  fireEvent.click(within(row("update-check-prereleases")).getByRole("switch"));

  // The poller is re-created under the new rule but the last stamp is still
  // inside the interval, so nothing goes out. A setting change is not a
  // request, and "Check now" is there for somebody who wants one.
  await waitFor(() =>
    assert.equal(storageManager.getUpdateCheckIncludePrereleases(), true),
  );
  assert.deepEqual(probe.calls, []);
});

// ── Recycle bin ─────────────────────────────────────────────────────────────

test("the recycle bin rows persist what they are set to", async () => {
  await renderSettings();
  await openSubtab("general");

  // On by default: a bin nobody discovers until the first time they needed it
  // is not a bin.
  assert.equal(
    within(row("recycle-bin-enabled"))
      .getByRole("switch")
      .getAttribute("aria-checked"),
    "true",
  );

  await pickOption(
    within(row("recycle-bin-retention-days")).getByRole("combobox"),
    "90",
  );
  await waitFor(() =>
    assert.equal(storageManager.getRecycleBinRetentionDays(), 90),
  );

  await pickOption(
    within(row("recycle-bin-max-entries")).getByRole("combobox"),
    "250",
  );
  await waitFor(() =>
    assert.equal(storageManager.getRecycleBinMaxEntries(), 250),
  );

  fireEvent.click(within(row("recycle-bin-auto-purge")).getByRole("switch"));
  await waitFor(() =>
    assert.equal(storageManager.getRecycleBinAutoPurge(), false),
  );
  fireEvent.click(within(row("recycle-bin-enabled")).getByRole("switch"));
  await waitFor(() =>
    assert.equal(storageManager.getRecycleBinEnabled(), false),
  );
});

test("the counter-intuitive halves of the bin are spelled out", async () => {
  await renderSettings();
  await openSubtab("general");

  // Retention applies forward only: an entry's expiry is stamped when it is
  // binned, so the date a user was shown is the date the purge honours.
  assert.match(
    row("recycle-bin-retention-days").textContent ?? "",
    /Entries already in the bin keep the expiry date they were given/u,
  );
  // And auto-purge off is not a stay of execution.
  assert.match(
    row("recycle-bin-auto-purge").textContent ?? "",
    /does not keep an expired entry restorable/u,
  );
});

// ── Diagnostics ─────────────────────────────────────────────────────────────

test("nothing is collected until the user asks for it", async () => {
  await renderSettings();
  await openSubtab("diagnostics");

  // `assert.ok` on the comparison, never `assert.equal` on a DOM node: a
  // failing node comparison makes `assert` deep-inspect a jsdom element and
  // exhausts the test process instead of printing a diff.
  assert.ok(
    screen.queryByTestId("diagnostics-report") === null,
    "opening the subtab must not run the probes",
  );
  // Zone names are off, and the row says what turning them on would reveal
  // before it is on.
  assert.equal(
    within(row("diagnostics-include-zone-names"))
      .getByRole("switch")
      .getAttribute("aria-checked"),
    "false",
  );
  assert.match(
    row("diagnostics-include-zone-names").textContent ?? "",
    /On, it names them — and a report exists to be pasted somewhere public/u,
  );
});

test("a collected report carries the builder's own withheld note", async () => {
  await renderSettings();
  await openSubtab("diagnostics");

  fireEvent.click(
    within(row("diagnostics-report")).getByRole("button", { name: "Collect" }),
  );
  await screen.findByTestId("diagnostics-report");

  // Rendered from `DiagnosticsReport.withheld`, not written again in the UI:
  // one of these lines flips with the opt-in, and a second copy would drift.
  const withheld = screen.getByTestId("diagnostics-withheld").textContent ?? "";
  assert.match(withheld, /zone and domain names, reported as counts only/u);
  assert.match(withheld, /API keys, bearer tokens, passwords/u);
  // The preview is the exact text the copy button will copy.
  assert.match(
    screen.getByTestId("diagnostics-preview").textContent ?? "",
    /Better Cloudflare diagnostics/u,
  );
});

test("turning zone names on discards the report collected without them", async () => {
  await renderSettings();
  await openSubtab("diagnostics");

  fireEvent.click(
    within(row("diagnostics-report")).getByRole("button", { name: "Collect" }),
  );
  await screen.findByTestId("diagnostics-report");

  fireEvent.click(
    within(row("diagnostics-include-zone-names")).getByRole("switch"),
  );
  await waitFor(() =>
    assert.ok(
      screen.queryByTestId("diagnostics-report") === null,
      "a preview built under the other rule would disagree with the copy button",
    ),
  );

  fireEvent.click(
    within(row("diagnostics-report")).getByRole("button", { name: "Collect" }),
  );
  await screen.findByTestId("diagnostics-report");
  assert.match(
    screen.getByTestId("diagnostics-withheld").textContent ?? "",
    /zone names are included, at the user's request/u,
  );
});

test("the opt-in is never remembered between mounts", async () => {
  await renderSettings();
  await openSubtab("diagnostics");
  fireEvent.click(
    within(row("diagnostics-include-zone-names")).getByRole("switch"),
  );
  await waitFor(() =>
    assert.equal(
      within(row("diagnostics-include-zone-names"))
        .getByRole("switch")
        .getAttribute("aria-checked"),
      "true",
    ),
  );

  // Consent to publish a DNS estate once is not consent next time.
  cleanup();
  render(<DNSManager apiKey="test-key" onLogout={() => {}} />);
  await openSettings();
  await openSubtab("diagnostics");
  assert.equal(
    within(row("diagnostics-include-zone-names"))
      .getByRole("switch")
      .getAttribute("aria-checked"),
    "false",
  );
});
