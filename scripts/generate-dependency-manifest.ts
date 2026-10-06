/**
 * Regenerate the About screen's dependency and licence list.
 *
 *   npm run deps:manifest              # rewrite the committed artefacts
 *   npm run deps:manifest -- --check   # exit 1 if stale, write nothing
 *
 * Run it after any dependency change — `npm install`, a `Cargo.toml` edit, a
 * `cargo update` — and commit the result. `test/dependencyManifest.contract.test.ts`
 * fails when a committed artefact disagrees with the manifests, so forgetting
 * shows up as a red test rather than as a silently wrong licence notice.
 *
 * Needs a Rust toolchain: `Cargo.lock` records no licences, so crate licences
 * come from `cargo metadata` (`--locked --offline`). The contract test needs
 * no toolchain; see the module comment in `scripts/dependency-manifest.ts` for
 * why that split is complete rather than a gap.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRustLicenses,
  DEPENDENCY_MANIFEST_RELATIVE_PATH,
  DEPENDENCY_TOTALS_RELATIVE_PATH,
  deriveLockedFacts,
  rustLicensesFromCargoMetadata,
  serializeManifest,
  serializeTotals,
} from "./dependency-manifest.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface Artefact {
  relativePath: string;
  absolutePath: string;
  expected: string;
  actual: string | null;
}

function readIfPresent(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

async function main(): Promise<number> {
  const checkOnly = process.argv.slice(2).includes("--check");

  const manifest = applyRustLicenses(
    deriveLockedFacts(repositoryRoot),
    rustLicensesFromCargoMetadata(repositoryRoot),
  );

  const artefacts: Artefact[] = [];
  for (const [relativePath, render] of [
    [DEPENDENCY_MANIFEST_RELATIVE_PATH, serializeManifest],
    [DEPENDENCY_TOTALS_RELATIVE_PATH, serializeTotals],
  ] as const) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    artefacts.push({
      relativePath,
      absolutePath,
      expected: await render(manifest, absolutePath),
      actual: readIfPresent(absolutePath),
    });
  }

  const stale = artefacts.filter(
    (artefact) => artefact.actual !== artefact.expected,
  );
  const scale = `${manifest.npm.packages.length} npm, ${manifest.rust.packages.length} crates`;

  if (stale.length === 0) {
    process.stdout.write(`Dependency manifest is up to date (${scale}).\n`);
    return 0;
  }

  if (checkOnly) {
    process.stderr.write(
      `Stale: ${stale.map((artefact) => artefact.relativePath).join(", ")}\nRun: npm run deps:manifest\n`,
    );
    return 1;
  }

  for (const artefact of stale) {
    fs.mkdirSync(path.dirname(artefact.absolutePath), { recursive: true });
    fs.writeFileSync(artefact.absolutePath, artefact.expected);
    process.stdout.write(
      `${artefact.actual === null ? "Created" : "Updated"} ${artefact.relativePath}\n`,
    );
  }
  process.stdout.write(`Dependency manifest regenerated (${scale}).\n`);
  return 0;
}

process.exitCode = await main();
