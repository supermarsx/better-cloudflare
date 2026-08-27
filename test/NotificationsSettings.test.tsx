import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { NotificationsSettings } from "../src/components/dns/NotificationsSettings";
import { resetNotificationSettingsCache } from "../src/hooks/dns/use-notification-settings";
import {
  TauriClient,
  type NotificationServiceStatus,
  type NotificationZoneSummary,
} from "../src/lib/api/tauri-client";
import {
  clampNotificationSettings,
  createDefaultNotificationSettings,
  type NotificationSettings,
  type NotificationSettingsInput,
} from "../src/lib/notifications/notification-settings";

/** Accessible name from the naming sources these controls actually use. */
function computeAccessibleName(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  }
  if (element.id) {
    const forLabel = document.querySelector(`label[for="${element.id}"]`);
    if (forLabel?.textContent) return forLabel.textContent;
  }
  const wrapping = element.closest("label");
  if (wrapping?.textContent) return wrapping.textContent;
  return element.textContent ?? "";
}

const STATUS: NotificationServiceStatus = {
  running: true,
  enabled: true,
  paused: false,
  quietHoursActive: false,
  zonesTracked: 2,
  unread: 0,
  lastRecordCheckAt: "2026-08-07T10:30:00Z",
  nextRecordCheckAt: "2026-08-07T10:45:00Z",
  lastPass: {
    kind: "records",
    startedAt: "2026-08-07T10:30:00Z",
    durationMs: 1840,
    zonesChecked: 2,
    notificationsCreated: 0,
    errors: 0,
  },
};

const ZONES: NotificationZoneSummary[] = [
  {
    zoneId: "zone-a",
    zoneName: "alpha.test",
    monitored: true,
    muted: false,
    lastCheckedAt: "2026-08-07T10:30:00Z",
    snapshotRecords: 12,
    expiresAt: "2027-03-14T00:00:00Z",
    daysLeft: 219,
    expirySource: "registrar",
  },
  {
    zoneId: "zone-b",
    zoneName: "beta.test",
    monitored: true,
    muted: false,
    lastCheckedAt: null,
    snapshotRecords: null,
    lastError: "RDAP lookup failed",
  },
];

type Backend = {
  stored: NotificationSettings;
  updates: NotificationSettings[];
  resets: unknown[];
};

function installBackend(initial: NotificationSettingsInput = {}): Backend {
  const backend: Backend = {
    stored: clampNotificationSettings(initial),
    updates: [],
    resets: [],
  };
  mock.method(
    TauriClient,
    "notificationsGetSettings",
    async () => backend.stored,
  );
  mock.method(
    TauriClient,
    "notificationsUpdateSettings",
    async (settings: NotificationSettings) => {
      backend.updates.push(settings);
      backend.stored = clampNotificationSettings(settings);
      return backend.stored;
    },
  );
  mock.method(TauriClient, "notificationsZoneSummary", async () => ZONES);
  mock.method(TauriClient, "notificationsResetState", async (what: unknown) => {
    backend.resets.push(what);
  });
  return backend;
}

function lastUpdate(backend: Backend): NotificationSettings {
  const last = backend.updates.at(-1);
  assert.ok(last, "expected at least one settings write");
  return last;
}

beforeEach(() => {
  resetNotificationSettingsCache();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

type Section = React.ComponentProps<
  typeof NotificationsSettings
>["initialSection"];

function renderSettings(
  section: Section,
  overrides: Partial<React.ComponentProps<typeof NotificationsSettings>> = {},
) {
  const calls: string[] = [];
  const props: React.ComponentProps<typeof NotificationsSettings> = {
    status: STATUS,
    onCheckNow: async (kind) => {
      calls.push(`checkNow:${kind ?? "default"}`);
    },
    onPause: async () => {
      calls.push("pause");
    },
    onResume: async () => {
      calls.push("resume");
    },
    initialSection: section,
    ...overrides,
  };
  const view = render(<NotificationsSettings {...props} />);
  return {
    calls,
    rerender: (next: Partial<typeof props>) =>
      view.rerender(<NotificationsSettings {...props} {...next} />),
  };
}

test("every sub-section renders from the seeded settings", async () => {
  installBackend();
  renderSettings("service");
  await screen.findByTestId("notifications-settings-service");
  assert.ok(screen.getByTestId("notifications-settings-status"));
  assert.equal(
    screen.getByTestId("notifications-service-state").textContent,
    "Running",
  );

  const toolbar = screen.getByRole("toolbar", {
    name: "Notification settings sections",
  });
  const expect = async (label: string, testId: string) => {
    fireEvent.click(within(toolbar).getByRole("button", { name: label }));
    await screen.findByTestId(testId);
  };
  await expect("Kinds", "notifications-settings-kind-recordChange");
  await expect("Expiry", "notifications-settings-milestones");
  await expect("Zones", "notifications-settings-zones");
  await screen.findByText("alpha.test");
  await expect("Delivery", "notifications-settings-quiet-hours");
  await expect("Retention", "notifications-settings-retention");
});

test("toggling the master switch writes service.enabled=false", async () => {
  const backend = installBackend();
  renderSettings("service");
  const master = await screen.findByRole("switch", {
    name: "Enable monitoring",
  });
  assert.equal(master.getAttribute("aria-checked"), "true");
  fireEvent.click(master);
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.equal(lastUpdate(backend).service.enabled, false);
  // The rest of the object is sent whole and unchanged.
  assert.equal(lastUpdate(backend).service.recordPollMinutes, 15);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("notifications-save-state").textContent,
      "Saved",
    ),
  );
});

test("Pause and Resume call the service commands and relabel", async () => {
  installBackend();
  const { calls, rerender } = renderSettings("service");
  const pause = await screen.findByRole("button", { name: "Pause" });
  fireEvent.click(pause);
  await waitFor(() => assert.deepEqual(calls, ["pause"]));

  rerender({ status: { ...STATUS, paused: true } });
  const resume = await screen.findByRole("button", { name: "Resume" });
  assert.equal(
    screen.getByTestId("notifications-service-state").textContent,
    "Paused",
  );
  fireEvent.click(resume);
  await waitFor(() => assert.deepEqual(calls, ["pause", "resume"]));
});

test("a typed poll interval is clamped and reported inline", async () => {
  const backend = installBackend();
  renderSettings("service");
  const input = await screen.findByRole("spinbutton", {
    name: "Record poll interval (minutes)",
  });
  assert.equal(input.getAttribute("min"), "5");
  assert.equal(input.getAttribute("max"), "1440");
  assert.ok(input.getAttribute("aria-describedby"));

  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.blur(input);
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.equal(lastUpdate(backend).service.recordPollMinutes, 5);
  assert.match(
    screen.getByText(/Adjusted to 5/).textContent ?? "",
    /allowed range 5–1440/,
  );
});

test("the reset rows ask for confirmation, then call notifications_reset_state", async () => {
  const backend = installBackend();
  renderSettings("service");
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete snapshots" }),
  );
  const dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByText("Delete record snapshots?"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => assert.deepEqual(backend.resets, [{ snapshots: true }]));
});

test("kind rows toggle enable, sub-kinds and the change fields", async () => {
  const backend = installBackend();
  renderSettings("kinds");
  const expiry = await screen.findByTestId(
    "notifications-settings-kind-domainExpiry",
  );
  fireEvent.click(within(expiry).getByRole("switch", { name: "Enabled" }));
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.equal(lastUpdate(backend).kinds.domainExpiry.enabled, false);

  fireEvent.click(
    screen.getByRole("switch", { name: "Report removed records" }),
  );
  await waitFor(() => assert.equal(backend.updates.length, 2));
  assert.equal(lastUpdate(backend).kinds.recordChange.changes.removed, false);

  fireEvent.click(screen.getByRole("checkbox", { name: "comment" }));
  await waitFor(() => assert.equal(backend.updates.length, 3));
  assert.deepEqual(lastUpdate(backend).kinds.recordChange.fields, [
    "content",
    "ttl",
    "proxied",
    "priority",
    "name",
    "type",
  ]);

  // Without the OS plugin the switch is disabled and says so; with it, it
  // is a live control (the kind is off here, so it stays disabled either way).
  const os = within(expiry).getByRole("switch", { name: "OS notification" });
  assert.equal(os.hasAttribute("disabled"), true);
  if (!TauriClient.hasOsNotifications) {
    assert.ok(within(expiry).getByText("Not available in this build."));
  }
});

test("the last change field cannot be removed", async () => {
  const backend = installBackend({
    kinds: { recordChange: { fields: ["content"] } },
  });
  renderSettings("kinds");
  const box = await screen.findByRole("checkbox", { name: "content" });
  fireEvent.click(box);
  assert.ok(screen.getByText("At least one field must count as a change."));
  assert.equal(backend.updates.length, 0);
});

test("milestones can be added, removed, and reject duplicates and overflow", async () => {
  const backend = installBackend();
  renderSettings("expiry");
  const list = await screen.findByRole("list", { name: "Expiry milestones" });
  assert.equal(within(list).getAllByTestId("milestone-chip").length, 7);

  const input = screen.getByRole("spinbutton", {
    name: "Add milestone (days)",
  });
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.deepEqual(
    lastUpdate(backend).expiry.milestones,
    [90, 60, 45, 30, 14, 7, 3, 1],
  );
  assert.equal((input as HTMLInputElement).value, "", "the input clears");

  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  assert.equal(
    screen.getByTestId("milestone-message").textContent,
    "45 days is already in the list.",
  );
  assert.equal(backend.updates.length, 1);

  fireEvent.change(input, { target: { value: "400" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  assert.match(
    screen.getByTestId("milestone-message").textContent ?? "",
    /between 1 and 365/,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Remove 45-day milestone" }),
  );
  await waitFor(() => assert.equal(backend.updates.length, 2));
  assert.deepEqual(
    lastUpdate(backend).expiry.milestones,
    [90, 60, 30, 14, 7, 3, 1],
  );
});

test("the milestone list is capped at twelve entries", async () => {
  const backend = installBackend({
    expiry: { milestones: [120, 110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10] },
  });
  renderSettings("expiry");
  const input = await screen.findByRole("spinbutton", {
    name: "Add milestone (days)",
  });
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  assert.equal(
    screen.getByTestId("milestone-message").textContent,
    "At most 12 milestones.",
  );
  assert.equal(backend.updates.length, 0);
});

test("zone rows map to exclude in 'all' mode and to include in allowlist mode", async () => {
  const backend = installBackend();
  renderSettings("zones");
  await screen.findByText("alpha.test");

  fireEvent.click(screen.getByRole("switch", { name: "Monitor alpha.test" }));
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.deepEqual(lastUpdate(backend).zones.exclude, ["zone-a"]);
  assert.deepEqual(lastUpdate(backend).zones.include, []);

  fireEvent.click(screen.getByRole("switch", { name: "Monitor alpha.test" }));
  await waitFor(() => assert.equal(backend.updates.length, 2));
  assert.deepEqual(lastUpdate(backend).zones.exclude, []);

  fireEvent.click(screen.getByRole("button", { name: "Monitor none" }));
  await waitFor(() => assert.equal(backend.updates.length, 3));
  assert.deepEqual(lastUpdate(backend).zones.exclude, ["zone-a", "zone-b"]);

  cleanup();
  mock.restoreAll();
  resetNotificationSettingsCache();
  const allowlist = installBackend({ zones: { mode: "allowlist" } });
  renderSettings("zones");
  await screen.findByText("alpha.test");
  const monitor = screen.getByRole("switch", { name: "Monitor beta.test" });
  assert.equal(monitor.getAttribute("aria-checked"), "false");
  fireEvent.click(monitor);
  await waitFor(() => assert.equal(allowlist.updates.length, 1));
  assert.deepEqual(lastUpdate(allowlist).zones.include, ["zone-b"]);
  assert.deepEqual(lastUpdate(allowlist).zones.exclude, []);

  fireEvent.click(screen.getByRole("button", { name: "Monitor all" }));
  await waitFor(() => assert.equal(allowlist.updates.length, 2));
  assert.deepEqual(lastUpdate(allowlist).zones.include, ["zone-a", "zone-b"]);
});

test("per-zone kind switches and mute picks land in zones.overrides", async () => {
  const backend = installBackend();
  const fixedNow = Date.parse("2026-08-07T10:00:00Z");
  render(
    <NotificationsSettings
      status={STATUS}
      onCheckNow={async () => {}}
      onPause={async () => {}}
      onResume={async () => {}}
      initialSection="zones"
    />,
  );
  await screen.findByText("alpha.test");

  fireEvent.click(
    screen.getByRole("switch", {
      name: "Record change notices for alpha.test",
    }),
  );
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.deepEqual(lastUpdate(backend).zones.overrides, {
    "zone-a": { muted: false, kinds: { recordChange: false } },
  });

  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Mute alpha.test for 8 h" }),
    );
    await waitFor(() => assert.equal(backend.updates.length, 2));
  } finally {
    Date.now = realNow;
  }
  const override = lastUpdate(backend).zones.overrides["zone-a"];
  assert.equal(override.muted, true);
  assert.deepEqual(override.kinds, { recordChange: false });
  const until = Date.parse(override.mutedUntil ?? "");
  assert.equal(until, fixedNow + 8 * 3_600_000);

  fireEvent.click(screen.getByRole("switch", { name: "Mute alpha.test" }));
  await waitFor(() => assert.equal(backend.updates.length, 3));
  assert.equal(lastUpdate(backend).zones.overrides["zone-a"].muted, false);
  assert.equal(
    lastUpdate(backend).zones.overrides["zone-a"].mutedUntil,
    undefined,
  );
});

test("quiet hours controls write the window, days and enable flag", async () => {
  const backend = installBackend();
  renderSettings("delivery");
  const enable = await screen.findByRole("switch", {
    name: "Enable quiet hours",
  });
  fireEvent.click(enable);
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.equal(lastUpdate(backend).quietHours.enabled, true);

  const start = screen.getByLabelText("From") as HTMLInputElement;
  fireEvent.change(start, { target: { value: "21:30" } });
  fireEvent.blur(start);
  await waitFor(() => assert.equal(backend.updates.length, 2));
  assert.equal(lastUpdate(backend).quietHours.start, "21:30");

  fireEvent.click(screen.getByRole("button", { name: "Saturday" }));
  await waitFor(() => assert.equal(backend.updates.length, 3));
  assert.deepEqual(lastUpdate(backend).quietHours.days, [0, 1, 2, 3, 4, 5]);

  // The OS switch follows the build: live with the plugin, disabled + note without.
  const os = screen.getByRole("switch", { name: "Show system notifications" });
  assert.equal(os.hasAttribute("disabled"), !TauriClient.hasOsNotifications);
  if (!TauriClient.hasOsNotifications) {
    assert.ok(screen.getByText("Not available in this build."));
  }

  fireEvent.click(
    screen.getByRole("switch", { name: "Unread badge on the bell" }),
  );
  await waitFor(() => assert.equal(backend.updates.length, 4));
  assert.equal(lastUpdate(backend).inApp.badge, false);
});

test("retention 'Never' clears the number and unchecking restores the default", async () => {
  const backend = installBackend();
  renderSettings("retention");
  const input = (await screen.findByRole("spinbutton", {
    name: "Auto-archive read items after",
  })) as HTMLInputElement;
  assert.equal(input.value, "30");
  const never = screen.getAllByRole("checkbox", { name: "Never" })[0];
  fireEvent.click(never);
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.equal(lastUpdate(backend).retention.autoArchiveReadAfterDays, null);
  await waitFor(() => assert.equal(input.value, ""));
  assert.equal(input.hasAttribute("disabled"), true);

  fireEvent.click(never);
  await waitFor(() => assert.equal(backend.updates.length, 2));
  assert.equal(lastUpdate(backend).retention.autoArchiveReadAfterDays, 30);

  fireEvent.click(
    screen.getByRole("switch", { name: "Keep record snapshots" }),
  );
  await waitFor(() => assert.equal(backend.updates.length, 3));
  assert.equal(lastUpdate(backend).retention.keepSnapshots, false);
  assert.ok(screen.getByText(/Record-change detection is off/));
});

test("Restore defaults asks first, then writes the default object", async () => {
  const backend = installBackend({ service: { recordPollMinutes: 60 } });
  renderSettings("service");
  await screen.findByTestId("notifications-settings-service");
  fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Restore defaults" }),
  );
  await waitFor(() => assert.equal(backend.updates.length, 1));
  assert.deepEqual(lastUpdate(backend), createDefaultNotificationSettings());
});

test("a failed write rolls back and is announced", async () => {
  installBackend();
  mock.method(TauriClient, "notificationsUpdateSettings", async () => {
    throw new Error("prefs write failed");
  });
  renderSettings("service");
  const master = await screen.findByRole("switch", {
    name: "Enable monitoring",
  });
  fireEvent.click(master);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("notifications-save-state").getAttribute("data-state"),
      "error",
    ),
  );
  assert.match(
    screen.getByTestId("notifications-save-state").textContent ?? "",
    /prefs write failed/,
  );
  assert.equal(master.getAttribute("aria-checked"), "true", "rolled back");
});

test("every switch, button, input and select in every section has a name", async () => {
  installBackend();
  renderSettings("service");
  await screen.findByTestId("notifications-settings-service");
  const toolbar = screen.getByRole("toolbar", {
    name: "Notification settings sections",
  });
  const sections = [
    "Service",
    "Kinds",
    "Expiry",
    "Zones",
    "Delivery",
    "Retention",
  ];
  for (const label of sections) {
    fireEvent.click(within(toolbar).getByRole("button", { name: label }));
    if (label === "Zones") await screen.findByText("alpha.test");
    for (const role of [
      "switch",
      "button",
      "spinbutton",
      "textbox",
      "searchbox",
      "checkbox",
      "combobox",
    ]) {
      for (const control of screen.queryAllByRole(role, { hidden: false })) {
        const name = computeAccessibleName(control);
        assert.ok(
          name.trim(),
          `${label}: ${role} without an accessible name: ${control.outerHTML.slice(0, 160)}`,
        );
      }
    }
    // `<input type="time">` and `datetime-local` have no ARIA role in jsdom;
    // check them by label association instead.
    for (const input of document.querySelectorAll<HTMLInputElement>(
      'input[type="time"], input[type="datetime-local"]',
    )) {
      assert.ok(
        computeAccessibleName(input).trim(),
        `${label}: unlabeled ${input.type} input`,
      );
    }
  }
});
