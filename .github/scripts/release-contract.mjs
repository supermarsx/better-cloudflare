#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { freemem, totalmem } from "node:os";
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
      executable: "better-cloudflare",
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
      executable: "better-cloudflare",
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
      executable: "better-cloudflare",
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
      executable: "better-cloudflare",
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
      executable: "better-cloudflare.exe",
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
      executable: "better-cloudflare.exe",
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
const MAX_RELEASE_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 256;
const MAX_STDIN_BYTES = 64 * 1024;

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
      "executable",
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

function filesRecursively(directory, depth = 0, budget = { files: 0 }) {
  if (depth > 32) {
    fail(`Bundle directory nesting exceeds 32 levels: ${directory}.`);
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesRecursively(path, depth + 1, budget));
    } else if (entry.isFile()) {
      budget.files += 1;
      if (budget.files > 10_000) {
        fail("Bundle directory contains more than 10,000 files.");
      }
      files.push(path);
    }
  }
  return files;
}

function releaseAssetSize(path) {
  const size = statSync(path, { throwIfNoEntry: false })?.size;
  if (!size) {
    fail(`Release asset is missing or empty: ${basename(path)}.`);
  }
  if (size > MAX_RELEASE_ASSET_BYTES) {
    fail(
      `Release asset exceeds the 1 GiB contract: ${basename(path)} (${size} bytes).`,
    );
  }
  return size;
}

function sha256(path) {
  releaseAssetSize(path);
  const hash = createHash("sha256");
  const file = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const bytesRead = readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(file);
  }
  return hash.digest("hex");
}

function readChecksum(path) {
  const size = statSync(path, { throwIfNoEntry: false })?.size;
  if (!size || size > MAX_CHECKSUM_BYTES) {
    fail(
      `Checksum file must contain 1-${MAX_CHECKSUM_BYTES} bytes: ${basename(path)}.`,
    );
  }
  return readFileSync(path, "utf8").trimEnd();
}

function readStdinBounded(maximumBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let retainedBytes = 0;
  while (true) {
    const buffer = Buffer.alloc(Math.min(8192, maximumBytes + 1));
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    retainedBytes += bytesRead;
    if (retainedBytes > maximumBytes) {
      fail(`Standard input exceeds the ${maximumBytes}-byte contract.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, retainedBytes).toString("utf8");
}

function readExact(path, length, position = 0) {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(file, buffer, 0, length, position);
    if (bytesRead !== length) {
      fail(
        `Executable header is truncated at offset ${position}: ${basename(path)}.`,
      );
    }
    return buffer;
  } finally {
    closeSync(file);
  }
}

export function detectExecutableArchitecture(path) {
  const executable = resolve(path);
  const size = statSync(executable, { throwIfNoEntry: false })?.size;
  if (!size || size < 8) {
    fail(`Executable is missing or too small to inspect: ${executable}.`);
  }

  const header = readExact(executable, Math.min(64, size));

  if (
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46
  ) {
    if (header.length < 20 || header[4] !== 2) {
      fail(`Only 64-bit ELF executables are supported: ${executable}.`);
    }
    const machine =
      header[5] === 1
        ? header.readUInt16LE(18)
        : header[5] === 2
          ? header.readUInt16BE(18)
          : fail(`ELF byte order is invalid: ${executable}.`);
    const arch = machine === 62 ? "x64" : machine === 183 ? "arm64" : undefined;
    if (!arch) {
      fail(`Unsupported ELF machine ${machine}: ${executable}.`);
    }
    return { format: "elf", arch };
  }

  if (header[0] === 0x4d && header[1] === 0x5a) {
    if (header.length < 64) {
      fail(`PE DOS header is truncated: ${executable}.`);
    }
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset > 1024 * 1024 || peOffset + 6 > size) {
      fail(`PE header offset is invalid: ${executable}.`);
    }
    const peHeader = readExact(executable, 6, peOffset);
    if (
      peHeader[0] !== 0x50 ||
      peHeader[1] !== 0x45 ||
      peHeader[2] !== 0 ||
      peHeader[3] !== 0
    ) {
      fail(`PE signature is invalid: ${executable}.`);
    }
    const machine = peHeader.readUInt16LE(4);
    const arch =
      machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : undefined;
    if (!arch) {
      fail(`Unsupported PE machine 0x${machine.toString(16)}: ${executable}.`);
    }
    return { format: "pe", arch };
  }

  const magic = header.subarray(0, 4).toString("hex");
  if (magic === "cafebabe" || magic === "bebafeca") {
    fail(
      `Universal Mach-O binaries are not accepted for a single-architecture release: ${executable}.`,
    );
  }
  if (magic === "cffaedfe" || magic === "feedfacf") {
    const cpuType =
      magic === "cffaedfe" ? header.readUInt32LE(4) : header.readUInt32BE(4);
    const arch =
      cpuType === 0x01000007
        ? "x64"
        : cpuType === 0x0100000c
          ? "arm64"
          : undefined;
    if (!arch) {
      fail(
        `Unsupported Mach-O CPU type 0x${cpuType.toString(16)}: ${executable}.`,
      );
    }
    return { format: "mach-o", arch };
  }

  fail(`Executable format is not ELF, PE, or Mach-O: ${executable}.`);
}

export function verifyExecutableArchitecture(path, platform, arch) {
  const entry = matrixEntry(platform, arch);
  const detected = detectExecutableArchitecture(path);
  const expectedFormat =
    entry.platform === "linux"
      ? "elf"
      : entry.platform === "windows"
        ? "pe"
        : "mach-o";
  if (detected.format !== expectedFormat || detected.arch !== entry.arch) {
    fail(
      `Executable architecture mismatch for ${platform}-${arch}: expected ${expectedFormat}/${entry.arch}, received ${detected.format}/${detected.arch}.`,
    );
  }
  return true;
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
  releaseAssetSize(candidates[0]);
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
    releaseAssetSize(assetPath);

    const expectedChecksum = `${sha256(assetPath)}  ${asset}`;
    const actualChecksum = readChecksum(`${assetPath}.sha256`);
    if (actualChecksum !== expectedChecksum) {
      fail(`SHA-256 checksum does not match ${asset}.`);
    }
  }

  return true;
}

export function aggregateNativeArtifacts(
  artifactRoot,
  outputDirectory,
  matrix = RELEASE_MATRIX,
) {
  assertMatrixContract(matrix);
  const root = resolve(artifactRoot);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Native artifact root is missing: ${root}.`);
  }

  const expectedDirectories = matrix
    .map(({ platform, arch }) => `native-${platform}-${arch}`)
    .sort();
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory())) {
    fail("Native artifact root must contain platform directories only.");
  }
  const actualDirectories = entries.map((entry) => entry.name).sort();
  if (
    JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)
  ) {
    const missing = expectedDirectories.filter(
      (name) => !actualDirectories.includes(name),
    );
    const unexpected = actualDirectories.filter(
      (name) => !expectedDirectories.includes(name),
    );
    fail(
      `Native artifact directory contract failed. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }

  const destination = resolve(outputDirectory);
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length !== 0) {
    fail(`Aggregate release directory must be empty: ${destination}.`);
  }

  for (const entry of matrix) {
    const platformDirectory = join(
      root,
      `native-${entry.platform}-${entry.arch}`,
    );
    const expected = [entry.asset, `${entry.asset}.sha256`].sort();
    const platformEntries = readdirSync(platformDirectory, {
      withFileTypes: true,
    });
    if (platformEntries.some((candidate) => !candidate.isFile())) {
      fail(
        `Artifact directory native-${entry.platform}-${entry.arch} must contain files only.`,
      );
    }
    const actual = platformEntries.map((candidate) => candidate.name).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(
        `Artifact directory native-${entry.platform}-${entry.arch} must contain only ${expected.join(" and ")}.`,
      );
    }

    const assetPath = join(platformDirectory, entry.asset);
    releaseAssetSize(assetPath);
    const expectedChecksum = `${sha256(assetPath)}  ${entry.asset}`;
    const actualChecksum = readChecksum(
      join(platformDirectory, `${entry.asset}.sha256`),
    );
    if (actualChecksum !== expectedChecksum) {
      fail(
        `SHA-256 checksum does not match ${entry.asset} in its platform artifact.`,
      );
    }
    copyFileSync(
      assetPath,
      join(destination, entry.asset),
      constants.COPYFILE_EXCL,
    );
    copyFileSync(
      join(platformDirectory, `${entry.asset}.sha256`),
      join(destination, `${entry.asset}.sha256`),
      constants.COPYFILE_EXCL,
    );
  }

  return validateReleaseAssets(destination, matrix);
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

function remoteReferenceCommit(remote, reference) {
  const result = runGit(["ls-remote", "--exit-code", remote, reference]);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    fail(
      `Expected one ${reference} reference on ${remote}; found ${lines.length}.`,
    );
  }
  const [commit, returnedReference] = lines[0].split(/\s+/);
  if (
    returnedReference !== reference ||
    !/^[0-9a-f]{40}$/i.test(commit ?? "")
  ) {
    fail(`Remote ${reference} response is invalid for ${remote}.`);
  }
  return commit;
}

export function assertReleaseCommitIsCurrentMain(commit, currentMainCommit) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail(
      `Release commit must be a full 40-character SHA; received "${commit}".`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(currentMainCommit)) {
    fail(
      `Remote main commit must be a full 40-character SHA; received "${currentMainCommit}".`,
    );
  }
  if (commit.toLowerCase() !== currentMainCommit.toLowerCase()) {
    fail(
      `Release commit ${commit} is stale; current remote main is ${currentMainCommit}.`,
    );
  }
  return true;
}

export function assertRemoteMain(commit, remote = "origin") {
  return assertReleaseCommitIsCurrentMain(
    commit,
    remoteReferenceCommit(remote, "refs/heads/main"),
  );
}

export function assertReleaseTagTarget(tag, commit) {
  if (!/^\d{2}\.(0|[1-9]\d*)$/.test(tag)) {
    fail(`Release tag is invalid: "${tag}".`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail(
      `Release commit must be a full 40-character SHA; received "${commit}".`,
    );
  }
  const actual = tagCommit(tag);
  if (actual.toLowerCase() !== commit.toLowerCase()) {
    fail(
      `Release tag ${tag} targets ${actual || "nothing"}, expected ${commit}.`,
    );
  }
  return true;
}

export function validateReleaseMetadata(
  metadata,
  expectedTag,
  expectedCommit,
  expectedState,
) {
  if (!/^\d{2}\.(0|[1-9]\d*)$/.test(expectedTag)) {
    fail(`Release tag is invalid: "${expectedTag}".`);
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    fail(
      `Release commit must be a full 40-character SHA; received "${expectedCommit}".`,
    );
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("Release metadata must be a JSON object.");
  }
  if (metadata.tagName !== expectedTag) {
    fail(
      `Release metadata tag is ${String(metadata.tagName)}, expected ${expectedTag}.`,
    );
  }
  if (
    typeof metadata.targetCommitish !== "string" ||
    metadata.targetCommitish.toLowerCase() !== expectedCommit.toLowerCase()
  ) {
    fail(
      `Release metadata target is ${String(metadata.targetCommitish)}, expected ${expectedCommit}.`,
    );
  }
  const expectedDraft =
    expectedState === "draft"
      ? true
      : expectedState === "published"
        ? false
        : fail(`Release state must be "draft" or "published".`);
  if (metadata.isDraft !== expectedDraft) {
    fail(
      `Release ${expectedTag} draft state is ${String(metadata.isDraft)}, expected ${expectedDraft}.`,
    );
  }
  return true;
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
  assertRemoteMain(commit, remote);
  fetchAllTags(remote);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    assertRemoteMain(commit, remote);
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
      try {
        assertRemoteMain(commit, remote);
      } catch (error) {
        cleanupReservedTag(commit, candidate, true, remote);
        throw error;
      }
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

export function cleanupReservedTag(commit, tag, created, remote = "origin") {
  if (created !== true) {
    return false;
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail(
      `Release commit must be a full 40-character SHA; received "${commit}".`,
    );
  }
  if (!/^\d{2}\.(0|[1-9]\d*)$/.test(tag)) {
    fail(`Release tag is invalid: "${tag}".`);
  }

  const remoteTarget = remoteReferenceCommit(remote, `refs/tags/${tag}`);
  if (remoteTarget.toLowerCase() !== commit.toLowerCase()) {
    fail(
      `Refusing to clean release tag ${tag}: remote target ${remoteTarget} does not match ${commit}.`,
    );
  }
  const deletion = runGit(
    [
      "push",
      `--force-with-lease=refs/tags/${tag}:${commit}`,
      remote,
      `:refs/tags/${tag}`,
    ],
    { allowFailure: true },
  );
  if (deletion.status !== 0) {
    fail(
      `Unable to clean reserved release tag ${tag}: ${(deletion.stderr || deletion.stdout).trim()}`,
    );
  }

  const local = runGit(["show-ref", "--verify", `refs/tags/${tag}`], {
    allowFailure: true,
  });
  if (local.status === 0) {
    assertReleaseTagTarget(tag, commit);
    runGit(["tag", "--delete", tag]);
  }
  return true;
}

export function assertResourceHeadroom(
  minimumFreeMemoryMiB,
  minimumFreeDiskMiB,
  currentFreeMemoryBytes = freemem(),
  currentTotalMemoryBytes = totalmem(),
  currentFreeDiskBytes = (() => {
    const disk = statfsSync(process.cwd());
    return disk.bavail * disk.bsize;
  })(),
) {
  for (const [label, value] of [
    ["minimum free memory", minimumFreeMemoryMiB],
    ["minimum free disk", minimumFreeDiskMiB],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${label} must be a non-negative integer MiB value.`);
    }
  }
  const freeMemoryMiB = Math.floor(currentFreeMemoryBytes / 1024 / 1024);
  const totalMemoryMiB = Math.floor(currentTotalMemoryBytes / 1024 / 1024);
  const freeDiskMiB = Math.floor(currentFreeDiskBytes / 1024 / 1024);
  if (freeMemoryMiB < minimumFreeMemoryMiB) {
    fail(
      `Runner has ${freeMemoryMiB} MiB free memory; ${minimumFreeMemoryMiB} MiB is required.`,
    );
  }
  if (freeDiskMiB < minimumFreeDiskMiB) {
    fail(
      `Runner has ${freeDiskMiB} MiB free disk; ${minimumFreeDiskMiB} MiB is required.`,
    );
  }
  return { freeMemoryMiB, totalMemoryMiB, freeDiskMiB };
}

function usage() {
  return [
    "Usage:",
    "  release-contract.mjs matrix",
    "  release-contract.mjs next-tag <YY> [tags...]",
    "  release-contract.mjs verify-runner <platform> <arch>",
    "  release-contract.mjs verify-executable <path> <platform> <arch>",
    "  release-contract.mjs stage <bundle-root> <platform> <arch> <output-dir>",
    "  release-contract.mjs aggregate <artifact-root> <output-dir>",
    "  release-contract.mjs validate <asset-dir>",
    "  release-contract.mjs validate-names",
    "  release-contract.mjs assert-main <commit-sha>",
    "  release-contract.mjs verify-tag <tag> <commit-sha>",
    "  release-contract.mjs validate-release-json <tag> <commit-sha> <draft|published>",
    "  release-contract.mjs reserve-tag <commit-sha> [YY]",
    "  release-contract.mjs cleanup-tag <commit-sha> <tag> <true|false>",
    "  release-contract.mjs diagnostics <minimum-free-memory-MiB> <minimum-free-disk-MiB>",
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
    case "verify-executable":
      verifyExecutableArchitecture(arguments_[0], arguments_[1], arguments_[2]);
      console.log(
        `Executable matches ${arguments_[1]}-${arguments_[2]} architecture.`,
      );
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
    case "aggregate":
      aggregateNativeArtifacts(arguments_[0], arguments_[1]);
      console.log(
        "All six isolated platform artifacts were validated and aggregated.",
      );
      break;
    case "validate":
      validateReleaseAssets(arguments_[0]);
      console.log("All six native assets and checksums are present and valid.");
      break;
    case "validate-names": {
      const names = readStdinBounded().split(/\r?\n/).filter(Boolean);
      validateAssetNames(names);
      console.log("Published release asset names match the contract.");
      break;
    }
    case "assert-main":
      assertRemoteMain(arguments_[0]);
      console.log(`Release commit ${arguments_[0]} is current remote main.`);
      break;
    case "verify-tag":
      assertReleaseTagTarget(arguments_[0], arguments_[1]);
      console.log(`Release tag ${arguments_[0]} targets ${arguments_[1]}.`);
      break;
    case "validate-release-json": {
      const metadata = JSON.parse(readStdinBounded());
      validateReleaseMetadata(
        metadata,
        arguments_[0],
        arguments_[1],
        arguments_[2],
      );
      console.log(
        `Release ${arguments_[0]} metadata matches ${arguments_[1]}.`,
      );
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
    case "cleanup-tag": {
      const created =
        arguments_[2] === "true"
          ? true
          : arguments_[2] === "false"
            ? false
            : fail('Created flag must be "true" or "false".');
      const removed = cleanupReservedTag(arguments_[0], arguments_[1], created);
      console.log(
        removed
          ? `Cleaned reserved release tag ${arguments_[1]}.`
          : `Release tag ${arguments_[1]} was reused and was not removed.`,
      );
      break;
    }
    case "diagnostics": {
      const minimumFreeMemoryMiB = Number(arguments_[0]);
      const minimumFreeDiskMiB = Number(arguments_[1]);
      const result = assertResourceHeadroom(
        minimumFreeMemoryMiB,
        minimumFreeDiskMiB,
      );
      console.log(
        `Runner capacity: ${result.freeMemoryMiB} MiB free of ${result.totalMemoryMiB} MiB memory; ${result.freeDiskMiB} MiB free disk.`,
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
