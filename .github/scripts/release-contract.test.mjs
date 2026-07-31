import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RELEASE_MATRIX,
  aggregateNativeArtifacts,
  assertReleaseCommitIsCurrentMain,
  assertMatrixContract,
  assertResourceHeadroom,
  expectedAssetNames,
  nextReleaseTag,
  stageNativeAsset,
  validateAssetNames,
  validateReleaseMetadata,
  validateReleaseAssets,
  verifyExecutableArchitecture,
  verifyRunnerArchitecture,
} from "./release-contract.mjs";

const RELEASE_CONTRACT_SCRIPT = fileURLToPath(
  new URL("./release-contract.mjs", import.meta.url),
);
const BOUNDED_NODE_SCRIPT = fileURLToPath(
  new URL("./run-bounded-node.ps1", import.meta.url),
);
const AUTOPUBLISH_WORKFLOW = readFileSync(
  new URL("../workflows/autopublish.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const CI_WORKFLOW = readFileSync(
  new URL("../workflows/ci.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const PAGES_WORKFLOW = readFileSync(
  new URL("../workflows/pages.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const SECURITY_WORKFLOW = readFileSync(
  new URL("../workflows/security.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const SUPPORT_WORKFLOWS = ["format.yml", "lint.yml", "test-package.yml"]
  .map((name) =>
    readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8"),
  )
  .join("\n")
  .replaceAll("\r\n", "\n");

function workflowStep(name, workflow = AUTOPUBLISH_WORKFLOW) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    assert.fail(
      `${command} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function runFailure(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  assert.notEqual(
    result.status,
    0,
    `${command} ${arguments_.join(" ")} unexpectedly succeeded`,
  );
  return `${result.stderr}\n${result.stdout}`;
}

function withPatchedFs(name, replacement, operation) {
  const original = fs[name];
  fs[name] = (...arguments_) => replacement(original, ...arguments_);
  syncBuiltinESMExports();
  try {
    return operation();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}

function writeReleaseAssets(root) {
  for (const { asset } of RELEASE_MATRIX) {
    const contents = `native-${asset}`;
    const hash = createHash("sha256").update(contents).digest("hex");
    writeFileSync(join(root, asset), contents);
    writeFileSync(join(root, `${asset}.sha256`), `${hash}  ${asset}\n`);
  }
}

function writeIsolatedArtifacts(root) {
  for (const { platform, arch, asset } of RELEASE_MATRIX) {
    const directory = join(root, `native-${platform}-${arch}`);
    mkdirSync(directory, { recursive: true });
    const contents = `native-${asset}`;
    const hash = createHash("sha256").update(contents).digest("hex");
    writeFileSync(join(directory, asset), contents);
    writeFileSync(join(directory, `${asset}.sha256`), `${hash}  ${asset}\n`);
  }
}

function writeExecutable(path, format, arch) {
  if (format === "elf") {
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
    writeFileSync(path, header);
    return;
  }
  if (format === "pe") {
    const header = Buffer.alloc(512);
    header.set([0x4d, 0x5a]);
    header.writeUInt32LE(128, 0x3c);
    header.set([0x50, 0x45, 0, 0], 128);
    header.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 132);
    writeFileSync(path, header);
    return;
  }
  if (format === "mach-o") {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(arch === "x64" ? 0x01000007 : 0x0100000c, 4);
    writeFileSync(path, header);
    return;
  }
  assert.fail(`Unsupported test executable format: ${format}`);
}

function assertOutputParentSwapRejected(linkType) {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-output-swap-"));
  try {
    const bundle = join(root, "bundle");
    const parent = join(root, "parent");
    const outside = join(root, "outside");
    const output = join(parent, "output");
    for (const path of [bundle, parent, outside]) mkdirSync(path);
    writeFileSync(
      join(bundle, "Better Cloudflare_0.0.0_amd64.AppImage"),
      "trusted",
    );
    const swapParent = (original, prefix, ...arguments_) => {
      renameSync(parent, join(root, "parked"));
      symlinkSync(outside, parent, linkType);
      return original(prefix, ...arguments_);
    };
    assert.throws(
      () =>
        withPatchedFs("mkdtempSync", swapParent, () =>
          stageNativeAsset(bundle, "linux", "x64", output),
        ),
      /link or reparse point|path identity changed/,
    );
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("release matrix contains the six required native runner/target pairs", () => {
  assert.equal(assertMatrixContract(), true);
  assert.deepEqual(
    RELEASE_MATRIX.map(
      ({ runner, platform, arch, target }) =>
        `${platform}-${arch}:${runner}:${target}`,
    ),
    [
      "linux-x64:ubuntu-24.04:x86_64-unknown-linux-gnu",
      "linux-arm64:ubuntu-24.04-arm:aarch64-unknown-linux-gnu",
      "macos-x64:macos-15-intel:x86_64-apple-darwin",
      "macos-arm64:macos-15:aarch64-apple-darwin",
      "windows-x64:windows-2025:x86_64-pc-windows-msvc",
      "windows-arm64:windows-11-arm:aarch64-pc-windows-msvc",
    ],
  );
});

test("release asset names are deterministic", () => {
  assert.deepEqual(
    RELEASE_MATRIX.map(({ asset }) => asset),
    [
      "better-cloudflare-linux-x64.AppImage",
      "better-cloudflare-linux-arm64.AppImage",
      "better-cloudflare-macos-x64.dmg",
      "better-cloudflare-macos-arm64.dmg",
      "better-cloudflare-windows-x64-setup.exe",
      "better-cloudflare-windows-arm64-setup.exe",
    ],
  );
  assert.equal(expectedAssetNames().length, 12);
});

test("next release tag is strict and incremental within the requested year", () => {
  assert.equal(nextReleaseTag("26", []), "26.1");
  assert.equal(
    nextReleaseTag("26", [
      "25.9007199254740992",
      "26.1",
      "refs/tags/26.2",
      "26.4",
      "26.04",
      "v26.20",
      "26.invalid",
    ]),
    "26.5",
  );
  assert.throws(() => nextReleaseTag("2026", []), /exactly two digits/);
  assert.throws(
    () => nextReleaseTag("26", [`26.${Number.MAX_SAFE_INTEGER}`]),
    /cannot be incremented safely/,
  );
});

test("release tags treat hostile CLI text as data", () => {
  const hostileTags = (
    "26.(a+)+$|26.[1-9]|26.４|２６.4|26.4 | 26.4|26.4\n26.99|" +
    "26.4.1|26.+4|26.-4|26.4e1"
  ).split("|");
  assert.equal(nextReleaseTag("26", ["26.4", ...hostileTags]), "26.5");
  assert.equal(
    run(process.execPath, [
      RELEASE_CONTRACT_SCRIPT,
      "next-tag",
      "26",
      "26.4",
      ...hostileTags,
    ]),
    "26.5",
  );
  for (const year of [".*", "2[", "\\d", "２６", "26\n", " 26"]) {
    assert.match(
      runFailure(process.execPath, [
        RELEASE_CONTRACT_SCRIPT,
        "next-tag",
        year,
        "26.4",
      ]),
      /exactly two digits/,
    );
  }
  assert.equal(
    readFileSync(RELEASE_CONTRACT_SCRIPT, "utf8").includes("new RegExp"),
    false,
  );
});

test("runner verification rejects a target that is only cross-compiled", () => {
  assert.equal(
    verifyRunnerArchitecture("linux", "arm64", "linux", "arm64"),
    true,
  );
  assert.throws(
    () => verifyRunnerArchitecture("linux", "arm64", "linux", "x64"),
    /Runner architecture mismatch/,
  );
});

test("executable inspection rejects a correctly named wrong architecture", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-binary-"));
  try {
    const fixtures = [
      ["linux", "x64", "elf"],
      ["linux", "arm64", "elf"],
      ["macos", "x64", "mach-o"],
      ["macos", "arm64", "mach-o"],
      ["windows", "x64", "pe"],
      ["windows", "arm64", "pe"],
    ];
    for (const [platform, arch, format] of fixtures) {
      const path = join(root, `${platform}-${arch}.bin`);
      writeExecutable(path, format, arch);
      assert.equal(verifyExecutableArchitecture(path, platform, arch), true);
      assert.throws(
        () =>
          verifyExecutableArchitecture(
            path,
            platform,
            arch === "x64" ? "arm64" : "x64",
          ),
        /architecture mismatch/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native staging uses the repository-root Cargo bundle directory", () => {
  const step = workflowStep("Stage deterministic native asset");
  assert.match(
    step,
    /^\s+target\/\$\{\{ matrix\.target \}\}\/release\/bundle$/m,
  );
  assert.doesNotMatch(AUTOPUBLISH_WORKFLOW, /src-tauri\/target/);
});

test("only Windows ARM64 disables dependency lifecycle scripts", () => {
  const standardInstall = workflowStep("Install JavaScript dependencies");
  assert.match(
    standardInstall,
    /^\s+if: matrix\.platform != 'windows' \|\| matrix\.arch != 'arm64'$/m,
  );
  assert.match(standardInstall, /^\s+run: npm ci --no-audit --no-fund$/m);
  assert.doesNotMatch(standardInstall, /ignore-scripts/);

  const windowsArmInstall = workflowStep(
    "Install JavaScript dependencies without lifecycle scripts (Windows ARM64)",
  );
  assert.match(
    windowsArmInstall,
    /^\s+if: matrix\.platform == 'windows' && matrix\.arch == 'arm64'$/m,
  );
  assert.match(
    windowsArmInstall,
    /^\s+run: npm ci --ignore-scripts --no-audit --no-fund$/m,
  );
  assert.equal(
    AUTOPUBLISH_WORKFLOW.match(/npm ci --ignore-scripts/g)?.length,
    1,
  );

  const nativeBuild = workflowStep("Build native Tauri bundle");
  assert.match(nativeBuild, /npm run tauri -- build/);
  assert.ok(
    AUTOPUBLISH_WORKFLOW.indexOf(windowsArmInstall) <
      AUTOPUBLISH_WORKFLOW.indexOf(nativeBuild),
  );
});

test("native staging renames one real bundle and writes its checksum", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-release-"));
  try {
    const bundleRoot = join(root, "bundle", "appimage");
    const output = join(root, "release-assets", "linux-x64");
    mkdirSync(bundleRoot, { recursive: true });
    const source = join(bundleRoot, "Better Cloudflare_0.0.0_amd64.AppImage");
    writeFileSync(source, "native-appimage");

    const result = stageNativeAsset(bundleRoot, "linux", "x64", output);
    assert.equal(
      readFileSync(result.asset, "utf8"),
      readFileSync(source, "utf8"),
    );
    const expectedHash = createHash("sha256")
      .update(readFileSync(source))
      .digest("hex");
    assert.equal(
      readFileSync(result.checksum, "utf8"),
      `${expectedHash}  better-cloudflare-linux-x64.AppImage\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native staging rejects an open-time parent junction swap", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-open-race-"));
  try {
    const bundle = join(root, "bundle");
    const outside = join(root, "outside");
    const out = join(root, "output");
    for (const path of [bundle, outside]) mkdirSync(path);
    const source = join(bundle, "Better Cloudflare_0.0.0_amd64.AppImage");
    writeFileSync(source, "trusted");
    writeFileSync(join(outside, basename(source)), "attacker");
    let swapped = false;
    const swapParent = (original, path, ...arguments_) => {
      if (!swapped && resolve(String(path)) === resolve(source)) {
        renameSync(bundle, join(root, "parked"));
        symlinkSync(
          outside,
          bundle,
          process.platform === "win32" ? "junction" : "dir",
        );
        swapped = true;
      }
      return original(path, ...arguments_);
    };
    const stage = () => stageNativeAsset(bundle, "linux", "x64", out);
    assert.throws(
      () => withPatchedFs("openSync", swapParent, stage),
      /path (identity )?changed/,
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects every copy and identity fault without leftovers", () => {
  const mutations =
    "copy checksum rename truncation growth zero-write " +
    "asset-identity checksum-identity byte-mismatch";
  for (const mutation of mutations.split(" ")) {
    const root = mkdtempSync(join(tmpdir(), `better-cloudflare-${mutation}-`));
    try {
      const bundle = join(root, "bundle");
      const out = join(root, "output");
      const source = join(bundle, "Better Cloudflare_0.0.0_amd64.AppImage");
      mkdirSync(bundle);
      writeFileSync(source, "trusted");
      let calls = 0;
      const inject = (original, ...arguments_) => {
        calls += 1;
        if (mutation === "rename") {
          throw new Error("injected publish failure");
        }
        if (mutation === "truncation") {
          if (calls === 1) fs.truncateSync(source, 0);
          return original(...arguments_);
        }
        if (
          (mutation === "copy" && calls === 1) ||
          (mutation === "checksum" && calls === 2)
        ) {
          throw new Error(`injected ${mutation} failure`);
        }
        if (mutation === "zero-write" && calls === 1) return 0;
        if (mutation === "byte-mismatch" && calls === 1) {
          const [file, , , length, position] = arguments_;
          return original(
            file,
            Buffer.alloc(length, 0x78),
            offset,
            length,
            position,
          );
        }
        const count = original(...arguments_);
        if (mutation === "growth" && calls === 1)
          fs.appendFileSync(source, "changed");
        const identityWrite =
          (mutation === "asset-identity" && calls === 1) ||
          (mutation === "checksum-identity" && calls === 2);
        if (identityWrite) {
          const stageName = readdirSync(root).find((name) =>
            name.startsWith(".output.staging-"),
          );
          const suffix = mutation === "asset-identity" ? "" : ".sha256";
          const name = `better-cloudflare-linux-x64.AppImage${suffix}`;
          const pathname = join(root, stageName, name);
          renameSync(pathname, `${pathname}.replaced`);
          writeFileSync(pathname, "attacker");
        }
        return count;
      };
      const stage = () => stageNativeAsset(bundle, "linux", "x64", out);
      const functionName =
        mutation === "rename"
          ? "renameSync"
          : mutation === "truncation"
            ? "readSync"
            : "writeSync";
      assert.throws(() => withPatchedFs(functionName, inject, stage));
      assert.equal(fs.existsSync(out), false);
      assert.equal(
        readdirSync(root).some((name) => name.startsWith(".output.staging-")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test(
  "Windows output-parent junction swap is rejected and cleaned",
  { skip: process.platform === "win32" ? false : "Windows junction test" },
  () => assertOutputParentSwapRejected("junction"),
);

test(
  "POSIX output-parent symlink swap is rejected and cleaned",
  { skip: process.platform === "win32" ? "POSIX symlink test" : false },
  () => assertOutputParentSwapRejected("dir"),
);

test("aggregate validation fails on missing assets and verifies all checksums", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-assets-"));
  try {
    writeReleaseAssets(root);

    assert.equal(validateReleaseAssets(root), true);
    assert.equal(validateAssetNames(expectedAssetNames()), true);

    rmSync(join(root, "better-cloudflare-windows-arm64-setup.exe.sha256"));
    assert.throws(() => validateReleaseAssets(root), /Missing:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release validation rejects a symlinked checksum", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-symlink-"));
  try {
    const assets = join(root, "assets");
    mkdirSync(assets);
    writeReleaseAssets(assets);
    const checksum = join(
      assets,
      "better-cloudflare-linux-x64.AppImage.sha256",
    );
    rmSync(checksum);
    if (process.platform === "win32") {
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "checksum"), "outside");
      symlinkSync(outside, checksum, "junction");
    } else {
      const outside = join(root, "outside.sha256");
      writeFileSync(outside, "outside");
      symlinkSync(outside, checksum, "file");
    }
    assert.throws(
      () => validateReleaseAssets(assets),
      /must contain files only/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correct release names with changed bytes are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-wrong-bytes-"));
  try {
    writeReleaseAssets(root);
    writeFileSync(
      join(root, "better-cloudflare-linux-x64.AppImage"),
      "substituted-binary",
    );
    assert.throws(
      () => validateReleaseAssets(root),
      /SHA-256 checksum does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("platform artifacts remain isolated and cross-platform injection is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-isolated-"));
  try {
    const artifacts = join(root, "artifacts");
    const output = join(root, "output");
    writeIsolatedArtifacts(artifacts);
    assert.equal(aggregateNativeArtifacts(artifacts, output), true);

    const injected = join(root, "injected");
    const rejectedOutput = join(root, "rejected-output");
    writeIsolatedArtifacts(injected);
    writeFileSync(
      join(
        injected,
        "native-linux-x64",
        "better-cloudflare-windows-x64-setup.exe",
      ),
      "cross-platform-injection",
    );
    assert.throws(
      () => aggregateNativeArtifacts(injected, rejectedOutput),
      /must contain only/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release metadata rejects a release that targets another commit", () => {
  const commit = "a".repeat(40);
  assert.equal(
    validateReleaseMetadata(
      {
        tagName: "26.7",
        targetCommitish: commit,
        isDraft: false,
      },
      "26.7",
      commit,
      "published",
    ),
    true,
  );
  assert.equal(
    validateReleaseMetadata(
      {
        tagName: "26.7",
        targetCommitish: "main",
        isDraft: false,
      },
      "26.7",
      commit,
      "published",
    ),
    true,
    "GitHub retains the default branch as target_commitish when the verified tag already exists",
  );
  assert.throws(
    () =>
      validateReleaseMetadata(
        {
          tagName: "26.7",
          targetCommitish: "b".repeat(40),
          isDraft: false,
        },
        "26.7",
        commit,
        "published",
      ),
    /metadata target/,
  );
});

test("reverse completion is rejected when main has advanced", () => {
  assert.equal(
    assertReleaseCommitIsCurrentMain("a".repeat(40), "a".repeat(40)),
    true,
  );
  assert.throws(
    () => assertReleaseCommitIsCurrentMain("a".repeat(40), "b".repeat(40)),
    /is stale/,
  );
});

test("runner diagnostics reject insufficient memory or disk deterministically", () => {
  const mib = 1024 * 1024;
  assert.deepEqual(
    assertResourceHeadroom(512, 1024, 1024 * mib, 2048 * mib, 2048 * mib),
    {
      freeMemoryMiB: 1024,
      totalMemoryMiB: 2048,
      freeDiskMiB: 2048,
    },
  );
  assert.throws(
    () => assertResourceHeadroom(1025, 1, 1024 * mib, 2048 * mib, 2048 * mib),
    /free memory/,
  );
  assert.throws(
    () => assertResourceHeadroom(1, 2049, 1024 * mib, 2048 * mib, 2048 * mib),
    /free disk/,
  );
});

test("tag reservation fetches history, increments, and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-tags-"));
  try {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    run("git", ["init", "--bare", remote], root);
    run("git", ["init", work], root);
    run("git", ["config", "user.name", "Release Contract Test"], work);
    run(
      "git",
      ["config", "user.email", "release-contract@example.invalid"],
      work,
    );
    run("git", ["commit", "--allow-empty", "-m", "first"], work);
    run("git", ["branch", "-M", "main"], work);
    run("git", ["remote", "add", "origin", remote], work);
    run("git", ["push", "-u", "origin", "main"], work);

    const firstCommit = run("git", ["rev-parse", "HEAD"], work);
    assert.match(
      run(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "reserve-tag", firstCommit, "26"],
        work,
      ),
      /Reserved release tag 26\.1/,
    );
    assert.match(
      run(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "reserve-tag", firstCommit, "26"],
        work,
      ),
      /Reusing release tag 26\.1/,
    );

    run("git", ["commit", "--allow-empty", "-m", "second"], work);
    run("git", ["push", "origin", "main"], work);
    const secondCommit = run("git", ["rev-parse", "HEAD"], work);
    assert.match(
      runFailure(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "reserve-tag", firstCommit, "26"],
        work,
      ),
      /is stale/,
    );
    assert.match(
      run(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "reserve-tag", secondCommit, "26"],
        work,
      ),
      /Reserved release tag 26\.2/,
    );
    assert.deepEqual(
      run("git", ["tag", "--list", "--sort=version:refname"], work).split(
        /\r?\n/,
      ),
      ["26.1", "26.2"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly reserved orphan tag can be safely recovered and reused", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-orphan-tag-"));
  try {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    run("git", ["init", "--bare", remote], root);
    run("git", ["init", work], root);
    run("git", ["config", "user.name", "Release Contract Test"], work);
    run(
      "git",
      ["config", "user.email", "release-contract@example.invalid"],
      work,
    );
    run("git", ["commit", "--allow-empty", "-m", "release"], work);
    run("git", ["branch", "-M", "main"], work);
    run("git", ["remote", "add", "origin", remote], work);
    run("git", ["push", "-u", "origin", "main"], work);
    const commit = run("git", ["rev-parse", "HEAD"], work);

    assert.match(
      run(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "reserve-tag", commit, "26"],
        work,
      ),
      /Reserved release tag 26\.1/,
    );
    assert.match(
      run(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "cleanup-tag", commit, "26.1", "true"],
        work,
      ),
      /Cleaned reserved release tag 26\.1/,
    );
    assert.equal(run("git", ["ls-remote", "--tags", "origin"], work), "");
    assert.match(
      run(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "reserve-tag", commit, "26"],
        work,
      ),
      /Reserved release tag 26\.1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote tag movement is detected even when the local tag is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-moved-tag-"));
  try {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    run("git", ["init", "--bare", remote], root);
    run("git", ["init", work], root);
    run("git", ["config", "user.name", "Release Contract Test"], work);
    run(
      "git",
      ["config", "user.email", "release-contract@example.invalid"],
      work,
    );
    run("git", ["commit", "--allow-empty", "-m", "release"], work);
    run("git", ["branch", "-M", "main"], work);
    run("git", ["remote", "add", "origin", remote], work);
    run("git", ["push", "-u", "origin", "main"], work);
    const releaseCommit = run("git", ["rev-parse", "HEAD"], work);
    run(
      process.execPath,
      [RELEASE_CONTRACT_SCRIPT, "reserve-tag", releaseCommit, "26"],
      work,
    );

    run("git", ["commit", "--allow-empty", "-m", "replacement"], work);
    const replacementCommit = run("git", ["rev-parse", "HEAD"], work);
    run(
      "git",
      ["push", "--force", "origin", `${replacementCommit}:refs/tags/26.1`],
      work,
    );

    assert.equal(
      run("git", ["rev-parse", "refs/tags/26.1"], work),
      releaseCommit,
    );
    assert.match(
      runFailure(
        process.execPath,
        [RELEASE_CONTRACT_SCRIPT, "verify-tag", "26.1", releaseCommit],
        work,
      ),
      /Remote release tag 26\.1 targets/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication is globally serialized and never merges or clobbers assets", () => {
  assert.match(
    AUTOPUBLISH_WORKFLOW,
    /group: native-release-publish-\$\{\{ github\.repository \}\}/,
  );
  assert.doesNotMatch(
    AUTOPUBLISH_WORKFLOW,
    /group: native-release-publish-[^\n]*inputs\.commit_sha/,
  );
  assert.match(AUTOPUBLISH_WORKFLOW, /merge-multiple: false/);
  assert.doesNotMatch(AUTOPUBLISH_WORKFLOW, /--clobber/);
  assert.match(
    AUTOPUBLISH_WORKFLOW,
    /release-contract\.mjs assert-main "\$RELEASE_SHA"/,
  );
  assert.match(
    AUTOPUBLISH_WORKFLOW,
    /release-contract\.mjs aggregate\s+release-artifacts release-assets/,
  );
  for (const requirement of [
    '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/autopublish.yml"',
    '--signer-digest "$RELEASE_SHA"',
    '--source-digest "$RELEASE_SHA"',
    '--source-ref "refs/heads/main"',
  ]) {
    assert.equal(
      AUTOPUBLISH_WORKFLOW.split(requirement).length - 1,
      2,
      `Every provenance verification must enforce ${requirement}`,
    );
  }
});

test("CI and release toolchains are exact rather than mutable channels", () => {
  const nodeWorkflows = [
    AUTOPUBLISH_WORKFLOW,
    CI_WORKFLOW,
    PAGES_WORKFLOW,
    SUPPORT_WORKFLOWS,
  ].join("\n");
  const setupCount = nodeWorkflows.match(/actions\/setup-node@/g)?.length ?? 0;
  const pinnedNodeCount =
    nodeWorkflows.match(/node-version: 24\.18\.1/g)?.length ?? 0;
  assert.equal(pinnedNodeCount, setupCount);
  assert.doesNotMatch(nodeWorkflows, /node-version:\s+\d+\.x/);
  assert.match(
    AUTOPUBLISH_WORKFLOW,
    /rustup toolchain install 1\.97\.1 --profile minimal/,
  );
  assert.match(
    CI_WORKFLOW,
    /rustup toolchain install 1\.97\.1 --profile minimal --component clippy/,
  );
  assert.doesNotMatch(
    `${AUTOPUBLISH_WORKFLOW}\n${CI_WORKFLOW}`,
    /rustup (?:toolchain install|default) stable/,
  );
});

test("Pages build has read-only contents and no standing administration token", () => {
  const buildStart = PAGES_WORKFLOW.indexOf("  build:");
  const deployStart = PAGES_WORKFLOW.indexOf("  deploy:");
  assert.notEqual(buildStart, -1);
  assert.notEqual(deployStart, -1);
  const build = PAGES_WORKFLOW.slice(buildStart, deployStart);
  const deploy = PAGES_WORKFLOW.slice(deployStart);
  assert.match(build, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(build, /pages: write|id-token: write/);
  assert.match(build, /persist-credentials: false/);
  assert.match(deploy, /pages: write/);
  assert.match(deploy, /id-token: write/);
  assert.doesNotMatch(PAGES_WORKFLOW, /PAGES_ADMIN_TOKEN|enablement:/);
});

test("security workflows pin external actions to immutable commits", () => {
  assert.match(SECURITY_WORKFLOW, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(
    SECURITY_WORKFLOW,
    /actions\/dependency-review-action@[0-9a-f]{40}/,
  );
  assert.match(
    `${SECURITY_WORKFLOW}\n${CI_WORKFLOW}`,
    /docker:\/\/ghcr\.io\/google\/osv-scanner-action@sha256:48406c58197201fe55e56615ad9d414f85063da320e204d0b0ed460fb3908dba/,
  );
  assert.doesNotMatch(
    `${SECURITY_WORKFLOW}\n${CI_WORKFLOW}`,
    /google\/osv-scanner-action\/osv-scanner-action@/,
  );

  const workflowRoot = fileURLToPath(new URL("../workflows", import.meta.url));
  for (const name of [
    "autopublish.yml",
    "ci.yml",
    "format.yml",
    "lint.yml",
    "pages.yml",
    "security.yml",
    "test-package.yml",
  ]) {
    const workflow = readFileSync(join(workflowRoot, name), "utf8");
    for (const match of workflow.matchAll(/uses:\s+([^\s#]+)/g)) {
      const reference = match[1];
      if (reference.startsWith("./")) {
        continue;
      }
      if (reference.startsWith("docker://")) {
        assert.match(
          reference,
          /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/,
          `${name} uses a mutable Docker action image: ${reference}`,
        );
        continue;
      }
      assert.match(
        reference,
        /@[0-9a-f]{40}$/,
        `${name} uses a mutable action reference: ${reference}`,
      );
    }
  }
});

test("Rust CodeQL analysis is preflight-gated with retained diagnostics", () => {
  const setup = workflowStep(
    "Install stable Rust with Clippy",
    SECURITY_WORKFLOW,
  );
  const preflight = workflowStep(
    "Check Rust workspace before analysis",
    SECURITY_WORKFLOW,
  );
  const proof = workflowStep(
    "Assert Rust preflight completion",
    SECURITY_WORKFLOW,
  );
  const analyze = workflowStep("Analyze", SECURITY_WORKFLOW);
  const upload = workflowStep(
    "Upload Rust scan diagnostics",
    SECURITY_WORKFLOW,
  );
  const rustAlways = /if: \$\{\{ matrix\.language == 'rust' && always\(\) \}\}/;

  assert.equal(SECURITY_WORKFLOW.match(/^\s+threads: 2$/gm)?.length, 2);
  assert.equal(SECURITY_WORKFLOW.match(/^\s+ram: 4096$/gm)?.length, 2);
  assert.match(
    SECURITY_WORKFLOW,
    /TAURI_CONFIG: '\{"build":\{"frontendDist":"\.\.\/app"\}\}'/,
  );
  assert.match(setup, /rustup toolchain install 1\.97\.1 --profile minimal/);
  assert.match(
    preflight,
    /cargo check --workspace --all-targets --locked --jobs 1/,
  );
  assert.match(
    preflight,
    /cargo check --workspace --all-targets --locked --jobs 1\s+2>&1\s*\|\s*tee "\$RUNNER_TEMP\/rust-codeql\/cargo-check\.log"/,
  );
  assert.match(preflight, /set -euo pipefail/);
  assert.doesNotMatch(preflight, /continue-on-error/);
  assert.ok(
    preflight.indexOf("cargo check") <
      preflight.indexOf("cargo-check.completed"),
  );
  assert.match(proof, rustAlways);
  assert.match(proof, /steps\.rust_preflight\.outcome \}\}" = "success"/);
  assert.match(proof, /cargo-check\.completed"\)" = "\$GITHUB_SHA"/);
  assert.ok(
    SECURITY_WORKFLOW.indexOf(preflight) < SECURITY_WORKFLOW.indexOf(proof),
  );
  assert.ok(
    SECURITY_WORKFLOW.indexOf(proof) < SECURITY_WORKFLOW.indexOf(analyze),
  );
  assert.match(analyze, /output: \$\{\{ runner\.temp \}\}\/codeql-results/);
  assert.match(
    upload,
    /uses:\s*actions\/upload-artifact@[0-9a-f]{40}(?:\s|#|$)/,
  );
  assert.match(upload, rustAlways);
  assert.match(upload, /\$\{\{ runner\.temp \}\}\/rust-codeql\//);
  assert.match(upload, /\$\{\{ runner\.temp \}\}\/codeql-results\/rust\.sarif/);
  assert.match(upload, /retention-days: 7/);
});

test("bounded Node watchdog retains peak accounting after fast exit", () => {
  const watchdog = readFileSync(BOUNDED_NODE_SCRIPT, "utf8");
  assert.match(watchdog, /PeakWorkingSet64/);
  assert.match(watchdog, /Root Node process exited with live descendants/);

  if (process.platform !== "win32") {
    return;
  }

  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-File",
      BOUNDED_NODE_SCRIPT,
      "-NodeArguments",
      "--version",
      "-HeapLimitMiB",
      "128",
      "-ProcessTreeLimitMiB",
      "256",
      "-TimeoutSeconds",
      "30",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const peak = /WATCHDOG_PEAK_MIB=([\d.]+)/.exec(result.stdout)?.[1];
  assert.ok(peak, `Watchdog omitted peak RSS:\n${result.stdout}`);
  assert.ok(
    Number(peak) > 0,
    `Watchdog reported a false zero peak:\n${result.stdout}`,
  );
  assert.ok(
    Number(peak) <= 256,
    `Watchdog exceeded its aggregate cap:\n${result.stdout}`,
  );
});
