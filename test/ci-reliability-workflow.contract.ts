import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { legacySourceLintDebt } from "../eslint.config.js";
import { createPlaywrightConfig } from "../playwright.config.ts";

const root = new URL("../", import.meta.url);
const rustCacheRevision = "c19371144df3bb44fab255c43d04cbc2ab54d1c4";
const workflowPaths = readdirSync(new URL(".github/workflows/", root))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => `.github/workflows/${name}`);
const externalActionPins = new Map([
  ["actions/checkout@v7.0.1", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  [
    "actions/configure-pages@v6.0.0",
    "45bfe0192ca1faeb007ade9deae92b16b8254a0d",
  ],
  ["actions/deploy-pages@v5.0.0", "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128"],
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
    "actions/upload-pages-artifact@v5.0.0",
    "fc324d3547104276b827a68afc52ff2a11cc49c9",
  ],
  ["Swatinem/rust-cache@v2.9.1", "c19371144df3bb44fab255c43d04cbc2ab54d1c4"],
]);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function changedSourceFiles(): string[] {
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      "origin/main..HEAD",
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

test("package scripts expose truthful lint and reliability gates", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const scripts = packageJson.scripts;

  assert.equal(scripts.typecheck, "tsc -p tsconfig.json --noEmit");
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
  const changedSources = changedSourceFiles();
  assert.ok(changedSources.length > 0, "Expected changed source files");
  assert.deepEqual(
    changedSources.filter(
      (path) =>
        !/\.(?:ts|tsx)$/.test(path) || legacySourceLintDebt.includes(path),
    ),
    [],
    "Every source file changed in origin/main..HEAD must be TypeScript and covered by the source lint gate",
  );
  assert.ok(!Object.keys(scripts).some((name) => name === "lint:production"));

  const reliabilityCommand = scripts["test:e2e:reliability"].split(/\s+/);
  for (const specification of [
    "e2e/home.spec.ts",
    "e2e/login-key-management.spec.ts",
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
  assert.equal(
    scripts["build:pages:ci"],
    "cross-env GITHUB_PAGES_BASE_PATH=better-cloudflare npm run build",
  );
  assert.equal(
    scripts["test:e2e:pages"],
    "cross-env CI=true PLAYWRIGHT_STATIC_BASE_PATH=/better-cloudflare playwright test test/ci-pages-base-path.spec.ts --project=chromium",
  );
  assert.match(scripts.check, /npm run test:ci-contract/);
});

test("Playwright structurally separates CI static export from local development", () => {
  const ciConfig = createPlaywrightConfig(true);
  const pagesConfig = createPlaywrightConfig(true, "/better-cloudflare");
  const localConfig = createPlaywrightConfig(false);
  const ciServer = Array.isArray(ciConfig.webServer)
    ? ciConfig.webServer[0]
    : ciConfig.webServer;
  const pagesServer = Array.isArray(pagesConfig.webServer)
    ? pagesConfig.webServer[0]
    : pagesConfig.webServer;
  const localServer = Array.isArray(localConfig.webServer)
    ? localConfig.webServer[0]
    : localConfig.webServer;

  assert.equal(ciConfig.projects?.[0]?.name, "chromium");
  assert.equal(ciConfig.projects?.[0]?.use?.browserName, "chromium");
  assert.equal(ciConfig.forbidOnly, true);
  assert.equal(ciConfig.retries, 0);
  assert.equal(ciConfig.workers, 1);
  assert.equal(ciConfig.use?.trace, "retain-on-failure");
  assert.deepEqual(ciConfig.testMatch, [
    "e2e/**/*.spec.ts",
    "test/ci-pages-base-path.spec.ts",
    "test/ci-playwright-runtime.spec.ts",
  ]);
  assert.equal(ciConfig.use?.baseURL, "http://localhost:3000");
  assert.equal(ciServer?.command, "npm run serve:e2e:ci");
  assert.equal(ciServer?.url, "http://localhost:3000/");
  assert.equal(ciServer?.reuseExistingServer, false);
  assert.equal(
    pagesConfig.use?.baseURL,
    "http://localhost:3000/better-cloudflare",
  );
  assert.equal(pagesServer?.command, "npm run serve:e2e:ci");
  assert.equal(pagesServer?.url, "http://localhost:3000/better-cloudflare/");
  assert.equal(localServer?.command, "npm run dev");
  assert.equal(localServer?.reuseExistingServer, true);
});

test("reliability specifications reject browser and network failures", () => {
  for (const relativePath of [
    "e2e/login-key-management.spec.ts",
    "test/ci-pages-base-path.spec.ts",
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

test("every external workflow action is pinned to its resolved commit", () => {
  const observed = new Map<string, string>();

  for (const workflowPath of workflowPaths) {
    for (const [index, line] of read(workflowPath).split(/\r?\n/).entries()) {
      const uses = /^\s+uses:\s+(\S+?)(?:\s+#\s*(v\d+(?:\.\d+)*))?\s*$/.exec(
        line,
      );
      if (!uses || uses[1].startsWith("./")) continue;

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
});

test("main pushes keep an independent non-cancelling release opportunity", () => {
  const workflow = read(".github/workflows/ci.yml");
  const releaseJob = workflowJob(workflow, "release");
  const autopublish = read(".github/workflows/autopublish.yml");
  const publishJob = workflowJob(autopublish, "publish");

  assert.match(
    workflow,
    /concurrency:\r?\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.sha \}\}\r?\n  cancel-in-progress: false/,
  );
  assert.match(releaseJob, /github\.event_name == 'push'/);
  assert.match(releaseJob, /commit_sha: \$\{\{ github\.sha \}\}/);
  assert.match(
    publishJob,
    /group: native-release-publish-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.commit_sha \}\}/,
  );
  assert.match(publishJob, /cancel-in-progress: false/);
  assert.equal(
    stepRun(workflowStep(publishJob, "Atomically reserve the next YY.N tag")),
    'node .github/scripts/release-contract.mjs reserve-tag "$RELEASE_SHA"',
  );
});

test("CI jobs structurally gate releases on static E2E and native checks", () => {
  const workflow = read(".github/workflows/ci.yml");
  const e2eJob = workflowJob(workflow, "e2e_reliability");
  const nativeJob = workflowJob(workflow, "native_reliability");
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
  assert.deepEqual(workflowNeeds(releaseJob), [
    "ci_contract",
    "unit_tests",
    "e2e_reliability",
    "native_reliability",
    "format",
    "lint",
    "test_package",
    "release_contract",
  ]);
});

test("Pages deployment is gated by a project-base-path browser check", () => {
  const workflow = read(".github/workflows/pages.yml");
  const buildJob = workflowJob(workflow, "build");
  const deployJob = workflowJob(workflow, "deploy");
  const buildStep = workflowStep(buildJob, "Build project-path export");
  const installStep = workflowStep(buildJob, "Install Playwright Chromium");
  const verifyStep = workflowStep(
    buildJob,
    "Verify project-path static export",
  );
  const uploadStep = workflowStep(buildJob, "Upload artifact");

  assert.equal(stepRun(buildStep), "npm run build:pages:ci");
  assert.equal(
    stepRun(installStep),
    "npx playwright install --with-deps chromium",
  );
  assert.equal(stepRun(verifyStep), "npm run test:e2e:pages");
  assert.ok(buildJob.indexOf(buildStep) < buildJob.indexOf(verifyStep));
  assert.ok(buildJob.indexOf(verifyStep) < buildJob.indexOf(uploadStep));
  assert.match(deployJob, /needs: build/);
  assert.match(deployJob, /pages: write/);
  assert.match(deployJob, /id-token: write/);

  const server = read("test/ci-static-export-server.mjs");
  assert.match(server, /process\.env\.PLAYWRIGHT_STATIC_BASE_PATH/);
  assert.match(server, /pathname\.startsWith\(`\$\{basePath\}\/`\)/);

  const specification = read("test/ci-pages-base-path.spec.ts");
  assert.match(specification, /const projectBasePath = "\/better-cloudflare"/);
  assert.match(specification, /rootResponse\.status\(\)\)\.toBe\(404\)/);
  assert.match(specification, /runtime\.assertClean\(\)/);
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
    "npm test",
    "npm run build",
    "npm pack",
  ]);
});
