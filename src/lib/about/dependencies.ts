/**
 * The About screen's view of what this application is built on.
 *
 * The data is `dependency-manifest.generated.json`, produced from
 * `package.json`, `package-lock.json`, `Cargo.lock` and the workspace's
 * `Cargo.toml` files by `scripts/generate-dependency-manifest.ts` and held
 * fresh by `test/dependencyManifest.contract.test.ts`. Nothing here is
 * hand-maintained, and nothing here reads a lockfile at runtime — a shipped
 * bundle contains no lockfiles to read.
 *
 * # Why the manifest is loaded, not imported
 *
 * The artefact is ~175 KB: 712 crates and 565 npm packages, which is the
 * honest size of a complete licence notice. {@link loadDependencyManifest}
 * reaches it through a dynamic `import()` so the bundler emits it as its own
 * chunk, and a user who never opens About never downloads it.
 * {@link DEPENDENCY_TOTALS} is the one thing available without that load,
 * because the diagnostics payload quotes the counts and should not pull in a
 * chunk to do it.
 */

/** One resolved npm package. */
export interface NpmDependency {
  name: string;
  version: string;
  /** The SPDX expression from the lockfile, or `null` if it declares none. */
  license: string | null;
  /** True when the package appears only in the development tree. */
  devOnly: boolean;
}

/** One resolved crate. */
export interface RustDependency {
  name: string;
  version: string;
  /** `null` for this project's own crates — `license.md` covers those. */
  license: string | null;
  /** True for a crate in this workspace rather than one from crates.io. */
  workspace: boolean;
}

export interface DependencyManifest {
  schema: string;
  generator: string;
  project: {
    name: string;
    /**
     * `package.json`'s placeholder `0.0.0`. The release a build carries is the
     * `YY.N` tag in {@link AppBuildInfo.releaseTag}, never this.
     */
    version: string;
    license: string;
    licenseFile: string;
  };
  npm: {
    lockfileVersion: number;
    direct: { runtime: string[]; development: string[]; optional: string[] };
    packages: NpmDependency[];
  };
  rust: {
    lockfileVersion: number;
    direct: string[];
    directDev: string[];
    packages: RustDependency[];
  };
}

/**
 * Counts without the chunk.
 *
 * Generated alongside the manifest, so it is not a second place to remember to
 * update, and re-derived from the manifest by
 * `test/dependencyManifest.contract.test.ts`, so the two artefacts cannot
 * disagree.
 */
export { DEPENDENCY_TOTALS } from "./dependency-totals.generated";

let manifestPromise: Promise<DependencyManifest> | null = null;

/**
 * Load the full dependency list, once per session.
 *
 * The promise is cached rather than the value, so two panels opening at the
 * same time share one chunk fetch. A rejected load is not cached: a transient
 * chunk-load failure should be retryable by reopening the panel.
 */
export function loadDependencyManifest(): Promise<DependencyManifest> {
  manifestPromise ??= import("./dependency-manifest.generated.json")
    .then((module) => module.default as unknown as DependencyManifest)
    .catch((error: unknown) => {
      manifestPromise = null;
      throw error;
    });
  return manifestPromise;
}

/** One row of the About screen's dependency table. */
export interface DependencyRow {
  name: string;
  /** Every version of this package in the build, in lockfile order. */
  versions: string[];
  /** Every distinct licence across those versions, deduplicated. */
  licenses: string[];
  /** `true` when nothing in the runtime tree reaches it. */
  developmentOnly: boolean;
}

function dependencyRows(
  packages: readonly {
    name: string;
    version: string;
    license: string | null;
  }[],
  names: ReadonlySet<string>,
  developmentOnly: (name: string) => boolean,
): DependencyRow[] {
  const rows = new Map<string, DependencyRow>();
  for (const entry of packages) {
    if (!names.has(entry.name)) continue;
    const row = rows.get(entry.name) ?? {
      name: entry.name,
      versions: [],
      licenses: [],
      developmentOnly: developmentOnly(entry.name),
    };
    row.versions.push(entry.version);
    if (entry.license !== null && !row.licenses.includes(entry.license)) {
      row.licenses.push(entry.license);
    }
    rows.set(entry.name, row);
  }
  return [...rows.values()].sort((left, right) =>
    left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
  );
}

/**
 * The npm packages `package.json` names, collapsed one row per package.
 *
 * This is the list to show first: "what is this built on" is answered by 26
 * runtime packages, not by 565. The full set is right there in
 * `manifest.npm.packages` for a reader who wants it, and the licence notice
 * needs it, but it is not an answer to the question a user asked.
 */
export function directNpmDependencies(
  manifest: DependencyManifest,
): DependencyRow[] {
  const development = new Set(manifest.npm.direct.development);
  const runtime = new Set([
    ...manifest.npm.direct.runtime,
    ...manifest.npm.direct.optional,
  ]);
  return dependencyRows(
    manifest.npm.packages,
    new Set([...runtime, ...development]),
    (name) => !runtime.has(name),
  );
}

/**
 * The crates some workspace crate depends on directly, one row per crate.
 *
 * `manifest.rust.direct` holds names rather than `(name, version)` pairs
 * because 61 crate names resolve to more than one version here and no
 * committed file records which copy a `[dependencies]` line took. A row
 * therefore lists every version of that crate in the build, which is the true
 * answer.
 */
export function directRustDependencies(
  manifest: DependencyManifest,
): DependencyRow[] {
  const development = new Set(manifest.rust.directDev);
  return dependencyRows(
    manifest.rust.packages,
    new Set([...manifest.rust.direct, ...development]),
    (name) => development.has(name),
  );
}

/** This project's own crates, which carry no licence of their own. */
export function workspaceCrates(
  manifest: DependencyManifest,
): RustDependency[] {
  return manifest.rust.packages.filter((entry) => entry.workspace);
}

/**
 * Licences present in the build, with how many packages carry each.
 *
 * Grouped by the SPDX expression verbatim — `"Apache-2.0 OR MIT"` is its own
 * group and is not split into two, because the expression is what the package
 * actually offers and splitting it would assert a choice this project has not
 * recorded making.
 */
export function licenseBreakdown(
  manifest: DependencyManifest,
): { license: string; packages: number }[] {
  const counts = new Map<string, number>();
  for (const entry of [...manifest.npm.packages, ...manifest.rust.packages]) {
    if ("workspace" in entry && entry.workspace) continue;
    const license = entry.license ?? "not declared";
    counts.set(license, (counts.get(license) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([license, packages]) => ({ license, packages }))
    .sort(
      (left, right) =>
        right.packages - left.packages ||
        (left.license < right.license
          ? -1
          : left.license > right.license
            ? 1
            : 0),
    );
}
