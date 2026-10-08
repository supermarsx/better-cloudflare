#!/usr/bin/env node
/**
 * One definition of "which strings the app shows" and "which locales carry
 * them", shared by the generator and the test that enforces it.
 *
 * Kept in one module on purpose. A coverage test that extracts strings one way
 * while a fixer extracts them another produces a file the test rejects and a
 * test the file cannot satisfy — the failure mode the dependency manifest
 * already taught this repo, so it is not repeated here.
 *
 * Usage:
 *   node scripts/i18n-coverage.mjs report      # what is missing, per locale
 *   node scripts/i18n-coverage.mjs fill-base   # add missing keys to en-US
 *   node scripts/i18n-coverage.mjs stubs <loc> # print untranslated keys as JSON
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LOCALES_DIR = join(ROOT, "src", "locales");
export const BASE_LOCALE = "en-US";

/** Directories whose `t()` calls reach a user. */
const SOURCE_DIRS = [join(ROOT, "src")];

/**
 * Registries whose string literals *are* i18n keys, reached through a
 * variable rather than a literal call.
 *
 * The settings screen renders each row with `t(label, label)`, where `label`
 * came out of a table. A scan for literal `t("…")` calls cannot see those, so
 * thirteen subtab names — General, Topology, About, Diagnostics — sat
 * uncatalogued and rendered in English in all twelve locales while the
 * coverage report said everything was fine.
 *
 * Reading the registry closes that by construction, and is sound precisely
 * here: `test/settingsSearch.registry.test.ts` parses `DNSManager.tsx` with
 * the TypeScript compiler and fails unless the registry's rows and the
 * component's rows are the same set with the same labels. The registry is
 * therefore already proven to match what is on screen, which is not something
 * a hand-kept list of strings would be.
 */
const REGISTRY_FILES = [
  join(ROOT, "src", "components", "dns", "settings-search.ts"),
];

/**
 * Properties in those registries that hold user-visible English.
 *
 * `id` and `keywords` are deliberately absent: an id is never shown, and
 * keywords are search aliases that exist to be matched, not read.
 *
 * `group` was absent too, and should not have been: `settings-search.ts:1114`
 * renders it as `translate(entry.group, entry.group)`, so it is a key like any
 * other. Leaving it out meant "Updates" and "Feature switches" appeared as the
 * breadcrumb in all twelve locales in English, while the coverage report
 * stayed green — the same silent shape as the subtab names, found by the agent
 * wiring the export surface when it went to add a group of its own and
 * realised a new one would never be translated.
 */
const REGISTRY_TEXT_FIELDS = ["label", "description", "hint", "group"];

/**
 * The shortest string worth cataloguing.
 *
 * Below this, a match is far more likely to be a fragment of some other
 * expression than a sentence shown to anyone.
 */
const MIN_LENGTH = 3;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Generated and vendored trees hold no authored UI text.
      if (entry.name === "node_modules" || entry.name === "locales") continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Read one double-quoted JavaScript string starting at `source[start]`, or
 * `null` if it is not terminated.
 *
 * Scans for the closing quote rather than taking the next one, because a
 * string may contain an escaped quote — `t("a house rule (\"always show the
 * TTL\")")` is one string, not a string cut off at `(`. Taking the next quote
 * catalogued a truncated key that could never match what the app passes at
 * runtime, so that string was untranslatable in every locale while looking
 * catalogued. Returns the **unescaped** value, which is what `t()` actually
 * receives and therefore what a locale file has to key on.
 */
function readQuoted(source, start) {
  if (source[start] !== '"') return null;
  let out = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (next === undefined) return null;
      out +=
        next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
      index += 1;
      continue;
    }
    if (char === '"') return out;
    out += char;
  }
  return null;
}

/**
 * The same text with comments removed.
 *
 * A comment that quotes a `t("…")` call is documentation, not a string the app
 * shows — but the scanner cannot tell, so it catalogued the sample and handed
 * it to eleven translators. That happened: a module header in
 * `src/components/portable/` illustrated the call shape in full and put
 * `"Text"` in the catalogue. Comments here are unusually thorough and quote
 * code constantly, so this will recur unless they are stripped.
 *
 * String state is tracked rather than the comment markers matched directly,
 * because `//` appears inside perfectly ordinary string literals — a URL, a
 * path — and treating one of those as the start of a comment would delete the
 * rest of a real line. Newlines are preserved so that nothing which was on
 * separate lines becomes adjacent.
 */
export function stripComments(text) {
  let out = "";
  let index = 0;
  let state = "code";
  while (index < text.length) {
    const pair = text.slice(index, index + 2);
    if (state === "code") {
      if (pair === "//") {
        state = "line";
        index += 2;
        continue;
      }
      if (pair === "/*") {
        state = "block";
        index += 2;
        continue;
      }
      const char = text[index];
      if (char === '"' || char === "'" || char === "`") state = char;
      out += char;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (text[index] === "\n") {
        state = "code";
        out += "\n";
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (pair === "*/") {
        state = "code";
        index += 2;
        continue;
      }
      if (text[index] === "\n") out += "\n";
      index += 1;
      continue;
    }
    // Inside a string literal: copy through, and let an escape carry its next
    // character so that `"\\""` does not look like a close followed by a open.
    const char = text[index];
    if (char === "\\") {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    out += char;
    if (char === state) state = "code";
    index += 1;
  }
  return out;
}

/**
 * Every literal `t("…")` default in one file's text.
 *
 * Separated from the filesystem walk so the scanning rules can be tested
 * directly on a snippet. They have been wrong three times -- once stopping at
 * an escaped quote, once cataloguing the argument of anything whose name ends
 * in `t`, once reading a sample call out of a doc comment -- and every one was
 * found by reading output rather than by a test, which is the gap this split
 * closes.
 */
export function extractFromSource(text) {
  const found = new Set();
  const flat = stripComments(text).split(/\s+/).join(" ");
  let cursor = 0;
  for (;;) {
    const at = flat.indexOf("t(", cursor);
    if (at < 0) break;
    cursor = at + 2;
    // A real call is `t(` on its own. Scanning for the substring also matches
    // the tail of `set(`, `insert(`, `logEvent(` and friends, which
    // catalogued 83 strings that were never UI text -- DOM tag names, file
    // extensions, module specifiers, DMARC tag names, a CSS selector -- and
    // sent them to twelve translators. Every real call site is a bare
    // `t("…")`; there is no `i18n.t("…")` anywhere in `src` (the hooks bind
    // it to a local `t` first), so a preceding identifier character means
    // this is not the `t` we want.
    const before = at > 0 ? flat[at - 1] : " ";
    if (/[\w$.]/.test(before)) continue;
    const quote = flat.slice(cursor).search(/\S/);
    if (quote < 0) continue;
    const value = readQuoted(flat, cursor + quote);
    if (value === null || value.length < MIN_LENGTH) continue;
    found.add(value);
  }
  return found;
}

/**
 * The user-visible English in one registry file's text.
 *
 * Only quoted values of {@link REGISTRY_TEXT_FIELDS} count, so a type
 * declaration (`label: string;`) contributes nothing — there is no quote after
 * the colon.
 */
export function extractRegistryStrings(text) {
  const found = new Set();
  // Comments stripped for the same reason as in `extractFromSource`: a
  // commented-out registry entry is not a setting anyone can see.
  const source = stripComments(text);
  for (const field of REGISTRY_TEXT_FIELDS) {
    const pattern = new RegExp(`\\b${field}:\\s*"`, "g");
    for (const match of source.matchAll(pattern)) {
      const value = readQuoted(source, match.index + match[0].length - 1);
      if (value === null || value.length < MIN_LENGTH) continue;
      found.add(value);
    }
  }
  return found;
}

/**
 * The second argument of every `t("key", "default")` call whose two literals
 * disagree, as key to default.
 *
 * This exists because of how i18next and `fill-base` interact, which is not
 * obvious and cost one key before it was noticed. While a key is uncatalogued
 * i18next renders the **default**. `fill-base` writes `base[key] = key`. So the
 * instant a key is catalogued, the visible English jumps from the default to
 * the key wherever the two differ — and the eleven translators are then handed
 * the key to translate rather than the sentence users had been reading.
 * Nothing in the coverage report compares the two, so it is silent.
 *
 * `"Comment input"` is the realised case: its call site asks for `"Comment"`,
 * the catalogue holds `"Comment input"`, and the catalogue wins.
 *
 * Writing the default instead removes the class rather than reporting it.
 */
export function extractDefaults(text) {
  const defaults = new Map();
  const flat = stripComments(text).split(/\s+/).join(" ");
  let cursor = 0;
  for (;;) {
    const at = flat.indexOf("t(", cursor);
    if (at < 0) break;
    cursor = at + 2;
    const before = at > 0 ? flat[at - 1] : " ";
    if (/[\w$.]/.test(before)) continue;
    const skip = flat.slice(cursor).search(/\S/);
    if (skip < 0) continue;
    const start = cursor + skip;
    const key = readQuoted(flat, start);
    if (key === null || key.length < MIN_LENGTH) continue;
    // Step past the key's closing quote to look for a second literal.
    const after = findQuoteEnd(flat, start);
    if (after < 0) continue;
    const separator = /^\s*,\s*/.exec(flat.slice(after));
    if (!separator) continue;
    const fallback = readQuoted(flat, after + separator[0].length);
    if (fallback === null || fallback === key) continue;
    if (!defaults.has(key)) defaults.set(key, fallback);
  }
  return defaults;
}

/** Index just past the closing quote of the string starting at `start`. */
function findQuoteEnd(source, start) {
  if (source[start] !== '"') return -1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === '"') return index + 1;
  }
  return -1;
}

export function extractStrings() {
  const found = new Map();
  for (const dir of SOURCE_DIRS) {
    for (const path of walk(dir)) {
      const text = readFileSync(path, "utf8");
      for (const value of extractFromSource(text)) {
        if (!found.has(value)) found.set(value, relative(ROOT, path));
      }
    }
  }
  for (const path of REGISTRY_FILES) {
    const text = readFileSync(path, "utf8");
    for (const value of extractRegistryStrings(text)) {
      if (!found.has(value)) found.set(value, relative(ROOT, path));
    }
  }
  return found;
}

/** Every call-site default across the source tree, keyed by its i18n key. */
export function collectDefaults() {
  const defaults = new Map();
  for (const dir of SOURCE_DIRS) {
    for (const path of walk(dir)) {
      for (const [key, value] of extractDefaults(readFileSync(path, "utf8"))) {
        if (!defaults.has(key)) defaults.set(key, value);
      }
    }
  }
  return defaults;
}

/** The `{{name}}` placeholders a string carries, as a sorted list. */
export function placeholdersOf(value) {
  return [...String(value).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort();
}

export function localeNames() {
  return readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

export function readLocale(name) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${name}.json`), "utf8"));
}

export function writeLocale(name, data) {
  const sorted = Object.fromEntries(
    Object.keys(data)
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((key) => [key, data[key]]),
  );
  writeFileSync(
    join(LOCALES_DIR, `${name}.json`),
    `${JSON.stringify(sorted, null, 2)}\n`,
    "utf8",
  );
}

/**
 * What is wrong, as data rather than prose, so the test and the CLI report the
 * same thing.
 *
 * Note the asymmetry: a locale carrying a key the base locale lacks is
 * reported as `extra`, but a *base* key with no detected call site is not
 * reported at all. That is deliberate. Several hundred base keys are reached
 * only through a variable — `t(row.label, row.label)` and its cousins — and no
 * scan here can see them, so "no call site found" is not evidence a key is
 * dead.
 *
 * A substring sweep of `src` was tried as a deadness test and is not safe
 * either: it called `C:\Users\You\Documents\Audit Exports` dead because the
 * key is the unescaped runtime value while the source carries doubled
 * backslashes. The cost of a false "dead" is a live string silently reverting
 * to English in twelve locales, which no test would catch, so extra base keys
 * are left alone unless there is positive evidence — as there was for "Better
 * Cloudflare Console", a retired product name whose only remaining occurrence
 * was a comment explaining that it had been retired.
 */
export function auditCoverage() {
  const strings = extractStrings();
  const base = readLocale(BASE_LOCALE);
  const uncatalogued = [...strings.keys()]
    .filter((value) => !(value in base))
    .sort();

  const locales = {};
  for (const name of localeNames()) {
    if (name === BASE_LOCALE) continue;
    const data = readLocale(name);
    const missing = Object.keys(base)
      .filter((key) => !(key in data))
      .sort();
    // A translation that dropped or renamed a placeholder renders the
    // placeholder's literal text, or nothing — a broken sentence rather than a
    // loud failure, which is why this is checked rather than trusted.
    const brokenPlaceholders = Object.keys(base)
      .filter((key) => key in data)
      .filter((key) => {
        const expected = placeholdersOf(base[key]).join(",");
        return placeholdersOf(data[key]).join(",") !== expected;
      })
      .sort();
    // An entry no key in the base locale asks for is dead weight at best and a
    // stale translation of a since-reworded string at worst.
    const extra = Object.keys(data)
      .filter((key) => !(key in base))
      .sort();
    locales[name] = { missing, brokenPlaceholders, extra };
  }
  return { uncatalogued, locales, strings, base };
}

function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "report") {
    const { uncatalogued, locales } = auditCoverage();
    console.log(`${BASE_LOCALE}: ${uncatalogued.length} uncatalogued strings`);
    for (const [name, state] of Object.entries(locales)) {
      console.log(
        `${name}: missing ${state.missing.length}, broken placeholders ${state.brokenPlaceholders.length}, extra ${state.extra.length}`,
      );
    }
    return;
  }
  if (command === "fill-base") {
    const { uncatalogued, base } = auditCoverage();
    // The call site's default, not the key. While a key is uncatalogued
    // i18next renders the default, so writing the key as its own value would
    // change the visible English the instant this runs -- and hand the
    // translators the key instead of the sentence users were reading.
    const defaults = collectDefaults();
    let reworded = 0;
    for (const value of uncatalogued) {
      const fallback = defaults.get(value);
      base[value] = fallback ?? value;
      if (fallback !== undefined) reworded += 1;
    }
    writeLocale(BASE_LOCALE, base);
    console.log(
      `${BASE_LOCALE}: added ${uncatalogued.length} keys` +
        (reworded > 0
          ? `, ${reworded} of them taking the call site's default rather than the key`
          : ""),
    );
    return;
  }
  if (command === "stubs") {
    if (!argument) throw new Error("stubs needs a locale name");
    const { locales, base } = auditCoverage();
    const state = locales[argument];
    if (!state) throw new Error(`unknown locale: ${argument}`);
    const todo = Object.fromEntries(
      [...state.missing, ...state.brokenPlaceholders].map((key) => [
        key,
        base[key],
      ]),
    );
    console.log(JSON.stringify(todo, null, 2));
    return;
  }
  throw new Error("usage: i18n-coverage.mjs report|fill-base|stubs <locale>");
}

// Only when run as a program. Comparing `import.meta.url` with itself was
// always true, so importing this module from a test ran `main()` and threw
// its usage error before a single assertion.
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
