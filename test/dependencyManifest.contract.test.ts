/**
 * Holds the committed dependency manifest to the real lockfiles.
 *
 * `src/lib/about/dependency-manifest.generated.json` is what the About screen
 * renders, and the only thing that keeps it honest is this file. A generated
 * artefact with no staleness test is a hand-maintained list that nobody
 * remembers is hand-maintained: it would stay correct until the first
 * `npm install` and then quietly describe a build that no longer exists.
 *
 * Nothing here runs `cargo`. Every field except a crate's licence is a pure
 * function of committed files, and this re-derives all of it and compares
 * field for field. Crate licences are the one thing `Cargo.lock` does not
 * record, so they come from `cargo metadata` at generation time — and that is
 * not a gap, because a licence is a property of a `(name, version)` pair and
 * the full set of those pairs *is* re-derived and compared exactly. A licence
 * cannot go stale while its pair is pinned, and a bumped or added crate
 * changes the pair set and fails here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEPENDENCY_MANIFEST_RELATIVE_PATH,
  DEPENDENCY_TOTALS_RELATIVE_PATH,
  dependencyTotals,
  deriveLockedFacts,
  parseCargoLock,
  parseCargoTomlDependencies,
  serializeManifest,
  serializeTotals,
  withoutRustLicenses,
  type DependencyManifest,
} from "../scripts/dependency-manifest.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const manifestPath = path.join(
  repositoryRoot,
  DEPENDENCY_MANIFEST_RELATIVE_PATH,
);
const totalsPath = path.join(repositoryRoot, DEPENDENCY_TOTALS_RELATIVE_PATH);

const STALE = "Run: npm run deps:manifest";

function committedManifest(): DependencyManifest {
  return JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as DependencyManifest;
}

test("the committed manifest matches what the real manifests say", () => {
  // Everything bar crate licences, field for field. A dependency added,
  // removed or bumped in package.json, package-lock.json, Cargo.lock or any
  // workspace Cargo.toml fails right here.
  assert.deepEqual(
    withoutRustLicenses(committedManifest()),
    deriveLockedFacts(repositoryRoot),
    `the committed dependency manifest is stale. ${STALE}`,
  );
});

test("the committed manifest is in the exact form the generator writes", async () => {
  // Compares bytes, not structure, so a hand edit — a reordered key, a
  // reflowed array, a changed indent — is caught too. It is also what keeps
  // `npm run format:check` and the generator from ever disagreeing: both go
  // through prettier's own API.
  assert.equal(
    fs.readFileSync(manifestPath, "utf8"),
    await serializeManifest(committedManifest(), manifestPath),
    `the committed dependency manifest is not canonically formatted. ${STALE}`,
  );
});

test("the committed totals are the manifest's own counts", async () => {
  const manifest = committedManifest();
  assert.equal(
    fs.readFileSync(totalsPath, "utf8"),
    await serializeTotals(manifest, totalsPath),
    `the committed dependency totals disagree with the manifest. ${STALE}`,
  );

  // And the module the application imports really does export those numbers.
  const { DEPENDENCY_TOTALS } =
    await import("../src/lib/about/dependency-totals.generated");
  assert.deepEqual(DEPENDENCY_TOTALS, dependencyTotals(manifest));
});

test("every third-party crate carries a licence, and only this project's do not", () => {
  const manifest = committedManifest();
  const missing = manifest.rust.packages.filter(
    (entry) => !entry.workspace && (entry.license ?? "").trim().length === 0,
  );
  assert.deepEqual(
    missing.map((entry) => `${entry.name} ${entry.version}`),
    [],
    "a dependency shipped without a known licence is a decision for a person, not an empty cell in a notice",
  );

  const claiming = manifest.rust.packages.filter(
    (entry) => entry.workspace && entry.license !== null,
  );
  assert.deepEqual(
    claiming.map((entry) => entry.name),
    [],
    "this project's own crates publish nothing and declare no licence; license.md covers them",
  );
});

test("the workspace crates in the manifest are the ones Cargo.lock lists", () => {
  const manifest = committedManifest();
  const lock = parseCargoLock(
    fs.readFileSync(path.join(repositoryRoot, "Cargo.lock"), "utf8"),
  );

  assert.deepEqual(
    manifest.rust.packages
      .filter((entry) => entry.workspace)
      .map((entry) => entry.name)
      .sort(),
    lock.packages
      .filter((entry) => entry.source === null)
      .map((entry) => entry.name)
      .sort(),
    "a crate with no registry source in Cargo.lock is one of ours",
  );
});

test("every directly declared crate resolves to a version in Cargo.lock", () => {
  const manifest = committedManifest();
  const names = new Set(manifest.rust.packages.map((entry) => entry.name));

  for (const name of [...manifest.rust.direct, ...manifest.rust.directDev]) {
    assert.ok(
      names.has(name),
      `${name} is declared in a Cargo.toml but is not in Cargo.lock`,
    );
  }
});

test("every direct npm dependency resolves to a version in the lockfile", () => {
  const manifest = committedManifest();
  const names = new Set(manifest.npm.packages.map((entry) => entry.name));

  for (const name of [
    ...manifest.npm.direct.runtime,
    ...manifest.npm.direct.development,
    ...manifest.npm.direct.optional,
  ]) {
    assert.ok(
      names.has(name),
      `${name} is in package.json but is not in package-lock.json`,
    );
  }
});

test("the manifest carries both the direct set and the full transitive set", () => {
  const manifest = committedManifest();

  // The About screen shows the direct lists; the licence notice needs all of
  // it. Both have to be present, and the direct set has to be the smaller one
  // or something has collapsed.
  assert.ok(manifest.npm.direct.runtime.length > 0);
  assert.ok(manifest.rust.direct.length > 0);
  assert.ok(
    manifest.npm.direct.runtime.length < manifest.npm.packages.length,
    "26 runtime dependencies resolving to 26 packages would mean the tree was not read",
  );
  assert.ok(
    manifest.rust.direct.length < manifest.rust.packages.length,
    "the direct crate list cannot be the whole lockfile",
  );
  assert.equal(
    manifest.project.version,
    "0.0.0",
    "package.json's version is a placeholder; if it ever changes, the About screen's labelling has to change with it",
  );
});

// ── The parsers the derivation depends on ───────────────────────────────────
//
// The contract test above and the generator share these, so a parser that
// misreads a manifest would produce an artefact that agrees with itself and is
// wrong. These drive the parsers directly, against the shapes this workspace
// actually uses.

test("the Cargo.toml reader finds every shape this workspace uses", () => {
  const manifest = [
    "[package]",
    'name = "demo"',
    "",
    "[build-dependencies]",
    'tauri-build = { version = "2", features = [] }',
    "",
    "[dependencies]",
    '# a comment with a "quoted ]" bracket and a { brace',
    'bare = "1"',
    'inline = { version = "2", features = ["a", "b"] }',
    'multiline = { version = "3", default-features = false, features = [',
    '    "charset",',
    '    "http2", # trailing comment inside the array',
    "] }",
    'dotted.version = "4"',
    'renamed = { package = "real-crate", version = "5" }',
    'local = { path = "../local" }',
    "",
    "[target.'cfg(windows)'.dependencies]",
    'windows = { version = "0.61", features = ["Win32_Foundation"] }',
    "",
    "[target.'cfg(target_os = \"linux\")'.dependencies]",
    'zbus = { version = "5", default-features = false }',
    "",
    "[dependencies.subtable]",
    'version = "6"',
    "",
    "[dev-dependencies]",
    'tempfile = "3"',
    "",
    "[features]",
    'default = ["custom-protocol"]',
    "not-a-dependency = []",
  ].join("\n");

  assert.deepEqual(parseCargoTomlDependencies(manifest, "demo/Cargo.toml"), [
    { name: "tauri-build", kind: "normal" },
    { name: "bare", kind: "normal" },
    { name: "inline", kind: "normal" },
    { name: "multiline", kind: "normal" },
    { name: "dotted", kind: "normal" },
    // The crate is what `package =` says, not what the key says.
    { name: "real-crate", kind: "normal" },
    { name: "local", kind: "normal" },
    { name: "windows", kind: "normal" },
    { name: "zbus", kind: "normal" },
    { name: "subtable", kind: "normal" },
    { name: "tempfile", kind: "dev" },
  ]);
});

test("the Cargo.toml reader refuses a dependency table it cannot read", () => {
  assert.throws(
    () =>
      parseCargoTomlDependencies(
        ["[dependencies]", "this line declares nothing"].join("\n"),
        "broken/Cargo.toml",
      ),
    /unrecognised line in a dependency table/u,
    "a reader that shrugged would under-report, and under-reporting is a missing licence notice",
  );

  assert.throws(
    () =>
      parseCargoTomlDependencies(
        ["[dependencies]", 'open = { version = "1"'].join("\n"),
        "broken/Cargo.toml",
      ),
    /unbalanced brackets/u,
  );
});

test("the Cargo.lock reader reads name, version and whether it is ours", () => {
  const lock = [
    "# This file is automatically @generated by Cargo.",
    "version = 4",
    "",
    "[[package]]",
    'name = "bc-update"',
    'version = "0.1.0"',
    "dependencies = [",
    ' "chrono",',
    "]",
    "",
    "[[package]]",
    'name = "chrono"',
    'version = "0.4.44"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "deadbeef"',
  ].join("\n");

  assert.deepEqual(parseCargoLock(lock), {
    lockfileVersion: 4,
    packages: [
      { name: "bc-update", version: "0.1.0", source: null },
      {
        name: "chrono",
        version: "0.4.44",
        source: "registry+https://github.com/rust-lang/crates.io-index",
      },
    ],
  });
});

test("the Cargo.lock reader refuses a file it cannot account for", () => {
  assert.throws(
    () => parseCargoLock("version = 4\n"),
    /no \[\[package\]\] blocks/u,
  );
  assert.throws(
    () => parseCargoLock('[[package]]\nname = "x"\n'),
    /declares no lockfile version/u,
  );
  assert.throws(
    () => parseCargoLock('version = 4\n\n[[package]]\nchecksum = "x"\n'),
    /has no name\/version pair/u,
  );
});
