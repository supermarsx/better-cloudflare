/**
 * Reading a source file as text, with its comments removed.
 *
 * # Why this exists
 *
 * Forty-five tests in this suite assert against a file's raw text — they are
 * the only thing that catches wiring a behavioural test cannot see, like a
 * hook nothing mounts or a provider rendered beside the app instead of around
 * it. Twenty-two of them read a commented format without stripping the
 * comments first, and **an assertion that matches a comment asserts nothing.**
 *
 * That is not hypothetical. An audit of all forty-five on 2026-10-10 found:
 *
 * - `test/AboutAppInfoCard.test.tsx` asserting `/loadDependencyManifest\(\)/`
 *   against a file whose module header names `loadDependencyManifest()` in
 *   prose. Replace the real call with a static import and the assertion still
 *   passes.
 * - `test/AppShellCss.contract.test.ts` passing only because the three
 *   comments naming `scrollbar-gutter` happen to sit outside the slice its
 *   `section()` helper cuts. Move one comment into the rule and the assertion
 *   becomes vacuous.
 * - `test/CloudSyncDialog.test.tsx` — clean today only because nobody has yet
 *   described that component's props in a sentence beside the code.
 *
 * And it was caught twice by mutation rather than by reading: a test for
 * `<DocumentDirection />` stayed green when the component was deleted from the
 * layout, because the assertion was matching the component's name in the
 * comment above it; and a test naming a Tailwind class stayed green against
 * the prose two lines above the class.
 *
 * # The component side matters too
 *
 * When a test derives a requirement by scanning one file and asserting about
 * another, strip **both**. The menu primitives' header comments name `pl-8` as
 * the spelling they moved *away* from, so a scan that read comments would
 * conclude `pl-8` is still in use and demand an override for a class nothing
 * uses — turning a correct cleanup into a spurious failure.
 *
 * # Known limits
 *
 * This is a regex, not a parser, so a `/*` or `//` inside a string literal is
 * removed as though it opened a comment. That is safe for the assertions here
 * (none of them match on such a string) and would not be safe for a tool that
 * had to preserve the code's meaning. If you need that, use the TypeScript AST
 * the way `test/i18nDeadKeys.test.ts` does — comments are not nodes there, so
 * the problem does not arise.
 *
 * It also does not strip YAML `#` comments. An audit pass once classified YAML
 * as a comment-free format, which is wrong; `test/ci-reliability-workflow.contract.ts`
 * reads `.github/workflows/*.yml` and needs its own handling.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/**
 * Read a source file relative to this directory, comments already removed.
 *
 * Prefer this over a bare `readFileSync` in any test that asserts on the
 * result. The point is that the safe form is the shorter one to write.
 */
export function readSource(
  relativePath: string,
  importMetaUrl: string,
): string {
  // Imported lazily so this module stays usable from a test that has already
  // read the file itself and only wants the stripping.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return stripComments(
    readFileSync(new URL(relativePath, importMetaUrl), "utf8"),
  );
}
