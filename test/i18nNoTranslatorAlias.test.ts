/**
 * No source file may route user-visible strings through a `t()` alias.
 *
 * `scripts/i18n-coverage.mjs` finds literal `t(` call sites and deliberately
 * rejects any with an identifier character in front of them — without that
 * rule the substring scan also matched `set(`, `insert(` and `logEvent(`, and
 * once catalogued 83 strings that were never UI text. The cost of the rule is
 * that a one-argument wrapper makes every string passing through it invisible:
 *
 * ```ts
 * const label = (text: string) => t(text, text) || text;   // scanner sees nothing
 * ...
 * {label("Keys and settings")}                             // never catalogued
 * ```
 *
 * `LoginSettingsMenu.tsx` did exactly this, and "Keys and settings" — the
 * login screen's menu button, its only accessible name — shipped in English in
 * all twelve locales while the coverage report read `0 uncatalogued strings`.
 * The menu's six other strings were catalogued only because other files
 * happened to use the same English in a literal call, which is luck and not a
 * mechanism.
 *
 * It is the third sighting of this shape. The other two are recorded in
 * `i18n-coverage.mjs` itself: `ACTION_TABS` holding subtab names as data, and
 * the settings-search registry. Those are handled by `REGISTRY_FILES`, which
 * reads named object fields — it cannot help with a function call, so this is
 * checked here instead.
 *
 * The rule: a one-parameter arrow or function whose body hands that same
 * parameter to `t` is an alias, and is refused. Passing a *variable* to `t`
 * for a reason — a value from a registry that `REGISTRY_FILES` covers — is
 * untouched by this, because such a call does not take the string as its own
 * parameter and give it straight to `t`.
 */
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * `const f = (x: string) => … t(x …` and its `function f(x: string) { … t(x`
 * sibling, with the parameter name captured so the body can be required to
 * use *that* identifier rather than any variable at all.
 */
const ALIAS_PATTERNS = [
  /(?:const|let|var)\s+(\w+)\s*=\s*\(\s*(\w+)\s*:\s*string\s*\)\s*(?::[^=]*)?=>\s*(?:[^;]*?\W)?t\(\s*\2\b/,
  /function\s+(\w+)\s*\(\s*(\w+)\s*:\s*string\s*\)[^{]*\{[^}]*?\Wt\(\s*\2\b/,
];

test("no source file hides strings behind a t() alias", () => {
  // `cwd` keeps the matches relative, and `join` puts them back together in
  // whatever separator this platform uses — the alternative, building a URL,
  // has to hand-escape Windows backslashes and is not worth it for a path
  // that only ever gets handed to `readFileSync`.
  const files = globSync("src/**/*.{ts,tsx}", { cwd: ROOT }).map((found) =>
    join(ROOT, found),
  );
  assert.ok(files.length > 100, "the glob should find the source tree");

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Cheap pre-filter: a file with no `t(` at all cannot alias one.
    if (!text.includes("t(")) continue;
    for (const pattern of ALIAS_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        offenders.push(
          `${relative(ROOT, file).replace(/\\/g, "/")}: ${match[1]}() forwards its argument to t()`,
        );
        break;
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a t() alias hides every string passed to it from scripts/i18n-coverage.mjs, so those strings are never catalogued and ship in English in every locale while the report reads clean. Write the call sites as a bare t("…", "…") instead:\n${offenders.join("\n")}`,
  );
});

test("the alias patterns match the shape that actually shipped", () => {
  // The regexes are the whole test, so they are checked against the code that
  // caused the defect and against the forms that must stay legal. Without
  // this, a pattern that matches nothing would make the test above pass for
  // the wrong reason — and it would pass on an empty offender list forever.
  const shipped = "const label = (text: string) => t(text, text) || text;";
  assert.ok(
    ALIAS_PATTERNS.some((pattern) => pattern.test(shipped)),
    "the patterns must match the alias that shipped in LoginSettingsMenu",
  );

  const functionForm =
    "function label(text: string): string { return t(text, text) || text; }";
  assert.ok(
    ALIAS_PATTERNS.some((pattern) => pattern.test(functionForm)),
    "the function-declaration form must be caught too",
  );

  // Legal: a literal call site.
  assert.ok(
    !ALIAS_PATTERNS.some((pattern) =>
      pattern.test('const name = t("Keys and settings", "Keys and settings");'),
    ),
    "a literal call is what this test is asking for and must not be flagged",
  );

  // Legal: a registry value passed to `t`. `REGISTRY_FILES` catalogues these,
  // and the parameter is not the string being translated.
  assert.ok(
    !ALIAS_PATTERNS.some((pattern) =>
      pattern.test("const render = (tab: Tab) => t(tab.label, tab.label);"),
    ),
    "a registry-driven call is covered by REGISTRY_FILES and must stay legal",
  );
});
