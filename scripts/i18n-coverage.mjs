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
 * Every literal `t("…")` default in the source, mapped to where it was found.
 *
 * Deliberately not a regex over the raw text. Whitespace is collapsed first so
 * a call broken across lines is still seen, and only a `t(` followed by a
 * double quote counts — `t(entry.label, …)` passes a variable and has no
 * literal to catalogue.
 */
export function extractStrings() {
  const found = new Map();
  for (const dir of SOURCE_DIRS) {
    for (const path of walk(dir)) {
      const flat = readFileSync(path, "utf8").split(/\s+/).join(" ");
      let rest = flat;
      while (rest.includes("t(")) {
        rest = rest.slice(rest.indexOf("t(") + 2);
        const trimmed = rest.replace(/^\s+/, "");
        if (!trimmed.startsWith('"')) continue;
        const end = trimmed.indexOf('"', 1);
        if (end < 0) continue;
        const value = trimmed.slice(1, end);
        if (value.length < MIN_LENGTH) continue;
        if (!found.has(value)) found.set(value, relative(ROOT, path));
      }
    }
  }
  return found;
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
    for (const value of uncatalogued) base[value] = value;
    writeLocale(BASE_LOCALE, base);
    console.log(`${BASE_LOCALE}: added ${uncatalogued.length} keys`);
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
