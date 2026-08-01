#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { freemem, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

const DARWIN_VM_STAT_HEADER =
  /^Mach Virtual Memory Statistics:\s*\(page size of (\d+) bytes\)\.?\s*$/;
const DARWIN_VM_STAT_COUNTER_PATTERN =
  /^(Pages (?:free|inactive|speculative)):\s*(-?\d+)\s*\.?\s*$/;
const DARWIN_VM_STAT_REQUIRED_COUNTERS = Object.freeze([
  "Pages free",
  "Pages inactive",
  "Pages speculative",
]);
const DARWIN_VM_STAT_SAFE_PAGE_SIZES = Object.freeze([4096n, 16384n]);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

let runVmStatCommand = (command, args, options) =>
  spawnSync(command, args, options);

export function __setVmStatCommandRunner(invocation) {
  const previous = runVmStatCommand;
  if (typeof invocation !== "function") {
    fail("vm_stat command runner must be a function.");
  }
  runVmStatCommand = invocation;
  return previous;
}

function parseDarwinVmStatOutput(output) {
  const lines = String(output).replace(/\r/g, "").split("\n");
  let headerSeen = false;
  let pageSize;
  const counters = Object.create(null);

  for (const line of lines) {
    const header = DARWIN_VM_STAT_HEADER.exec(line.trim());
    if (header) {
      if (headerSeen) {
        fail("vm_stat output contains duplicate header lines.");
      }
      headerSeen = true;
      const size = BigInt(header[1]);
      if (!DARWIN_VM_STAT_SAFE_PAGE_SIZES.includes(size)) {
        fail(`vm_stat output has an unreasonable page size: ${size} bytes.`);
      }
      pageSize = size;
      continue;
    }

    const counter = DARWIN_VM_STAT_COUNTER_PATTERN.exec(line.trim());
    if (!counter) continue;
    const [, name, value] = counter;
    if (Object.prototype.hasOwnProperty.call(counters, name)) {
      fail(`vm_stat output contains duplicate ${name} line.`);
    }
    if (!/^\d+$/.test(value)) {
      fail(`vm_stat output ${name} must be a non-negative integer.`);
    }
    counters[name] = BigInt(value);
  }

  if (!headerSeen) {
    fail("vm_stat output is missing the page size header.");
  }
  for (const counter of DARWIN_VM_STAT_REQUIRED_COUNTERS) {
    if (!Object.prototype.hasOwnProperty.call(counters, counter)) {
      fail(`vm_stat output is missing required counter ${counter}.`);
    }
  }

  const totalPages =
    counters["Pages free"] +
    counters["Pages inactive"] +
    counters["Pages speculative"];
  if (totalPages > MAX_SAFE_INTEGER_BIGINT) {
    fail("vm_stat counter arithmetic overflow.");
  }
  const availableBytes = totalPages * pageSize;
  if (availableBytes > MAX_SAFE_INTEGER_BIGINT) {
    fail("vm_stat arithmetic overflow.");
  }
  return availableBytes;
}

function pathsFromRoot(path) {
  const paths = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) break;
  }
  return paths.reverse();
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function pathMetadata(path, label) {
  let metadata;
  for (const component of pathsFromRoot(path)) {
    metadata = lstatSync(component, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (!metadata) fail(`${label} is missing: ${component}.`);
    if (metadata.isSymbolicLink()) {
      fail(`${label} contains a link or reparse point: ${component}.`);
    }
  }
  return metadata;
}

function openedPathMetadata(file, path, label, expectedType) {
  const descriptor = fstatSync(file, { bigint: true });
  const pathname = pathMetadata(path, label);
  if (
    !pathname ||
    pathname.isSymbolicLink() ||
    !descriptor[expectedType]() ||
    !pathname[expectedType]() ||
    !sameIdentity(descriptor, pathname)
  ) {
    fail(`${label} pathname/descriptor identity mismatch: ${path}.`);
  }
  return descriptor;
}

function openRealDirectory(path, label) {
  const before = pathMetadata(path, label);
  let file;
  try {
    file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = openedPathMetadata(file, path, label, "isDirectory");
    if (!sameIdentity(before, metadata))
      fail(`${label} path identity changed.`);
    return { file, metadata };
  } catch (error) {
    if (file !== undefined) closeSync(file);
    throw error;
  }
}

function withRealDirectory(path, label, operation, finalPath = () => path) {
  const opened = openRealDirectory(path, label);
  try {
    const result = operation(opened.file);
    const after = openedPathMetadata(
      opened.file,
      finalPath(),
      label,
      "isDirectory",
    );
    if (!sameIdentity(after, opened.metadata)) {
      fail(`${label} path identity changed.`);
    }
    return result;
  } finally {
    closeSync(opened.file);
  }
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
  const requestedYear = parseReleaseTag(`${year}.0`)?.year;
  if (requestedYear !== year) {
    fail(`Release year must contain exactly two digits; received "${year}".`);
  }

  let maximum = 0;

  for (const rawTag of tags) {
    const parsed = parseReleaseTag(rawTag);
    if (!parsed || parsed.year !== year) {
      continue;
    }
    maximum = Math.max(maximum, releaseSequence(parsed));
  }

  if (maximum === Number.MAX_SAFE_INTEGER) {
    fail(`Release sequence cannot be incremented safely for year ${year}.`);
  }
  return `${year}.${maximum + 1}`;
}

function parseReleaseTag(rawTag) {
  if (typeof rawTag !== "string") return undefined;
  const tag = rawTag.startsWith("refs/tags/") ? rawTag.slice(10) : rawTag;
  const parts = tag.split(".");
  if (parts.length !== 2) return undefined;
  const [year, sequenceText] = parts;
  if (
    year.length !== 2 ||
    sequenceText.length === 0 ||
    (sequenceText.length > 1 && sequenceText[0] === "0")
  ) {
    return undefined;
  }
  for (const character of year + sequenceText) {
    if (character < "0" || character > "9") return undefined;
  }
  return { tag, year, sequenceText };
}

function releaseSequence({ tag, sequenceText }) {
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) {
    fail(`Release sequence is outside the safe integer range: ${tag}.`);
  }
  return sequence;
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
    if (entry.isSymbolicLink()) {
      continue;
    }
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

function withReleaseFile(
  path,
  { label, minimumBytes = 1, maximumBytes = MAX_RELEASE_ASSET_BYTES },
  operation,
) {
  const before = pathMetadata(path, label);
  if (!before?.isFile()) {
    fail(`${label} is missing or not a regular file: ${basename(path)}.`);
  }
  let file;
  try {
    file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (!["ENOENT", "ELOOP"].includes(error?.code)) throw error;
    fail(`${label} path changed or is not a regular file: ${basename(path)}.`);
  }
  try {
    const metadata = fstatSync(file, { bigint: true });
    if (!metadata.isFile() || !sameIdentity(before, metadata)) {
      fail(`${label} path changed while opening: ${basename(path)}.`);
    }
    if (metadata.size < BigInt(minimumBytes)) {
      fail(`${label} is empty or too small: ${basename(path)}.`);
    }
    if (metadata.size > BigInt(maximumBytes)) {
      fail(`${label} exceeds ${maximumBytes} bytes: ${basename(path)}.`);
    }
    const result = operation(file, Number(metadata.size));
    const after = openedPathMetadata(file, path, label, "isFile");
    if (after.size !== metadata.size || after.ctimeNs !== metadata.ctimeNs) {
      fail(`${label} changed while it was being read: ${basename(path)}.`);
    }
    return result;
  } finally {
    closeSync(file);
  }
}

function readExact(file, path, size, at = 0) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = readSync(file, buffer, read, size - read, at + read);
    if (count === 0) {
      fail(`File changed or is truncated: ${basename(path)}.`);
    }
    read += count;
  }
  return buffer;
}

function sha256(file, size, path) {
  const hash = createHash("sha256");
  for (let position = 0; position < size; position += 1024 * 1024) {
    hash.update(
      readExact(file, path, Math.min(1024 * 1024, size - position), position),
    );
  }
  return hash.digest("hex");
}

function readChecksum(path) {
  return withReleaseFile(
    path,
    { label: "Checksum file", maximumBytes: MAX_CHECKSUM_BYTES },
    (file, size) => readExact(file, path, size).toString("utf8").trimEnd(),
  );
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

function withNewFile(destination, label, operation) {
  const parent = pathMetadata(dirname(destination), label);
  let file;
  try {
    file = openSync(
      destination,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
      0o666,
    );
    openedPathMetadata(file, destination, label, "isFile");
    if (!sameIdentity(parent, pathMetadata(dirname(destination), label))) {
      fail(`${label} parent path identity changed.`);
    }
    const result = operation(file);
    const metadata = openedPathMetadata(file, destination, label, "isFile");
    closeSync(file);
    file = undefined;
    return { ...result, metadata };
  } catch (error) {
    if (file !== undefined) {
      const metadata = fstatSync(file, { bigint: true });
      closeSync(file);
      const pathname = lstatSync(destination, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (pathname && sameIdentity(metadata, pathname)) {
        rmSync(destination, { force: true });
      }
    }
    throw error;
  }
}

function copyOpenedFile(file, size, source, destination) {
  return withNewFile(destination, "Staged release file", (out) => {
    const hash = createHash("sha256");
    for (let position = 0; position < size; position += 1024 * 1024) {
      const buffer = readExact(
        file,
        source,
        Math.min(1024 * 1024, size - position),
        position,
      );
      let offset = 0;
      hash.update(buffer);
      while (offset < buffer.length) {
        const count = writeSync(out, buffer, offset, buffer.length - offset);
        if (!count) fail(`Copy stalled: ${basename(destination)}.`);
        offset += count;
      }
    }
    if (fstatSync(file).size !== size) {
      fail(`File size changed while copying: ${basename(source)}.`);
    }
    const sourceDigest = hash.digest("hex");
    const output = fstatSync(out, { bigint: true });
    if (output.size !== BigInt(size)) {
      fail(`Copied file has an unexpected size: ${basename(destination)}.`);
    }
    const outputDigest = sha256(out, size, destination);
    if (outputDigest !== sourceDigest) {
      fail(`Copied bytes differ from source: ${basename(source)}.`);
    }
    return { digest: outputDigest };
  });
}

function writeOpenedFile(destination, contents) {
  const data = Buffer.from(contents);
  return withNewFile(destination, "Staged checksum file", (file) => {
    for (let offset = 0; offset < data.length; ) {
      const count = writeSync(file, data, offset, data.length - offset);
      if (!count) fail(`Write stalled: ${basename(destination)}.`);
      offset += count;
    }
    const metadata = fstatSync(file, { bigint: true });
    if (
      metadata.size !== BigInt(data.length) ||
      !readExact(file, destination, data.length).equals(data)
    ) {
      fail("Staged checksum bytes differ from its descriptor.");
    }
    const digest = createHash("sha256").update(data).digest("hex");
    return { digest };
  });
}

function verifyTrackedFile(path, expected) {
  pathMetadata(path, "Staged release file");
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = openedPathMetadata(
      file,
      path,
      "Staged release file",
      "isFile",
    );
    if (
      !sameIdentity(metadata, expected.metadata) ||
      metadata.size !== expected.metadata.size ||
      sha256(file, Number(metadata.size), path) !== expected.digest
    ) {
      fail(`Staged release file identity or bytes changed: ${path}.`);
    }
  } finally {
    closeSync(file);
  }
}

// Node has no openat/renameat: verify identities around the same-parent atomic
// rename, but callers must still protect paths from swaps after this returns.
function publishOutputDirectory(outputDirectory, label, operation) {
  const destination = resolve(outputDirectory);
  const paths = pathsFromRoot(destination);
  let missing = paths.length;
  for (let index = 0; index < paths.length; index += 1) {
    const metadata = lstatSync(paths[index], { throwIfNoEntry: false });
    if (!metadata) {
      missing = index;
      break;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(`${label} contains a link or reparse point: ${paths[index]}.`);
    }
  }
  if (missing === paths.length) fail(`${label} must not already exist.`);
  const publishTarget = paths[missing];
  const parent = dirname(publishTarget);
  let stage;
  let stageMetadata;
  let published = false;
  const stagedFiles = [];
  try {
    return withRealDirectory(parent, label, () => {
      stage = mkdtempSync(join(parent, `.${basename(publishTarget)}.staging-`));
      stageMetadata = lstatSync(stage, { bigint: true });
      const work = join(stage, relative(publishTarget, destination));
      if (work !== stage) mkdirSync(work, { recursive: true });
      let currentStage = stage;
      return withRealDirectory(
        stage,
        "Private staging directory",
        () => {
          const track = (opened, path) => stagedFiles.push({ ...opened, path });
          const result = operation(work, track);
          for (const opened of stagedFiles) {
            verifyTrackedFile(opened.path, opened);
          }
          if (lstatSync(publishTarget, { throwIfNoEntry: false })) {
            fail(`${label} appeared before publication: ${publishTarget}.`);
          }
          renameSync(stage, publishTarget);
          published = true;
          currentStage = publishTarget;
          for (const opened of stagedFiles) {
            const finalPath = join(destination, relative(work, opened.path));
            verifyTrackedFile(finalPath, opened);
          }
          return result;
        },
        () => currentStage,
      );
    });
  } catch (error) {
    const cleanup = published ? publishTarget : stage;
    const cleanupMetadata = cleanup
      ? lstatSync(cleanup, { bigint: true, throwIfNoEntry: false })
      : undefined;
    if (
      stageMetadata &&
      cleanupMetadata &&
      sameIdentity(cleanupMetadata, stageMetadata)
    ) {
      rmSync(cleanup, { recursive: true, force: true });
    }
    throw error;
  }
}

export function detectExecutableArchitecture(path) {
  const executable = resolve(path);
  return withReleaseFile(
    executable,
    { label: "Executable", minimumBytes: 8 },
    (file, size) => {
      const header = readExact(file, executable, Math.min(64, size));

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
        const arch =
          machine === 62 ? "x64" : machine === 183 ? "arm64" : undefined;
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
        const peHeader = readExact(file, executable, 6, peOffset);
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
          fail(
            `Unsupported PE machine 0x${machine.toString(16)}: ${executable}.`,
          );
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
          magic === "cffaedfe"
            ? header.readUInt32LE(4)
            : header.readUInt32BE(4);
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
    },
  );
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

  const destinationDirectory = resolve(outputDirectory);
  let source;
  withRealDirectory(root, "Tauri bundle directory", () => {
    const candidates = filesRecursively(root).filter((path) =>
      path.endsWith(entry.sourceSuffix),
    );
    if (candidates.length !== 1) {
      fail(
        `Expected exactly one non-empty ${entry.sourceSuffix} bundle for ${platform}-${arch}; found ${candidates.length}.`,
      );
    }
    source = candidates[0];
    publishOutputDirectory(
      destinationDirectory,
      "Release output directory",
      (stage, track) =>
        withReleaseFile(source, { label: "Release asset" }, (file, size) => {
          const destination = join(stage, entry.asset);
          const copied = copyOpenedFile(file, size, source, destination);
          track(copied, destination);
          const checksumPath = `${destination}.sha256`;
          track(
            writeOpenedFile(checksumPath, `${copied.digest}  ${entry.asset}\n`),
            checksumPath,
          );
        }),
    );
  });

  return {
    asset: join(destinationDirectory, entry.asset),
    checksum: join(destinationDirectory, `${entry.asset}.sha256`),
    source,
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
  return withRealDirectory(root, "Release asset directory", () => {
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
      withReleaseFile(assetPath, { label: "Release asset" }, (file, size) => {
        const expectedChecksum = `${sha256(file, size, assetPath)}  ${asset}`;
        const actualChecksum = readChecksum(`${assetPath}.sha256`);
        if (actualChecksum !== expectedChecksum) {
          fail(`SHA-256 checksum does not match ${asset}.`);
        }
      });
    }

    return true;
  });
}

export function aggregateNativeArtifacts(
  artifactRoot,
  outputDirectory,
  matrix = RELEASE_MATRIX,
) {
  assertMatrixContract(matrix);
  const root = resolve(artifactRoot);
  const destination = resolve(outputDirectory);
  withRealDirectory(root, "Native artifact root", () => {
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
      fail(
        `Native artifact directory contract failed. Missing: ${expectedDirectories.filter((name) => !actualDirectories.includes(name)).join(", ") || "none"}. Unexpected: ${actualDirectories.filter((name) => !expectedDirectories.includes(name)).join(", ") || "none"}.`,
      );
    }

    publishOutputDirectory(
      destination,
      "Aggregate release directory",
      (stage, track) => {
        for (const entry of matrix) {
          const platformDirectory = join(
            root,
            `native-${entry.platform}-${entry.arch}`,
          );
          const expected = [entry.asset, `${entry.asset}.sha256`].sort();
          const platformEntries = withRealDirectory(
            platformDirectory,
            "Platform artifact directory",
            () => readdirSync(platformDirectory, { withFileTypes: true }),
          );
          if (platformEntries.some((candidate) => !candidate.isFile())) {
            fail(
              `Artifact directory native-${entry.platform}-${entry.arch} must contain files only.`,
            );
          }
          const actual = platformEntries
            .map((candidate) => candidate.name)
            .sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            fail(
              `Artifact directory native-${entry.platform}-${entry.arch} must contain only ${expected.join(" and ")}.`,
            );
          }

          const assetPath = join(platformDirectory, entry.asset);
          const checksumPath = join(platformDirectory, `${entry.asset}.sha256`);
          withReleaseFile(assetPath, { label: "Release asset" }, (file, size) =>
            withReleaseFile(
              checksumPath,
              { label: "Checksum file", maximumBytes: MAX_CHECKSUM_BYTES },
              (checksumFile, checksumSize) => {
                const actualChecksum = readExact(
                  checksumFile,
                  checksumPath,
                  checksumSize,
                )
                  .toString("utf8")
                  .trimEnd();
                const copiedPath = join(stage, entry.asset);
                const copied = copyOpenedFile(
                  file,
                  size,
                  assetPath,
                  copiedPath,
                );
                track(copied, copiedPath);
                if (actualChecksum !== `${copied.digest}  ${entry.asset}`) {
                  fail(
                    `SHA-256 checksum does not match ${entry.asset} in its platform artifact.`,
                  );
                }
                const stagedChecksum = `${copiedPath}.sha256`;
                track(
                  writeOpenedFile(
                    stagedChecksum,
                    `${copied.digest}  ${entry.asset}\n`,
                  ),
                  stagedChecksum,
                );
              },
            ),
          );
        }
      },
    );
  });

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

export function assertReleaseTagTarget(tag, commit, remote = "origin") {
  if (parseReleaseTag(tag)?.tag !== tag) {
    fail(`Release tag is invalid: "${tag}".`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail(
      `Release commit must be a full 40-character SHA; received "${commit}".`,
    );
  }
  const actual = remoteReferenceCommit(remote, `refs/tags/${tag}`);
  if (actual.toLowerCase() !== commit.toLowerCase()) {
    fail(
      `Remote release tag ${tag} targets ${actual || "nothing"}, expected ${commit}.`,
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
  if (parseReleaseTag(expectedTag)?.tag !== expectedTag) {
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
  // GitHub documents target_commitish as a tag-creation hint. It is unused
  // when the tag already exists, as it does after our atomic reservation, and
  // the API can therefore retain the default branch name. The pushed tag is
  // the authoritative release target and is verified separately.
  if (
    typeof metadata.targetCommitish !== "string" ||
    ![expectedCommit.toLowerCase(), "main"].includes(
      metadata.targetCommitish.toLowerCase(),
    )
  ) {
    fail(
      `Release metadata target is ${String(metadata.targetCommitish)}, expected ${expectedCommit} or main for an existing verified tag.`,
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
  const matches = allTags().filter(
    (tag) => parseReleaseTag(tag)?.year === year && tagCommit(tag) === commit,
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
  if (parseReleaseTag(`${year}.0`)?.year !== year) {
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
  if (parseReleaseTag(tag)?.tag !== tag) {
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
    const localTarget = tagCommit(tag);
    if (localTarget.toLowerCase() !== commit.toLowerCase()) {
      fail(
        `Refusing to clean local release tag ${tag}: target ${localTarget} does not match ${commit}.`,
      );
    }
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
  platform = process.platform,
) {
  for (const [label, value] of [
    ["minimum free memory", minimumFreeMemoryMiB],
    ["minimum free disk", minimumFreeDiskMiB],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${label} must be a non-negative integer MiB value.`);
    }
  }
  let freeMemoryBytes = currentFreeMemoryBytes;
  if (platform === "darwin") {
    const vmStatResult = runVmStatCommand("vm_stat", [], {
      encoding: "utf8",
      shell: false,
    });
    if (vmStatResult.error) {
      fail(
        `vm_stat command execution failed: ${vmStatResult.error.message || vmStatResult.error}.`,
      );
    }
    if (typeof vmStatResult.status !== "number" || vmStatResult.status !== 0) {
      fail(
        `vm_stat command failed: ${(vmStatResult.stderr || vmStatResult.stdout || "").trim() || "unknown error"}.`,
      );
    }
    freeMemoryBytes = Number(
      parseDarwinVmStatOutput(vmStatResult.stdout || vmStatResult.output),
    );
  }
  const freeMemoryMiB = Math.floor(freeMemoryBytes / 1024 / 1024);
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
