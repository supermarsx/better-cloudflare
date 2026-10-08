/**
 * The README's badges state facts about this repository, and facts drift.
 *
 * The Rust badge read "17 crates" while there were 19. Nobody noticed, because
 * nothing checked it — the number is in an image URL, so it is invisible to a
 * reader of the diff and to every other test in this suite. That is the whole
 * argument for this file: the repo already refuses to take a claim on trust
 * when it can be derived instead (the dependency manifest, the settings search
 * registry, `APP_TITLE` against `tauri.conf.json`), and a badge is a claim.
 *
 * Only derivable claims are checked. The CI, release, licence and docs badges
 * point at URLs whose correctness is not a fact about the working tree.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

const readme = read("../README.md");

/** The major version of a dependency range like `^19.2.8` or `16.3.6`. */
function majorOf(range: string): string {
  const match = /(\d+)/.exec(range);
  assert.ok(match, `could not read a major version out of ${range}`);
  return match[1];
}

const packageJson = JSON.parse(read("../package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function dependencyRange(name: string): string {
  const range =
    packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
  assert.ok(range, `${name} should be a dependency`);
  return range;
}

test("the Rust badge counts the crates that are actually there", () => {
  const crates = readdirSync(
    fileURLToPath(new URL("../src-tauri/crates", import.meta.url)),
    { withFileTypes: true },
  ).filter((entry) => entry.isDirectory());

  const badge = /Rust-(\d+)%20crates/.exec(readme);
  assert.ok(badge, "the README should carry a Rust crate-count badge");
  assert.equal(
    Number(badge[1]),
    crates.length,
    `the badge says ${badge[1]} crates, the workspace has ${crates.length}: ${crates
      .map((entry) => entry.name)
      .join(", ")}`,
  );
});

test("the framework badges match the versions installed", () => {
  // Pinned on the major only. That is what the badge shows, and a patch bump
  // should not have to touch the README.
  for (const [dependency, pattern] of [
    ["next", /Next\.js-(\d+)/],
    ["react", /React-(\d+)/],
  ] as const) {
    const badge = pattern.exec(readme);
    assert.ok(badge, `the README should carry a ${dependency} badge`);
    assert.equal(
      badge[1],
      majorOf(dependencyRange(dependency)),
      `the ${dependency} badge disagrees with package.json`,
    );
  }
});

test("the app is named the same way in the README heading as everywhere else", () => {
  // `src/lib/app-identity.ts` is the constant and `tauri.conf.json` is its
  // authority; the README is a fourth place the name is written by hand. It
  // had already drifted into four spellings once.
  const tauri = JSON.parse(read("../src-tauri/tauri.conf.json")) as {
    productName?: string;
  };
  assert.ok(tauri.productName, "tauri.conf.json should name the product");
  assert.equal(
    readme.split("\n")[0].trim(),
    `# ${tauri.productName}`,
    "the README's first heading should be the product name",
  );
});
