import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { legacySourceLintDebt } from "../eslint.config.js";
import { createPlaywrightConfig } from "../playwright.config.ts";

const root = new URL("../", import.meta.url);
const rustCacheRevision = "e18b497796c12c097a38f9edb9d0641fb99eee32";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, root), "utf8");
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
  assert.equal(legacySourceLintDebt.length, 17);
  assert.equal(
    new Set(legacySourceLintDebt).size,
    legacySourceLintDebt.length,
    "Source lint debt entries must be unique",
  );
  assert.ok(
    legacySourceLintDebt.every((path) => path.startsWith("src/")),
    "Source lint debt must stay scoped to src",
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
  assert.match(scripts.check, /npm run test:ci-contract/);
});

test("Playwright structurally separates CI static export from local development", () => {
  const ciConfig = createPlaywrightConfig(true);
  const localConfig = createPlaywrightConfig(false);
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
  assert.equal(ciConfig.use?.trace, "retain-on-failure");
  assert.deepEqual(ciConfig.testMatch, [
    "e2e/**/*.spec.ts",
    "test/ci-playwright-runtime.spec.ts",
  ]);
  assert.equal(ciServer?.command, "npm run serve:e2e:ci");
  assert.equal(ciServer?.reuseExistingServer, false);
  assert.equal(localServer?.command, "npm run dev");
  assert.equal(localServer?.reuseExistingServer, true);
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
