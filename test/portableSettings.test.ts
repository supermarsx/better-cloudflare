/**
 * Two of the three properties in `src/lib/portable/types.ts`, written as the
 * attacks they are there to stop.
 *
 * The credential test plants `apiKeys` and `currentSession` -- the two fields
 * `StorageData` adds on top of `BrowserPreferenceData` -- on both sides: in the
 * object handed to the exporter, in case an export could ever carry them, and
 * in the payload of a file handed to the importer, in case a hand-made file
 * could put them back. Neither may survive, and the reason neither does is
 * that `sanitizeBrowserPreferencesValue` projects onto a schema that cannot
 * name them.
 *
 * The feature-switch test checks where a row lands rather than whether it
 * exists. `passkeysEnabled: true` arriving in `changed` would be applied by
 * "apply all" and would re-open the ceremony path someone deliberately shut,
 * which is the hazard `BrowserPreferenceData` names in its own comment; the
 * same row in `optIn` is a question.
 *
 * The diff assertions lean on the difference between unset and `false`,
 * because several of these preferences are documented "absent means on". A
 * comparison that treated the two as the same would report "off to off" for a
 * row that is about to turn a feature off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEnvelope } from "../src/lib/portable/envelope";
import {
  diffPortableSettings,
  exportSettings,
  parseSettingsFile,
} from "../src/lib/portable/settings";
import {
  PORTABLE_GATED_PREFERENCE_KEYS,
  PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS,
  type PortableSettings,
} from "../src/lib/portable/types";
import type { BrowserPreferenceData } from "../src/lib/storage/storage-util";

const OPTIONS = { appVersion: "1.2.3", now: new Date("2026-03-04T05:06:07Z") };

function preferences(value: Record<string, unknown>): BrowserPreferenceData {
  return value as unknown as BrowserPreferenceData;
}

function settingsFile(value: Record<string, unknown>): string {
  return JSON.stringify(
    buildEnvelope("settings", { preferences: value }, OPTIONS),
  );
}

function parsedPreferences(
  value: Record<string, unknown>,
): BrowserPreferenceData {
  const parse = parseSettingsFile(settingsFile(value));
  assert.equal(parse.ok, true);
  return parse.ok ? parse.value.payload.preferences : {};
}

function incoming(value: Record<string, unknown>): PortableSettings {
  return { preferences: preferences(value) };
}

function keysOf(rows: readonly { key: string }[]): string[] {
  return rows.map(({ key }) => key);
}

test("an export carries no credential, however the object it is given is shaped", () => {
  const envelope = exportSettings(
    preferences({
      // What `StorageData` actually holds alongside the preferences.
      apiKeys: [{ id: "k1", name: "prod", token: "secret-token" }],
      currentSession: "session-secret",
      vaultEnabled: true,
      defaultPerPage: 50,
    }),
    OPTIONS,
  );

  assert.deepEqual(Object.keys(envelope.payload.preferences).sort(), [
    "defaultPerPage",
    "vaultEnabled",
  ]);
  // Asserted on the serialized file as well: a key the projection missed would
  // still be in the bytes that leave the machine.
  const raw = JSON.stringify(envelope);
  assert.equal(raw.includes("secret-token"), false);
  assert.equal(raw.includes("session-secret"), false);
  assert.equal(raw.includes("apiKeys"), false);
  assert.equal(raw.includes("currentSession"), false);
});

test("a file cannot put a credential back", () => {
  const parsed = parsedPreferences({
    apiKeys: [{ id: "k1", token: "secret-token" }],
    currentSession: "session-secret",
    defaultPerPage: 25,
  });
  assert.deepEqual(Object.keys(parsed), ["defaultPerPage"]);

  const parse = parseSettingsFile(
    settingsFile({ apiKeys: [], currentSession: "x", defaultPerPage: 25 }),
  );
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  // Reported rather than silently dropped, so a file written by a build this
  // one does not understand is legible as a downgrade.
  assert.deepEqual(
    parse.warnings
      .filter(({ reason }) => reason === "unknown-preference")
      .flatMap(({ subjects }) => subjects)
      .sort(),
    ["apiKeys", "currentSession"],
  );

  const diff = diffPortableSettings(
    {},
    incoming({ apiKeys: [], currentSession: "x", defaultPerPage: 25 }),
  );
  assert.deepEqual(keysOf(diff.changed), ["defaultPerPage"]);
  assert.deepEqual(diff.droppedKeys.sort(), ["apiKeys", "currentSession"]);
});

test("turning the outbound switches on needs a tick; turning them off does not", () => {
  // Direction is the whole point. Restarting RDAP lookups or the latency
  // probe is work someone deliberately stopped, so it is a question the user
  // answers row by row. Stopping them is not a hazard and needs no ceremony.
  const on = diffPortableSettings(
    { registryMonitoringEnabled: false, cloudflareLatencyEnabled: false },
    incoming({
      registryMonitoringEnabled: true,
      cloudflareLatencyEnabled: true,
      defaultPerPage: 50,
    }),
  );
  assert.deepEqual(keysOf(on.optIn).sort(), [
    "cloudflareLatencyEnabled",
    "registryMonitoringEnabled",
  ]);
  assert.deepEqual(keysOf(on.changed), ["defaultPerPage"]);
  assert.deepEqual(on.withheld, []);

  const off = diffPortableSettings(
    {},
    incoming({
      registryMonitoringEnabled: false,
      cloudflareLatencyEnabled: false,
    }),
  );
  assert.deepEqual(keysOf(off.changed).sort(), [
    "cloudflareLatencyEnabled",
    "registryMonitoringEnabled",
  ]);
  assert.deepEqual(off.optIn, []);
});

test("an import may switch passkeys on, and may never switch them off", () => {
  // The mirror of the two above, and the reason the policy is per key. A
  // passkey here releases the API key from the OS vault without that key's
  // password, so it is a second *route*, not a second factor -- and it may be
  // the only route a user still remembers. The settings screen refuses to turn
  // it off until that key's password is proven in the same dialog; a tick in
  // an import preview is not that proof, so the off direction is refused
  // outright rather than offered.
  const off = diffPortableSettings({}, incoming({ passkeysEnabled: false }));
  assert.deepEqual(keysOf(off.changed), []);
  assert.deepEqual(keysOf(off.optIn), []);
  assert.deepEqual(off.withheld, [
    {
      key: "passkeysEnabled",
      current: undefined,
      incoming: false,
      reason: "needs-password-proof",
    },
  ]);

  // On only adds a route, so it applies with everything else.
  const on = diffPortableSettings(
    { passkeysEnabled: false },
    incoming({ passkeysEnabled: true }),
  );
  assert.deepEqual(keysOf(on.changed), ["passkeysEnabled"]);
  assert.deepEqual(on.withheld, []);
});

test("an unset switch counts as on, so the direction is read correctly", () => {
  // Absence means on for all three. Reading the raw value would call an unset
  // preference "off" and get the direction backwards half the time: an
  // incoming `false` against an absent current is a *disable*, which is the
  // withheld direction for passkeys and the safe one for the others.
  const diff = diffPortableSettings(
    {},
    incoming({ passkeysEnabled: false, registryMonitoringEnabled: false }),
  );
  assert.deepEqual(keysOf(diff.withheld), ["passkeysEnabled"]);
  assert.deepEqual(keysOf(diff.changed), ["registryMonitoringEnabled"]);

  // And an incoming `true` against an absent current changes nothing at all,
  // because both mean on.
  const noop = diffPortableSettings(
    {},
    incoming({ passkeysEnabled: true, registryMonitoringEnabled: true }),
  );
  assert.deepEqual(keysOf(noop.changed), []);
  assert.deepEqual(keysOf(noop.optIn), []);
  assert.equal(noop.unchangedCount, 2);
});

test("no gated preference ever reaches the changed rows", () => {
  const diff = diffPortableSettings(
    {},
    incoming({
      mcpEnabledTools: ["cf_delete_dns_record"],
      mcpPendingHighRiskTools: [],
      mcpRemovedImportedToolIds: ["invented"],
      mcpPermissionPolicyVersion: 9,
      passkeysEnabled: true,
      registryMonitoringEnabled: false,
      cloudflareLatencyEnabled: false,
    }),
  );
  for (const key of PORTABLE_GATED_PREFERENCE_KEYS) {
    assert.equal(
      keysOf(diff.changed).includes(key),
      false,
      `${key} must not be applied by a preference write`,
    );
  }
  // The permission preferences are not even offered: granting a tool is
  // `applyPortableToolPermissions`'s decision, and a preference write is the
  // path around that gate. So none of them reaches any of the three lists.
  for (const key of PORTABLE_GATED_PREFERENCE_KEYS) {
    for (const [name, rows] of [
      ["optIn", diff.optIn],
      ["withheld", diff.withheld],
    ] as const) {
      assert.equal(
        keysOf(rows).includes(key),
        false,
        `${key} must not appear in ${name} either`,
      );
    }
  }
  // `registryMonitoringEnabled: false` and `cloudflareLatencyEnabled: false`
  // are disables, which is their safe direction.
  assert.deepEqual(keysOf(diff.changed).sort(), [
    "cloudflareLatencyEnabled",
    "registryMonitoringEnabled",
  ]);
});

test("machine-local preferences travel in neither direction", () => {
  const local = {
    __storageRevision: 7,
    lastZone: "example.com",
    lastActiveTabId: "tab-1",
    lastOpenTabs: ["tab-1", "tab-2"],
    updateCheckLastCheckedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(
    Object.keys(local).sort(),
    [...PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS].sort(),
    "this test enumerates the list; keep the two in step",
  );

  const exported = exportSettings(
    preferences({ ...local, defaultPerPage: 10 }),
    OPTIONS,
  );
  assert.deepEqual(Object.keys(exported.payload.preferences), [
    "defaultPerPage",
  ]);

  // A hand-made file still carries them, and an import still refuses them: an
  // import that honoured `__storageRevision` would hand a migration someone
  // else's revision.
  const parsed = parsedPreferences({ ...local, defaultPerPage: 10 });
  assert.deepEqual(Object.keys(parsed), ["defaultPerPage"]);

  const diff = diffPortableSettings(
    { lastZone: "mine.example" },
    incoming({ ...local, defaultPerPage: 10 }),
  );
  assert.deepEqual(keysOf(diff.changed), ["defaultPerPage"]);
  // Not reported as dropped: they are known keys this format does not carry,
  // which is not the downgrade `droppedKeys` is there to make legible.
  assert.deepEqual(diff.droppedKeys, []);
});

test("an unset preference is not the same as one set to false", () => {
  const diff = diffPortableSettings({}, incoming({ recycleBinEnabled: false }));
  assert.equal(diff.changed.length, 1);
  const [row] = diff.changed;
  assert.equal(row.key, "recycleBinEnabled");
  assert.equal("current" in row, true);
  assert.equal(row.current, undefined);
  assert.equal(row.incoming, false);

  // The same file against a machine that has already turned it off changes
  // nothing at all.
  const unchanged = diffPortableSettings(
    { recycleBinEnabled: false },
    incoming({ recycleBinEnabled: false }),
  );
  assert.deepEqual(unchanged.changed, []);
  assert.equal(unchanged.unchangedCount, 1);
});

test("values are compared structurally, and arrays by order", () => {
  const current: BrowserPreferenceData = {
    dnsTableColumns: ["type", "name", "content"],
    zonePerPage: { "zone-a": 50 },
    domainAuditCategories: { email: true, security: false },
  };

  const same = diffPortableSettings(current, {
    preferences: JSON.parse(JSON.stringify(current)) as BrowserPreferenceData,
  });
  assert.deepEqual(same.changed, []);
  assert.equal(same.unchangedCount, 3);

  // Order is meaningful: `dnsTableColumns` is the order the table renders in.
  const reordered = diffPortableSettings(
    current,
    incoming({ dnsTableColumns: ["name", "type", "content"] }),
  );
  assert.deepEqual(keysOf(reordered.changed), ["dnsTableColumns"]);

  const deeper = diffPortableSettings(
    current,
    incoming({ domainAuditCategories: { email: true, security: true } }),
  );
  assert.deepEqual(keysOf(deeper.changed), ["domainAuditCategories"]);

  const extraKey = diffPortableSettings(
    current,
    incoming({ zonePerPage: { "zone-a": 50, "zone-b": 20 } }),
  );
  assert.deepEqual(keysOf(extraKey.changed), ["zonePerPage"]);
});

test("a preference this machine has and the file does not is left alone", () => {
  const diff = diffPortableSettings(
    { defaultPerPage: 50, confirmLogout: true },
    incoming({ defaultPerPage: 50 }),
  );
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.optIn, []);
  assert.equal(diff.unchangedCount, 1);
});

test("rows come out in schema order whatever order the file used", () => {
  const forwards = diffPortableSettings(
    {},
    incoming({ defaultPerPage: 10, confirmLogout: true, lastZone: "a" }),
  );
  const backwards = diffPortableSettings(
    {},
    incoming({ confirmLogout: true, lastZone: "a", defaultPerPage: 10 }),
  );
  assert.deepEqual(keysOf(forwards.changed), keysOf(backwards.changed));
  assert.deepEqual(keysOf(forwards.changed), [
    "defaultPerPage",
    "confirmLogout",
  ]);
});

test("a payload with no preferences object is malformed", () => {
  for (const payload of [{}, { preferences: [] }, { preferences: "no" }, 7]) {
    const parse = parseSettingsFile(
      JSON.stringify(buildEnvelope("settings", payload, OPTIONS)),
    );
    assert.equal(parse.ok === false && parse.rejection, "malformed-payload");
  }
});

test("a parsed payload diffs with nothing left to drop", () => {
  const raw = settingsFile({ defaultPerPage: 10, apiKeys: [] });
  const parse = parseSettingsFile(raw);
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  const diff = diffPortableSettings({}, parse.value.payload);
  assert.deepEqual(keysOf(diff.changed), ["defaultPerPage"]);
  // The parser already named them; this payload no longer carries them.
  assert.deepEqual(diff.droppedKeys, []);
});

test("a file this build writes imports as no change at all", () => {
  const current: BrowserPreferenceData = {
    defaultPerPage: 25,
    dnsTableColumns: ["type", "name"],
    passkeysEnabled: false,
    lastZone: "example.com",
  };
  const raw = JSON.stringify(exportSettings(current, OPTIONS));
  const parse = parseSettingsFile(raw);
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  assert.deepEqual(parse.warnings, []);

  const diff = diffPortableSettings(current, parse.value.payload);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.optIn, []);
  assert.deepEqual(diff.droppedKeys, []);
  assert.equal(diff.unchangedCount, 3);
});
