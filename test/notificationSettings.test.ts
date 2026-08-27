import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  clampNotificationSettings,
  createDefaultNotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  isZoneMonitored,
  isZoneMuted,
  mergeNotificationSettings,
  normalizeMilestones,
  osNotifyAllowed,
  quietHoursActive,
  settingsEqual,
  severityForChange,
  severityForExpiry,
  toastAllowed,
  zoneKindEnabled,
  type NotificationSettings,
} from "../src/lib/notifications/notification-settings";

interface FixtureCase {
  name: string;
  input: unknown;
  expectedNormalized:
    | "$defaults"
    | ({ $defaults: true } & Record<string, unknown>);
}

interface Fixture {
  defaults: NotificationSettings;
  cases: FixtureCase[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "test/fixtures/notification-settings.json"),
    "utf8",
  ),
);

function expected(entry: FixtureCase): NotificationSettings {
  if (entry.expectedNormalized === "$defaults") return fixture.defaults;
  const { $defaults: _flag, ...sections } = entry.expectedNormalized;
  return { ...fixture.defaults, ...sections } as NotificationSettings;
}

test("fixture defaults equal the TS defaults", () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_SETTINGS, fixture.defaults);
  assert.deepEqual(createDefaultNotificationSettings(), fixture.defaults);
});

for (const entry of fixture.cases) {
  test(`fixture parity: ${entry.name}`, () => {
    assert.deepEqual(clampNotificationSettings(entry.input), expected(entry));
  });
}

test("clamp is idempotent on every fixture output", () => {
  for (const entry of fixture.cases) {
    const once = clampNotificationSettings(entry.input);
    assert.deepEqual(clampNotificationSettings(once), once, entry.name);
  }
});

test("non-object and garbage input normalize to defaults", () => {
  assert.deepEqual(clampNotificationSettings(null), fixture.defaults);
  assert.deepEqual(clampNotificationSettings("nope"), fixture.defaults);
  assert.deepEqual(
    clampNotificationSettings({ service: "x", kinds: [], expiry: 4 }),
    fixture.defaults,
  );
});

test("non-integer numbers are rounded before clamping", () => {
  const out = clampNotificationSettings({
    service: { recordPollMinutes: 14.6 },
    retention: { maxItems: 150.2 },
  });
  assert.equal(out.service.recordPollMinutes, 15);
  assert.equal(out.retention.maxItems, 150);
});

test("normalizeMilestones drops non-numbers and keeps the largest twelve", () => {
  assert.deepEqual(normalizeMilestones(["x", 5, 5, 0, 366, 90.4]), [90, 5]);
  assert.deepEqual(normalizeMilestones(undefined), [90, 60, 30, 14, 7, 3, 1]);
  assert.equal(
    normalizeMilestones(Array.from({ length: 30 }, (_, i) => i + 1)).length,
    12,
  );
});

test("mergeNotificationSettings deep-merges objects and replaces arrays", () => {
  const base = createDefaultNotificationSettings();
  const merged = mergeNotificationSettings(base, {
    service: { recordPollMinutes: 30 },
    expiry: { milestones: [45] },
    zones: { exclude: ["z9"] },
  });
  assert.equal(merged.service.recordPollMinutes, 30);
  assert.equal(merged.service.expiryPollMinutes, 360);
  assert.deepEqual(merged.expiry.milestones, [45]);
  assert.equal(merged.expiry.notifyExpired, true);
  assert.deepEqual(merged.zones.exclude, ["z9"]);
  assert.equal(merged.zones.mode, "all");
  // Base untouched.
  assert.equal(base.service.recordPollMinutes, 15);
});

test("mergeNotificationSettings replaces zone overrides whole and honours null", () => {
  const base = clampNotificationSettings({
    zones: {
      overrides: {
        z1: { muted: true, mutedUntil: "2999-01-01T00:00:00Z" },
        z2: { muted: true },
      },
    },
  });
  const merged = mergeNotificationSettings(base, {
    zones: { overrides: { z1: { muted: false } } },
    retention: { autoArchiveReadAfterDays: null },
  });
  assert.deepEqual(merged.zones.overrides, { z1: { muted: false } });
  assert.equal(merged.retention.autoArchiveReadAfterDays, null);
  // `undefined` leaves the base value alone.
  const same = mergeNotificationSettings(base, {
    service: { recordPollMinutes: undefined },
  });
  assert.equal(same.service.recordPollMinutes, 15);
});

test("settingsEqual ignores key order and detects changes", () => {
  const a = createDefaultNotificationSettings();
  const b = JSON.parse(JSON.stringify(a)) as NotificationSettings;
  const reordered = {
    ...b,
    service: Object.fromEntries(
      Object.entries(b.service).reverse(),
    ) as NotificationSettings["service"],
  };
  assert.equal(settingsEqual(a, reordered), true);
  reordered.service.paused = true;
  assert.equal(settingsEqual(a, reordered), false);
});

test("zone helpers: exclude wins in all mode, allowlist ignores exclude", () => {
  const all = clampNotificationSettings({
    zones: { mode: "all", include: ["z1"], exclude: ["z1", "z2"] },
  });
  assert.equal(isZoneMonitored(all, "z1"), false);
  assert.equal(isZoneMonitored(all, "z2"), false);
  assert.equal(isZoneMonitored(all, "z3"), true);

  const allow = clampNotificationSettings({
    zones: { mode: "allowlist", include: ["z1"], exclude: ["z1"] },
  });
  assert.equal(isZoneMonitored(allow, "z1"), true);
  assert.equal(isZoneMonitored(allow, "z3"), false);
});

test("zone helpers: mute and per-zone kind overrides", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  const settings = clampNotificationSettings(
    {
      kinds: { service: { enabled: false } },
      zones: {
        overrides: {
          forever: { muted: true },
          timed: { muted: true, mutedUntil: "2026-08-26T13:00:00Z" },
          noExpiry: { muted: false, kinds: { domainExpiry: false } },
        },
      },
    },
    now,
  );
  assert.equal(isZoneMuted(settings, "forever", now), true);
  assert.equal(isZoneMuted(settings, "timed", now), true);
  assert.equal(isZoneMuted(settings, "timed", now + 2 * 3_600_000), false);
  assert.equal(isZoneMuted(settings, "unknown", now), false);

  assert.equal(zoneKindEnabled(settings, "noExpiry", "domainExpiry"), false);
  assert.equal(zoneKindEnabled(settings, "noExpiry", "recordChange"), true);
  assert.equal(zoneKindEnabled(settings, "forever", "recordChange"), true);
  assert.equal(zoneKindEnabled(settings, null, "service"), false);
  assert.equal(zoneKindEnabled(settings, undefined, "domainExpiry"), true);
});

function local(y: number, mo: number, d: number, h: number, mi: number) {
  return new Date(y, mo - 1, d, h, mi);
}

test("quiet hours across midnight, day filter and 24h window", () => {
  const settings = clampNotificationSettings({
    quietHours: { enabled: true, start: "22:00", end: "07:00" },
  });
  // 2026-08-26 is a Wednesday.
  assert.equal(quietHoursActive(settings, local(2026, 8, 26, 23, 30)), true);
  assert.equal(quietHoursActive(settings, local(2026, 8, 27, 6, 59)), true);
  assert.equal(quietHoursActive(settings, local(2026, 8, 27, 7, 0)), false);
  assert.equal(quietHoursActive(settings, local(2026, 8, 26, 12, 0)), false);
  assert.equal(quietHoursActive(settings, local(2026, 8, 26, 22, 0)), true);

  const disabled = clampNotificationSettings({
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  });
  assert.equal(quietHoursActive(disabled, local(2026, 8, 26, 23, 30)), false);

  // Only weekdays 1–5: Saturday night → Sunday morning is not covered.
  const weekdays = clampNotificationSettings({
    quietHours: {
      enabled: true,
      start: "22:00",
      end: "07:00",
      days: [1, 2, 3, 4, 5],
    },
  });
  assert.equal(quietHoursActive(weekdays, local(2026, 8, 29, 23, 0)), false); // Sat
  assert.equal(quietHoursActive(weekdays, local(2026, 8, 30, 6, 0)), false); // Sun morning (Sat leg)
  assert.equal(quietHoursActive(weekdays, local(2026, 8, 31, 23, 0)), true); // Mon
  assert.equal(quietHoursActive(weekdays, local(2026, 9, 1, 6, 0)), true); // Tue morning (Mon leg)

  const sameDay = clampNotificationSettings({
    quietHours: { enabled: true, start: "09:00", end: "17:00" },
  });
  assert.equal(quietHoursActive(sameDay, local(2026, 8, 26, 12, 0)), true);
  assert.equal(quietHoursActive(sameDay, local(2026, 8, 26, 17, 0)), false);

  const allDay = clampNotificationSettings({
    quietHours: { enabled: true, start: "08:00", end: "08:00", days: [3] },
  });
  assert.equal(quietHoursActive(allDay, local(2026, 8, 26, 3, 0)), true);
  assert.equal(quietHoursActive(allDay, local(2026, 8, 27, 3, 0)), false);
});

test("quiet hours honour an IANA timezone", () => {
  const settings = clampNotificationSettings({
    quietHours: {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    },
  });
  assert.equal(
    quietHoursActive(settings, new Date("2026-08-26T23:30:00Z")),
    true,
  );
  assert.equal(
    quietHoursActive(settings, new Date("2026-08-26T12:00:00Z")),
    false,
  );
});

test("severity mapping: auto thresholds vs fixed", () => {
  const auto = createDefaultNotificationSettings();
  assert.equal(severityForExpiry(auto, 90), "info");
  assert.equal(severityForExpiry(auto, 14), "warning");
  assert.equal(severityForExpiry(auto, 3), "critical");
  assert.equal(severityForExpiry(auto, -1), "critical");
  assert.equal(severityForChange(auto, "added"), "warning");
  assert.equal(severityForChange(auto, "changed"), "warning");
  assert.equal(severityForChange(auto, "removed"), "critical");

  const fixed = clampNotificationSettings({
    kinds: {
      domainExpiry: { severity: "info" },
      recordChange: { severity: "critical" },
    },
  });
  assert.equal(severityForExpiry(fixed, 0), "info");
  assert.equal(severityForChange(fixed, "added"), "critical");
});

test("osNotifyAllowed and toastAllowed respect every gate", () => {
  const noon = local(2026, 8, 26, 12, 0);
  const night = local(2026, 8, 26, 23, 0);
  const settings = clampNotificationSettings({
    quietHours: { enabled: true, start: "22:00", end: "07:00" },
    zones: { overrides: { muted: { muted: true } } },
  });
  assert.equal(
    osNotifyAllowed(settings, "domainExpiry", "warning", "z1", noon),
    true,
  );
  assert.equal(
    osNotifyAllowed(settings, "domainExpiry", "info", "z1", noon),
    false,
  );
  assert.equal(
    osNotifyAllowed(settings, "service", "critical", null, noon),
    false,
  );
  assert.equal(
    osNotifyAllowed(settings, "domainExpiry", "critical", "z1", night),
    false,
  );
  assert.equal(
    osNotifyAllowed(settings, "domainExpiry", "critical", "muted", noon),
    false,
  );
  const off = clampNotificationSettings({
    osNotifications: { enabled: false },
  });
  assert.equal(
    osNotifyAllowed(off, "domainExpiry", "critical", null, noon),
    false,
  );

  assert.equal(toastAllowed(settings, "critical", noon), true);
  assert.equal(toastAllowed(settings, "warning", noon), false);
  assert.equal(toastAllowed(settings, "critical", night), false);
  const never = clampNotificationSettings({
    inApp: { toastMinSeverity: "never" },
  });
  assert.equal(toastAllowed(never, "critical", noon), false);
});
