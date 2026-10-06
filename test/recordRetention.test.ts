import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  RETAINED_FIELD_LOSSES,
  RETENTION_COMMANDS,
  RETENTION_LIMITS,
  RETENTION_REASON_DELETED,
  RETENTION_REASON_DISABLED,
  clampRetainedEntryLimit,
  clampRetentionDays,
  createRecordRetentionClient,
  isRetainedRecordExpired,
  isRetainedRecordRestorable,
  parseRetainedRecord,
  parseRetainedRecords,
  restorableRetainedRecords,
  retainedRecordDaysLeft,
  retainedRecordInput,
  retentionDaysForReason,
  retentionReasonKind,
  shouldRetainDeletion,
  sortRetainedRecords,
  type RetainDecision,
  type RetainedRecord,
  type RetentionInvoke,
} from "../src/lib/records/retention.ts";

const RUST_RETENTION = path.resolve(
  process.cwd(),
  "src-tauri/crates/bc-storage/src/retention.rs",
);
const RUST_COMMANDS = path.resolve(
  process.cwd(),
  "src-tauri/src/commands/retention.rs",
);

function rustConst(source: string, name: string): number {
  const pattern = new RegExp(
    `pub const ${name}:\\s*\\w+\\s*=\\s*([0-9_]+)\\s*;`,
    "u",
  );
  const match = pattern.exec(source);
  assert.ok(match, `retention.rs must declare ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

const ONE_DAY_MS = 86_400_000;

function entry(overrides: Record<string, unknown> = {}): RetainedRecord {
  const parsed = parseRetainedRecord({
    entry_id: "ret_1",
    reason: RETENTION_REASON_DELETED,
    zone_id: "zone-1",
    zone_name: "example.com",
    origin_record_id: "cf-1",
    removed_from_provider_at: "2026-01-01T00:00:00+00:00",
    expires_at: "2026-01-31T00:00:00+00:00",
    type: "A",
    name: "www.example.com",
    content: "203.0.113.1",
    ttl: 1,
    proxied: true,
    local_tags: ["infra"],
    ...overrides,
  });
  assert.ok(parsed, "the fixture must parse");
  return parsed;
}

// ── Parity with the Rust source of truth ────────────────────────────────────

test("the mirrored bounds are the ones the native store enforces", () => {
  const source = fs.readFileSync(RUST_RETENTION, "utf8");

  assert.equal(
    RETENTION_LIMITS.retentionDays.min,
    rustConst(source, "MIN_RETENTION_DAYS"),
  );
  assert.equal(
    RETENTION_LIMITS.retentionDays.max,
    rustConst(source, "MAX_RETENTION_DAYS"),
  );
  assert.equal(
    RETENTION_LIMITS.retentionDays.default,
    rustConst(source, "DEFAULT_RETENTION_DAYS"),
  );
  assert.equal(
    RETENTION_LIMITS.maxEntries.min,
    rustConst(source, "MIN_RETAINED_ENTRY_LIMIT"),
  );
  assert.equal(
    RETENTION_LIMITS.maxEntries.max,
    rustConst(source, "MAX_RETAINED_ENTRIES"),
  );
  assert.equal(
    RETENTION_LIMITS.maxEntries.default,
    rustConst(source, "MAX_RETAINED_ENTRIES"),
    "the default entry cap is the hard ceiling: a user lowers it, never raises it",
  );
  assert.equal(
    RETENTION_LIMITS.storeBytes,
    rustConst(source, "MAX_RETAINED_BYTES"),
  );
  assert.equal(
    RETENTION_LIMITS.entryBytes,
    rustConst(source, "MAX_RETAINED_ENTRY_BYTES"),
  );
  assert.equal(RETENTION_LIMITS.tags, rustConst(source, "MAX_RETAINED_TAGS"));
});

test("the reason spellings are the ones the native store writes", () => {
  const source = fs.readFileSync(RUST_RETENTION, "utf8");
  assert.match(
    source,
    new RegExp(
      `pub const DISABLED: &'static str = "${RETENTION_REASON_DISABLED}";`,
      "u",
    ),
  );
  assert.match(
    source,
    new RegExp(
      `pub const DELETED: &'static str = "${RETENTION_REASON_DELETED}";`,
      "u",
    ),
  );
});

test("the mirrored wire keys are the ones the native entry carries", () => {
  const source = fs.readFileSync(RUST_RETENTION, "utf8");
  // The parser reads snake_case keys off the stored object. A key renamed in
  // Rust and not here silently produces an entry with an empty zone or no
  // expiry, which is far worse than a parse failure.
  for (const [constant, key] of [
    ["KEY_ENTRY_ID", "entry_id"],
    ["KEY_REASON", "reason"],
    ["KEY_ZONE_ID", "zone_id"],
    ["KEY_ZONE_NAME", "zone_name"],
    ["KEY_ORIGIN_RECORD_ID", "origin_record_id"],
    ["KEY_REMOVED_AT", "removed_from_provider_at"],
    ["KEY_EXPIRES_AT", "expires_at"],
    ["KEY_TYPE", "type"],
    ["KEY_NAME", "name"],
    ["KEY_CONTENT", "content"],
    ["KEY_TTL", "ttl"],
    ["KEY_PRIORITY", "priority"],
    ["KEY_PROXIED", "proxied"],
    ["KEY_COMMENT", "comment"],
    ["KEY_LOCAL_TAGS", "local_tags"],
  ] as const) {
    assert.match(
      source,
      new RegExp(`const ${constant}: &str = "${key}";`, "u"),
      `${constant} must still be "${key}"`,
    );
  }
});

test("every mirrored command name exists as a native command", () => {
  const source = fs.readFileSync(RUST_COMMANDS, "utf8");
  for (const command of Object.values(RETENTION_COMMANDS)) {
    assert.match(
      source,
      new RegExp(`pub async fn ${command}\\(`, "u"),
      `${command} must be a command in commands/retention.rs`,
    );
  }
  const declared = [
    ...source.matchAll(/#\[tauri::command\]\s*\npub async fn (\w+)\(/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    declared.toSorted(),
    Object.values(RETENTION_COMMANDS).toSorted(),
    "a command the UI cannot see is a command nobody registered",
  );
});

// ── Parsing ─────────────────────────────────────────────────────────────────

test("a complete entry parses into the fields a restore needs", () => {
  const parsed = entry();
  assert.equal(parsed.entryId, "ret_1");
  assert.equal(parsed.reasonKind, "deleted");
  assert.equal(parsed.zoneId, "zone-1");
  assert.equal(parsed.originRecordId, "cf-1");
  assert.equal(parsed.type, "A");
  assert.equal(parsed.content, "203.0.113.1");
  assert.equal(parsed.ttl, 1);
  assert.equal(parsed.proxied, true);
  assert.deepEqual(parsed.localTags, ["infra"]);
  assert.ok(isRetainedRecordRestorable(parsed));
});

test("an entry missing every field parses and simply cannot restore", () => {
  const parsed = parseRetainedRecord({});
  assert.ok(parsed, "an empty object is still an object");
  assert.equal(parsed.reasonKind, "unknown");
  assert.equal(parsed.expiresAt, undefined);
  assert.equal(parsed.ttl, undefined);
  assert.deepEqual(parsed.localTags, []);
  assert.equal(
    isRetainedRecordRestorable(parsed),
    false,
    "nothing to restore, but nothing crashed either",
  );
});

test("only a value that cannot be an entry is rejected", () => {
  for (const value of [null, undefined, 7, "entry", [], true]) {
    assert.equal(
      parseRetainedRecord(value),
      null,
      `${JSON.stringify(value) ?? "undefined"} is not an entry`,
    );
  }
  assert.deepEqual(
    parseRetainedRecords([1, {}, "x", { entry_id: "a" }]).length,
    2,
  );
  assert.deepEqual(parseRetainedRecords(undefined), []);
});

test("a newer build's fields and reason survive this build's reading", () => {
  const parsed = entry({
    reason: "quarantined_by_policy",
    policy_id: "pol-7",
    settings: { flatten_cname: true },
  });
  assert.equal(parsed.reason, "quarantined_by_policy");
  assert.equal(
    parsed.reasonKind,
    "unknown",
    "a reason this build never heard of is a reading, not a failure",
  );
  assert.equal(parsed.raw.policy_id, "pol-7");
  assert.deepEqual(parsed.raw.settings, { flatten_cname: true });
});

test("an unreadable expiry means never expire rather than expire now", () => {
  const parsed = entry({ expires_at: "whenever" });
  assert.equal(parsed.expiresAt, undefined);
  assert.equal(
    isRetainedRecordExpired(parsed, Date.parse("2099-01-01T00:00:00Z")),
    false,
    "a date this build cannot read is not a licence to delete the record",
  );
  assert.equal(retainedRecordDaysLeft(parsed, Date.now()), null);
});

test("a malformed number or tag is dropped rather than carried through", () => {
  const parsed = entry({
    ttl: "3600",
    priority: -1,
    proxied: "yes",
    local_tags: ["ok", "   ", 7, null],
  });
  assert.equal(parsed.ttl, undefined);
  assert.equal(parsed.priority, undefined);
  assert.equal(parsed.proxied, undefined);
  assert.deepEqual(parsed.localTags, ["ok"]);
});

test("the tag list is capped at the native limit", () => {
  const tags = Array.from(
    { length: RETENTION_LIMITS.tags * 2 },
    (_unused, index) => `tag-${index}`,
  );
  assert.equal(
    entry({ local_tags: tags }).localTags.length,
    RETENTION_LIMITS.tags,
  );
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test("expiry is decided by the clock it is handed, to the instant", () => {
  const parsed = entry();
  const expires = Date.parse("2026-01-31T00:00:00Z");
  assert.equal(isRetainedRecordExpired(parsed, expires - 1), false);
  assert.equal(isRetainedRecordExpired(parsed, expires), true);
  assert.equal(isRetainedRecordExpired(parsed, expires + ONE_DAY_MS), true);
});

test("a disable never expires, however old it is", () => {
  const parsed = entry({
    reason: RETENTION_REASON_DISABLED,
    expires_at: undefined,
  });
  assert.equal(parsed.reasonKind, "disabled");
  assert.equal(
    isRetainedRecordExpired(parsed, Date.parse("2099-01-01T00:00:00Z")),
    false,
  );
  assert.equal(retainedRecordDaysLeft(parsed, Date.now()), null);
});

test("the countdown rounds up, so it never says zero while restorable", () => {
  const parsed = entry();
  const expires = Date.parse("2026-01-31T00:00:00Z");
  assert.equal(retainedRecordDaysLeft(parsed, expires - 30 * ONE_DAY_MS), 30);
  assert.equal(
    retainedRecordDaysLeft(parsed, expires - ONE_DAY_MS / 6),
    1,
    "four hours left is a day left, not none",
  );
  assert.equal(retainedRecordDaysLeft(parsed, expires), 0);
});

test("the restorable list hides exactly what a purge would take", () => {
  const entries = [
    entry({ entry_id: "a", expires_at: "2026-01-10T00:00:00Z" }),
    entry({ entry_id: "b", expires_at: "2026-02-10T00:00:00Z" }),
    entry({
      entry_id: "c",
      reason: RETENTION_REASON_DISABLED,
      expires_at: undefined,
    }),
  ];
  const now = Date.parse("2026-01-15T00:00:00Z");
  assert.deepEqual(
    restorableRetainedRecords(entries, now).map((item) => item.entryId),
    ["b", "c"],
    "the list and the purge share one clock, so they cannot disagree",
  );
});

test("entries sort oldest removal first, undated ones last", () => {
  const entries = [
    entry({
      entry_id: "new",
      removed_from_provider_at: "2026-03-01T00:00:00Z",
    }),
    entry({ entry_id: "undated", removed_from_provider_at: undefined }),
    entry({
      entry_id: "old",
      removed_from_provider_at: "2026-01-01T00:00:00Z",
    }),
  ];
  assert.deepEqual(
    sortRetainedRecords(entries).map((item) => item.entryId),
    ["old", "new", "undated"],
  );
});

// ── Settings ────────────────────────────────────────────────────────────────

test("a retention window is clamped, and a nonsense one falls back", () => {
  const { min, max, default: fallback } = RETENTION_LIMITS.retentionDays;
  assert.equal(clampRetentionDays(0), min);
  assert.equal(clampRetentionDays(-5), min);
  assert.equal(clampRetentionDays(100_000), max);
  assert.equal(clampRetentionDays(30.4), 30);
  assert.equal(clampRetentionDays(Number.NaN), fallback);
  assert.equal(clampRetentionDays("30"), fallback);
  assert.equal(clampRetentionDays(undefined), fallback);
});

test("an entry limit is clamped to the native bounds", () => {
  const { min, max, default: fallback } = RETENTION_LIMITS.maxEntries;
  assert.equal(clampRetainedEntryLimit(1), min);
  assert.equal(clampRetainedEntryLimit(10_000), max);
  assert.equal(clampRetainedEntryLimit(250), 250);
  assert.equal(clampRetainedEntryLimit(null), fallback);
});

test("a disable gets no expiry whatever the bin is configured to", () => {
  const settings = { retentionDays: 7 };
  assert.equal(retentionDaysForReason(RETENTION_REASON_DELETED, settings), 7);
  assert.equal(
    retentionDaysForReason(RETENTION_REASON_DISABLED, settings),
    null,
    "a disable that expired would delete a parked record unasked",
  );
  assert.equal(retentionDaysForReason("quarantined", settings), null);
});

test("the configured window is the one a deletion is stamped with", () => {
  // The setting has to reach the call. A bound and a clamp are not evidence
  // that anything reads the value.
  assert.equal(
    retentionDaysForReason(RETENTION_REASON_DELETED, { retentionDays: 90 }),
    90,
  );
  assert.equal(
    retentionDaysForReason(RETENTION_REASON_DELETED, { retentionDays: 0 }),
    RETENTION_LIMITS.retentionDays.min,
    "and it is clamped on the way, not trusted",
  );
});

test("a disabled bin means a deletion is not retained", () => {
  assert.equal(shouldRetainDeletion({ enabled: true }), true);
  assert.equal(shouldRetainDeletion({ enabled: false }), false);
});

test("an unknown reason reads as unknown, not as a crash", () => {
  for (const raw of [undefined, null, 7, "", "Deleted", "future"]) {
    assert.equal(retentionReasonKind(raw), "unknown", `${String(raw)}`);
  }
});

// ── Restore input ───────────────────────────────────────────────────────────

test("the restore input carries every field the create path accepts", () => {
  const parsed = entry({ priority: 10, comment: "primary", type: "MX" });
  assert.deepEqual(retainedRecordInput(parsed), {
    type: "MX",
    name: "www.example.com",
    content: "203.0.113.1",
    ttl: 1,
    priority: 10,
    proxied: true,
    comment: "primary",
  });
});

test("an absent field stays absent rather than becoming undefined", () => {
  const parsed = entry({ ttl: undefined, proxied: undefined });
  const input = retainedRecordInput(parsed);
  assert.equal("ttl" in input, false);
  assert.equal("proxied" in input, false);
  assert.equal("priority" in input, false);
});

test("what a round trip cannot preserve is stated, not implied", () => {
  assert.ok(
    RETAINED_FIELD_LOSSES.some((loss) => loss.includes("record id")),
    "a restore mints a new id, and the UI has to say so",
  );
  assert.ok(RETAINED_FIELD_LOSSES.some((loss) => loss.includes("tags")));
  assert.ok(RETAINED_FIELD_LOSSES.length >= 3);
});

// ── Native call surface ─────────────────────────────────────────────────────

function recordingInvoke(): {
  invoke: RetentionInvoke;
  calls: { command: string; args: Record<string, unknown> }[];
} {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const invoke: RetentionInvoke = async (command, args) => {
    calls.push({ command, args });
    return undefined as never;
  };
  return { invoke, calls };
}

test("retain sends every argument the native command needs", async () => {
  const { invoke, calls } = recordingInvoke();
  const client = createRecordRetentionClient(invoke);
  await client.retain({
    apiKey: "token",
    email: "a@example.com",
    zoneId: "zone-1",
    zoneName: "example.com",
    recordId: "cf-1",
    record: { type: "A", name: "www.example.com", content: "203.0.113.1" },
    reason: RETENTION_REASON_DISABLED,
    retentionDays: null,
    localTags: ["infra"],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "retain_dns_record");
  assert.deepEqual(calls[0].args, {
    apiKey: "token",
    email: "a@example.com",
    zoneId: "zone-1",
    zoneName: "example.com",
    recordId: "cf-1",
    record: { type: "A", name: "www.example.com", content: "203.0.113.1" },
    reason: "disabled",
    retentionDays: undefined,
    localTags: ["infra"],
    maxEntries: undefined,
  });
});

test("a refusal is distinguishable from a success without parsing a message", () => {
  // The two cases differ in whether the record is still live at Cloudflare, so
  // the UI has to be able to tell them apart structurally.
  const refused: RetainDecision = {
    status: "store_full",
    held: 10,
    protected: 10,
    bytesHeld: 4096,
    maxBytes: RETENTION_LIMITS.storeBytes,
    maxEntries: 10,
    purged: 0,
  };
  const kept: RetainDecision = {
    status: "retained",
    entryId: "ret_1",
    expiresAt: null,
    purged: 0,
    evicted: 0,
  };
  assert.equal(
    refused.status === "store_full" ? refused.protected : -1,
    10,
    "a store_full decision carries what is blocking it",
  );
  assert.equal(kept.status === "retained" ? kept.entryId : "", "ret_1");
});

test("a disabled entry is never an eviction victim in the native rule", () => {
  // Pinned against the Rust source rather than restated, because the whole
  // point of the rule is that nothing in the eviction path can reach a
  // protected entry.
  const source = fs.readFileSync(RUST_RETENTION, "utf8");
  // `\}` escaped: a lone closing brace is invalid in a unicode-mode pattern.
  const victim = /fn victim_index\(([\s\S]*?)\n\}/u.exec(source);
  assert.ok(victim, "victim_index must be declared");
  assert.match(
    victim[1],
    /is_expired/u,
    "an expired entry is still a legitimate victim",
  );
  assert.match(victim[1], /is_expendable/u, "and so is a recycle-bin entry");
  assert.equal(
    /Some\(0\)|entries\.len\(\) - 1/u.test(victim[1]),
    false,
    "but there must be no fallback that takes an arbitrary entry: that is the line that would evict a disabled record",
  );
  assert.match(
    source,
    /pub fn is_protected\(/u,
    "the protection rule must be a named, testable predicate",
  );
  assert.match(
    source,
    /pub fn fits_after_eviction\(/u,
    "and callers must have a way to ask before they push",
  );
});

test("the native argument names match the command's parameters", () => {
  const source = fs.readFileSync(RUST_COMMANDS, "utf8");
  const signature = /pub async fn retain_dns_record\(([\s\S]*?)\n\) ->/u.exec(
    source,
  );
  assert.ok(signature, "retain_dns_record must be declared");
  const parameters = signature[1]
    .split("\n")
    .map((line) => /^\s*(\w+):/u.exec(line)?.[1])
    .filter((name): name is string => Boolean(name))
    .filter((name) => name !== "storage" && name !== "notifications");

  const { invoke, calls } = recordingInvoke();
  void createRecordRetentionClient(invoke).retain({
    apiKey: "token",
    zoneId: "zone-1",
    recordId: "cf-1",
    record: { type: "A", name: "a.example.com", content: "203.0.113.1" },
    reason: RETENTION_REASON_DELETED,
    retentionDays: 30,
  });

  const camel = (name: string) =>
    name.replace(/_([a-z])/gu, (_all, letter: string) => letter.toUpperCase());
  assert.deepEqual(
    Object.keys(calls[0].args).toSorted(),
    parameters.map(camel).toSorted(),
    "a mistyped argument name is a silently missing field in a retained entry",
  );
});

test("every client method targets its mirrored command", async () => {
  const { invoke, calls } = recordingInvoke();
  const client = createRecordRetentionClient(invoke);
  await client.list(250);
  await client.restore({ apiKey: "token", entryId: "ret_1" });
  await client.purge();
  await client.forget("ret_1");
  await client.clear();

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      RETENTION_COMMANDS.list,
      RETENTION_COMMANDS.restore,
      RETENTION_COMMANDS.purge,
      RETENTION_COMMANDS.forget,
      RETENTION_COMMANDS.clear,
    ],
  );
  assert.deepEqual(calls[0].args, { maxEntries: 250 });
  assert.deepEqual(calls[1].args, {
    apiKey: "token",
    email: undefined,
    entryId: "ret_1",
  });
  assert.deepEqual(calls[3].args, { entryId: "ret_1" });
});
