import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RELEASE_MATRIX,
  assertMatrixContract,
  expectedAssetNames,
  nextReleaseTag,
  stageNativeAsset,
  validateAssetNames,
  validateReleaseAssets,
  verifyRunnerArchitecture,
} from "./release-contract.mjs";

const RELEASE_CONTRACT_SCRIPT = fileURLToPath(
  new URL("./release-contract.mjs", import.meta.url),
);
const AUTOPUBLISH_WORKFLOW = readFileSync(
  new URL("../workflows/autopublish.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

function workflowStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = AUTOPUBLISH_WORKFLOW.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = AUTOPUBLISH_WORKFLOW.indexOf(
    "\n      - name: ",
    start + marker.length,
  );
  return AUTOPUBLISH_WORKFLOW.slice(start, next === -1 ? undefined : next);
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
      "25.99",
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
    const output = join(root, "output");
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

test("aggregate validation fails on missing assets and verifies all checksums", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-assets-"));
  try {
    for (const { asset } of RELEASE_MATRIX) {
      const contents = `native-${asset}`;
      const hash = createHash("sha256").update(contents).digest("hex");
      writeFileSync(join(root, asset), contents);
      writeFileSync(join(root, `${asset}.sha256`), `${hash}  ${asset}\n`);
    }

    assert.equal(validateReleaseAssets(root), true);
    assert.equal(validateAssetNames(expectedAssetNames()), true);

    rmSync(join(root, "better-cloudflare-windows-arm64-setup.exe.sha256"));
    assert.throws(() => validateReleaseAssets(root), /Missing:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
