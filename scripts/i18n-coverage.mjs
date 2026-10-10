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
  // `DNSManager.tsx` is the third sighting of the shape this file keeps
  // documenting, and it was the widest: `ACTION_TABS` holds the fifteen zone
  // subtabs as `{ id, label, hint }` data and the tablist renders
  // `t(tab.label, tab.label)`, so six labels and thirteen hints — every zone
  // subtab's name and its one-line description — were uncatalogued while the
  // report read green. Twelve variable-label `t()` call sites in that file are
  // invisible to `extractFromSource` for the same reason, which also covers
  // the topology port list and the diagram export formats.
  //
  // Those last two catalogue strings like "SSH (22)" and "PNG", which no
  // locale is likely to change. That is not a reason to leave them out: they
  // reach `t()`, so they are keys whether or not a translator moves them, and
  // a key whose value equals the key is already the common case here. The
  // alternative — scanning only part of a file — buys nothing and hides the
  // next one.
  //
  // Found by the agent adding the History subtab, which is exactly how the
  // `group` omission below was found: by someone adding a row and asking
  // whether their own string would ever be translated.
  join(ROOT, "src", "components", "dns", "DNSManager.tsx"),
  // The three AI registries, found by subtracting `extractStrings()` from
  // `en-US.json` and reading where each remaining key actually lives. All
  // three are pure copy tables consumed by a variable-label `t()` — the shape
  // above, in three more files:
  //
  //   `AI_ASSISTANT_PRESENTATION_OPTIONS` -> `t(option.label)`,
  //     `t(option.hint)`, `t(option.saved)`      DNSManager.tsx:2875-2877
  //   `PROVIDER_PROTOCOL_INFO`            -> `t(info.label)`,
  //     `t(protocolInfo.description)`      AiProviderSettings.tsx:517,713
  //   `AI_PERMISSION_MODE_COPY`           -> `t(mode.label)`,
  //     `t(mode.consequence)`              AiPermissionSettings.tsx:124,130
  //
  // Each of the twenty-one strings they hold was already catalogued and
  // already translated in all twelve locales, so adding them here costs no
  // translation work; it stops them reading as dead keys to anything that
  // asks which catalogued strings have a call site.
  join(ROOT, "src", "lib", "ai", "presentation.ts"),
  join(ROOT, "src", "lib", "ai", "providers.ts"),
  join(ROOT, "src", "lib", "ai", "permissions.ts"),
];

/**
 * Flat `{ id: "Label" }` maps whose *values* are keys, by declaration name.
 *
 * `REGISTRY_FILES` cannot express these. It sweeps a fixed set of property
 * names, and here the property names are the ids — `amber`, `oled`, `sunset` —
 * so there is no field list to write down. Sweeping every quoted value in the
 * file instead is not an option either: `ThemeToggle.tsx` is a component, and
 * that would catalogue its class names.
 *
 * So the declaration is named, and only the values inside that one object
 * literal are read. Both of these are consumed by a variable-label `t()`:
 * `t(TAG_COLOR_LABELS[colorId])` at `DNSManager.tsx:7715` and
 * `t(themeLabels[id], themeLabels[id])` at `ThemeToggle.tsx:203`.
 *
 * Reading them found `"Void"`, the fourth theme's name, uncatalogued while
 * `"Sunset"`, `"Night"` and `"Midday"` beside it were all catalogued and
 * translated twelve ways — so the theme menu listed three translated names and
 * one English one, in every locale, with the coverage report green.
 */
const REGISTRY_LABEL_MAPS = [
  {
    path: join(ROOT, "src", "components", "tags", "tag-colors.ts"),
    name: "TAG_COLOR_LABELS",
  },
  {
    path: join(ROOT, "src", "components", "layout", "ThemeToggle.tsx"),
    name: "themeLabels",
  },
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
 *
 * `saved` and `consequence` are the same omission a third and fourth time, in
 * the AI registries added above: `AI_ASSISTANT_PRESENTATION_OPTIONS` renders
 * `t(option.saved)` as the confirmation line under each layout choice, and
 * `AI_PERMISSION_MODE_COPY` renders `t(mode.consequence)` as the sentence
 * spelling out what a permission mode will actually let the assistant do —
 * which is the most consequential copy on that screen, and would have been the
 * one paragraph left in English.
 *
 * `synonyms` is the fifth, and the only one so far that is a *functional*
 * defect rather than a missing translation. `settings-search.ts:208` declares
 * it as one translatable string per entry and `:1265` renders it through
 * `translate(entry.synonyms, entry.synonyms)`; it is what makes a settings
 * search match anything beyond the literal label. Four entries carry one, all
 * of them sync settings. Left out of this list, those four never reached
 * `en-US.json`, so in every locale but English the sync settings were findable
 * only by their English synonyms — and a search that matches less does not look
 * broken, it just looks like a search. Found by `sync-copy`.
 *
 * `requires` is the sixth. `DNSManager.tsx:5344` renders
 * `t(entry.requires, entry.requires)` as the `{{condition}}` of
 * `t("{{label}} appears when {{condition}}.")`, so the sentence frame was
 * translated and the clause inside it was not: five conditions — "DNS server
 * is set to Custom", "GEO detection is enabled" and three more — were
 * uncatalogued and read as English inside an otherwise translated sentence, in
 * all twelve locales.
 *
 * Six omissions in one list is a pattern, not six accidents, and the mechanism
 * is measurable: this is a hand-kept mirror of property names chosen in other
 * files, and **removing a name from it makes the scanner find fewer strings,
 * so the uncatalogued count goes down and every test in the project gets
 * quieter.** See the note in `test/i18nDeadKeys.test.ts` for the measurement
 * and for the shape of a test that would catch the seventh.
 */
const REGISTRY_TEXT_FIELDS = [
  "label",
  "description",
  "hint",
  "group",
  "saved",
  "consequence",
  "synonyms",
  "requires",
];

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

/** The quote characters a JavaScript string literal can open with. */
const QUOTES = new Set(['"', "'"]);

/**
 * Read one quoted JavaScript string starting at `source[start]`, or `null` if
 * it is not terminated.
 *
 * Scans for the closing quote rather than taking the next one, because a
 * string may contain an escaped quote — `t("a house rule (\"always show the
 * TTL\")")` is one string, not a string cut off at `(`. Taking the next quote
 * catalogued a truncated key that could never match what the app passes at
 * runtime, so that string was untranslatable in every locale while looking
 * catalogued. Returns the **unescaped** value, which is what `t()` actually
 * receives and therefore what a locale file has to key on.
 *
 * **Single quotes count, and leaving them out hid a live string.** Prettier
 * picks whichever quote needs fewer escapes, so copy containing more double
 * quotes than apostrophes gets rewritten single-quoted — and then disappeared
 * from a scanner that only recognised `"`. The realised case is
 * `NotificationsSettingsDelivery.tsx:156`, the quiet-hours description: four
 * double quotes, no apostrophes, so Prettier chose `'`, so the scanner never
 * saw it, so it was in **0 of 12** locale files while the coverage report read
 * green. Nobody wrote that string wrongly; the formatter moved it out of view.
 *
 * Note how narrow the surviving margin was elsewhere: the one catalogued key
 * that contains a double quote (the AI standing-instructions description) has
 * exactly **two double quotes and two apostrophes** — a tie, which Prettier
 * breaks in favour of double by default. It was never safe, it was one
 * character from vanishing.
 */
function readQuoted(source, start) {
  const quote = source[start];
  if (!QUOTES.has(quote)) return null;
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
    if (char === quote) return out;
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
    // Either quote: a registry string that Prettier rewrote single-quoted is
    // still a registry string. See {@link readQuoted}.
    const pattern = new RegExp(`\\b${field}:\\s*["']`, "g");
    for (const match of source.matchAll(pattern)) {
      const value = readQuoted(source, match.index + match[0].length - 1);
      if (value === null || value.length < MIN_LENGTH) continue;
      found.add(value);
    }
  }
  return found;
}

/**
 * The values of one flat `{ id: "Label" }` map, by declaration name.
 *
 * Scoped to a single named declaration rather than the whole file, because the
 * files these live in are components: sweeping every quoted value would
 * catalogue class names. The brace depth is counted so that a nested object
 * cannot end the scan early, and a quoted *property* name is skipped by
 * looking for the colon that follows it — `{ "opt-in": "Needs turning on" }`
 * has to contribute the label and not the id.
 *
 * Returns the unescaped values, matching {@link readQuoted} elsewhere here:
 * the key a locale file needs is what `t()` receives, not what the source
 * spells.
 */
export function extractLabelMap(text, name) {
  const found = new Set();
  const source = stripComments(text);
  const declared = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).exec(
    source,
  );
  if (!declared) return found;
  const open = source.indexOf("{", declared.index);
  if (open < 0) return found;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    // Either quote. Safe despite apostrophes in English copy, because each
    // literal found is stepped over whole below, so a `'` inside a
    // double-quoted value is never reached as an opening quote.
    if (!QUOTES.has(char)) continue;
    const value = readQuoted(source, index);
    if (value === null) continue;
    // Step the cursor past this literal either way, so the closing quote is
    // never read as the opening one of the next.
    const end = findQuoteEnd(source, index);
    index = end < 0 ? index : end - 1;
    if (/^\s*:/.test(source.slice(end))) continue;
    if (value.length < MIN_LENGTH) continue;
    found.add(value);
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

/**
 * Index just past the closing quote of the string starting at `start`.
 *
 * Quote-aware for the same reason as {@link readQuoted}: a single-quoted key
 * whose end could not be found made the scanner miss the `, "default"` after
 * it, so `extractDefaults` silently dropped the pair.
 */
function findQuoteEnd(source, start) {
  const quote = source[start];
  if (!QUOTES.has(quote)) return -1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index + 1;
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
  for (const { path, name } of REGISTRY_LABEL_MAPS) {
    const text = readFileSync(path, "utf8");
    for (const value of extractLabelMap(text, name)) {
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
