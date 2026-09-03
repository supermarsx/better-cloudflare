/**
 * Pins the base `details` text of every audit finding across the two
 * implementations — `src/lib/audit/domain-audit.ts` and
 * `src-tauri/crates/bc-domain-audit/src/lib.rs`.
 *
 * `test/domain-audit-explanations.test.ts` already pins `FINDING_EXPLANATIONS`,
 * but that table is the *second* paragraph a reader sees. The first one — the
 * `details` string the finding is built with — was covered by nothing, so every
 * one of them could diverge silently. Two implementations agreeing is not the
 * same as two implementations being right (the SPF detector was a line-for-line
 * translation of a defect), but two implementations disagreeing about what a
 * user is told is a bug on its own, and this file is what notices.
 *
 * ## Why literal templates, and not rendered output
 *
 * `details` strings interpolate record names, counts, policy values and TTLs,
 * so there is no static string to compare. Three approaches were possible:
 *
 * 1. **Render both implementations against fixed inputs and diff.** Rejected.
 *    Node cannot call the crate without adding a build step and a binary target
 *    to the JavaScript test job, and the comparison would still be blind to
 *    every string no fixture happens to trigger — coverage would measure
 *    fixture effort rather than the code. It also *cannot* pin the
 *    `domain-expiry` family at all: TypeScript renders the date with
 *    `toLocaleString()` and Rust with `%Y-%m-%d %H:%M:%S UTC`, and the day
 *    count is `Math.ceil` against `num_days()` truncation. Comparing templates
 *    pins those four strings; comparing output could never have.
 * 2. **Compare the `details` expressions verbatim.** Rejected: TypeScript
 *    interpolates in place (`${name}`) where Rust uses positional `format!`
 *    holes, and several findings are built in TypeScript by `+`-joining an
 *    array to a literal where Rust uses one `format!` with a leading `{}`. The
 *    same rendered text, different literal boundaries.
 * 3. **Compare interpolation-normalised literal templates.** Chosen. Every
 *    string literal in each source is reduced to a fingerprint: placeholders
 *    (`${…}` / `{}` / `{named}`) collapse to one sentinel, and leading and
 *    trailing sentinels are stripped so a literal's boundaries relative to its
 *    interpolations stop mattering. Interior placeholders are kept, so a
 *    finding that gains or loses a substitution in the middle of a sentence
 *    still fails.
 *
 * Comparison is keyed by the text itself, because several findings —
 * `ttl-critical`, `txt-sprawl`, `cname-conflicts` and the SOA and SRV reviews —
 * accumulate their text into a local well away from the call that names them,
 * so keying by finding id would mean tracing dataflow. The failure message
 * still names the finding: each id owns the span of source that builds it, and
 * text accumulated outside every span belongs to the next finding built after
 * it. Both sides of a divergence are printed with file, line and id.
 *
 * This found three checks that existed only in TypeScript — a ten-digit SOA
 * serial with an impossible date, non-numeric SOA timers, and an SRV port above
 * the u16 range. The crate is now able to report all three.
 *
 * What it does not cover: the *conditions* under which each string is emitted.
 * Two implementations can hold identical text and reach it differently, which
 * is what `test/domain-audit-txt.test.ts` and the crate's own tests are for.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AUDIT_TS = path.join(REPO_ROOT, "src/lib/audit/domain-audit.ts");
const AUDIT_RS = path.join(
  REPO_ROOT,
  "src-tauri/crates/bc-domain-audit/src/lib.rs",
);

/** Stands in for one interpolation, whatever syntax produced it. */
const HOLE = "\u0001";

type Literal = {
  /** Byte offset of the opening quote. */
  start: number;
  /** Byte offset just past the closing quote. */
  end: number;
  /** Decoded text, with every interpolation replaced by {@link HOLE}. */
  text: string;
};

// ── Lexing ──────────────────────────────────────────────────────────────────
//
// Both files are read as text rather than parsed. A real parser for either
// language is a dependency this repo does not have, and the shapes involved —
// quoted strings, template literals, `format!` holes — are small enough to
// scan directly. What matters is that comments never contribute literals and
// that no literal is missed, both of which the coverage floor below asserts.

/** String and template literals of a TypeScript source, comments skipped. */
function typeScriptLiterals(source: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const start = i;
      i++;
      let text = "";
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          text += unescapeOne(source[i + 1]);
          i += 2;
        } else {
          text += source[i++];
        }
      }
      out.push({ start, end: ++i, text });
      continue;
    }

    if (c === "`") {
      const start = i;
      i++;
      let text = "";
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
          text += unescapeOne(source[i + 1]);
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          text += HOLE;
          i = skipInterpolation(source, i + 2);
          continue;
        }
        text += source[i++];
      }
      out.push({ start, end: ++i, text });
      continue;
    }

    i++;
  }

  return out;
}

/** Index just past the `}` closing a `${` interpolation opened at `from`. */
function skipInterpolation(source: string, from: number): number {
  let i = from;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "`") {
      // A nested template literal: skip it whole so its braces do not count.
      i++;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") i++;
        i++;
      }
    }
    i++;
  }
  return i;
}

/** String literals of a Rust source, comments and char literals skipped. */
function rustLiterals(source: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 2;
      continue;
    }

    // Raw string: r"…", r#"…"#, r##"…"##
    if (c === "r" && (source[i + 1] === '"' || source[i + 1] === "#")) {
      let j = i + 1;
      let hashes = 0;
      while (source[j] === "#") {
        hashes++;
        j++;
      }
      if (source[j] === '"') {
        const start = i;
        const close = '"' + "#".repeat(hashes);
        const bodyStart = j + 1;
        const bodyEnd = source.indexOf(close, bodyStart);
        i = bodyEnd + close.length;
        out.push({ start, end: i, text: source.slice(bodyStart, bodyEnd) });
        continue;
      }
    }

    if (c === '"') {
      const start = i;
      i++;
      let text = "";
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") {
          text += unescapeOne(source[i + 1]);
          i += 2;
        } else {
          text += source[i++];
        }
      }
      out.push({ start, end: ++i, text });
      continue;
    }

    // `'a'` / `'\n'` are char literals; `'a` on its own is a lifetime. Neither
    // opens a string, so step over just enough not to be confused by either.
    if (c === "'") {
      if (source[i + 1] === "\\") i += 4;
      else if (source[i + 2] === "'") i += 3;
      else i++;
      continue;
    }

    i++;
  }

  return out;
}

function unescapeOne(escaped: string): string {
  switch (escaped) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    default:
      return escaped;
  }
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** Replace `format!` holes — `{}`, `{0}`, `{name}`, `{:?}` — with {@link HOLE}. */
function collapseRustHoles(text: string): string {
  return text
    .replace(/\{\{/g, "\u0002")
    .replace(/\}\}/g, "\u0003")
    .replace(/\{[^{}]*\}/g, HOLE)
    .replace(/\u0002/g, "{")
    .replace(/\u0003/g, "}");
}

/**
 * Fold TypeScript literals joined by nothing but `+` into one.
 *
 * Prettier wraps long strings across lines with `+`, so a sentence Rust holds
 * in one literal is often two or three in TypeScript. Without this the two
 * sides would disagree about where a string starts and stops rather than about
 * what it says.
 */
function mergeConcatenations(source: string, literals: Literal[]): Literal[] {
  const merged: Literal[] = [];
  for (const literal of literals) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      /^\s*\+\s*$/.test(source.slice(previous.end, literal.start))
    ) {
      previous.text += literal.text;
      previous.end = literal.end;
      continue;
    }
    merged.push({ ...literal });
  }
  return merged;
}

/**
 * The comparable form of a literal: interpolations collapsed, and leading and
 * trailing ones dropped so that `"…{}"`, `"{}…"` and `"…"` are the same text
 * arriving by different routes. Interior holes are kept.
 */
function fingerprint(text: string): string {
  return text.replace(/^\u0001+/, "").replace(/\u0001+$/, "");
}

/**
 * Whether a literal is text a user reads rather than a key, a record type or a
 * separator. Anything with no whitespace once its holes are removed, or under
 * eight characters, carries no sentence worth pinning.
 */
function isUserFacingProse(text: string): boolean {
  const bare = text.split(HOLE).join("").trim();
  return bare.length >= 8 && /\s/.test(bare);
}

/** Drop the literals between two markers — used to skip a region. */
function withoutRegion(
  source: string,
  literals: Literal[],
  open: string,
  close: string,
): Literal[] {
  const start = source.indexOf(open);
  assert.notEqual(start, -1, `region marker not found: ${open}`);
  const end = source.indexOf(close, start);
  assert.notEqual(end, -1, `region is unterminated: ${open}`);
  return literals.filter((l) => !(l.start > start && l.end < end));
}

// ── Attribution, for the failure message ────────────────────────────────────

/** A finding id, and the span of source that builds that finding. */
type Anchor = { id: string; from: number; to: number };

/**
 * Where each source names a finding, and how far that finding's text extends.
 *
 * TypeScript writes `id:` at the top of an object literal whose `details:` sits
 * a few lines below, so the span runs to the end of that object. Rust names the
 * finding in the first argument of `item(…)`, so the span is that call's
 * argument list.
 */
function findingAnchors(
  source: string,
  pattern: RegExp,
  open: string,
  close: string,
): Anchor[] {
  return [...source.matchAll(pattern)].map((m) => {
    const at = m.index ?? 0;
    const from = source.lastIndexOf(open, at);
    return {
      id: m[1],
      from: from === -1 ? at : from,
      to: spanEnd(source, from === -1 ? at : from, open, close),
    };
  });
}

/** Index of the `close` that balances the `open` at `from`, ignoring strings. */
function spanEnd(
  source: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "`") {
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") i++;
        i++;
      }
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return source.length;
}

/**
 * The finding a literal belongs to.
 *
 * A literal inside a finding's span belongs to it. One outside every span is
 * text accumulated into a local — the SOA and SRV reviews, the TTL and CNAME
 * lists — which is consumed by the next finding built after it.
 */
function owningFinding(anchors: Anchor[], offset: number): string {
  for (const anchor of anchors) {
    if (offset >= anchor.from && offset <= anchor.to) return anchor.id;
  }
  const next = anchors.find((anchor) => anchor.from > offset);
  return next ? next.id : "unknown";
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function display(text: string): string {
  return JSON.stringify(text.replace(/\u0001/g, "{}"));
}

// ── The two inventories ─────────────────────────────────────────────────────

const tsSource = fs.readFileSync(AUDIT_TS, "utf8");
const rsSourceFull = fs.readFileSync(AUDIT_RS, "utf8");

const testModuleAt = rsSourceFull.indexOf("#[cfg(test)]");
assert.notEqual(
  testModuleAt,
  -1,
  "expected a #[cfg(test)] module to mark where the crate's own tests begin",
);
/** The crate without its test module: assertions there quote details on purpose. */
const rsSource = rsSourceFull.slice(0, testModuleAt);

/**
 * Literals the sibling test already owns. `FINDING_EXPLANATIONS` is pinned
 * entry by entry in `domain-audit-explanations.test.ts`, which reports drift
 * keyed by finding id; re-checking it here would only produce a second, worse
 * failure message for the same change.
 */
const tsLiterals = withoutRegion(
  tsSource,
  mergeConcatenations(tsSource, typeScriptLiterals(tsSource)),
  "export const FINDING_EXPLANATIONS",
  "\n};",
);
const rsLiterals = withoutRegion(
  rsSource,
  rustLiterals(rsSource).map((l) => ({
    ...l,
    text: collapseRustHoles(l.text),
  })),
  "const FINDING_EXPLANATIONS: &[(&str, &str)] = &[",
  "\n];",
);

function inventory(literals: Literal[]): Map<string, Literal> {
  const byFingerprint = new Map<string, Literal>();
  for (const literal of literals) {
    if (!isUserFacingProse(literal.text)) continue;
    const key = fingerprint(literal.text);
    if (!byFingerprint.has(key)) byFingerprint.set(key, literal);
  }
  return byFingerprint;
}

const tsProse = inventory(tsLiterals);
const rsProse = inventory(rsLiterals);

const tsAnchors = findingAnchors(tsSource, /\bid: "([a-z0-9-]+)"/g, "{", "}");
const rsAnchors = findingAnchors(
  rsSource,
  /\bitem(?:_with_suggestion)?\(\s*"([a-z0-9-]+)"/g,
  "(",
  ")",
);

/**
 * Text that exists in one implementation and cannot exist in the other.
 *
 * Every entry needs a reason, and the test below fails if one stops being
 * needed, so this list cannot quietly absorb real drift.
 */
const RUST_ONLY = new Map<string, string>([
  [
    "%Y-%m-%d %H:%M:%S UTC",
    "chrono's format string for the domain-expiry date. TypeScript reaches the " +
      "same place through Date.prototype.toLocaleString(), which is a method " +
      "call and not a literal, so there is nothing to pin it against. The " +
      "sentence the date is substituted into is pinned normally.",
  ],
]);

const TS_ONLY = new Map<string, string>();

// ── Tests ───────────────────────────────────────────────────────────────────

test("the extraction still finds the text it is supposed to guard", () => {
  // A lexer that silently stopped matching would turn this file into a test
  // that always passes. Assert the shape of what it found, not just that it
  // found something.
  assert.ok(
    tsProse.size >= 150,
    `expected at least 150 user-facing strings in the TypeScript audit, found ${tsProse.size}`,
  );
  assert.ok(
    rsProse.size >= 150,
    `expected at least 150 user-facing strings in the Rust audit, found ${rsProse.size}`,
  );
  assert.ok(
    tsAnchors.length >= 40,
    "no finding ids found in the TypeScript audit",
  );
  assert.ok(rsAnchors.length >= 40, "no finding ids found in the Rust audit");

  // Spot-check one plain string and one interpolated one, so that a change to
  // the fingerprinting that quietly dropped either shape would be caught.
  assert.ok(
    tsProse.has(
      "MX exists at the zone apex but no SPF TXT record was found at @.",
    ),
    "a known plain details string is missing from the inventory",
  );
  assert.ok(
    tsProse.has(
      `Found ${HOLE} SOA records; typically there should be exactly one.`,
    ),
    "a known interpolated details string is missing from the inventory",
  );
});

test("no details string exists in TypeScript but not in Rust", () => {
  const missing = [...tsProse.entries()].filter(
    ([key]) => !rsProse.has(key) && !TS_ONLY.has(key),
  );

  const report = missing
    .map(([key, literal]) => {
      const id = owningFinding(tsAnchors, literal.start);
      return `  ${id} (domain-audit.ts:${lineOf(tsSource, literal.start)}): ${display(key)}`;
    })
    .join("\n");

  assert.equal(
    missing.length,
    0,
    `text the TypeScript audit shows and the Rust one does not:\n${report}\n`,
  );
});

test("no details string exists in Rust but not in TypeScript", () => {
  const extra = [...rsProse.entries()].filter(
    ([key]) => !tsProse.has(key) && !RUST_ONLY.has(key),
  );

  const report = extra
    .map(([key, literal]) => {
      const id = owningFinding(rsAnchors, literal.start);
      return `  ${id} (bc-domain-audit/src/lib.rs:${lineOf(rsSource, literal.start)}): ${display(key)}`;
    })
    .join("\n");

  assert.equal(
    extra.length,
    0,
    `text the Rust audit shows and the TypeScript one does not:\n${report}\n`,
  );
});

test("every named exception is still needed", () => {
  // An exception that stops applying is one the next drift could hide behind.
  for (const [key] of RUST_ONLY) {
    assert.ok(
      rsProse.has(key),
      `RUST_ONLY lists ${display(key)}, which the Rust audit no longer contains`,
    );
    assert.ok(
      !tsProse.has(key),
      `RUST_ONLY lists ${display(key)}, but TypeScript now has it too — delete the exception`,
    );
  }
  for (const [key] of TS_ONLY) {
    assert.ok(
      tsProse.has(key),
      `TS_ONLY lists ${display(key)}, which the TypeScript audit no longer contains`,
    );
    assert.ok(
      !rsProse.has(key),
      `TS_ONLY lists ${display(key)}, but Rust now has it too — delete the exception`,
    );
  }
});

test("both implementations emit the same set of finding ids", () => {
  // The explanation table's keys are pinned next door, but the ids the audit
  // actually emits were not: one implementation could gain or rename a finding
  // and nothing would say so. The id is what the UI keys severity overrides and
  // the "show passed" filter off, so a rename is not cosmetic.
  assert.deepEqual(
    [...new Set(rsAnchors.map((a) => a.id))].sort(),
    [...new Set(tsAnchors.map((a) => a.id))].sort(),
    "the two audits emit different findings",
  );
});

test("the checks found missing from the Rust crate stay in both", () => {
  // These three strings were TypeScript-only when this file was written: the
  // crate had no ten-digit-serial date check, skipped every timer check when a
  // timer would not parse, and blamed an out-of-range SRV port on the record's
  // layout. Named here so a revert is a failure with a reason attached rather
  // than a count going down.
  for (const text of [
    "SOA serial looks like YYYYMMDDnn but the date part is unusual.",
    "SOA timers must be numeric.",
    `SRV ${HOLE}: port out of range.`,
  ]) {
    assert.ok(tsProse.has(text), `TypeScript no longer says ${display(text)}`);
    assert.ok(rsProse.has(text), `Rust no longer says ${display(text)}`);
  }
});
