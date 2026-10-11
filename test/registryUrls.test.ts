/**
 * The dependency links point somewhere that exists.
 *
 * # Why the workspace case needs a test and the other two do not
 *
 * `npmPackageUrl` and `cratesIoUrl` interpolate a name into a registry's own
 * URL shape. If the name is in the build it is in that registry, so there is
 * nothing to verify beyond the shape.
 *
 * `workspaceCrateUrl` is different: it **derives a repository path** from a
 * crate name, encoding a layout fact — every workspace crate but the root one
 * lives at `src-tauri/crates/<name>`. That fact is true today and nothing in
 * the code enforces it. Move `bc-collections` into a subdirectory and the link
 * keeps resolving to a GitHub 404, which looks like the project deleted the
 * crate. So the assertion below walks the real directory tree and requires a
 * directory for every crate the generated manifest calls a workspace member.
 *
 * This is the shape `[[config-must-reach-its-consumer]]` warns about inverted:
 * not "is the setting read" but "is the path real". A builder that constructs
 * a plausible string is not evidence the target is there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cratesIoUrl,
  crateUrl,
  npmPackageUrl,
  workspaceCrateUrl,
} from "../src/lib/about/registry-urls.ts";
import manifest from "../src/lib/about/dependency-manifest.generated.json" with { type: "json" };

const REPO = fileURLToPath(new URL("../", import.meta.url));

test("every workspace crate's derived path is a real directory", () => {
  const crates = manifest.rust.packages.filter(
    (entry: { workspace?: boolean }) => entry.workspace === true,
  ) as { name: string }[];

  // A sweep that found nothing would pass the loop below trivially.
  assert.ok(
    crates.length >= 20,
    `expected the manifest to list the workspace's crates, found ${crates.length}`,
  );

  const missing: string[] = [];
  for (const crate of crates) {
    const url = workspaceCrateUrl(crate.name);
    assert.ok(url !== null, `${crate.name} produced no url`);
    // Recover the repo-relative path from the url rather than rebuilding it,
    // so the test reads what a user's browser would be sent to.
    const path = url.split("/tree/main/")[1];
    assert.ok(path !== undefined, `${crate.name}: ${url} has no tree path`);
    const onDisk = `${REPO}${path}`;
    if (!existsSync(onDisk) || !statSync(onDisk).isDirectory()) {
      missing.push(`${crate.name} -> ${path}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these crates link to a path that does not exist:\n${missing.join("\n")}`,
  );
});

test("a scoped npm name keeps its @ and its slash", () => {
  // `encodeURIComponent` would make this `%40radix-ui%2Freact-direction`,
  // which npm does not resolve. This is the whole reason the module validates
  // instead of encoding.
  assert.equal(
    npmPackageUrl("@radix-ui/react-direction"),
    "https://www.npmjs.com/package/@radix-ui/react-direction",
  );
  assert.equal(npmPackageUrl("next"), "https://www.npmjs.com/package/next");
});

test("a name that is not clearly safe produces no link", () => {
  // The fallback the card renders as plain text. Each of these would otherwise
  // interpolate into a url that points somewhere other than the package.
  for (const name of [
    "../../etc/passwd",
    "name?query=1",
    "name#fragment",
    "two words",
    "",
    "UPPER",
  ]) {
    assert.equal(npmPackageUrl(name), null, `npm accepted ${name}`);
  }
  for (const name of ["../x", "a/b", "a b", "", "a?b"]) {
    assert.equal(cratesIoUrl(name), null, `crates.io accepted ${name}`);
    assert.equal(workspaceCrateUrl(name), null, `workspace accepted ${name}`);
  }
});

test("the workspace flag, not the name, chooses the destination", () => {
  // `bc-` is a convention. A published crate could carry it and a workspace
  // crate could drop it, so `crateUrl` must not read the prefix.
  const host = (name: string, workspace: boolean): string => {
    const url = crateUrl(name, workspace);
    assert.ok(url !== null, `${name} (workspace=${workspace}) produced no url`);
    return new URL(url).host;
  };
  assert.equal(host("bc-collections", true), "github.com");
  assert.equal(host("bc-collections", false), "crates.io");
  assert.equal(host("serde", true), "github.com");
  assert.equal(host("serde", false), "crates.io");
});

test("the root crate links to the Tauri root, not under crates/", () => {
  const url = workspaceCrateUrl("better-cloudflare");
  assert.ok(url !== null);
  assert.ok(
    url.endsWith("/tree/main/src-tauri"),
    `the root crate must not be looked for under crates/: ${url}`,
  );
});
