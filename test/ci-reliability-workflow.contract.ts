import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { legacySourceLintDebt } from "../eslint.config.js";
import {
  createPlaywrightConfig,
  resolveDevServerPort,
} from "../playwright.config.ts";
import { discoverTestFiles } from "../scripts/run-tests-seq.ts";

const root = new URL("../", import.meta.url);
const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const cssContractTest = "test/AppShellCss.contract.test.ts";
const rustCacheRevision = "c19371144df3bb44fab255c43d04cbc2ab54d1c4";
const osvScannerImage =
  "docker://ghcr.io/google/osv-scanner-action@sha256:48406c58197201fe55e56615ad9d414f85063da320e204d0b0ed460fb3908dba";
const workflowPaths = readdirSync(new URL(".github/workflows/", root))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => `.github/workflows/${name}`);
const externalActionPins = new Map([
  ["actions/attest@v4.2.1", "508db95dd578ae2727ebd6217d5ba78e4fbda05d"],
  ["actions/checkout@v7.0.1", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  [
    "actions/dependency-review-action@v5.0.0",
    "a1d282b36b6f3519aa1f3fc636f609c47dddb294",
  ],
  [
    "actions/download-artifact@v8.0.1",
    "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  ],
  ["actions/setup-node@v7.0.0", "820762786026740c76f36085b0efc47a31fe5020"],
  [
    "actions/upload-artifact@v7.0.1",
    "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ],
  [
    "github/codeql-action/analyze@v4.37.4",
    "f205ea1c3313d32999d8d6a48b4f6530d4437b38",
  ],
  [
    "github/codeql-action/init@v4.37.4",
    "f205ea1c3313d32999d8d6a48b4f6530d4437b38",
  ],
  ["Swatinem/rust-cache@v2.9.1", "c19371144df3bb44fab255c43d04cbc2ab54d1c4"],
]);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function fallbackChangedSourceBase(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: fileURLToPath(root),
      encoding: "utf8",
    }).trim();
  } catch {
    return emptyTreeSha;
  }
}

function changedSourceBase(baseSha = process.env.CI_BASE_SHA): string {
  const normalizedBase = baseSha?.trim();
  if (!normalizedBase || /^0{40}$/.test(normalizedBase)) {
    return fallbackChangedSourceBase();
  }
  return normalizedBase;
}

function changedSourceFiles(): string[] {
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXBD",
      changedSourceBase(),
      "HEAD",
      "--",
      "src",
    ],
    {
      cwd: fileURLToPath(root),
      encoding: "utf8",
    },
  );

  return output
    .split(/\r?\n/)
    .map((path) => path.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function workflowJob(workflow: string, jobId: string): string {
  const lines = workflow.split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsLine, -1, "Workflow has no jobs mapping");

  const jobLine = lines.findIndex(
    (line, index) => index > jobsLine && line === `  ${jobId}:`,
  );
  assert.notEqual(jobLine, -1, `Workflow job is missing: ${jobId}`);

  const nextJob = lines.findIndex(
    (line, index) => index > jobLine && /^  [a-zA-Z0-9_-]+:\s*$/.test(line),
  );
  return lines.slice(jobLine, nextJob === -1 ? undefined : nextJob).join("\n");
}

function workflowStep(job: string, stepName: string): string {
  const lines = job.split(/\r?\n/);
  const stepLine = lines.findIndex(
    (line) => line === `      - name: ${stepName}`,
  );
  assert.notEqual(stepLine, -1, `Workflow step is missing: ${stepName}`);

  const nextStep = lines.findIndex(
    (line, index) => index > stepLine && line.startsWith("      - name: "),
  );
  return lines
    .slice(stepLine, nextStep === -1 ? undefined : nextStep)
    .join("\n");
}

function workflowConcurrency(workflow: string): {
  group: string;
  cancelInProgress: string;
} {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "concurrency:");
  assert.notEqual(start, -1, "Workflow has no top-level concurrency block");
  assert.equal(
    lines.indexOf("concurrency:", start + 1),
    -1,
    "Workflow declares more than one top-level concurrency block",
  );

  const entries = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    const match = /^  ([a-z-]+):\s*(.*)$/.exec(line);
    if (!match) break;
    entries.set(match[1], match[2].trim());
  }

  const group = entries.get("group");
  const cancelInProgress = entries.get("cancel-in-progress");
  assert.ok(group, "Concurrency block has no group");
  assert.ok(cancelInProgress, "Concurrency block has no cancel-in-progress");
  return { group, cancelInProgress };
}

// The cancellation rule this repository runs on, expressed once: a superseded
// pull request run may be cancelled, and nothing else ever may. Non-pull-request
// runs are keyed by `github.run_id`, which is unique per run, so each of them is
// the sole occupant of its group and is unreachable by any later run's
// cancellation — belt to the braces of `cancel-in-progress` being false for
// them. `cancel-in-progress: true` written literally would cancel push and
// workflow_dispatch runs as well, so it is rejected outright.
function assertPullRequestOnlyCancellation(
  workflow: string,
  prefix: string,
): void {
  const { group, cancelInProgress } = workflowConcurrency(workflow);

  assert.equal(
    cancelInProgress,
    "${{ github.event_name == 'pull_request' }}",
    `${prefix} runs other than pull requests must not be cancellable`,
  );
  const branches =
    /^(.+)-\$\{\{ github\.event_name == 'pull_request' && (.+) \|\| (.+) \}\}$/.exec(
      group,
    );
  assert.ok(branches, `${prefix} concurrency group is not event-conditional`);
  assert.equal(branches[1], `${prefix}-\${{ github.workflow }}`);
  assert.equal(
    branches[2],
    "format('pr-{0}', github.event.pull_request.number)",
    `${prefix} pull request runs must group by pull request number so a new push supersedes the old run`,
  );
  assert.equal(
    branches[3],
    "format('{0}-{1}', github.event_name, github.run_id)",
    `${prefix} non-pull-request runs must be alone in their concurrency group`,
  );
}

function workflowNeeds(job: string): string[] {
  const lines = job.split(/\r?\n/);
  const needsLine = lines.findIndex((line) => line === "    needs:");
  assert.notEqual(needsLine, -1, "Workflow job has no needs list");

  const needs: string[] = [];
  for (const line of lines.slice(needsLine + 1)) {
    const match = /^      - ([a-zA-Z0-9_-]+)$/.exec(line);
    if (!match) break;
    needs.push(match[1]);
  }
  return needs;
}

function stepRun(step: string): string {
  const lines = step.split(/\r?\n/);
  const runLine = lines.findIndex((line) => line.startsWith("        run:"));
  assert.notEqual(runLine, -1, "Workflow step has no run command");

  const inline = lines[runLine].replace(/^        run:\s*/, "");
  if (inline && !["|", ">", ">-", "|-"].includes(inline)) return inline;
  return lines
    .slice(runLine + 1)
    .filter((line) => line.startsWith("          "))
    .map((line) => line.trim())
    .join(" ");
}

function stepUses(step: string): string {
  const usesLine = step
    .split(/\r?\n/)
    .find((line) => line.startsWith("        uses:"));
  assert.ok(usesLine, "Workflow step has no uses value");
  return usesLine
    .replace(/^        uses:\s*/, "")
    .replace(/\s+#.*$/, "")
    .trim();
}

interface ParsedRunStep {
  command: string;
  condition?: string;
}

interface SourceGateFixture {
  sources: string[];
  lint?: ParsedRunStep;
  typecheck?: ParsedRunStep;
  format?: ParsedRunStep;
  tests: string[];
}

function parsedRunStep(
  workflowName: string,
  jobId: string,
  stepName: string,
): ParsedRunStep {
  const workflow = read(`.github/workflows/${workflowName}`);
  const step = workflowStep(workflowJob(workflow, jobId), stepName);
  const conditionPrefix = "        if:";
  const condition = step
    .split(/\r?\n/)
    .find((line) => line.startsWith(conditionPrefix));
  return {
    command: stepRun(step),
    condition: condition?.slice(conditionPrefix.length).trim(),
  };
}

function sourceGateFixture(): SourceGateFixture {
  return {
    sources: changedSourceFiles(),
    lint: parsedRunStep("lint.yml", "eslint", "Run ESLint"),
    typecheck: parsedRunStep(
      "test-package.yml",
      "test-and-package",
      "Run TypeScript typecheck",
    ),
    format: parsedRunStep("format.yml", "check", "Check formatting"),
    tests: discoverTestFiles(fileURLToPath(root)),
  };
}

function requireUnconditionalCommand(
  step: ParsedRunStep | undefined,
  expectedCommand: string,
  name: string,
): void {
  assert.ok(step, `${name} step is missing`);
  assert.equal(step.command, expectedCommand, `${name} command must be exact`);
  assert.equal(step.condition, undefined, `${name} must be unconditional`);
}

function assertChangedSourceGateCoverage(
  fixture: SourceGateFixture,
  changedSources: string[],
): void {
  let hasTypeScript = false;
  let hasCss = false;
  for (const path of changedSources) {
    assert.ok(
      path.startsWith("src/"),
      `Changed source is outside src: ${path}`,
    );
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      hasTypeScript = true;
      assert.ok(
        !legacySourceLintDebt.includes(path),
        `Changed TypeScript source is excluded from lint: ${path}`,
      );
    } else if (path.endsWith(".css")) {
      hasCss = true;
    } else {
      assert.fail(`Unsupported changed source extension: ${path}`);
    }
  }

  if (hasTypeScript) {
    requireUnconditionalCommand(fixture.lint, "npm run lint", "Lint");
    requireUnconditionalCommand(
      fixture.typecheck,
      "npm run typecheck",
      "Typecheck",
    );
  }
  if (hasCss) {
    requireUnconditionalCommand(
      fixture.format,
      "npm run format:check",
      "Format",
    );
    assert.ok(
      fixture.tests.includes(cssContractTest),
      "CSS contract test is missing from official test discovery",
    );
  }
}

test("package scripts expose truthful lint and reliability gates", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    engines: { node: string };
    scripts: Record<string, string>;
  };
  const scripts = packageJson.scripts;

  assert.equal(packageJson.engines.node, "^20.19.0 || ^22.13.0 || >=24.0.0");
  // The dev stack resolves its own free port; the launcher owns the Next flags
  // the script used to carry, so assert they survived the move.
  assert.equal(scripts.dev, "node scripts/dev-server.mjs");
  assert.equal(scripts["tauri:dev"], "node scripts/tauri-dev.mjs");
  assert.equal(scripts.preview, "node test/ci-static-export-server.mjs");
  const devLauncher = read("scripts/dev-server.mjs");
  assert.match(devLauncher, /"dev",\r?\n\s*"--turbo",/);
  // The Tauri CLI only accepts a config patch through `--config`; it ignores the
  // `TAURI_CONFIG` environment variable that CI uses for bare cargo invocations.
  const desktopLauncher = read("scripts/tauri-dev.mjs");
  assert.match(desktopLauncher, /"--config",/);
  assert.match(desktopLauncher, /buildTauriConfigOverride/);
  assert.doesNotMatch(
    desktopLauncher,
    /TAURI_CONFIG:/,
    "TAURI_CONFIG must not be set for the CLI; tauri-build would read the partial patch as a whole configuration",
  );
  assert.match(
    workflowJob(read(".github/workflows/ci.yml"), "native_reliability"),
    /TAURI_CONFIG: '\{"build":\{"frontendDist":"\.\.\/app"\}\}'/,
    "The cargo-side TAURI_CONFIG override must stay intact",
  );
  assert.equal(scripts.build, "next build --webpack");
  // `typecheck` must fan out to both projects, because test-package.yml runs
  // that script directly — anything it does not reach is not covered by CI.
  assert.equal(
    scripts.typecheck,
    "npm run typecheck:app && npm run typecheck:tools",
  );
  assert.equal(scripts["typecheck:app"], "tsc -p tsconfig.json --noEmit");
  assert.equal(
    scripts["typecheck:tools"],
    "tsc -p tsconfig.tools.json --noEmit",
  );
  assert.equal(scripts.lint, "npm run lint:app && npm run lint:src:baseline");
  assert.equal(
    scripts["lint:src:baseline"],
    "cross-env ESLINT_SRC_BASELINE=true eslint src --rule react-refresh/only-export-components:off",
  );
  assert.equal(
    new Set(legacySourceLintDebt).size,
    legacySourceLintDebt.length,
    "Source lint debt entries must be unique",
  );
  assert.ok(
    legacySourceLintDebt.every((path) => path.startsWith("src/")),
    "Source lint debt must stay scoped to src",
  );
  assert.ok(
    !legacySourceLintDebt.includes("src/components/layout/WindowTitleBar.tsx"),
    "The titlebar reliability path must remain covered by source lint",
  );
  assert.ok(!Object.keys(scripts).some((name) => name === "lint:production"));

  const reliabilityCommand = scripts["test:e2e:reliability"].split(/\s+/);
  for (const specification of [
    "e2e/home.spec.ts",
    "e2e/login-key-management.spec.ts",
    "e2e/auth-errors.spec.ts",
    "test/ci-playwright-runtime.spec.ts",
  ]) {
    assert.ok(
      reliabilityCommand.includes(specification),
      `Reliability command omits ${specification}`,
    );
  }
  assert.ok(reliabilityCommand.includes("--project=chromium"));
  assert.equal(
    scripts["serve:e2e:ci"],
    "node test/ci-static-export-server.mjs",
  );
  assert.match(scripts.check, /npm run test:ci-contract/);
  assert.equal(
    scripts["test:release-contract"],
    "node --test .github/scripts/release-contract.test.mjs",
  );
  assert.equal(
    scripts["test:resource-safety"],
    "tsx --test --import ./test/node-test-env.ts test/resource-disposal.test.tsx test/AuditLogDialog.test.tsx",
  );
  assert.equal(
    scripts["memory:smoke:manual"],
    "node --expose-gc --import tsx scripts/memory-growth-smoke.mjs",
  );
});

test("changed source types have unconditional CI coverage", () => {
  const fixture = sourceGateFixture();
  const syntheticTsSource = ["src/example.ts"];
  const syntheticCssSource = ["src/example.css"];
  const syntheticDeletedTsSource = ["src/deleted/path.ts"];
  const syntheticDeletedCssSource = ["src/deleted/path.css"];
  const syntheticUnknownSource = ["src/unknown.mjs"];

  assertChangedSourceGateCoverage(fixture, fixture.sources);
  assertChangedSourceGateCoverage(
    { ...fixture, sources: syntheticTsSource },
    syntheticTsSource,
  );
  assertChangedSourceGateCoverage(
    { ...fixture, sources: syntheticDeletedTsSource },
    syntheticDeletedTsSource,
  );
  assertChangedSourceGateCoverage(
    { ...fixture, sources: syntheticCssSource },
    syntheticCssSource,
  );
  assertChangedSourceGateCoverage(
    { ...fixture, sources: syntheticDeletedCssSource },
    syntheticDeletedCssSource,
  );
  const conditional = (command: string): ParsedRunStep => ({
    command,
    condition: "success()",
  });
  const failures: Array<
    [readonly string[], Partial<SourceGateFixture>, RegExp]
  > = [
    [syntheticTsSource, { typecheck: undefined }, /Typecheck step is missing/],
    [
      syntheticTsSource,
      { typecheck: conditional("npm run typecheck") },
      /must be unconditional/,
    ],
    [
      syntheticTsSource,
      { lint: conditional("npm run lint") },
      /must be unconditional/,
    ],
    [syntheticCssSource, { format: undefined }, /Format step is missing/],
    [
      syntheticCssSource,
      { format: conditional("npm run format:check") },
      /must be unconditional/,
    ],
    [
      syntheticDeletedCssSource,
      { format: conditional("npm run format:check") },
      /must be unconditional/,
    ],
    [
      syntheticCssSource,
      { tests: fixture.tests.filter((path) => path !== cssContractTest) },
      /CSS contract test is missing/,
    ],
    [
      syntheticUnknownSource,
      { sources: [...syntheticUnknownSource] },
      /Unsupported changed source extension/,
    ],
  ];
  for (const [changedSources, mutation, expected] of failures) {
    assert.throws(
      () =>
        assertChangedSourceGateCoverage(
          { ...fixture, ...mutation, sources: changedSources },
          changedSources,
        ),
      expected,
    );
  }
});

test("CI changed-source lint uses the event base with complete history", () => {
  const workflow = read(".github/workflows/ci.yml");
  const contractJob = workflowJob(workflow, "ci_contract");
  const checkoutStep = workflowStep(contractJob, "Checkout");
  const contractStep = workflowStep(
    contractJob,
    "Test CI reliability contract",
  );

  assert.match(checkoutStep, /fetch-depth: 0/);
  assert.match(
    contractStep,
    /CI_BASE_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/,
  );
  assert.equal(changedSourceBase("0".repeat(40)), fallbackChangedSourceBase());
  assert.equal(
    changedSourceBase("1234567890abcdef1234567890abcdef12345678"),
    "1234567890abcdef1234567890abcdef12345678",
  );
});

test("Playwright structurally separates CI static export from local development", () => {
  // CI resolves its port with no probing at all, so the fixed address below is
  // exactly what a CI run sees. Local runs are handed a resolved port instead.
  assert.equal(resolveDevServerPort(true), 3000);
  const ciConfig = createPlaywrightConfig(true, 3000);
  const localConfig = createPlaywrightConfig(false, 4123);
  const ciServer = Array.isArray(ciConfig.webServer)
    ? ciConfig.webServer[0]
    : ciConfig.webServer;
  const localServer = Array.isArray(localConfig.webServer)
    ? localConfig.webServer[0]
    : localConfig.webServer;

  assert.equal(ciConfig.projects?.[0]?.name, "chromium");
  assert.equal(ciConfig.projects?.[0]?.use?.browserName, "chromium");
  assert.equal(ciConfig.forbidOnly, true);
  assert.equal(ciConfig.retries, 0);
  assert.equal(ciConfig.workers, 1);
  assert.equal(ciConfig.fullyParallel, false);
  assert.equal(localConfig.fullyParallel, true);
  assert.equal(ciConfig.use?.trace, "retain-on-failure");
  assert.deepEqual(ciConfig.testMatch, [
    "e2e/**/*.spec.ts",
    "test/ci-playwright-runtime.spec.ts",
  ]);
  assert.equal(ciConfig.use?.baseURL, "http://localhost:3000");
  assert.equal(ciServer?.command, "npm run serve:e2e:ci");
  assert.equal(ciServer?.url, "http://localhost:3000/");
  assert.equal(ciServer?.reuseExistingServer, false);
  assert.equal(localServer?.command, "npm run dev");
  assert.equal(localServer?.reuseExistingServer, true);

  // Every consumer of a run must agree on one port: the browser, the web server
  // Playwright starts, and the environment that server is pinned with.
  assert.equal(ciServer?.env?.PORT, "3000");
  assert.equal(localConfig.use?.baseURL, "http://localhost:4123");
  assert.equal(localServer?.url, "http://localhost:4123");
  assert.equal(localServer?.env?.PORT, "4123");
});

test("reliability specifications reject browser and network failures", () => {
  for (const relativePath of [
    "e2e/login-key-management.spec.ts",
    "test/ci-playwright-runtime.spec.ts",
  ]) {
    const specification = read(relativePath);
    for (const event of ["console", "pageerror", "requestfailed", "response"]) {
      assert.match(
        specification,
        new RegExp(`page\\.on\\([\"']${event}[\"']`),
        `${relativePath} does not monitor ${event}`,
      );
    }
    assert.match(specification, /response\.status\(\) >= 400/);
  }

  const harness = read("test/ci-playwright-runtime.spec.ts");
  assert.match(harness, /expectedFailures/);
  assert.match(harness, /runtime\.assertClean\(\)/);
});

test("every external workflow action and image is immutably pinned", () => {
  const observed = new Map<string, string>();
  let observedOsvImages = 0;

  for (const workflowPath of workflowPaths) {
    for (const [index, line] of read(workflowPath).split(/\r?\n/).entries()) {
      const uses = /^\s+uses:\s+(\S+?)(?:\s+#\s*(v\d+(?:\.\d+)*))?\s*$/.exec(
        line,
      );
      if (!uses || uses[1].startsWith("./")) continue;

      if (uses[1].startsWith("docker://")) {
        assert.equal(
          uses[1],
          osvScannerImage,
          `${workflowPath}:${index + 1} uses an unapproved Docker action image`,
        );
        assert.equal(
          uses[2],
          "v2.3.8",
          `${workflowPath}:${index + 1} must retain the OSV version comment`,
        );
        observedOsvImages += 1;
        continue;
      }

      const action = /^([^@]+)@([0-9a-f]{40})$/.exec(uses[1]);
      assert.ok(
        action,
        `${workflowPath}:${index + 1} must pin external uses to a full commit SHA`,
      );
      assert.ok(
        uses[2],
        `${workflowPath}:${index + 1} must retain its version comment`,
      );

      const actionVersion = `${action[1]}@${uses[2]}`;
      const expectedSha = externalActionPins.get(actionVersion);
      assert.ok(
        expectedSha,
        `${workflowPath}:${index + 1} uses an unapproved action version: ${actionVersion}`,
      );
      assert.equal(
        action[2],
        expectedSha,
        `${workflowPath}:${index + 1} has a stale pin for ${actionVersion}`,
      );
      observed.set(actionVersion, action[2]);
    }
  }

  assert.deepEqual(observed, externalActionPins);
  assert.equal(observedOsvImages, 2);
});

test("releasing is manual only and stays globally serialized and non-cancelling", () => {
  const workflow = read(".github/workflows/ci.yml");
  const releaseJob = workflowJob(workflow, "release");
  const autopublish = read(".github/workflows/autopublish.yml");
  const publishJob = workflowJob(autopublish, "publish");

  // A release runs *inside* a ci.yml run, so the caller's concurrency decides
  // whether a publish can be torn down halfway. Two independent facts keep it
  // safe, and both are asserted: only pull request runs are cancellable, and a
  // release is reachable only from workflow_dispatch, which is never a pull
  // request. Cancelling a caller cancels its reusable-workflow jobs too, so
  // neither guarantee is redundant.
  assertPullRequestOnlyCancellation(workflow, "ci");
  assert.match(
    releaseJob,
    /github\.ref == 'refs\/heads\/main'/,
    "A release must be reachable only from main",
  );
  // Production-release deployment is disabled on push: merging to main must
  // never publish. The only way in is an explicit workflow_dispatch asking
  // for it, which still has to clear every gate listed in `needs`.
  assert.doesNotMatch(releaseJob, /github\.event_name == 'push'/);
  assert.match(
    releaseJob,
    /github\.event_name == 'workflow_dispatch' && inputs\.release/,
  );
  assert.match(releaseJob, /commit_sha: \$\{\{ github\.sha \}\}/);
  assert.match(
    publishJob,
    /group: native-release-publish-\$\{\{ github\.repository \}\}/,
  );
  assert.doesNotMatch(
    publishJob,
    /group: native-release-publish-[^\r\n]*inputs\.commit_sha/,
  );
  assert.match(publishJob, /cancel-in-progress: false/);
  assert.equal(
    stepRun(workflowStep(publishJob, "Atomically reserve the next YY.N tag")),
    'node .github/scripts/release-contract.mjs reserve-tag "$RELEASE_SHA"',
  );
});

test("security analysis cancels only superseded pull request runs", () => {
  // CodeQL is the longest job in the repository, so it is the one worth
  // superseding — but a cancelled CodeQL run uploads no SARIF at all. Scheduled
  // full-history scans and main-branch analyses must therefore survive whatever
  // else lands while they run.
  assertPullRequestOnlyCancellation(
    read(".github/workflows/security.yml"),
    "security",
  );
});

test("Windows-only native code is compiled and linted by CI", () => {
  const workflow = read(".github/workflows/ci.yml");
  const windowsJob = workflowJob(workflow, "windows_reliability");

  // Pinned to the same image the release matrix builds windows-x64 on, so this
  // job fails where the release would have, not merely somewhere near it.
  assert.match(workflow, /^  windows_reliability:$/m);
  assert.match(windowsJob, /runs-on: windows-2025/);
  assert.doesNotMatch(
    windowsJob,
    /runs-on: windows-latest/,
    "The Windows runner image must be pinned, not a mutable channel",
  );
  assert.match(
    windowsJob,
    /TAURI_CONFIG: '\{"build":\{"frontendDist":"\.\.\/app"\}\}'/,
  );
  assert.equal(
    stepUses(workflowStep(windowsJob, "Cache Rust build outputs")),
    `Swatinem/rust-cache@${rustCacheRevision}`,
  );
  // `--all-targets` is what makes this meaningful: it type-checks the test and
  // benchmark targets too, so a `#[cfg(windows)]` body that only a test reaches
  // still has to compile.
  assert.equal(
    stepRun(workflowStep(windowsJob, "Check Windows workspace targets")),
    "cargo check --workspace --all-targets --locked",
  );
  assert.equal(
    stepRun(workflowStep(windowsJob, "Run incremental workspace Clippy")),
    "cargo clippy --workspace --all-targets --locked",
  );
  // Held to exactly the standard native_reliability holds Linux to — no
  // stricter, so the platforms cannot drift apart, and no looser, so
  // bc-cloudflare-api's Windows arm is denied warnings like its Linux arm.
  assert.deepEqual(
    stepRun(
      workflowStep(
        windowsJob,
        "Enforce strict Clippy for native error contracts",
      ),
    ).split(/\s+/),
    [
      "cargo",
      "clippy",
      "-p",
      "bc-error",
      "-p",
      "bc-cloudflare-api",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
  );

  // The job is worthless as a release gate unless the release actually waits
  // for it, in `needs` and in the `if` that re-checks every result.
  const releaseJob = workflowJob(workflow, "release");
  assert.ok(workflowNeeds(releaseJob).includes("windows_reliability"));
  assert.match(
    releaseJob,
    /needs\.windows_reliability\.result == 'success'/,
    "The release condition must re-check the Windows gate",
  );

  // The Windows-gated code this job exists to compile. If these move, the job
  // is still valid, but the claim in its comment is not.
  for (const source of [
    "src-tauri/src/startup_guard.rs",
    "src-tauri/src/app_config.rs",
    "src-tauri/crates/bc-cloudflare-api/src/lib.rs",
  ]) {
    assert.match(
      read(source),
      /#\[cfg\((?:windows|target_os = "windows")/,
      `${source} no longer carries Windows-gated code`,
    );
  }
});

test("CI jobs structurally gate releases on static E2E and native checks", () => {
  const workflow = read(".github/workflows/ci.yml");
  const e2eJob = workflowJob(workflow, "e2e_reliability");
  const nativeJob = workflowJob(workflow, "native_reliability");
  const releaseContractJob = workflowJob(workflow, "release_contract");
  const releaseJob = workflowJob(workflow, "release");

  assert.equal(
    stepRun(workflowStep(e2eJob, "Build static export for browser tests")),
    "npm run build",
  );
  assert.equal(
    stepRun(workflowStep(e2eJob, "Install Playwright Chromium")),
    "npx playwright install --with-deps chromium",
  );
  assert.equal(
    stepRun(workflowStep(e2eJob, "Run Chromium reliability specifications")),
    "npm run test:e2e:reliability",
  );
  assert.equal(
    stepUses(workflowStep(nativeJob, "Cache Rust build outputs")),
    `Swatinem/rust-cache@${rustCacheRevision}`,
  );
  assert.equal(
    stepRun(workflowStep(nativeJob, "Test Rust workspace")),
    "cargo test --workspace --all-targets --locked",
  );
  assert.equal(
    stepRun(workflowStep(nativeJob, "Run incremental workspace Clippy")),
    "cargo clippy --workspace --all-targets --locked",
  );
  assert.deepEqual(
    stepRun(
      workflowStep(
        nativeJob,
        "Enforce strict Clippy for native error contracts",
      ),
    ).split(/\s+/),
    [
      "cargo",
      "clippy",
      "-p",
      "bc-error",
      "-p",
      "bc-cloudflare-api",
      "--all-targets",
      "--locked",
      "--",
      "-D",
      "warnings",
    ],
  );
  assert.equal(
    stepRun(workflowStep(releaseContractJob, "Test release contract")),
    "npm run test:release-contract -- --test-concurrency=1",
  );
  assert.deepEqual(workflowNeeds(releaseJob), [
    "ci_contract",
    "unit_tests",
    "e2e_reliability",
    "native_reliability",
    "windows_reliability",
    "format",
    "lint",
    "test_package",
    "release_contract",
  ]);
});

test("CI bounds build concurrency and gates deterministic disposal checks", () => {
  const workflow = read(".github/workflows/ci.yml");
  const contractJob = workflowJob(workflow, "ci_contract");
  const unitJob = workflowJob(workflow, "unit_tests");
  const e2eJob = workflowJob(workflow, "e2e_reliability");
  const nativeJob = workflowJob(workflow, "native_reliability");
  const releaseContractJob = workflowJob(workflow, "release_contract");

  assert.doesNotMatch(workflow, /^env:\r?\n  NODE_OPTIONS:/m);
  assert.match(contractJob, /NODE_OPTIONS: --max-old-space-size=1536/);
  assert.match(unitJob, /NODE_OPTIONS: --max-old-space-size=1536/);
  assert.match(e2eJob, /NODE_OPTIONS: --max-old-space-size=3072/);
  assert.match(releaseContractJob, /NODE_OPTIONS: --max-old-space-size=1536/);
  assert.equal(
    stepRun(workflowStep(unitJob, "Run unit tests")),
    "npm test -- --test-concurrency=1",
  );
  assert.equal(
    stepRun(workflowStep(contractJob, "Test deterministic resource disposal")),
    "npm run test:resource-safety -- --test-concurrency=1",
  );
  assert.match(nativeJob, /CARGO_BUILD_JOBS: "2"/);
  assert.match(nativeJob, /RUST_TEST_THREADS: "2"/);
  assert.doesNotMatch(
    workflow,
    /memory:smoke:manual/,
    "Heap-growth sampling must remain manual until its variance is proven stable",
  );
});

test("package workflow typechecks before testing and packaging", () => {
  const workflow = read(".github/workflows/test-package.yml");
  const packageJob = workflowJob(workflow, "test-and-package");
  const orderedCommands = [
    "Run TypeScript typecheck",
    "Run unit tests",
    "Run web build",
    "Create npm package",
  ].map((name) => stepRun(workflowStep(packageJob, name)));

  assert.deepEqual(orderedCommands, [
    "npm run typecheck",
    "npm test -- --test-concurrency=1",
    "npm run build",
    "npm pack",
  ]);
});

test("the desktop shell loads the real application on every launch path", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    build: { beforeDevCommand: string; frontendDist: string };
    app: { security: { csp: string } };
  };

  // `npm run tauri dev` must go through the free-port launcher; every other
  // subcommand (`build` in autopublish.yml among them) passes through it.
  assert.equal(packageJson.scripts.tauri, "node scripts/tauri-cli.mjs");
  // The raw CLI path (`npx tauri dev`, `cargo tauri dev`) is guarded: the
  // static devUrl is only ever handed to Tauri when this app's server owns it.
  assert.equal(
    tauriConfig.build.beforeDevCommand,
    "node scripts/tauri-before-dev.mjs",
  );
  // Production windows load the static export, not a placeholder page.
  assert.match(read("next.config.mjs"), /output: "export"/);
  assert.equal(tauriConfig.build.frontendDist, "../out");

  // Tauri does not inject `connect-src`; without it `default-src 'self'`
  // blocks every `invoke()` (they go to `http://ipc.localhost`), so the
  // production window renders but no native command ever answers.
  const directives = new Map(
    tauriConfig.app.security.csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter((parts) => parts[0] !== undefined && parts[0].length > 0)
      .map(([name, ...sources]) => [name, sources] as const),
  );
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  const connectSources = directives.get("connect-src") ?? [];
  for (const source of ["ipc:", "http://ipc.localhost"]) {
    assert.ok(
      connectSources.includes(source),
      `connect-src must allow ${source} so Tauri IPC is not blocked`,
    );
  }
  // 8bc93ac removed inline/eval scripts on purpose; keep them out.
  const scriptSources = directives.get("script-src") ?? [];
  for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'"]) {
    assert.ok(
      !scriptSources.includes(forbidden),
      `script-src must not allow ${forbidden}`,
    );
  }
});
