/**
 * Records why `typescript` is held at 6.x, in the only place that can keep the
 * reason alive.
 *
 * `package.json` cannot carry a comment, so a deliberate hold there is
 * indistinguishable from an oversight: the next person to run
 * `npm outdated` sees `typescript 6.0.3 -> 7.0.2` with nothing to say it was
 * considered and rejected. These assertions are that explanation, and unlike a
 * comment they fail the moment the hold stops being correct.
 *
 * TypeScript 7 is the native Go port. The published package is a set of
 * platform binaries, its `bin` is `tsc` alone, and it exports no JavaScript
 * compiler API — `createProgram`, `createSourceFile` and `SyntaxKind` are all
 * gone. `tsc --noEmit` still works, so a typecheck gate passes and the
 * breakage lands somewhere less obvious:
 *
 * - `next build` type-checks by calling `typescript.createProgram` directly
 *   (`next/dist/lib/typescript/runTypeCheck.js`). It resolves `typescript`
 *   itself and exposes no hook, so there is no alias or shim that helps.
 * - `typescript-eslint` throws at config load rather than warning:
 *   "typescript-eslint does not support TS 7.0". Its declared peer range is
 *   `<6.1.0` on every published version including the canary, and upstream is
 *   targeting TS >= 7.1.
 * - This repository's own `settingsSearch.registry` test imports `ts` and uses
 *   the compiler API to read the settings registry.
 *
 * So the hold is not caution about a new major; it is that two gates and one
 * test consume an API the new major does not ship. It clears on TypeScript
 * 7.1 plus a typescript-eslint that accepts it, not on an override — and
 * forcing it would mean deleting the lint gate and setting
 * `typescript.ignoreBuildErrors`, which is two silencings rather than an
 * upgrade.
 *
 * Nothing here pins a version number. Both assertions describe capabilities,
 * so taking TypeScript 7.1 the day it is supported requires no edit to this
 * file, and taking it a day early fails here with the reason attached.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readPackage(name: string): {
  version?: string;
  peerDependencies?: Record<string, string>;
} {
  const file = path.join(repositoryRoot, "node_modules", name, "package.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("the installed TypeScript still ships the JavaScript compiler API", () => {
  // The three entry points that `next build`, typescript-eslint and
  // `settingsSearch.registry.test.ts` reach for. A `tsc` binary alone is not
  // enough for any of them.
  for (const api of [
    "createProgram",
    "createSourceFile",
    "SyntaxKind",
  ] as const) {
    assert.equal(
      typeof ts[api] !== "undefined",
      true,
      `typescript ${ts.version} does not export \`${api}\`. TypeScript 7 dropped the JavaScript compiler API; \`next build\` calls createProgram directly and cannot be shimmed. See this file's header.`,
    );
  }
});

test("the installed TypeScript is inside the range typescript-eslint supports", () => {
  const { peerDependencies } = readPackage("typescript-eslint");
  const range = peerDependencies?.typescript;
  assert.ok(
    range,
    "typescript-eslint should declare a typescript peer range; if it stopped, this test needs rewriting rather than deleting",
  );

  // Only the upper bound matters here: the floor has not been a constraint
  // since TypeScript 5. It is a minor-level bound (`<6.1.0` admits 6.0.3), so
  // this compares the whole triple rather than the major — comparing majors
  // would call the currently supported version unsupported.
  const upperBound = /<\s*(\d+)\.(\d+)\.(\d+)/.exec(range);
  assert.ok(
    upperBound,
    `could not read an upper bound from typescript-eslint's peer range ${JSON.stringify(range)}`,
  );

  const triple = (value: string) =>
    value.split(".").slice(0, 3).map(Number) as [number, number, number];
  const below = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

  assert.ok(
    below(triple(ts.version), [
      Number(upperBound[1]),
      Number(upperBound[2]),
      Number(upperBound[3]),
    ]),
    `typescript ${ts.version} is outside typescript-eslint's declared support (${range}), so \`npm run lint\` throws at config load rather than warning. Bumping TypeScript needs a typescript-eslint that accepts it; see this file's header.`,
  );
});
