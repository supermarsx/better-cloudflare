/**
 * Holds the one `overrides` entry that is still load-bearing, and the
 * condition that retires it.
 *
 * mermaid renders maths through katex, and every katex from 0.11.0 to 0.18.1
 * carries GHSA-238p-pmpm-9mq7 — an existing prototype pollution that bypasses
 * katex's trust restrictions. There is no fix anywhere in the 0.16 line, and
 * mermaid 12.1.0 still declares `katex: ^0.16.47`, so without an override the
 * tree resolves 0.16.47 and the advisory comes straight back. `npm audit`
 * reports it, which is how it was found; the override is what keeps it quiet.
 *
 * Two things about the entry are deliberate and are asserted here rather than
 * described in a comment that cannot fail:
 *
 * 1. It is **scoped under `mermaid`**, not flat. Crossing a declared range is
 *    a liberty worth taking for the dependant that provably does not reach the
 *    vulnerable code — nothing in this app renders maths in a diagram — but a
 *    flat entry would also silently apply to some future direct dependant that
 *    *does*, and would then be hiding a real exposure rather than waiving an
 *    unreachable one.
 * 2. It is the **narrowest** thing that works. It stops being justified the
 *    moment mermaid itself declares a patched katex, and the whole point of
 *    testing that condition is that nobody will think to check it: an override
 *    that has outlived its reason looks identical to one that has not.
 *
 * So when mermaid widens its range to 0.18.2 or later, the second test fails
 * and says to delete the override. That is a test failing because the world
 * improved, which is the correct trade here — the alternative is prose in
 * `package.json` that drifts silently, and that is exactly what this file
 * replaced.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** First version the advisory does not affect. GHSA-238p-pmpm-9mq7. */
const PATCHED_KATEX = [0, 18, 2] as const;

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, relative), "utf8"),
  ) as Record<string, unknown>;
}

/** Leading `major.minor.patch` of a range such as `^0.16.47` or `0.19.0`. */
function leadingVersion(range: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  assert.ok(match, `could not read a version out of ${JSON.stringify(range)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBelow(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

test("the katex override is scoped under mermaid rather than flat", () => {
  const manifest = readJson("package.json");
  const overrides = manifest.overrides as Record<string, unknown> | undefined;
  assert.ok(overrides, "package.json should declare overrides");

  assert.equal(
    typeof overrides.katex,
    "undefined",
    "a flat `katex` override would apply to every dependant, including a future direct one that does render maths and would therefore be really exposed. Scope it under its dependant.",
  );

  const scoped = overrides.mermaid as Record<string, string> | undefined;
  assert.ok(
    scoped?.katex,
    "the `mermaid.katex` override is what keeps GHSA-238p-pmpm-9mq7 out of the tree; see this file's header before removing it",
  );
  assert.ok(
    !isBelow(leadingVersion(scoped.katex), PATCHED_KATEX),
    `the override pins katex ${scoped.katex}, which is still inside GHSA-238p-pmpm-9mq7 (fixed in ${PATCHED_KATEX.join(".")})`,
  );
});

test("mermaid still cannot reach a patched katex on its own", () => {
  const mermaid = readJson("node_modules/mermaid/package.json");
  const declared = (mermaid.dependencies as Record<string, string>).katex;
  assert.ok(declared, "mermaid should declare a katex dependency");

  assert.ok(
    isBelow(leadingVersion(declared), PATCHED_KATEX),
    `mermaid now declares katex ${declared}, which reaches the patched line on its own. The \`mermaid.katex\` override has outlived its reason — delete it from package.json, delete this test, and let the declared range resolve.`,
  );
});

test("the installed katex is one the advisory does not affect", () => {
  const installed = readJson("node_modules/katex/package.json");
  const version = String(installed.version);
  assert.ok(
    !isBelow(leadingVersion(version), PATCHED_KATEX),
    `katex ${version} is inside GHSA-238p-pmpm-9mq7. The override is declared but not in effect — check that \`npm install\` has run against the committed lockfile.`,
  );
});
