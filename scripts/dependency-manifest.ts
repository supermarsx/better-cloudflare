/**
 * Derive the About screen's dependency and licence list from the real
 * manifests, so nothing about it is hand-maintained.
 *
 * # Why a committed artefact and not a runtime read
 *
 * The obvious implementation — read `Cargo.lock` when the About screen opens —
 * cannot work in a shipped build. `Cargo.lock` is a source file; it is not in
 * the `.app`/`.msi`/`.AppImage` bundle, and the webview has no filesystem
 * access to the source tree anyway. `package-lock.json` is equally absent. A
 * runtime read would therefore work on a developer's machine and show an empty
 * list to every actual user, which is the worst of the three options because
 * nothing fails loudly.
 *
 * A build step is the second option. It would have to run before `next build`
 * *and* before `cargo build`, in `npm run dev`, in the Playwright harness and
 * in CI, and a missing hook anywhere produces a stale list silently. The
 * generated text would also never appear in a diff, so a licence change in a
 * dependency bump would land unreviewed.
 *
 * So: a script with a committed output
 * ({@link DEPENDENCY_MANIFEST_RELATIVE_PATH}), plus
 * `test/dependencyManifest.contract.test.ts`, which re-derives everything
 * derivable from the committed manifests and fails when the committed file
 * disagrees. The list is then reviewable in a diff, present in every bundle,
 * and cannot rot without a red test.
 *
 * # What is derivable here, and what needs `cargo`
 *
 * Everything except Rust licences is a pure function of files in the
 * repository, and {@link deriveLockedFacts} computes exactly that set with no
 * subprocess. `Cargo.lock` has no licence field, so Rust licences come from
 * `cargo metadata` at generation time ({@link rustLicensesFromCargoMetadata}).
 *
 * That split is what lets the staleness test run without `cargo` while still
 * being complete: a licence is a property of a `(name, version)` pair, and the
 * full set of those pairs *is* re-derived from `Cargo.lock` and compared
 * exactly. A licence value therefore cannot go stale while its pair is pinned,
 * and a new or bumped crate changes the pair set and fails the comparison.
 *
 * npm licences need no subprocess at all — `package-lock.json` records them.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where the generated artefact lives, relative to the repository root. */
export const DEPENDENCY_MANIFEST_RELATIVE_PATH =
  "src/lib/about/dependency-manifest.generated.json";

/**
 * The second, tiny artefact: just the counts, as a module small enough to
 * import statically.
 *
 * The full manifest is ~175 KB and is loaded on demand, but the diagnostics
 * payload quotes "45 direct crates of 712" and must not pull a 175 KB chunk to
 * say so. Generating the counts rather than hand-writing them means there is
 * no second place to remember to update.
 */
export const DEPENDENCY_TOTALS_RELATIVE_PATH =
  "src/lib/about/dependency-totals.generated.ts";

/** The generator a stale artefact should be regenerated with. */
export const DEPENDENCY_MANIFEST_GENERATOR =
  "npm run deps:manifest (scripts/generate-dependency-manifest.ts)";

/**
 * Identifies the payload shape. Bump it alongside a breaking field change so a
 * consumer reading an older committed artefact can tell rather than guess.
 */
export const DEPENDENCY_MANIFEST_SCHEMA = "better-cloudflare-dependencies/1";

/**
 * Where the workspace's own crates live. Checked against the set of
 * source-less packages in `Cargo.lock`, so a crate added outside this glob
 * fails the contract test instead of being silently skipped.
 */
const WORKSPACE_CRATES_DIRECTORY = "src-tauri/crates";
const ROOT_CRATE_MANIFEST = "src-tauri/Cargo.toml";

/** One resolved npm package, deduplicated across lockfile positions. */
export interface NpmPackageRecord {
  name: string;
  version: string;
  /** The lockfile's `license` field, or `null` when it declares none. */
  license: string | null;
  /**
   * True when every position this `(name, version)` occupies in the lockfile
   * is inside the development-only tree. A package reachable from runtime
   * dependencies anywhere is not dev-only.
   */
  devOnly: boolean;
}

/** The direct npm dependencies, by the section of `package.json` they are in. */
export interface NpmDirectDependencies {
  runtime: string[];
  development: string[];
  optional: string[];
}

export interface NpmFacts {
  lockfileVersion: number;
  direct: NpmDirectDependencies;
  /** Every package in the lockfile, sorted by name then version. */
  packages: NpmPackageRecord[];
}

/** One resolved crate from `Cargo.lock`. */
export interface RustPackageRecord {
  name: string;
  version: string;
  /**
   * The SPDX expression `cargo metadata` reported, or `null` for this
   * project's own crates, which publish nothing and declare no licence of
   * their own — the repository's `license.md` covers them.
   */
  license: string | null;
  /** True for a crate in this workspace rather than one from crates.io. */
  workspace: boolean;
}

export interface RustFacts {
  lockfileVersion: number;
  /**
   * Third-party crate names some workspace crate depends on directly, through
   * `[dependencies]`, `[build-dependencies]` or a `[target.*]` equivalent.
   *
   * Names, not `(name, version)` pairs: 61 crate names resolve to more than
   * one version in this lockfile, including directly declared ones such as
   * `base64` and `windows`, and which copy a `[dependencies]` line resolved to
   * is not recorded in any committed file. Marking the name is both derivable
   * and honest — every version of a directly used crate is in the build.
   */
  direct: string[];
  /** As {@link direct}, for crates only reached through `[dev-dependencies]`. */
  directDev: string[];
  /** Every package in `Cargo.lock`, sorted by name then version. */
  packages: RustPackageRecord[];
}

export interface DependencyManifest {
  schema: typeof DEPENDENCY_MANIFEST_SCHEMA;
  /** How to refresh this file, carried in the artefact itself. */
  generator: string;
  project: {
    name: string;
    /**
     * `package.json`'s version, which is the placeholder `0.0.0`. The release
     * a build actually carries is the `YY.N` tag stamped into the binary; see
     * `bc_update::embedded_release_tag`.
     */
    version: string;
    license: string;
    licenseFile: string;
  };
  npm: NpmFacts;
  rust: RustFacts;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function readTextFile(root: string, relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJsonFile(root: string, relativePath: string): unknown {
  return JSON.parse(readTextFile(root, relativePath)) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Sort by name then version so two runs over the same inputs produce the same
 * bytes. `localeCompare` is deliberately avoided — it is locale-sensitive, and
 * a generated artefact compared byte-for-byte cannot depend on the machine's
 * locale.
 */
function compareNameThenVersion(
  left: { name: string; version: string },
  right: { name: string; version: string },
): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.version === right.version) return 0;
  return left.version < right.version ? -1 : 1;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

// ── npm ─────────────────────────────────────────────────────────────────────

/** The package name a lockfile v2/v3 key refers to. */
function npmNameFromLockKey(key: string): string {
  const marker = "node_modules/";
  const lastIndex = key.lastIndexOf(marker);
  if (lastIndex < 0) {
    throw new Error(
      `package-lock.json key ${JSON.stringify(key)} is not under node_modules/.`,
    );
  }
  const name = key.slice(lastIndex + marker.length);
  if (name.length === 0) {
    throw new Error(
      `package-lock.json key ${JSON.stringify(key)} names no package.`,
    );
  }
  return name;
}

function npmDirectDependencies(
  packageJson: Record<string, unknown>,
): NpmDirectDependencies {
  const section = (field: string): string[] => {
    const value = packageJson[field];
    if (value === undefined) return [];
    return sortedUnique(Object.keys(asRecord(value, `package.json ${field}`)));
  };
  return {
    runtime: section("dependencies"),
    development: section("devDependencies"),
    optional: section("optionalDependencies"),
  };
}

function npmFacts(root: string): NpmFacts {
  const packageJson = asRecord(
    readJsonFile(root, "package.json"),
    "package.json",
  );
  const lock = asRecord(
    readJsonFile(root, "package-lock.json"),
    "package-lock.json",
  );
  const lockfileVersion = lock.lockfileVersion;
  if (typeof lockfileVersion !== "number") {
    throw new Error("package-lock.json has no numeric lockfileVersion.");
  }
  if (lockfileVersion < 2) {
    throw new Error(
      `package-lock.json v${lockfileVersion} has no per-package records; v2 or later is required.`,
    );
  }

  const entries = asRecord(lock.packages, "package-lock.json packages");
  const byIdentity = new Map<string, NpmPackageRecord>();
  for (const [key, rawEntry] of Object.entries(entries)) {
    // The `""` entry is the project itself, not a dependency of it.
    if (key === "") continue;
    const entry = asRecord(rawEntry, `package-lock.json packages[${key}]`);
    if (entry.link === true) {
      // A symlink into the workspace; the target has its own entry.
      continue;
    }
    // An alias (`"foo": "npm:bar@1"`) records the real name on the entry.
    const name =
      typeof entry.name === "string" && entry.name.length > 0
        ? entry.name
        : npmNameFromLockKey(key);
    const version = requireString(
      entry.version,
      `package-lock.json packages[${key}].version`,
    );
    const license =
      typeof entry.license === "string" && entry.license.length > 0
        ? entry.license
        : null;
    // `dev` and `devOptional` both mean "not in the runtime tree here".
    const devHere = entry.dev === true || entry.devOptional === true;

    const identity = `${name}@${version}`;
    const existing = byIdentity.get(identity);
    if (existing === undefined) {
      byIdentity.set(identity, { name, version, license, devOnly: devHere });
      continue;
    }
    // Reachable from the runtime tree at any position ⇒ not dev-only.
    existing.devOnly = existing.devOnly && devHere;
    if (existing.license === null) existing.license = license;
  }

  return {
    lockfileVersion,
    direct: npmDirectDependencies(packageJson),
    packages: [...byIdentity.values()].sort(compareNameThenVersion),
  };
}

// ── Cargo.lock ──────────────────────────────────────────────────────────────

interface ParsedLockPackage {
  name: string;
  version: string;
  /** Absent for a crate in this workspace. */
  source: string | null;
}

/**
 * Read the `[[package]]` blocks out of `Cargo.lock`.
 *
 * Cargo writes this file itself and never reflows it, so the three fields this
 * needs are always one per line in a known order. Anything that does not match
 * throws rather than being skipped: a package silently dropped from the About
 * list is a missing licence notice.
 */
export function parseCargoLock(text: string): {
  lockfileVersion: number;
  packages: ParsedLockPackage[];
} {
  const versionMatch = /^version = (\d+)$/m.exec(text);
  if (versionMatch === null) {
    throw new Error("Cargo.lock declares no lockfile version.");
  }
  const lockfileVersion = Number(versionMatch[1]);

  const blocks = text.split(/\r?\n\[\[package\]\]\r?\n/u).slice(1);
  if (blocks.length === 0) {
    throw new Error("Cargo.lock contains no [[package]] blocks.");
  }
  const packages = blocks.map((block, index) => {
    const name = /^name = "(.+)"$/m.exec(block)?.[1];
    const version = /^version = "(.+)"$/m.exec(block)?.[1];
    if (name === undefined || version === undefined) {
      throw new Error(
        `Cargo.lock [[package]] block ${index + 1} has no name/version pair.`,
      );
    }
    return {
      name,
      version,
      source: /^source = "(.+)"$/m.exec(block)?.[1] ?? null,
    };
  });
  return { lockfileVersion, packages };
}

// ── Cargo.toml dependency names ─────────────────────────────────────────────

export type CargoDependencyKind = "normal" | "dev";

/**
 * Pull the declared dependency names out of one `Cargo.toml`.
 *
 * This is not a TOML parser and does not try to be: it needs dependency
 * *names*, so it tracks table headers and brace depth and reads the key at the
 * start of each entry. That handles every shape this workspace uses — bare
 * `name = "1"`, single-line and multi-line inline tables, `[target.'cfg(…)']`
 * tables and `[dependencies.name]` sub-tables.
 *
 * It throws on anything it does not recognise inside a dependency table. A
 * parser that shrugged would under-report, and under-reporting here means the
 * About screen omits something the binary links.
 */
export function parseCargoTomlDependencies(
  text: string,
  label: string,
): { name: string; kind: CargoDependencyKind }[] {
  const found: { name: string; kind: CargoDependencyKind }[] = [];
  let table: string[] = [];
  let depth = 0;
  let pendingEntry: {
    name: string;
    kind: CargoDependencyKind;
    raw: string;
  } | null = null;

  const flushPendingEntry = (): void => {
    if (pendingEntry === null) return;
    // `foo = { package = "bar" }` renames: the crate is `bar`.
    const renamed = /\bpackage\s*=\s*"([^"]+)"/u.exec(pendingEntry.raw)?.[1];
    found.push({
      name: renamed ?? pendingEntry.name,
      kind: pendingEntry.kind,
    });
    pendingEntry = null;
  };

  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const location = `${label}:${index + 1}`;
    if (depth === 0) {
      const stripped = stripTomlComment(line).trim();
      if (stripped.length === 0) continue;
      if (stripped.startsWith("[")) {
        flushPendingEntry();
        table = parseTomlTableHeader(stripped, location);
        const subTableName = dependencyTableSubName(table);
        if (subTableName !== null) {
          found.push({ name: subTableName.name, kind: subTableName.kind });
        }
        continue;
      }
      const kind = dependencyTableKind(table);
      if (kind === null) {
        depth = trackTomlDepth(stripped, 0, location);
        continue;
      }
      const key = /^(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=/u.exec(stripped);
      if (key === null) {
        throw new Error(
          `${location}: unrecognised line in a dependency table: ${stripped}`,
        );
      }
      flushPendingEntry();
      // `dep.version = "1"` declares `dep`, not `dep.version`.
      const declared = (key[1] ?? key[2] ?? "").split(".")[0];
      if (declared.length === 0) {
        throw new Error(`${location}: dependency entry names no crate.`);
      }
      pendingEntry = { name: declared, kind, raw: stripped };
      depth = trackTomlDepth(stripped, 0, location);
      if (depth === 0) flushPendingEntry();
      continue;
    }

    const stripped = stripTomlComment(line);
    if (pendingEntry !== null) pendingEntry.raw += `\n${stripped}`;
    depth = trackTomlDepth(stripped, depth, location);
    if (depth === 0) flushPendingEntry();
  }
  flushPendingEntry();
  if (depth !== 0) {
    throw new Error(`${label}: unbalanced brackets at end of file.`);
  }
  return found;
}

/** Drop a trailing `#` comment, honouring quoted `#` characters. */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

/** Net bracket/brace depth added by one already-comment-stripped line. */
function trackTomlDepth(
  line: string,
  startingDepth: number,
  location: string,
): number {
  let depth = startingDepth;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (depth < 0) {
      throw new Error(`${location}: closing bracket with nothing open.`);
    }
  }
  return depth;
}

/** Split `[target.'cfg(windows)'.dependencies]` into its path segments. */
function parseTomlTableHeader(line: string, location: string): string[] {
  if (!line.startsWith("[") || !line.endsWith("]")) {
    throw new Error(`${location}: malformed table header: ${line}`);
  }
  // `[[array.of.tables]]` — not used in a dependency table, but keep the path.
  const inner = line.startsWith("[[") ? line.slice(2, -2) : line.slice(1, -1);
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of inner) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current.trim());
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`${location}: table header has an empty segment: ${line}`);
  }
  return segments;
}

const DEPENDENCY_TABLE_NAMES = new Set([
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
]);

/** The last segment of a dependency table path, ignoring `target.<spec>`. */
function dependencyTablePath(table: string[]): string[] {
  if (table[0] === "target" && table.length >= 3) return table.slice(2);
  return table;
}

/**
 * Which dependency list this table is, or `null` when it is not one.
 *
 * `build-dependencies` counts as `normal`: a proc-macro or a build script runs
 * as part of producing the shipped binary, so its licence belongs in the
 * notice. `dev-dependencies` are separated because they are what the project
 * is tested with, not what a user runs.
 */
function dependencyTableKind(table: string[]): CargoDependencyKind | null {
  const relative = dependencyTablePath(table);
  if (relative.length !== 1) return null;
  const name = relative[0];
  if (!DEPENDENCY_TABLE_NAMES.has(name)) return null;
  return name === "dev-dependencies" ? "dev" : "normal";
}

/** A `[dependencies.<crate>]` header, which declares `<crate>` by itself. */
function dependencyTableSubName(
  table: string[],
): { name: string; kind: CargoDependencyKind } | null {
  const relative = dependencyTablePath(table);
  if (relative.length !== 2) return null;
  const name = relative[0];
  if (!DEPENDENCY_TABLE_NAMES.has(name)) return null;
  return {
    name: relative[1],
    kind: name === "dev-dependencies" ? "dev" : "normal",
  };
}

// ── Derivation ──────────────────────────────────────────────────────────────

function workspaceManifestPaths(root: string): string[] {
  const cratesDirectory = path.join(root, WORKSPACE_CRATES_DIRECTORY);
  const crateManifests = fs
    .readdirSync(cratesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${WORKSPACE_CRATES_DIRECTORY}/${entry.name}/Cargo.toml`)
    .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
    .sort();
  return [ROOT_CRATE_MANIFEST, ...crateManifests];
}

function rustFacts(root: string): RustFacts {
  const lock = parseCargoLock(readTextFile(root, "Cargo.lock"));
  const workspaceCrateNames = new Set(
    lock.packages
      .filter((entry) => entry.source === null)
      .map((entry) => entry.name),
  );

  const manifests = workspaceManifestPaths(root);
  const declaredWorkspaceCrates = new Set<string>();
  const direct = new Set<string>();
  const dev = new Set<string>();
  for (const relativePath of manifests) {
    const text = readTextFile(root, relativePath);
    const crateName = /^\s*name\s*=\s*"([^"]+)"/mu.exec(text)?.[1];
    if (crateName === undefined) {
      throw new Error(`${relativePath} declares no [package] name.`);
    }
    declaredWorkspaceCrates.add(crateName);
    for (const dependency of parseCargoTomlDependencies(text, relativePath)) {
      // A path dependency on a sibling crate is this project, not a third
      // party, and `license.md` already covers it.
      if (workspaceCrateNames.has(dependency.name)) continue;
      (dependency.kind === "dev" ? dev : direct).add(dependency.name);
    }
  }

  // The crate list is found by globbing; `Cargo.lock` is the authority on what
  // the workspace actually contains. Holding the two together means a crate
  // added somewhere the glob does not reach fails the contract test rather
  // than quietly vanishing from the notice.
  const missing = [...workspaceCrateNames].filter(
    (name) => !declaredWorkspaceCrates.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `Cargo.lock lists workspace crates with no manifest under ${WORKSPACE_CRATES_DIRECTORY}/: ${missing.sort().join(", ")}`,
    );
  }

  // A crate reached both ways is a real dependency, so `directDev` holds only
  // the ones that are *nothing but* a test dependency.
  for (const name of direct) dev.delete(name);

  // Every name declared in a manifest must exist in the lockfile; one that
  // does not means the parser misread a line.
  const lockNames = new Set(lock.packages.map((entry) => entry.name));
  const unresolved = [...direct, ...dev].filter((name) => !lockNames.has(name));
  if (unresolved.length > 0) {
    throw new Error(
      `declared dependencies absent from Cargo.lock: ${unresolved.sort().join(", ")}`,
    );
  }

  return {
    lockfileVersion: lock.lockfileVersion,
    direct: sortedUnique(direct),
    directDev: sortedUnique(dev),
    packages: lock.packages
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        license: null,
        workspace: entry.source === null,
      }))
      .sort(compareNameThenVersion),
  };
}

/**
 * Everything the About list needs that is a pure function of committed files.
 *
 * Rust licences are left `null`; {@link applyRustLicenses} fills them from
 * `cargo metadata`. Nothing here spawns a subprocess, which is what lets the
 * contract test re-derive this on a machine with no Rust toolchain.
 */
export function deriveLockedFacts(root: string): DependencyManifest {
  const packageJson = asRecord(
    readJsonFile(root, "package.json"),
    "package.json",
  );
  return {
    schema: DEPENDENCY_MANIFEST_SCHEMA,
    generator: DEPENDENCY_MANIFEST_GENERATOR,
    project: {
      name: requireString(packageJson.name, "package.json name"),
      version: requireString(packageJson.version, "package.json version"),
      license: "MIT",
      licenseFile: "license.md",
    },
    npm: npmFacts(root),
    rust: rustFacts(root),
  };
}

/**
 * The SPDX expression per `name@version`, from `cargo metadata`.
 *
 * `--locked` so the call cannot rewrite `Cargo.lock` as a side effect, and
 * `--offline` so it cannot reach the network: everything needed is already in
 * the local registry cache once the project has been built once.
 */
export function rustLicensesFromCargoMetadata(
  root: string,
): Map<string, string | null> {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked", "--offline"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined) {
    throw new Error(
      `cargo metadata could not be run (${result.error.message}). The dependency manifest needs a Rust toolchain to resolve crate licences.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `cargo metadata exited ${String(result.status)}:\n${result.stderr}`,
    );
  }

  const metadata = asRecord(
    JSON.parse(result.stdout) as unknown,
    "cargo metadata",
  );
  const packages = metadata.packages;
  if (!Array.isArray(packages)) {
    throw new Error("cargo metadata returned no packages array.");
  }
  const licenses = new Map<string, string | null>();
  for (const rawPackage of packages) {
    const entry = asRecord(rawPackage, "cargo metadata package");
    const name = requireString(entry.name, "cargo metadata package name");
    const version = requireString(
      entry.version,
      "cargo metadata package version",
    );
    const license =
      typeof entry.license === "string" && entry.license.trim().length > 0
        ? entry.license.trim()
        : typeof entry.license_file === "string" &&
            entry.license_file.trim().length > 0
          ? `see ${entry.license_file.trim()}`
          : null;
    licenses.set(`${name}@${version}`, license);
  }
  return licenses;
}

/**
 * Attach resolved licences to the crates in a derived manifest.
 *
 * A third-party crate with no licence in `cargo metadata` throws: shipping a
 * dependency whose licence is unknown is a decision for a person, not a
 * silently empty cell in a notice. This project's own crates are expected to
 * have none and keep `null`.
 */
export function applyRustLicenses(
  manifest: DependencyManifest,
  licenses: Map<string, string | null>,
): DependencyManifest {
  const unlicensed: string[] = [];
  const packages = manifest.rust.packages.map((entry) => {
    if (entry.workspace) return { ...entry, license: null };
    const license = licenses.get(`${entry.name}@${entry.version}`) ?? null;
    if (license === null) unlicensed.push(`${entry.name} ${entry.version}`);
    return { ...entry, license };
  });
  if (unlicensed.length > 0) {
    throw new Error(
      `cargo metadata reported no licence for: ${unlicensed.sort().join(", ")}`,
    );
  }
  return { ...manifest, rust: { ...manifest.rust, packages } };
}

/**
 * Drop Rust licences, leaving exactly what {@link deriveLockedFacts} produces.
 *
 * The contract test compares a committed manifest against a fresh derivation
 * through this, so every other field is checked field-for-field rather than
 * being trusted.
 */
export function withoutRustLicenses(
  manifest: DependencyManifest,
): DependencyManifest {
  return {
    ...manifest,
    rust: {
      ...manifest.rust,
      packages: manifest.rust.packages.map((entry) => ({
        ...entry,
        license: null,
      })),
    },
  };
}

/**
 * Render the artefact exactly as it is committed.
 *
 * Prettier does the formatting rather than `JSON.stringify(…, 2)`, because
 * `npm run format:check` covers `src/**\/*.json` and prettier collapses a
 * short array onto one line where `JSON.stringify` always expands it. Routing
 * both the generator and the contract test through prettier's own API makes it
 * impossible for the generated bytes and the format gate to disagree.
 */
export async function serializeManifest(
  manifest: DependencyManifest,
  filePath: string,
): Promise<string> {
  return formatWithPrettier(JSON.stringify(manifest), filePath, "json");
}

/** The counts the two artefacts agree on, derived from the manifest. */
export interface DependencyTotals {
  npm: {
    direct: number;
    directDevelopment: number;
    directOptional: number;
    total: number;
  };
  rust: {
    direct: number;
    directDevelopment: number;
    workspaceCrates: number;
    total: number;
  };
}

export function dependencyTotals(
  manifest: DependencyManifest,
): DependencyTotals {
  return {
    npm: {
      direct: manifest.npm.direct.runtime.length,
      directDevelopment: manifest.npm.direct.development.length,
      directOptional: manifest.npm.direct.optional.length,
      total: manifest.npm.packages.length,
    },
    rust: {
      direct: manifest.rust.direct.length,
      directDevelopment: manifest.rust.directDev.length,
      workspaceCrates: manifest.rust.packages.filter((entry) => entry.workspace)
        .length,
      total: manifest.rust.packages.length,
    },
  };
}

/** Render the counts module exactly as it is committed. */
export async function serializeTotals(
  manifest: DependencyManifest,
  filePath: string,
): Promise<string> {
  const totals = dependencyTotals(manifest);
  const source = `// Generated by ${DEPENDENCY_MANIFEST_GENERATOR}. Do not edit.
//
// Counts only, so a caller that just wants "45 of 712" — the diagnostics
// payload, the About header — can import them statically instead of loading
// the ~175 KB manifest. \`test/dependencyManifest.contract.test.ts\` derives
// these from the manifest and fails when this file disagrees.

/** How many packages this build is made of, by ecosystem. */
export const DEPENDENCY_TOTALS = ${JSON.stringify(totals)} as const;
`;
  return formatWithPrettier(source, filePath, "typescript");
}

/**
 * Format generated text with prettier's own API.
 *
 * Both artefacts land under paths `npm run format:check` covers, and matching
 * prettier by hand does not work: it collapses a short array onto one line
 * where `JSON.stringify(…, 2)` always expands it. Routing the generator and
 * the contract test through the same call makes it impossible for the
 * generated bytes and the format gate to disagree.
 */
async function formatWithPrettier(
  source: string,
  filePath: string,
  parser: "json" | "typescript",
): Promise<string> {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(source, { ...options, filepath: filePath, parser });
}
