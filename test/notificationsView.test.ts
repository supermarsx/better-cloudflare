import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppNotification } from "../src/lib/api/tauri-client";
import {
  changedFields,
  countUnread,
  describeChange,
  describeExpiry,
  filterNotifications,
  fullTimestamp,
  groupByDay,
  isDomainExpiryPayload,
  isRecordChangePayload,
  kindLabel,
  NOTIFICATION_KINDS,
  relativeTime,
  severityLabel,
  zoneOptions,
} from "../src/lib/notifications/notifications-view";

function item(overrides: Partial<AppNotification>): AppNotification {
  return {
    id: "n",
    kind: "service",
    severity: "info",
    zoneId: null,
    zoneName: null,
    title: "title",
    body: "body",
    createdAt: "2026-08-26T10:00:00Z",
    readAt: null,
    archivedAt: null,
    dedupeKey: "k",
    payload: {},
    ...overrides,
  };
}

const NOW = new Date(2026, 7, 26, 12, 0, 0); // local Wed 2026-08-26 12:00

const expiry = item({
  id: "e1",
  kind: "domain_expiry",
  severity: "critical",
  zoneId: "z-labs",
  zoneName: "labs.test",
  title: "labs.test expires in 3 days",
  createdAt: new Date(2026, 7, 26, 8, 0).toISOString(),
  payload: {
    domain: "labs.test",
    expiresAt: "2026-08-29T00:00:00Z",
    daysLeft: 3,
    milestone: 3,
    source: "rdap",
  },
});
const change = item({
  id: "c1",
  kind: "record_change",
  severity: "warning",
  zoneId: "z-main",
  zoneName: "main.test",
  title: "A app.main.test changed",
  createdAt: new Date(2026, 7, 25, 23, 30).toISOString(),
  readAt: "2026-08-26T09:00:00Z",
  payload: {
    change: "changed",
    recordId: "r1",
    recordType: "A",
    recordName: "app.main.test",
    before: { content: "203.0.113.20", ttl: 1, proxied: true },
    after: { content: "203.0.113.99", ttl: 300, proxied: false },
  },
});
const archived = item({
  id: "s1",
  kind: "service",
  title: "Monitoring started",
  createdAt: new Date(2026, 7, 20, 9, 0).toISOString(),
  readAt: "2026-08-20T09:05:00Z",
  archivedAt: "2026-08-21T09:05:00Z",
});
const INBOX = [archived, change, expiry];

test("labels and kind catalogue", () => {
  assert.deepEqual(
    NOTIFICATION_KINDS.map((k) => k.value),
    ["domain_expiry", "record_change", "service"],
  );
  assert.equal(kindLabel("domain_expiry"), "Domain expiry");
  assert.equal(kindLabel("bogus"), "Notification");
  assert.equal(severityLabel("critical"), "Critical");
  assert.equal(severityLabel("bogus"), "Info");
});

test("payload guards", () => {
  assert.equal(isRecordChangePayload(change.payload), true);
  assert.equal(isRecordChangePayload(expiry.payload), false);
  assert.equal(isDomainExpiryPayload(expiry.payload), true);
  assert.equal(isDomainExpiryPayload(null), false);
});

test("filterNotifications by scope", () => {
  assert.deepEqual(
    filterNotifications(INBOX, { scope: "all" }).map((i) => i.id),
    ["c1", "e1"],
  );
  assert.deepEqual(
    filterNotifications(INBOX, { scope: "unread" }).map((i) => i.id),
    ["e1"],
  );
  assert.deepEqual(
    filterNotifications(INBOX, { scope: "archived" }).map((i) => i.id),
    ["s1"],
  );
  assert.equal(filterNotifications(INBOX).length, 2);
});

test("filterNotifications by kind, zone and search", () => {
  assert.deepEqual(
    filterNotifications(INBOX, { kind: "record_change" }).map((i) => i.id),
    ["c1"],
  );
  assert.deepEqual(
    filterNotifications(INBOX, { kind: "all", zoneId: "z-labs" }).map(
      (i) => i.id,
    ),
    ["e1"],
  );
  assert.deepEqual(
    filterNotifications(INBOX, { search: "  203.0.113.99 " }).map((i) => i.id),
    ["c1"],
  );
  assert.deepEqual(
    filterNotifications(INBOX, { search: "LABS" }).map((i) => i.id),
    ["e1"],
  );
  assert.deepEqual(
    filterNotifications(INBOX, { scope: "archived", search: "monitoring" }).map(
      (i) => i.id,
    ),
    ["s1"],
  );
  assert.deepEqual(filterNotifications(INBOX, { search: "nothing here" }), []);
});

test("groupByDay sorts newest first and labels Today/Yesterday", () => {
  const groups = groupByDay(INBOX, NOW, "en-US");
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [
      ["Today", ["e1"]],
      ["Yesterday", ["c1"]],
      ["Thursday, Aug 20", ["s1"]],
    ],
  );
  assert.equal(groups[0].key, "2026-08-26");
});

test("groupByDay puts unparsable dates last and labels older years", () => {
  const groups = groupByDay(
    [
      item({ id: "bad", createdAt: "not-a-date" }),
      item({ id: "old", createdAt: new Date(2025, 0, 5, 9).toISOString() }),
      item({ id: "recent", createdAt: new Date(2026, 7, 22, 9).toISOString() }),
    ],
    NOW,
    "en-US",
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.items[0].id]),
    [
      ["Saturday, Aug 22", "recent"],
      ["Jan 5, 2025", "old"],
      ["Unknown date", "bad"],
    ],
  );
});

test("describeChange covers added/removed/changed and field diffs", () => {
  assert.equal(
    describeChange(change.payload),
    "A app.main.test: 203.0.113.20 → 203.0.113.99, ttl: auto TTL → TTL 300, proxied: proxied → DNS only",
  );
  assert.equal(
    describeChange({
      change: "added",
      recordId: "r",
      recordType: "TXT",
      recordName: "_acme.main.test",
      after: { content: "token" },
    }),
    "TXT _acme.main.test added: token",
  );
  assert.equal(
    describeChange({
      change: "removed",
      recordId: "r",
      recordType: "MX",
      recordName: "main.test",
      before: { content: "mx1.main.test" },
    }),
    "MX main.test removed (was mx1.main.test)",
  );
  assert.equal(
    describeChange({
      change: "changed",
      recordId: "r",
      recordType: "A",
      recordName: "x",
    }),
    "A x changed",
  );
  assert.equal(describeChange({}), "");
});

test("changedFields reports only differing fields in canonical order", () => {
  assert.deepEqual(
    changedFields(
      { content: "a", ttl: 1, comment: null },
      { content: "a", ttl: 1, comment: "hello", priority: 10 },
    ),
    [
      { field: "priority", before: "—", after: "10" },
      { field: "comment", before: "—", after: "hello" },
    ],
  );
  assert.deepEqual(changedFields(undefined, undefined), []);
});

test("describeExpiry handles future, today and past", () => {
  assert.equal(
    describeExpiry(expiry.payload),
    "labs.test expires in 3 days (2026-08-29)",
  );
  assert.equal(
    describeExpiry({ ...expiry.payload, daysLeft: 1 }),
    "labs.test expires in 1 day (2026-08-29)",
  );
  assert.equal(
    describeExpiry({ ...expiry.payload, daysLeft: 0 }),
    "labs.test expires today (2026-08-29)",
  );
  assert.equal(
    describeExpiry({ ...expiry.payload, daysLeft: -2 }),
    "labs.test expired 2 days ago (2026-08-29)",
  );
  assert.equal(describeExpiry(change.payload), "");
});

test("relativeTime and fullTimestamp", () => {
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
  assert.equal(relativeTime(at(10_000), NOW), "just now");
  assert.equal(relativeTime(at(3 * 60_000), NOW), "3 min ago");
  assert.equal(relativeTime(at(2 * 3_600_000), NOW), "2 h ago");
  assert.equal(relativeTime(at(5 * 86_400_000), NOW), "5 d ago");
  assert.equal(relativeTime(at(30 * 86_400_000), NOW, "en-US"), "Jul 27");
  assert.equal(relativeTime("garbage", NOW), "");
  assert.equal(fullTimestamp("garbage"), "garbage");
  assert.match(fullTimestamp(expiry.createdAt, "en-US"), /Aug 26, 2026/);
});

test("countUnread and zoneOptions", () => {
  assert.equal(countUnread(INBOX), 1);
  assert.deepEqual(zoneOptions(INBOX), [
    { zoneId: "z-labs", zoneName: "labs.test" },
    { zoneId: "z-main", zoneName: "main.test" },
  ]);
});
