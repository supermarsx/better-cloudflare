/**
 * Every string the app shows is catalogued, and every locale carries it.
 *
 * This is a contract rather than a tidiness check. The app renders `t(key,
 * default)`, so a key absent from a locale silently falls back to English —
 * the feature works, nothing errors, and a Japanese user reads English. That
 * is invisible to every other test in this suite, which is why it needs its
 * own.
 *
 * The extraction lives in `scripts/i18n-coverage.mjs` and is shared with the
 * tool that fills the files in. A test that extracted strings one way while a
 * fixer extracted them another would produce a file the test rejects and a
 * test the file cannot satisfy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASE_LOCALE,
  auditCoverage,
  extractFromSource,
  extractRegistryStrings,
  localeNames,
  placeholdersOf,
  stripComments,
} from "../scripts/i18n-coverage.mjs";

/** Keep a failure readable when it names hundreds of keys. */
function sample(keys: readonly string[], limit = 12): string {
  const shown = keys.slice(0, limit).map((key) => `  ${JSON.stringify(key)}`);
  const rest = keys.length - shown.length;
  return [...shown, rest > 0 ? `  …and ${rest} more` : ""]
    .filter(Boolean)
    .join("\n");
}

test(`every t() default is catalogued in ${BASE_LOCALE}`, () => {
  const { uncatalogued } = auditCoverage();
  assert.equal(
    uncatalogued.length,
    0,
    `${uncatalogued.length} strings are shown but not catalogued. Run \`node scripts/i18n-coverage.mjs fill-base\`.\n${sample(uncatalogued)}`,
  );
});

test("every locale carries every catalogued string", () => {
  const { locales } = auditCoverage();
  const broken = Object.entries(locales).filter(
    ([, state]) => state.missing.length > 0,
  );
  assert.equal(
    broken.length,
    0,
    `these locales fall back to English for some strings:\n${broken
      .map(
        ([name, state]) =>
          `${name}: ${state.missing.length} missing\n${sample(state.missing, 6)}`,
      )
      .join("\n")}`,
  );
});

test("a translation keeps the placeholders its English carries", () => {
  // The failure this prevents is quiet: a dropped `{{count}}` renders a
  // sentence with a hole in it, and a renamed one renders the literal
  // `{{cantidad}}`. Neither throws, so only a check like this finds it.
  const { locales } = auditCoverage();
  const broken = Object.entries(locales).filter(
    ([, state]) => state.brokenPlaceholders.length > 0,
  );
  assert.equal(
    broken.length,
    0,
    `these translations changed their placeholders:\n${broken
      .map(
        ([name, state]) => `${name}:\n${sample(state.brokenPlaceholders, 6)}`,
      )
      .join("\n")}`,
  );
});

test("no locale carries a key the catalogue no longer has", () => {
  // An extra key is dead weight at best, and at worst a translation of a
  // string that has since been reworded — which reads as current and is not.
  const { locales } = auditCoverage();
  const broken = Object.entries(locales).filter(
    ([, state]) => state.extra.length > 0,
  );
  assert.equal(
    broken.length,
    0,
    `these locales carry keys that no longer exist:\n${broken
      .map(([name, state]) => `${name}:\n${sample(state.extra, 6)}`)
      .join("\n")}`,
  );
});

test("the locale set is the one the app offers", () => {
  // Guards the other direction: a locale file added without being registered
  // would be translated and never shown, and a locale offered without a file
  // would show English while claiming otherwise.
  const names = localeNames();
  assert.ok(names.includes(BASE_LOCALE), "the base locale must have a file");
  assert.equal(
    names.length,
    12,
    `expected 12 locale files, found ${names.length}: ${names.join(", ")}`,
  );
});

test("the placeholder reader finds what it is meant to", () => {
  // The three checks above are only as good as this, so it is pinned
  // directly rather than trusted.
  assert.deepEqual(placeholdersOf("{{count}} of {{total}}"), [
    "count",
    "total",
  ]);
  assert.deepEqual(placeholdersOf("spaced {{ name }}"), ["name"]);
  assert.deepEqual(placeholdersOf("dotted {{a.b}}"), ["a.b"]);
  assert.deepEqual(placeholdersOf("none here"), []);
  assert.deepEqual(placeholdersOf("{{a}} and {{a}}"), ["a", "a"]);
});

test("the scanner reads a whole string, escaped quotes included", () => {
  // The first bug this file exists for. The scan used to take the next quote
  // rather than the closing one, so a default containing an escaped quote was
  // catalogued truncated -- a key that could never match what the app passes
  // at runtime, which left the string untranslatable in all twelve locales
  // while looking perfectly catalogued.
  const found = extractFromSource(
    'const label = t("a house rule (\\"always show the TTL\\") applies");',
  );
  assert.deepEqual(
    [...found],
    ['a house rule ("always show the TTL") applies'],
  );
});

test("the scanner unescapes, because that is what t() receives", () => {
  // A locale file has to key on the runtime value, so a Windows path written
  // "C:\\\\Users" in source must be catalogued with single
  // separators. Cataloguing the source form produced two keys no lookup could
  // ever hit.
  const found = extractFromSource('t("C:\\\\Users\\\\You\\\\Audit Exports")');
  assert.deepEqual([...found], ["C:\\Users\\You\\Audit Exports"]);
});

test("a function whose name merely ends in t is not the translator", () => {
  // The second bug. Scanning for the substring "t(" also matches the tail of
  // set(, insert(, logEvent(, connect(, import(, and so catalogued 83 strings
  // that were never UI text -- DOM tag names, file extensions, module
  // specifiers, DMARC tag names, a CSS selector -- and sent all of them to
  // twelve translators.
  for (const snippet of [
    'document.createElement("div")',
    'map.set("expiryLedger", value)',
    'logEvent("audit.export")',
    'await import("@/lib/api/tauri-client")',
    'element.closest(".titlebar.fixed")',
    'window.addEventListener("preferences-changed", onChange)',
  ]) {
    assert.deepEqual(
      [...extractFromSource(snippet)],
      [],
      `${snippet} must not be catalogued`,
    );
  }
});

test("a real call is still found in the shapes source actually uses", () => {
  // The guard above must not have bought precision by losing real calls, so
  // the punctuation that genuinely precedes a t() call is pinned here.
  const shapes = [
    '{t("Inside JSX")}',
    'const a = t("After an equals");',
    'f(t("As an argument"))',
    'x ? t("After a question mark") : y',
    'label: t("After a colon"),',
    '[t("Inside an array")]',
    't("At the very start")',
    'return t("After a keyword");',
  ];
  for (const snippet of shapes) {
    assert.equal(
      extractFromSource(snippet).size,
      1,
      `${snippet} should yield exactly one string`,
    );
  }
});

test("a call split across lines is still one call", () => {
  // Source is flattened before scanning precisely so that prettier wrapping a
  // long call does not hide it from the catalogue.
  const found = extractFromSource(
    't(\n  "A default long enough that prettier would wrap it",\n);',
  );
  assert.deepEqual(
    [...found],
    ["A default long enough that prettier would wrap it"],
  );
});

test("registry text is catalogued even though no literal call names it", () => {
  // The settings screen renders a row with `t(label, label)`, so the label
  // is an i18n key that no scan for literal `t("…")` calls can see. Thirteen
  // subtab names were uncatalogued for exactly this reason and rendered in
  // English in all twelve locales while the report said coverage was complete.
  const found = extractRegistryStrings(
    [
      "export interface SettingsSearchEntry {",
      "  label: string;",
      "  description?: string;",
      "}",
      'const ROWS = [{ id: "general", label: "General", keywords: "basics" }];',
      'const MORE = [{ label: "Registry monitoring", description: "Off stops every RDAP request." }];',
    ].join("\n"),
  );
  assert.deepEqual([...found].sort(), [
    "General",
    "Off stops every RDAP request.",
    "Registry monitoring",
  ]);
});

test("a type declaration is not a string, and an id is not shown", () => {
  // `label: string;` has no quote after the colon, so it contributes nothing,
  // and `id` and `keywords` are deliberately not read: an id never reaches
  // the screen and keywords exist to be matched rather than read.
  const found = extractRegistryStrings(
    [
      "  label: string;",
      "  description?: string | undefined;",
      'const E = { id: "mcp-server-port", keywords: "listen socket bind" };',
    ].join("\n"),
  );
  assert.deepEqual([...found], []);
});

test("every settings subtab name is catalogued", () => {
  // The concrete regression: these are the names on the settings tabs, and
  // each one was missing. Pinned by value rather than by count so that a
  // renamed tab has to be translated rather than silently falling back.
  const { base } = auditCoverage();
  for (const subtab of [
    "General",
    "Columns",
    "Topology",
    "Audit",
    "MCP",
    "About",
    "Diagnostics",
  ]) {
    assert.ok(
      subtab in base,
      `the "${subtab}" settings tab name must be catalogued`,
    );
  }
});

test("a sample call in a comment is documentation, not a string to translate", () => {
  // The third scanner bug. A module header illustrating the call shape put
  // `"Text"` in the catalogue and owed it to eleven translators. Comments in
  // this repo are thorough and quote code constantly, so this is the shape
  // most likely to recur.
  assert.deepEqual(
    [...extractFromSource('// render it with t("Text", "Text")')],
    [],
  );
  assert.deepEqual(
    [...extractFromSource('/**\n * Call it as t("Sample string").\n */')],
    [],
  );
  // A commented-out call is also not a call.
  assert.deepEqual(
    [...extractFromSource('// const label = t("Removed string");')],
    [],
  );
  // But a comment must not blind the scanner to the code around it.
  const mixed = extractFromSource(
    '// t("In a comment")\nconst a = t("In the code"); /* t("In a block") */',
  );
  assert.deepEqual([...mixed], ["In the code"]);
});

test("a comment marker inside a string is not a comment", () => {
  // Why the stripping tracks string state rather than matching the markers
  // directly: "//" is ordinary content in a URL or a path, and treating one as
  // a comment start would delete the rest of a real line along with any call
  // on it.
  assert.deepEqual(
    [
      ...extractFromSource(
        'const url = "https://example.com/x"; const label = t("After a URL");',
      ),
    ],
    ["After a URL"],
  );
  assert.deepEqual(
    [...extractFromSource('t("https://example.com/docs")')],
    ["https://example.com/docs"],
  );
  // A block-comment opener inside a string is equally inert.
  assert.deepEqual(
    [...extractFromSource('t("a /* not a comment */ b")')],
    ["a /* not a comment */ b"],
  );
});

test("stripping comments preserves line structure", () => {
  // Newlines survive so that two things on separate lines cannot become
  // adjacent and form a token nobody wrote.
  const stripped = stripComments("const a = 1; // note\nconst b = 2;");
  assert.equal(stripped.split("\n").length, 2);
  assert.ok(stripped.includes("const a = 1;"));
  assert.ok(stripped.includes("const b = 2;"));
  assert.ok(!stripped.includes("note"));
});

test("a commented-out registry entry is not a setting", () => {
  const found = extractRegistryStrings(
    [
      'const ROWS = [{ id: "live", label: "A live setting" }];',
      '// { id: "removed", label: "A setting that was deleted" },',
      '/* { id: "planned", label: "A setting not built yet" }, */',
    ].join("\n"),
  );
  assert.deepEqual([...found], ["A live setting"]);
});
