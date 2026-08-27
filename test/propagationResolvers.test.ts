import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PROPAGATION_RESOLVER_IDS,
  PROPAGATION_RESOLVER_CATALOGUE,
  PROPAGATION_SETTING_LIMITS,
  clampPropagationSettings,
  isResolverIpLiteral,
  normalizeCustomResolvers,
  resolvePropagationSettings,
} from "../src/lib/dns/propagation-resolvers.ts";

const RUST_LIB = path.resolve(
  process.cwd(),
  "src-tauri/crates/bc-topology/src/lib.rs",
);
const RUST_LIMITS = path.resolve(
  process.cwd(),
  "src-tauri/crates/bc-topology/src/limits.rs",
);

// The historical hard-coded set, minus Alternate DNS (76.76.19.19), which is
// still in the catalogue but no longer default-enabled after repeated timeouts.
const ORIGINAL_DEFAULTS_STILL_ENABLED = [
  "1.1.1.1",
  "8.8.8.8",
  "9.9.9.9",
  "208.67.222.222",
  "185.228.168.9",
  "94.140.14.14",
  "8.26.56.26",
];

interface RustEntry {
  ip: string;
  label: string;
  provider: string;
  region: string;
  defaultEnabled: boolean;
}

function parseRustCatalogue(source: string): RustEntry[] {
  const begin = source.indexOf("PROPAGATION_CATALOGUE_BEGIN");
  const end = source.indexOf("PROPAGATION_CATALOGUE_END");
  assert.ok(
    begin >= 0 && end > begin,
    "lib.rs must delimit the catalogue with PROPAGATION_CATALOGUE_BEGIN/END",
  );
  const block = source.slice(begin, end);
  const pattern =
    /entry\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(true|false)\s*,?\s*\)/gu;
  const out: RustEntry[] = [];
  for (const m of block.matchAll(pattern)) {
    out.push({
      ip: m[1],
      label: m[2],
      provider: m[3],
      region: m[4],
      defaultEnabled: m[5] === "true",
    });
  }
  return out;
}

function rustConst(source: string, name: string): number | undefined {
  const m = new RegExp(`const ${name}:\\s*\\w+\\s*=\\s*([0-9_]+)`, "u").exec(
    source,
  );
  return m ? Number(m[1].replace(/_/gu, "")) : undefined;
}

test("catalogue ids are unique, valid IPv4 literals, and keep the original eight enabled", () => {
  const ids = PROPAGATION_RESOLVER_CATALOGUE.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of PROPAGATION_RESOLVER_CATALOGUE) {
    assert.equal(r.id, r.ip);
    assert.ok(isResolverIpLiteral(r.ip), `${r.ip} is not an IP literal`);
    assert.ok(r.label && r.provider && r.region);
  }
  assert.equal(PROPAGATION_RESOLVER_CATALOGUE.length, 23);
  assert.equal(DEFAULT_PROPAGATION_RESOLVER_IDS.length, 12);
  for (const ip of ORIGINAL_DEFAULTS_STILL_ENABLED) {
    assert.ok(DEFAULT_PROPAGATION_RESOLVER_IDS.includes(ip), ip);
  }
});

test("TS catalogue mirrors the Rust catalogue row for row", () => {
  const source = fs.readFileSync(RUST_LIB, "utf8");
  const rust = parseRustCatalogue(source);
  assert.equal(rust.length, PROPAGATION_RESOLVER_CATALOGUE.length);
  rust.forEach((entry, index) => {
    const ts = PROPAGATION_RESOLVER_CATALOGUE[index];
    assert.deepEqual(
      {
        ip: ts.ip,
        label: ts.label,
        provider: ts.provider,
        region: ts.region,
        defaultEnabled: ts.defaultEnabled,
      },
      entry,
      `row ${index} (${entry.ip}) differs between Rust and TS`,
    );
  });
});

test("TS clamp limits mirror the Rust limits", () => {
  const source =
    fs.readFileSync(RUST_LIB, "utf8") +
    "\n" +
    fs.readFileSync(RUST_LIMITS, "utf8");
  const expect = (name: string, value: number) => {
    const found = rustConst(source, name);
    assert.equal(found, value, `${name}: rust=${found} ts=${value}`);
  };
  const L = PROPAGATION_SETTING_LIMITS;
  expect("MAX_EXTRA_RESOLVERS", L.maxCustomResolvers);
  expect("MAX_PROPAGATION_RESOLVERS", L.maxResolvers);
  expect("MAX_IP_LITERAL_BYTES", L.maxIpLiteralBytes);
  for (const [name, value] of [
    ["MIN_PROPAGATION_TIMEOUT_MS", L.timeoutMs.min],
    ["MAX_PROPAGATION_TIMEOUT_MS", L.timeoutMs.max],
    ["DEFAULT_PROPAGATION_TIMEOUT_MS", L.timeoutMs.default],
    ["MAX_PROPAGATION_ATTEMPTS", L.attempts.max],
    ["MIN_PROPAGATION_CONSENSUS_PERCENT", L.consensusPercent.min],
  ] as const) {
    const found = rustConst(source, name);
    if (found !== undefined) assert.equal(found, value, name);
  }
  // The numeric ranges are always asserted literally as well, so a renamed
  // Rust constant cannot silently disable the check.
  const literal = (n: number) =>
    new RegExp(`\\b${n}\\b`, "u").test(source) ||
    new RegExp(
      `\\b${n.toLocaleString("en-US").replace(/,/gu, "_")}\\b`,
      "u",
    ).test(source);
  for (const n of [
    L.timeoutMs.min,
    L.timeoutMs.max,
    L.timeoutMs.default,
    L.attempts.max,
    L.consensusPercent.min,
  ]) {
    assert.ok(literal(n), `Rust source does not mention limit ${n}`);
  }
});

test("clampPropagationSettings fills defaults and clamps into range", () => {
  const d = clampPropagationSettings(undefined);
  assert.deepEqual(d.resolvers, [...DEFAULT_PROPAGATION_RESOLVER_IDS]);
  assert.deepEqual(d.customResolvers, []);
  assert.equal(d.timeoutMs, 3000);
  assert.equal(d.attempts, 1);
  assert.equal(d.consensusPercent, 100);
  assert.equal(d.watchIntervalS, 15);

  const c = clampPropagationSettings({
    resolvers: ["8.8.8.8", "nope", "1.1.1.1", "8.8.8.8"],
    customResolvers: ["9.9.9.11", "bad", " 2606:4700::1111 ", "9.9.9.11"],
    timeoutMs: 10,
    attempts: 99,
    consensusPercent: Number.NaN,
    watchIntervalS: 100000,
  });
  assert.deepEqual(c.resolvers, ["1.1.1.1", "8.8.8.8"]);
  assert.deepEqual(c.customResolvers, ["9.9.9.11", "2606:4700::1111"]);
  assert.equal(c.timeoutMs, 500);
  assert.equal(c.attempts, 3);
  assert.equal(c.consensusPercent, 100);
  assert.equal(c.watchIntervalS, 600);
  assert.deepEqual(clampPropagationSettings({ resolvers: [] }).resolvers, []);
});

test("isResolverIpLiteral accepts bare IPv4/IPv6 only", () => {
  for (const ok of ["1.1.1.1", "255.255.255.255", "::1", "2001:db8::1"]) {
    assert.ok(isResolverIpLiteral(ok), ok);
  }
  for (const bad of [
    "",
    "1.1.1",
    "256.1.1.1",
    "01.1.1.1",
    "1.1.1.1:53",
    "[::1]",
    "fe80::1%eth0",
    "dns.google",
    "2001:db8::1".padEnd(46, "0"),
    "::g",
  ]) {
    assert.ok(!isResolverIpLiteral(bad), bad);
  }
  const many = Array.from({ length: 40 }, (_, i) => `10.0.0.${i + 1}`);
  assert.equal(
    normalizeCustomResolvers(many).length,
    PROPAGATION_SETTING_LIMITS.maxCustomResolvers,
  );
});

test("resolvePropagationSettings produces wire options and caps the total", () => {
  const r = resolvePropagationSettings({
    resolvers: ["1.1.1.1"],
    customResolvers: ["9.9.9.11", "1.1.1.1"],
    consensusPercent: 75,
  });
  assert.deepEqual(r.resolverIds, ["1.1.1.1"]);
  assert.deepEqual(r.customResolvers, ["9.9.9.11"]);
  assert.deepEqual(r.options, {
    resolvers: ["1.1.1.1"],
    timeoutMs: 3000,
    attempts: 1,
    consensusPercent: 75,
  });

  const all = PROPAGATION_RESOLVER_CATALOGUE.map((x) => x.id);
  const customs = Array.from({ length: 32 }, (_, i) => `10.1.0.${i + 1}`);
  const capped = resolvePropagationSettings({
    resolvers: all,
    customResolvers: customs,
  });
  assert.equal(
    capped.resolverIds.length + capped.customResolvers.length,
    PROPAGATION_SETTING_LIMITS.maxResolvers > all.length + customs.length
      ? all.length + customs.length
      : PROPAGATION_SETTING_LIMITS.maxResolvers,
  );
  assert.equal(capped.resolverIds.length, all.length);
});
