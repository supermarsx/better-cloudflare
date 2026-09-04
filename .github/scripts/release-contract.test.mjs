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
  attestationSubjects,
  assertReleaseCommitIsCurrentMain,
  assertMatrixContract,
  assertResourceHeadroom,
  __setVmStatCommandRunner,
  expectedAssetNames,
  nextReleaseTag,
  stageNativeAsset,
  validateAssetNames,
  validateReleaseMetadata,
  validateReleaseAssets,
  verifyExecutableArchitecture,
  verifyRunnerArchitecture,
  versionedAssetName,
} from "./release-contract.mjs";

// A representative resolved tag. Published names are a pure function of the
// tag, so pinning the full 32-name set at one version is exactly as strict as
// the fixed list this contract used before names carried a version.
const RELEASE_VERSION = "26.11";

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

const DARWIN_VMSTAT_FIXTURES = {
  fourK: `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                256.
Pages inactive:                            128.
Pages speculative:                          64.
Pages purgeable:                            8.
Pages wired down:                           4.
`,
  sixteenK: `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                256.
Pages inactive:                             128.
Pages speculative:                          224.
`,
  tricky: `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                10
Pages inactive:                             9.
Pages speculative:                          8.
`,
};

function workflowStep(name, workflow = AUTOPUBLISH_WORKFLOW) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function withVmStatRunner(runner, operation) {
  const previous = __setVmStatCommandRunner(runner);
  try {
    return operation();
  } finally {
    __setVmStatCommandRunner(previous);
  }
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

// A published release directory: every name carries the resolved tag.
function writeReleaseAssets(root, version = RELEASE_VERSION) {
  for (const { outputs } of RELEASE_MATRIX) {
    for (const { asset } of outputs) {
      const published = versionedAssetName(asset, version);
      const contents = `native-${asset}`;
      const hash = createHash("sha256").update(contents).digest("hex");
      writeFileSync(join(root, published), contents);
      writeFileSync(
        join(root, `${published}.sha256`),
        `${hash}  ${published}\n`,
      );
    }
  }
}

// A per-pair build artifact, exactly as `stage` leaves it: base names, with no
// version, because the tag does not exist yet when the build jobs run.
function writeIsolatedArtifacts(root) {
  for (const { platform, arch, outputs } of RELEASE_MATRIX) {
    const directory = join(root, `native-${platform}-${arch}`);
    mkdirSync(directory, { recursive: true });
    for (const { asset } of outputs) {
      const contents = `native-${asset}`;
      const hash = createHash("sha256").update(contents).digest("hex");
      writeFileSync(join(directory, asset), contents);
      writeFileSync(join(directory, `${asset}.sha256`), `${hash}  ${asset}\n`);
    }
  }
}

const LINUX_X64 = RELEASE_MATRIX.find(
  ({ platform, arch }) => platform === "linux" && arch === "x64",
);

// linux-x64 publishes four bundles. A staging test that has to reach the copy
// stage must provide all of them, because discovery fails on the first
// missing suffix. Returns the written paths keyed by suffix.
function writeLinuxBundle(bundleRoot, contents = "trusted") {
  const written = new Map();
  for (const { suffix } of LINUX_X64.outputs) {
    const path = join(bundleRoot, `Better Cloudflare_0.0.0_amd64${suffix}`);
    writeFileSync(path, `${contents}${suffix}`);
    written.set(suffix, path);
  }
  return written;
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
    writeLinuxBundle(bundle);
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
    RELEASE_MATRIX.flatMap(({ outputs }) => outputs.map(({ asset }) => asset)),
    [
      "better-cloudflare-linux-x64.AppImage",
      "better-cloudflare-linux-x64.deb",
      "better-cloudflare-linux-x64.rpm",
      "better-cloudflare-linux-x64.flatpak",
      "better-cloudflare-linux-arm64.AppImage",
      "better-cloudflare-linux-arm64.deb",
      "better-cloudflare-linux-arm64.rpm",
      "better-cloudflare-linux-arm64.flatpak",
      "better-cloudflare-macos-x64.dmg",
      "better-cloudflare-macos-arm64.dmg",
      "better-cloudflare-windows-x64-setup.exe",
      "better-cloudflare-windows-x64.msi",
      "better-cloudflare-windows-x64-portable.exe",
      "better-cloudflare-windows-arm64-setup.exe",
      "better-cloudflare-windows-arm64.msi",
      "better-cloudflare-windows-arm64-portable.exe",
    ],
  );
  // 16 assets, each with a .sha256 sidecar.
  assert.equal(expectedAssetNames(RELEASE_VERSION).length, 32);
});

test("published asset names carry the resolved release tag", () => {
  // Pinned in full at a representative tag: a dropped asset, an extra one, a
  // reordering, or a misplaced version all fail here.
  assert.deepEqual(expectedAssetNames("26.11"), [
    "better-cloudflare-26.11-linux-x64.AppImage",
    "better-cloudflare-26.11-linux-x64.AppImage.sha256",
    "better-cloudflare-26.11-linux-x64.deb",
    "better-cloudflare-26.11-linux-x64.deb.sha256",
    "better-cloudflare-26.11-linux-x64.rpm",
    "better-cloudflare-26.11-linux-x64.rpm.sha256",
    "better-cloudflare-26.11-linux-x64.flatpak",
    "better-cloudflare-26.11-linux-x64.flatpak.sha256",
    "better-cloudflare-26.11-linux-arm64.AppImage",
    "better-cloudflare-26.11-linux-arm64.AppImage.sha256",
    "better-cloudflare-26.11-linux-arm64.deb",
    "better-cloudflare-26.11-linux-arm64.deb.sha256",
    "better-cloudflare-26.11-linux-arm64.rpm",
    "better-cloudflare-26.11-linux-arm64.rpm.sha256",
    "better-cloudflare-26.11-linux-arm64.flatpak",
    "better-cloudflare-26.11-linux-arm64.flatpak.sha256",
    "better-cloudflare-26.11-macos-x64.dmg",
    "better-cloudflare-26.11-macos-x64.dmg.sha256",
    "better-cloudflare-26.11-macos-arm64.dmg",
    "better-cloudflare-26.11-macos-arm64.dmg.sha256",
    "better-cloudflare-26.11-windows-x64-setup.exe",
    "better-cloudflare-26.11-windows-x64-setup.exe.sha256",
    "better-cloudflare-26.11-windows-x64.msi",
    "better-cloudflare-26.11-windows-x64.msi.sha256",
    "better-cloudflare-26.11-windows-x64-portable.exe",
    "better-cloudflare-26.11-windows-x64-portable.exe.sha256",
    "better-cloudflare-26.11-windows-arm64-setup.exe",
    "better-cloudflare-26.11-windows-arm64-setup.exe.sha256",
    "better-cloudflare-26.11-windows-arm64.msi",
    "better-cloudflare-26.11-windows-arm64.msi.sha256",
    "better-cloudflare-26.11-windows-arm64-portable.exe",
    "better-cloudflare-26.11-windows-arm64-portable.exe.sha256",
  ]);

  // A different tag moves every name and nothing else, so the set stays the
  // same size and no base name survives unversioned.
  const other = expectedAssetNames("09.1234");
  assert.equal(other.length, 32);
  assert.equal(new Set(other).size, 32);
  for (const name of other) {
    assert.ok(
      name.startsWith("better-cloudflare-09.1234-"),
      `${name} does not carry its release tag`,
    );
  }
  assert.equal(
    other.filter((name) => name.endsWith(".sha256")).length,
    16,
    "every published asset must keep exactly one checksum sidecar",
  );

  // Every base name in the matrix must appear, versioned, exactly once. This
  // is what keeps a new bundle target from being published unversioned.
  for (const { outputs } of RELEASE_MATRIX) {
    for (const { asset } of outputs) {
      const published = versionedAssetName(asset, "26.11");
      assert.ok(
        expectedAssetNames("26.11").includes(published),
        `${asset} is not published as ${published}`,
      );
      assert.equal(published.includes("26.11"), true);
    }
  }
});

test("asset naming rejects a version that is not a bare YY.N tag", () => {
  for (const version of [
    undefined,
    "",
    "26",
    "2026.1",
    "26.01",
    "v26.1",
    "refs/tags/26.1",
    "26.1.2",
    "../26.1",
    "26.1/../etc",
    "26.1\n26.2",
    "26.1 ",
    "２６.1",
    "26.-1",
    "26.1e1",
  ]) {
    assert.throws(
      () => expectedAssetNames(version),
      /bare YY\.N tag/,
      `version ${JSON.stringify(version)} must be rejected`,
    );
    assert.throws(
      () => versionedAssetName("better-cloudflare-linux-x64.deb", version),
      /bare YY\.N tag/,
    );
  }
  // A name the version cannot be spliced into is rejected rather than mangled.
  for (const asset of ["", "better-cloudflare-", "cloudflare-linux-x64.deb"]) {
    assert.throws(() => versionedAssetName(asset, "26.11"), /not versionable/);
  }
});

test("every platform builds the bundle targets its assets are staged from", () => {
  assert.deepEqual(
    RELEASE_MATRIX.map(
      ({ platform, arch, bundles, flatpak }) =>
        `${platform}-${arch}:${bundles}:${flatpak ? "flatpak" : "none"}`,
    ),
    [
      "linux-x64:appimage deb rpm:flatpak",
      "linux-arm64:appimage deb rpm:flatpak",
      "macos-x64:dmg:none",
      "macos-arm64:dmg:none",
      "windows-x64:nsis msi:none",
      "windows-arm64:nsis msi:none",
    ],
  );

  // Flatpak is not a Tauri bundler target, so it must never be requested from
  // the Tauri CLI; the workflow wraps the .deb instead.
  for (const { bundles } of RELEASE_MATRIX) {
    assert.doesNotMatch(bundles, /flatpak/);
  }

  // Every suffix-sourced asset must come from a bundle target that is built.
  const bundleForSuffix = {
    ".AppImage": "appimage",
    ".deb": "deb",
    ".rpm": "rpm",
    ".dmg": "dmg",
    "-setup.exe": "nsis",
    ".msi": "msi",
  };
  for (const { platform, arch, bundles, outputs } of RELEASE_MATRIX) {
    const built = bundles.split(" ");
    for (const { suffix, fromExecutable } of outputs) {
      if (fromExecutable || suffix === ".flatpak") continue;
      assert.ok(
        built.includes(bundleForSuffix[suffix]),
        `${platform}-${arch} stages ${suffix} without building it`,
      );
    }
  }
});

test("the portable Windows executable is staged from the unpackaged binary", () => {
  for (const entry of RELEASE_MATRIX) {
    const portable = entry.outputs.filter(
      ({ fromExecutable }) => fromExecutable,
    );
    assert.equal(
      portable.length,
      entry.platform === "windows" ? 1 : 0,
      `${entry.platform}-${entry.arch} portable output count`,
    );
    for (const output of portable) {
      assert.match(output.asset, /-portable\.exe$/);
      assert.equal(output.suffix, undefined);
    }
  }
});

test("staging a Windows pair requires the unpackaged executable path", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-portable-"));
  try {
    const bundle = join(root, "bundle");
    mkdirSync(bundle);
    assert.throws(
      () =>
        stageNativeAsset(
          bundle,
          "windows",
          "x64",
          join(root, "release-assets", "windows-x64"),
        ),
      /requires the path of the unpackaged executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Windows pair stages the installers and the portable executable", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-windows-"));
  try {
    const bundle = join(root, "bundle");
    const output = join(root, "release-assets", "windows-x64");
    mkdirSync(bundle);
    const setup = join(bundle, "Better Cloudflare_0.0.0_x64-setup.exe");
    const msi = join(bundle, "Better Cloudflare_0.0.0_x64_en-US.msi");
    const executable = join(root, "better-cloudflare.exe");
    writeFileSync(setup, "nsis-installer");
    writeFileSync(msi, "wix-installer");
    writeExecutable(executable, "pe", "x64");

    const results = stageNativeAsset(
      bundle,
      "windows",
      "x64",
      output,
      executable,
    );
    assert.deepEqual(
      results.map(({ asset }) => basename(asset)),
      [
        "better-cloudflare-windows-x64-setup.exe",
        "better-cloudflare-windows-x64.msi",
        "better-cloudflare-windows-x64-portable.exe",
      ],
    );
    // The portable asset must be the raw binary, not the NSIS installer.
    assert.deepEqual(readFileSync(results[2].asset), readFileSync(executable));
    assert.equal(
      readFileSync(results[0].asset, "utf8"),
      readFileSync(setup, "utf8"),
    );
    assert.deepEqual(readdirSync(output).sort(), [
      "better-cloudflare-windows-x64-portable.exe",
      "better-cloudflare-windows-x64-portable.exe.sha256",
      "better-cloudflare-windows-x64-setup.exe",
      "better-cloudflare-windows-x64-setup.exe.sha256",
      "better-cloudflare-windows-x64.msi",
      "better-cloudflare-windows-x64.msi.sha256",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const step = workflowStep("Stage deterministic native assets");
  assert.match(
    step,
    /^\s+target\/\$\{\{ matrix\.target \}\}\/release\/bundle$/m,
  );
  // The portable Windows asset is copied from the unpackaged binary, which
  // lives beside the bundle tree rather than inside it.
  assert.match(
    step,
    /^\s+target\/\$\{\{ matrix\.target \}\}\/release\/\$\{\{ matrix\.executable \}\}$/m,
  );
  assert.doesNotMatch(AUTOPUBLISH_WORKFLOW, /src-tauri\/target/);
});

test("the workflow builds every bundle target the matrix declares", () => {
  assert.match(
    workflowStep("Build native Tauri bundle"),
    /--bundles \$\{\{ matrix\.bundles \}\}/,
  );
  // A stale singular reference would silently build only one target.
  assert.doesNotMatch(AUTOPUBLISH_WORKFLOW, /matrix\.bundle \}\}/);
  assert.doesNotMatch(AUTOPUBLISH_WORKFLOW, /matrix\.asset \}\}/);
});

test("the deb and rpm declare the runtime libraries they need", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const linux = config.bundle?.linux ?? {};

  // Tauri writes no Depends/Requires at all when these are empty, which yields
  // packages that install on a minimal system and then fail to launch. That is
  // the whole point of shipping deb/rpm instead of only the AppImage: they rely
  // on the system WebKitGTK rather than carrying one.
  for (const format of ["deb", "rpm"]) {
    const depends = linux[format]?.depends ?? [];
    assert.ok(
      depends.length > 0,
      `bundle.linux.${format}.depends must not be empty`,
    );
    // The webview and TLS are what the binary cannot start without.
    assert.ok(
      depends.some((entry) => /webkit2gtk[-.]?4[._]1/.test(entry)),
      `bundle.linux.${format}.depends must require WebKitGTK 4.1`,
    );
    assert.ok(
      depends.some((entry) => /gtk-?3/.test(entry)),
      `bundle.linux.${format}.depends must require GTK 3`,
    );
    assert.ok(
      depends.some((entry) => /ssl/.test(entry)),
      `bundle.linux.${format}.depends must require OpenSSL (reqwest uses native-tls)`,
    );
  }

  // Debian and Ubuntu disagree on the t64 names, so those two entries have to
  // stay alternatives rather than a single hard-coded package.
  for (const entry of linux.deb.depends) {
    if (/gtk-?3|ssl/.test(entry)) {
      assert.match(entry, / \| /, `${entry} must offer a t64 alternative`);
    }
  }

  // The app configures no tray icon and enables no tray feature, so declaring
  // appindicator would force an unused dependency on every user.
  assert.equal(JSON.stringify(config).includes("trayIcon"), false);
  for (const format of ["deb", "rpm"]) {
    for (const entry of linux[format].depends) {
      assert.doesNotMatch(entry, /appindicator/);
    }
  }
});

test("Flatpak is built from the Debian package on Linux runners only", () => {
  const install = workflowStep("Install Flatpak tooling");
  const build = workflowStep("Build Flatpak bundle");
  for (const step of [install, build]) {
    assert.match(step, /^\s+if: matrix\.flatpak$/m);
  }
  assert.match(build, /flatpak-builder/);
  assert.match(build, /flatpak build-bundle/);
  // The bundle must land where the staging step's .flatpak suffix looks.
  assert.match(
    build,
    /\$BUNDLE_DIRECTORY\/flatpak\/better-cloudflare\.flatpak/,
  );

  const manifest = readFileSync(
    new URL("../flatpak/com.bettercloudflare.app.yml", import.meta.url),
    "utf8",
  );
  assert.match(manifest, /^id: com\.bettercloudflare\.app$/m);
  assert.match(manifest, /^command: better-cloudflare$/m);

  // The runtime the workflow installs and the one the manifest builds against
  // must not drift apart, or the build fails after a ~1 GB download.
  const manifestRuntime = /^runtime-version: '(\d+)'$/m.exec(manifest)?.[1];
  assert.ok(manifestRuntime, "manifest must pin a numeric runtime version");
  const installed = new RegExp(
    String.raw`org\.gnome\.Platform//(\d+) org\.gnome\.Sdk//(\d+)`,
  ).exec(install);
  assert.deepEqual(
    [installed?.[1], installed?.[2]],
    [manifestRuntime, manifestRuntime],
  );
  // GNOME runtimes are supported for roughly a year, so an old branch means an
  // unpatched WebKitGTK under an app that handles API tokens. 47 and 48 are
  // both already end-of-life.
  assert.ok(
    Number(manifestRuntime) >= 49,
    `GNOME runtime ${manifestRuntime} is end-of-life; pin a supported branch`,
  );
  // A DNS client with no network egress would be inert.
  assert.match(manifest, /--share=network/);
  // Building from the local .deb keeps the sandboxed build offline.
  assert.match(manifest, /path: better-cloudflare\.deb/);

  const flatpakPairs = RELEASE_MATRIX.filter(({ flatpak }) => flatpak).map(
    ({ platform, arch }) => `${platform}-${arch}`,
  );
  assert.deepEqual(flatpakPairs, ["linux-x64", "linux-arm64"]);
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
    const written = writeLinuxBundle(bundleRoot, "native");
    const source = written.get(".AppImage");

    const results = stageNativeAsset(bundleRoot, "linux", "x64", output);
    assert.deepEqual(
      results.map(({ asset }) => basename(asset)),
      [
        "better-cloudflare-linux-x64.AppImage",
        "better-cloudflare-linux-x64.deb",
        "better-cloudflare-linux-x64.rpm",
        "better-cloudflare-linux-x64.flatpak",
      ],
    );
    for (const result of results) {
      assert.equal(
        readFileSync(result.asset, "utf8"),
        readFileSync(result.source, "utf8"),
      );
      assert.equal(
        readFileSync(result.checksum, "utf8"),
        `${createHash("sha256").update(readFileSync(result.source)).digest("hex")}  ${basename(result.asset)}\n`,
      );
    }
    assert.equal(results[0].source, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "native staging tolerates a legitimate AppDir DirIcon symlink while selecting a real AppImage",
  { skip: process.platform === "win32" ? "POSIX symlink test" : false },
  () => {
    const root = mkdtempSync(join(tmpdir(), "better-cloudflare-diricon-"));
    try {
      const bundleRoot = join(root, "bundle", "appimage");
      const output = join(root, "release-assets", "linux-x64");
      const appDir = join(bundleRoot, "AppDir");
      const icon = join(root, "icon.png");
      const iconLink = join(appDir, ".DirIcon");
      mkdirSync(appDir, { recursive: true });
      writeFileSync(icon, "trusted-icon");
      symlinkSync(icon, iconLink);
      const source = writeLinuxBundle(bundleRoot, "trusted-appimage").get(
        ".AppImage",
      );

      const results = stageNativeAsset(bundleRoot, "linux", "x64", output);
      assert.equal(
        readFileSync(results[0].asset, "utf8"),
        readFileSync(source, "utf8"),
      );
      assert.equal(
        readFileSync(results[0].checksum, "utf8"),
        `${createHash("sha256").update(readFileSync(source)).digest("hex")}  better-cloudflare-linux-x64.AppImage\n`,
      );
      assert.equal(results[0].source, source);
      assert.equal(fs.lstatSync(iconLink).isSymbolicLink(), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "native staging skips symlinked directories so escaped targets are not read",
  { skip: process.platform === "win32" ? "POSIX symlink test" : false },
  () => {
    const root = mkdtempSync(
      join(tmpdir(), "better-cloudflare-escape-symlink-dir-"),
    );
    try {
      const bundleRoot = join(root, "bundle", "appimage");
      const output = join(root, "release-assets", "linux-x64");
      const outside = join(root, "outside");
      const escapedArtifact = join(
        outside,
        "Better Cloudflare_0.0.0_amd64.AppImage",
      );
      mkdirSync(bundleRoot, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(bundleRoot, "AppDir"), "dir");
      writeFileSync(escapedArtifact, "attacker");

      let openedEscapedArtifact = false;
      const stage = () =>
        withPatchedFs(
          "openSync",
          (original, path, ...arguments_) => {
            if (path === escapedArtifact) {
              openedEscapedArtifact = true;
            }
            return original(path, ...arguments_);
          },
          () => stageNativeAsset(bundleRoot, "linux", "x64", output),
        );
      assert.throws(stage, /Found: 0|found 0/);
      assert.equal(openedEscapedArtifact, false);
      assert.equal(fs.existsSync(output), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "native staging skips symlinked expected artifact names so they are never selected",
  { skip: process.platform === "win32" ? "POSIX symlink test" : false },
  () => {
    const root = mkdtempSync(
      join(tmpdir(), "better-cloudflare-expected-symlink-"),
    );
    try {
      const bundleRoot = join(root, "bundle", "appimage");
      const output = join(root, "release-assets", "linux-x64");
      const source = join(bundleRoot, "Better Cloudflare_0.0.0_amd64.AppImage");
      const linked = join(root, "outside-appimage");
      mkdirSync(bundleRoot, { recursive: true });
      mkdirSync(linked, { recursive: true });
      writeFileSync(join(linked, "payload"), "attacker-appimage");
      symlinkSync(join(linked, "payload"), source, "file");

      assert.throws(
        () => stageNativeAsset(bundleRoot, "linux", "x64", output),
        /Expected exactly one non-empty \.AppImage bundle for linux-x64; found 0\./,
      );
      assert.equal(fs.existsSync(output), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("native staging rejects an open-time parent junction swap", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-open-race-"));
  try {
    const bundle = join(root, "bundle");
    const outside = join(root, "outside");
    const out = join(root, "output");
    for (const path of [bundle, outside]) mkdirSync(path);
    const source = writeLinuxBundle(bundle).get(".AppImage");
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
      mkdirSync(bundle);
      // The AppImage is staged first, so the injected call indices below still
      // land on its copy (1) and its checksum (2).
      const source = writeLinuxBundle(bundle).get(".AppImage");
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

    assert.equal(validateReleaseAssets(root, RELEASE_VERSION), true);
    assert.equal(
      validateAssetNames(expectedAssetNames(RELEASE_VERSION), RELEASE_VERSION),
      true,
    );

    // A directory of correctly named assets for a different tag is a wrong
    // set, not a near miss.
    assert.throws(() => validateReleaseAssets(root, "26.12"), /Missing:/);

    rmSync(
      join(root, "better-cloudflare-26.11-windows-arm64-setup.exe.sha256"),
    );
    assert.throws(
      () => validateReleaseAssets(root, RELEASE_VERSION),
      /Missing:/,
    );
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
      "better-cloudflare-26.11-linux-x64.AppImage.sha256",
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
      () => validateReleaseAssets(assets, RELEASE_VERSION),
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
      join(root, "better-cloudflare-26.11-linux-x64.AppImage"),
      "substituted-binary",
    );
    assert.throws(
      () => validateReleaseAssets(root, RELEASE_VERSION),
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
    assert.equal(
      aggregateNativeArtifacts(artifacts, output, RELEASE_VERSION),
      true,
    );

    // Aggregation is where unversioned staged names become published ones, so
    // its output must be exactly the release contract for this tag, with each
    // sidecar naming the renamed file rather than the file it was copied from.
    assert.deepEqual(
      readdirSync(output).sort(),
      [...expectedAssetNames(RELEASE_VERSION)].sort(),
    );
    assert.equal(validateReleaseAssets(output, RELEASE_VERSION), true);
    for (const { outputs } of RELEASE_MATRIX) {
      for (const { asset } of outputs) {
        const published = versionedAssetName(asset, RELEASE_VERSION);
        const contents = `native-${asset}`;
        assert.equal(readFileSync(join(output, published), "utf8"), contents);
        assert.equal(
          readFileSync(join(output, `${published}.sha256`), "utf8"),
          `${createHash("sha256").update(contents).digest("hex")}  ${published}\n`,
        );
      }
    }

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
      () => aggregateNativeArtifacts(injected, rejectedOutput, RELEASE_VERSION),
      /must contain only/,
    );
    // Platform artifacts are produced before any tag exists, so aggregation
    // must keep reading base names rather than versioned ones. Renaming one
    // input to its published name is therefore a contract violation, not a
    // shortcut that quietly works.
    const versionedInput = join(root, "versioned-input");
    const versionedOutput = join(root, "versioned-output");
    writeIsolatedArtifacts(versionedInput);
    const macos = join(versionedInput, "native-macos-x64");
    renameSync(
      join(macos, "better-cloudflare-macos-x64.dmg"),
      join(macos, "better-cloudflare-26.11-macos-x64.dmg"),
    );
    assert.throws(
      () =>
        aggregateNativeArtifacts(
          versionedInput,
          versionedOutput,
          RELEASE_VERSION,
        ),
      /must contain only/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Release 26.12 failed at publish with `HTTP 404` from the attestations API
// for sha256:9fab9330..., which is the SHA-256 of the *republished* body
// "<digest>  better-cloudflare-26.12-linux-arm64.AppImage\n". Aggregation
// rewrites every sidecar to name the published file, so its bytes stop being
// the bytes the build job attested, and the publish job asked GitHub to
// verify an attestation that by construction cannot exist. Attestation
// verification only means anything while every subject it names is a file
// something actually signed, so that is what this pins.
test("every attestation subject is bytes the build job attested", () => {
  const root = mkdtempSync(join(tmpdir(), "better-cloudflare-attested-"));
  try {
    const artifacts = join(root, "artifacts");
    const output = join(root, "output");
    writeIsolatedArtifacts(artifacts);

    // `actions/attest` receives exactly the staged platform directories, so
    // these are the only digests that carry a build-provenance attestation.
    const attestedDigests = new Set();
    for (const directory of readdirSync(artifacts)) {
      for (const name of readdirSync(join(artifacts, directory))) {
        attestedDigests.add(
          createHash("sha256")
            .update(readFileSync(join(artifacts, directory, name)))
            .digest("hex"),
        );
      }
    }

    assert.equal(
      aggregateNativeArtifacts(artifacts, output, RELEASE_VERSION),
      true,
    );
    const { attested, derived } = attestationSubjects(
      artifacts,
      output,
      RELEASE_VERSION,
    );

    const published = expectedAssetNames(RELEASE_VERSION);
    const sidecars = published.filter((name) => name.endsWith(".sha256"));
    const binaries = published.filter((name) => !name.endsWith(".sha256"));

    // The regression itself: a subject whose bytes nobody signed is a 404
    // waiting to happen, and it only happens during a real release.
    for (const subject of attested) {
      assert.ok(
        attestedDigests.has(
          createHash("sha256").update(readFileSync(subject)).digest("hex"),
        ),
        `${basename(subject)} is offered for attestation verification but was never attested`,
      );
    }

    // Nothing may be quietly dropped from the attestation surface either.
    // Every published binary is verified where it now sits, and every
    // rewritten sidecar is verified as the staged bytes it came from.
    assert.equal(attested.length, published.length);
    assert.deepEqual(
      [...derived].sort(),
      sidecars.map((name) => join(output, name)).sort(),
    );
    for (const name of binaries) {
      assert.ok(
        attested.includes(join(output, name)),
        `${name} must be attestation-verified in its published form`,
      );
    }
    for (const { platform, arch, outputs } of RELEASE_MATRIX) {
      for (const { asset } of outputs) {
        assert.ok(
          attested.includes(
            join(artifacts, `native-${platform}-${arch}`, `${asset}.sha256`),
          ),
          `${asset}.sha256 must be attestation-verified in its staged form`,
        );
      }
    }

    // A published binary that is not the built binary is the one thing the
    // attestation exists to rule out, so it must stop the release rather than
    // be reclassified as a derived file that verification skips.
    writeFileSync(join(output, binaries[0]), "substituted-binary");
    assert.throws(
      () => attestationSubjects(artifacts, output, RELEASE_VERSION),
      /not byte-identical to the attested build output/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the publish job verifies attestations only over attested subjects", () => {
  const verify = workflowStep("Verify build provenance attestations");
  assert.match(verify, /RELEASE_TAG: \$\{\{ steps\.tag\.outputs\.tag \}\}/);
  assert.match(
    verify,
    /release-contract\.mjs attestation-subjects[\s\\]+release-artifacts release-assets "\$RELEASE_TAG"[\s\\]+> attestation-subjects\.txt/,
  );
  assert.match(
    verify,
    /release-contract\.mjs attestation-subjects[\s\\]+release-artifacts release-assets "\$RELEASE_TAG" --published[\s\\]+> published-attestation-subjects\.txt/,
  );
  // An empty subject list would verify nothing while still exiting zero.
  assert.match(verify, /! -s attestation-subjects\.txt/);
  assert.match(verify, /! -s published-attestation-subjects\.txt/);

  // Both loops must draw their subjects from those lists. Iterating the
  // published directory directly is exactly what broke 26.12: it hands the
  // rewritten sidecars to `gh attestation verify`, which cannot succeed.
  assert.deepEqual(
    [...AUTOPUBLISH_WORKFLOW.matchAll(/gh attestation verify "([^"]+)"/g)].map(
      (match) => match[1],
    ),
    ["$subject", "$directory/$subject_name"],
  );
  assert.equal(
    AUTOPUBLISH_WORKFLOW.match(
      /done < (?:published-)?attestation-subjects\.txt/g,
    )?.length,
    2,
  );
  assert.doesNotMatch(
    AUTOPUBLISH_WORKFLOW,
    /for \w+ in release-assets\/\*; do\s+[^\n]*\n\s+gh attestation verify/,
  );

  // A subject list read with a bare `read` silently drops a final line that
  // carries no newline, which would skip one asset without failing.
  assert.equal(
    AUTOPUBLISH_WORKFLOW.match(
      /while IFS= read -r subject \|\| \[ -n "\$subject" \]; do/g,
    )?.length,
    2,
  );

  // The published sidecars are unattested by construction, so the checks that
  // bind them to an attested artifact digest must still run over the release
  // that was actually downloaded back from GitHub.
  const publish = workflowStep(
    "Upload a complete draft, verify it, then publish",
  );
  assert.match(
    publish,
    /release-contract\.mjs validate \\\n\s+"\$directory" "\$RELEASE_TAG"/,
  );
  assert.match(publish, /cmp -- "\$local_asset" "\$directory\/\$asset_name"/);
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

test("darwin diagnostics parse representative vm_stat formats", () => {
  for (const { expectedMiB, fixture } of [
    { expectedMiB: 1, fixture: DARWIN_VMSTAT_FIXTURES.fourK },
    { expectedMiB: 9, fixture: DARWIN_VMSTAT_FIXTURES.sixteenK },
    { expectedMiB: 0, fixture: DARWIN_VMSTAT_FIXTURES.tricky },
  ]) {
    assert.equal(
      withVmStatRunner(
        () => ({ status: 0, stdout: fixture }),
        () =>
          assertResourceHeadroom(
            expectedMiB,
            0,
            0,
            2048 * 1024 * 1024,
            2048 * 1024 * 1024,
            "darwin",
          ).freeMemoryMiB,
      ),
      expectedMiB,
    );
  }
});

test("darwin diagnostics invokes vm_stat without shell or positional arguments", () => {
  const invocations = [];
  withVmStatRunner(
    (command, args, options) => {
      invocations.push({ command, args, options });
      return { status: 0, stdout: DARWIN_VMSTAT_FIXTURES.fourK };
    },
    () => {
      assert.equal(
        assertResourceHeadroom(
          1,
          0,
          0,
          1024 * 1024 * 1024,
          1024 * 1024 * 1024,
          "darwin",
        ).freeMemoryMiB,
        1,
      );
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].command, "vm_stat");
      assert.deepEqual(invocations[0].args, []);
      assert.equal(invocations[0].options.shell, false);
      assert.equal(invocations[0].options.encoding, "utf8");
    },
  );
});

test("darwin diagnostics reject malformed, duplicate, missing, and overflowing vm_stat payloads", () => {
  const cases = [
    [
      /free memory/,
      `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                1.
Pages inactive:                             1.
Pages speculative:                          1.`,
    ],
    [
      /missing the page size header/,
      `Pages free: 1.
Pages inactive: 1.
Pages speculative: 1.`,
    ],
    [
      /duplicate header lines/,
      `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 1.
Pages inactive: 1.
Pages speculative: 1.`,
    ],
    [
      /duplicate Pages free line/,
      `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 1.
Pages free: 2.
Pages inactive: 1.
Pages speculative: 1.`,
    ],
    [
      /non-negative integer/,
      `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: -1.
Pages inactive: 1.
Pages speculative: 1.`,
    ],
    [
      /arithmetic overflow/,
      `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 9007199254740992.
Pages inactive: 0.
Pages speculative: 0.`,
    ],
  ];
  for (const [error, fixture] of cases) {
    assert.throws(
      () =>
        withVmStatRunner(
          () => ({ status: 0, stdout: fixture }),
          () =>
            assertResourceHeadroom(
              2,
              0,
              0,
              1024 * 1024 * 1024,
              1024 * 1024 * 1024,
              "darwin",
            ),
        ),
      error,
    );
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
    /release-contract\.mjs aggregate\s+release-artifacts release-assets "\$RELEASE_TAG"/,
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

test("the tag is reserved before any step that needs a versioned asset name", () => {
  const reserve = workflowStep("Atomically reserve the next YY.N tag");
  assert.match(reserve, /id: tag/);
  assert.match(reserve, /release-contract\.mjs reserve-tag "\$RELEASE_SHA"/);

  // Aggregation renames staged files to their published names, so a tag that
  // is reserved after it would leave the release unversioned.
  const reserveAt = AUTOPUBLISH_WORKFLOW.indexOf(reserve);
  for (const step of [
    "Validate isolated platform artifacts",
    "Require every native asset and valid checksums",
    "Upload a complete draft, verify it, then publish",
  ]) {
    assert.ok(
      reserveAt < AUTOPUBLISH_WORKFLOW.indexOf(workflowStep(step)),
      `"${step}" must run after the tag is reserved`,
    );
  }
  assert.equal(
    AUTOPUBLISH_WORKFLOW.match(/release-contract\.mjs reserve-tag/g)?.length,
    1,
    "the tag must be reserved exactly once",
  );

  // Every gate that builds or checks asset names must be told which tag.
  for (const step of [
    "Validate isolated platform artifacts",
    "Require every native asset and valid checksums",
  ]) {
    const body = workflowStep(step);
    assert.match(body, /RELEASE_TAG: \$\{\{ steps\.tag\.outputs\.tag \}\}/);
    assert.match(body, /"\$RELEASE_TAG"/);
  }
  assert.match(
    workflowStep("Upload a complete draft, verify it, then publish"),
    /release-contract\.mjs validate \\\n\s+"\$directory" "\$RELEASE_TAG"/,
  );
  // A bare `validate <dir>` would silently fall back to no contract at all.
  assert.doesNotMatch(
    AUTOPUBLISH_WORKFLOW,
    /release-contract\.mjs validate release-assets$/m,
  );

  // Cleanup still covers a tag reserved for a run that then fails.
  const recovery = workflowStep(
    "Recover a failed draft and newly reserved tag",
  );
  assert.match(
    recovery,
    /if: \$\{\{ failure\(\) && steps\.tag\.outputs\.tag != '' \}\}/,
  );
  assert.match(recovery, /release-contract\.mjs cleanup-tag/);
});

test("CI and release toolchains are exact rather than mutable channels", () => {
  const nodeWorkflows = [
    AUTOPUBLISH_WORKFLOW,
    CI_WORKFLOW,
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
