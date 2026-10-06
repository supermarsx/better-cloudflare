import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  aboutInfoFromDiagnostics,
  APP_DISPLAY_NAME,
  describeAppBuild,
  GITHUB_REPOSITORY,
  PROJECT_LICENSE,
  PROJECT_LINKS,
} from "../src/lib/about/app-info";
import {
  directNpmDependencies,
  directRustDependencies,
  licenseBreakdown,
  workspaceCrates,
  type DependencyManifest,
} from "../src/lib/about/dependencies";
import { buildDiagnosticsReport } from "../src/lib/diagnostics/diagnostics-report";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function committedManifest(): DependencyManifest {
  return JSON.parse(
    readRepositoryFile("src/lib/about/dependency-manifest.generated.json"),
  ) as DependencyManifest;
}

test("the repository slug matches bc_update::GITHUB_REPO", () => {
  // The frontend cannot ask the host for a compile-time constant on the web,
  // so the slug is duplicated. This is the check that keeps the duplicate
  // honest: if the repository is ever renamed, the Rust constant moves and
  // this fails rather than the About links quietly 404ing.
  const github = readRepositoryFile("src-tauri/crates/bc-update/src/github.rs");
  const declared = /pub const GITHUB_REPO: &str = "([^"]+)";/u.exec(
    github,
  )?.[1];

  assert.equal(
    declared,
    GITHUB_REPOSITORY,
    "src/lib/about/app-info.ts mirrors bc_update::GITHUB_REPO and has drifted",
  );
});

test("the product name matches tauri.conf.json", () => {
  const config = JSON.parse(
    readRepositoryFile("src-tauri/tauri.conf.json"),
  ) as {
    productName?: string;
    version?: string;
  };

  assert.equal(config.productName, APP_DISPLAY_NAME);
  assert.equal(
    config.version,
    "0.0.0",
    "the bundle version is a placeholder, which is why the About screen labels it as one",
  );
});

test("the project licence matches license.md", () => {
  const license = readRepositoryFile("license.md");

  assert.ok(license.startsWith("MIT License"));
  assert.equal(PROJECT_LICENSE.spdx, "MIT");
  assert.ok(
    license.includes(PROJECT_LICENSE.holder),
    `license.md does not name ${PROJECT_LICENSE.holder}`,
  );
  assert.ok(fs.existsSync(path.join(repositoryRoot, PROJECT_LICENSE.file)));
});

test("every About link is an https github.com URL", () => {
  for (const [name, url] of Object.entries(PROJECT_LINKS)) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:", `${name} must be https`);
    assert.equal(parsed.host, "github.com", `${name} must be on github.com`);
    assert.ok(
      parsed.pathname.startsWith(`/${GITHUB_REPOSITORY}`),
      `${name} must point at this repository`,
    );
  }
});

test("describeAppBuild reports the stamped release and nothing invented", () => {
  const info = describeAppBuild(
    {
      releaseTag: "26.14",
      bundleVersion: "0.0.0",
      buildProfile: "release",
      os: "windows",
      arch: "x86_64",
      tauriVersion: "2.11.5",
      webviewVersion: "131.0.2903.70",
    },
    "desktop",
  );

  assert.equal(info.releaseTag, "26.14");
  assert.equal(info.versionLabel, "26.14");
  assert.equal(info.bundleVersion, "0.0.0");
  assert.equal(info.target, "windows x86_64");
  assert.equal(info.shell, "desktop");
});

test("an unstamped or hostless build says so instead of guessing", () => {
  for (const [hostFacts, shell] of [
    [null, "browser"],
    [{ releaseTag: null }, "desktop"],
    [{ releaseTag: "  " }, "desktop"],
  ] as const) {
    const info = describeAppBuild(hostFacts, shell);
    assert.equal(info.releaseTag, null);
    assert.equal(info.versionLabel, "local build (no release tag stamped)");
    assert.equal(info.target, null);
    // The parts that do not depend on the host are still there, so the About
    // screen renders on the web rather than failing to.
    assert.equal(info.name, APP_DISPLAY_NAME);
    assert.equal(info.license.spdx, "MIT");
    assert.ok(info.dependencies.rust.total > 0);
  }
});

test("About data derived from a diagnostics report says the same thing", () => {
  const report = buildDiagnosticsReport({
    shell: "desktop",
    hostFacts: { releaseTag: "26.14", bundleVersion: "0.0.0" },
  });
  const info = aboutInfoFromDiagnostics(report.build);

  assert.equal(info.versionLabel, report.build.versionLabel);
  assert.equal(info.releaseTag, "26.14");
  assert.equal(info.shell, "desktop");
});

test("the direct npm list is one row per package, with its versions", () => {
  const rows = directNpmDependencies(committedManifest());
  const manifest = committedManifest();

  assert.equal(
    rows.length,
    new Set([
      ...manifest.npm.direct.runtime,
      ...manifest.npm.direct.development,
      ...manifest.npm.direct.optional,
    ]).size,
    "every package package.json names should produce exactly one row",
  );
  for (const row of rows) {
    assert.ok(row.versions.length > 0, `${row.name} has no version`);
  }

  const next = rows.find((row) => row.name === "next");
  assert.ok(next, "next is a runtime dependency and must be listed");
  assert.equal(next.developmentOnly, false);
  assert.deepEqual(next.licenses, ["MIT"]);

  const prettier = rows.find((row) => row.name === "prettier");
  assert.ok(prettier);
  assert.equal(
    prettier.developmentOnly,
    true,
    "a devDependency is what the project is built with, not what a user runs",
  );
});

test("the direct crate list lists every version of a crate it names", () => {
  const manifest = committedManifest();
  const rows = directRustDependencies(manifest);

  const base64 = rows.find((row) => row.name === "base64");
  assert.ok(base64, "base64 is declared directly by three workspace crates");
  assert.ok(
    base64.versions.length > 1,
    "base64 resolves to more than one version here, and every one of them is in the build",
  );

  const tempfile = rows.find((row) => row.name === "tempfile");
  assert.ok(tempfile);
  assert.equal(tempfile.developmentOnly, true);

  for (const row of rows) {
    assert.ok(
      row.licenses.length > 0,
      `${row.name} is a third-party crate with no licence`,
    );
  }
});

test("this project's own crates are listed apart from third-party ones", () => {
  const manifest = committedManifest();
  const own = workspaceCrates(manifest);

  assert.ok(own.length > 0);
  for (const crate of own) {
    assert.equal(crate.workspace, true);
    assert.equal(crate.license, null);
  }
  assert.ok(
    own.some((crate) => crate.name === "bc-update"),
    "bc-update is a workspace crate",
  );
  assert.ok(
    !directRustDependencies(manifest).some((row) => row.name === "bc-update"),
    "a sibling crate is this project, not something it is built on",
  );
});

test("the licence breakdown counts third-party packages only", () => {
  const manifest = committedManifest();
  const breakdown = licenseBreakdown(manifest);

  assert.ok(breakdown.length > 0);
  const total = breakdown.reduce((sum, entry) => sum + entry.packages, 0);
  assert.equal(
    total,
    manifest.npm.packages.length +
      manifest.rust.packages.filter((entry) => !entry.workspace).length,
    "every third-party package belongs to exactly one licence group",
  );
  assert.deepEqual(
    [...breakdown].sort((left, right) => right.packages - left.packages)[0],
    breakdown[0],
    "the breakdown is ordered by how many packages carry each licence",
  );
  // An SPDX expression is a group of its own: splitting "Apache-2.0 OR MIT"
  // would assert a choice this project has not recorded making.
  assert.ok(
    breakdown.some((entry) => entry.license.includes(" OR ")),
    "dual-licensed crates keep their expression verbatim",
  );
  assert.ok(
    breakdown.some((entry) => entry.license === "not declared"),
    "a package whose lockfile entry declares no licence is shown as undeclared, not as MIT",
  );
});
