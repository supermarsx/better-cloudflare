#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_MATRIX = Object.freeze(
  [
    {
      runner: "ubuntu-24.04",
      platform: "linux",
      arch: "x64",
      nodePlatform: "linux",
      nodeArch: "x64",
      target: "x86_64-unknown-linux-gnu",
      bundle: "appimage",
      sourceSuffix: ".AppImage",
      asset: "better-cloudflare-linux-x64.AppImage",
    },
    {
      runner: "ubuntu-24.04-arm",
      platform: "linux",
      arch: "arm64",
      nodePlatform: "linux",
      nodeArch: "arm64",
      target: "aarch64-unknown-linux-gnu",
      bundle: "appimage",
      sourceSuffix: ".AppImage",
      asset: "better-cloudflare-linux-arm64.AppImage",
    },
    {
      runner: "macos-15-intel",
      platform: "macos",
      arch: "x64",
      nodePlatform: "darwin",
      nodeArch: "x64",
      target: "x86_64-apple-darwin",
      bundle: "dmg",
      sourceSuffix: ".dmg",
      asset: "better-cloudflare-macos-x64.dmg",
    },
    {
      runner: "macos-15",
      platform: "macos",
      arch: "arm64",
      nodePlatform: "darwin",
      nodeArch: "arm64",
      target: "aarch64-apple-darwin",
      bundle: "dmg",
      sourceSuffix: ".dmg",
      asset: "better-cloudflare-macos-arm64.dmg",
    },
    {
      runner: "windows-2025",
      platform: "windows",
      arch: "x64",
      nodePlatform: "win32",
      nodeArch: "x64",
      target: "x86_64-pc-windows-msvc",
      bundle: "nsis",
      sourceSuffix: "-setup.exe",
      asset: "better-cloudflare-windows-x64-setup.exe",
    },
    {
      runner: "windows-11-arm",
      platform: "windows",
      arch: "arm64",
      nodePlatform: "win32",
      nodeArch: "arm64",
      target: "aarch64-pc-windows-msvc",
      bundle: "nsis",
      sourceSuffix: "-setup.exe",
      asset: "better-cloudflare-windows-arm64-setup.exe",
    },
  ].map(Object.freeze),
);

const EXPECTED_PAIRS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "macos-x64",
  "macos-arm64",
  "windows-x64",
  "windows-arm64",
]);

function fail(message) {
  throw new Error(message);
}

export function assertMatrixContract(matrix = RELEASE_MATRIX) {
  if (matrix.length !== 6) {
    fail(
      `Release matrix must contain exactly six entries; found ${matrix.length}.`,
    );
  }

  const pairs = matrix.map(({ platform, arch }) => `${platform}-${arch}`);
  if (new Set(pairs).size !== pairs.length) {
    fail("Release matrix contains a duplicate platform/architecture pair.");
  }

  const expectedPairs = [...EXPECTED_PAIRS].sort();
  const actualPairs = [...pairs].sort();
  if (JSON.stringify(actualPairs) !== JSON.stringify(expectedPairs)) {
    fail(
      `Release matrix pairs do not match the required contract: ${actualPairs.join(", ")}.`,
    );
  }

  const assets = matrix.map(({ asset }) => asset);
  if (new Set(assets).size !== assets.length) {
    fail("Release matrix contains duplicate asset names.");
  }

  for (const entry of matrix) {
    for (const field of [
      "runner",
      "platform",
      "arch",
      "nodePlatform",
      "nodeArch",
      "target",
      "bundle",
      "sourceSuffix",
      "asset",
    ]) {
      if (!entry[field]) {
        fail(
          `Release matrix entry ${entry.platform}-${entry.arch} is missing ${field}.`,
        );
      }
    }
  }

  return true;
}

export function expectedAssetNames(matrix = RELEASE_MATRIX) {
  assertMatrixContract(matrix);
  return matrix.flatMap(({ asset }) => [asset, `${asset}.sha256`]);
}

export function nextReleaseTag(year, tags) {
  if (!/^\d{2}$/.test(year)) {
    fail(`Release year must contain exactly two digits; received "${year}".`);
  }

  const pattern = new RegExp(`^${year}\\.(0|[1-9]\\d*)$`);
  let maximum = 0;

  for (const rawTag of tags) {
    const tag = rawTag.replace(/^refs\/tags\//, "");
    const match = pattern.exec(tag);
    if (!match) {
      continue;
    }

    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) {
      fail(`Release sequence is outside the safe integer range: ${tag}.`);
    }
    maximum = Math.max(maximum, sequence);
  }

  return `${year}.${maximum + 1}`;
}

function matrixEntry(platform, arch) {
  const entry = RELEASE_MATRIX.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!entry) {
    fail(`Unsupported release platform/architecture: ${platform}-${arch}.`);
  }
  return entry;
}

function filesRecursively(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesRecursively(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function stageNativeAsset(bundleRoot, platform, arch, outputDirectory) {
  const entry = matrixEntry(platform, arch);
  const root = resolve(bundleRoot);

  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Tauri bundle directory is missing: ${root}.`);
  }

  const candidates = filesRecursively(root).filter(
    (path) => path.endsWith(entry.sourceSuffix) && statSync(path).size > 0,
  );
  if (candidates.length !== 1) {
    fail(
      `Expected exactly one non-empty ${entry.sourceSuffix} bundle for ${platform}-${arch}; found ${candidates.length}.`,
    );
  }

  const destinationDirectory = resolve(outputDirectory);
  mkdirSync(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, entry.asset);
  copyFileSync(candidates[0], destination, constants.COPYFILE_EXCL);

  const checksum = `${sha256(destination)}  ${entry.asset}\n`;
  writeFileSync(`${destination}.sha256`, checksum, {
    encoding: "utf8",
    flag: "wx",
  });

  return {
    asset: destination,
    checksum: `${destination}.sha256`,
    source: candidates[0],
  };
}

export function validateAssetNames(names, matrix = RELEASE_MATRIX) {
  const expected = expectedAssetNames(matrix).sort();
  const actual = [...names].sort();

  if (new Set(actual).size !== actual.length) {
    fail("Release contains duplicate asset names.");
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !expected.includes(name));
    fail(
      `Release asset contract failed. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }

  return true;
}

export function validateReleaseAssets(directory, matrix = RELEASE_MATRIX) {
  const root = resolve(directory);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Release asset directory is missing: ${root}.`);
  }

  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    fail("Release asset directory must contain files only.");
  }
  validateAssetNames(
    entries.map((entry) => entry.name),
    matrix,
  );

  for (const { asset } of matrix) {
    const assetPath = join(root, asset);
    if (statSync(assetPath).size === 0) {
      fail(`Release asset is empty: ${asset}.`);
    }

    const expectedChecksum = `${sha256(assetPath)}  ${asset}`;
    const actualChecksum = readFileSync(
      `${assetPath}.sha256`,
      "utf8",
    ).trimEnd();
    if (actualChecksum !== expectedChecksum) {
      fail(`SHA-256 checksum does not match ${asset}.`);
    }
  }

  return true;
}

export function verifyRunnerArchitecture(
  platform,
  arch,
  actualPlatform = process.platform,
  actualArch = process.arch,
) {
  const entry = matrixEntry(platform, arch);
  if (actualPlatform !== entry.nodePlatform || actualArch !== entry.nodeArch) {
    fail(
      `Runner architecture mismatch for ${platform}-${arch}: expected ${entry.nodePlatform}/${entry.nodeArch}, received ${actualPlatform}/${actualArch}.`,
    );
  }
  return true;
}

function runGit(arguments_, { allowFailure = false, ...options } = {}) {
  const result = spawnSync("git", arguments_, {
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    fail(
      `git ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function fetchAllTags(remote) {
  runGit(["fetch", "--force", "--prune", remote, "+refs/tags/*:refs/tags/*"]);
}

function allTags() {
  return runGit(["tag", "--list"]).stdout.split(/\r?\n/).filter(Boolean);
}

function tagCommit(tag) {
  return runGit(["rev-list", "-n", "1", `refs/tags/${tag}`]).stdout.trim();
}

function existingYearTagForCommit(year, commit) {
  const pattern = new RegExp(`^${year}\\.(0|[1-9]\\d*)$`);
  const matches = allTags().filter(
    (tag) => pattern.test(tag) && tagCommit(tag) === commit,
  );
  if (matches.length > 1) {
    fail(`Commit ${commit} already has multiple ${year}.N release tags.`);
  }
  return matches[0];
}

export function reserveReleaseTag(commit, year, remote = "origin") {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail(
      `Release commit must be a full 40-character SHA; received "${commit}".`,
    );
  }
  if (!/^\d{2}$/.test(year)) {
    fail(`Release year must contain exactly two digits; received "${year}".`);
  }

  runGit(["cat-file", "-e", `${commit}^{commit}`]);
  fetchAllTags(remote);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const existing = existingYearTagForCommit(year, commit);
    if (existing) {
      return { tag: existing, created: false };
    }

    const candidate = nextReleaseTag(year, allTags());
    runGit(["tag", candidate, commit]);
    const push = runGit(
      ["push", remote, `refs/tags/${candidate}:refs/tags/${candidate}`],
      { allowFailure: true },
    );
    if (push.status === 0) {
      return { tag: candidate, created: true };
    }

    runGit(["tag", "--delete", candidate]);
    fetchAllTags(remote);

    if (!allTags().includes(candidate)) {
      fail(
        `Unable to reserve ${candidate}; no competing tag appeared. ${(
          push.stderr || push.stdout
        ).trim()}`,
      );
    }
    if (tagCommit(candidate) === commit) {
      return { tag: candidate, created: false };
    }
  }

  fail("Unable to reserve a release tag after 20 concurrent-tag retries.");
}

function usage() {
  return [
    "Usage:",
    "  release-contract.mjs matrix",
    "  release-contract.mjs next-tag <YY> [tags...]",
    "  release-contract.mjs verify-runner <platform> <arch>",
    "  release-contract.mjs stage <bundle-root> <platform> <arch> <output-dir>",
    "  release-contract.mjs validate <asset-dir>",
    "  release-contract.mjs validate-names",
    "  release-contract.mjs reserve-tag <commit-sha> [YY]",
  ].join("\n");
}

function main() {
  assertMatrixContract();
  const [command, ...arguments_] = process.argv.slice(2);

  switch (command) {
    case "matrix":
      console.log(`matrix=${JSON.stringify({ include: RELEASE_MATRIX })}`);
      break;
    case "next-tag": {
      const [year, ...tags] = arguments_;
      console.log(nextReleaseTag(year, tags));
      break;
    }
    case "verify-runner":
      verifyRunnerArchitecture(arguments_[0], arguments_[1]);
      console.log(`Runner matches ${arguments_[0]}-${arguments_[1]}.`);
      break;
    case "stage": {
      const result = stageNativeAsset(
        arguments_[0],
        arguments_[1],
        arguments_[2],
        arguments_[3],
      );
      console.log(
        `Staged ${basename(result.source)} as ${basename(result.asset)} with SHA-256 checksum.`,
      );
      break;
    }
    case "validate":
      validateReleaseAssets(arguments_[0]);
      console.log("All six native assets and checksums are present and valid.");
      break;
    case "validate-names": {
      const names = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
      validateAssetNames(names);
      console.log("Published release asset names match the contract.");
      break;
    }
    case "reserve-tag": {
      const commit = arguments_[0];
      const year =
        arguments_[1] ??
        String(new Date().getUTCFullYear()).slice(-2).padStart(2, "0");
      const result = reserveReleaseTag(commit, year);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `tag=${result.tag}\ncreated=${result.created}\n`,
        );
      }
      console.log(
        `${result.created ? "Reserved" : "Reusing"} release tag ${result.tag} for ${commit}.`,
      );
      break;
    }
    default:
      fail(usage());
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message);
    process.exitCode = 1;
  }
}
