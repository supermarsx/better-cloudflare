import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_TEST_FILE_PATTERN = /^test\/[^/]+\.test\.(?:ts|tsx)$/u;
const RUNNER_CONTRACT_FILE = "scripts/run-tests-seq.contract.test.ts";
const WATCHDOG_RESULT_PATTERN =
  /^PROCESS_TREE_WATCHDOG_RESULT (?<result>\{.+\})$/gmu;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const SUMMARY_PATTERN =
  /^(?:ℹ|#)\s+(?<field>tests|pass|fail|cancelled|skipped|todo)\s+(?<count>\d+)\s*$/gmu;
const CALLER_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "--conditions",
  "-e",
  "--env-file",
  "--env-file-if-exists",
  "--eval",
  "--experimental-loader",
  "--import",
  "--inspect-port",
  "--loader",
  "-r",
  "--redirect-warnings",
  "--require",
  "--test-concurrency",
  "--test-isolation",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-skip-pattern",
  "--test-timeout",
  "--title",
]);
const UNSAFE_PERSISTENT_OPTIONS = new Set(["--watch", "--watch-path"]);
const UNSAFE_RESOURCE_OPTIONS = new Set([
  "--max-old-space-size",
  "--max-old-space-size-percentage",
]);
const MAX_TEST_FILTER_LENGTH = 1024;
const MAX_PROCESS_TREE_MEMORY_MIB = 1792;
const MAX_OLD_SPACE_SIZE_MIB = 1536;
const MAX_BATCH_CONCURRENCY = 8;
const BATCH_MEMORY_HEADROOM = 0.5;

/**
 * The bounded profile every CI runner gets. One file per process, one process at
 * a time, so the peak footprint of the whole suite is the peak footprint of its
 * single heaviest file. {@link resolveBatchConcurrency} returns exactly this on
 * CI; only a developer machine is allowed to widen it.
 */
export const TEST_RUNNER_LIMITS = Object.freeze({
  maxWorkers: 1,
  fileParallelism: false,
  filesPerBatch: 1,
});

export interface TestSummary {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
}

export interface WatchdogSummary {
  status: string;
  exitCode: number;
  hardMemoryLimitEnabled: boolean;
  hardMemoryLimitBytes: number;
  peakSingleRssBytes: number;
  peakSingleRssMiB: number;
  peakAggregateRssBytes: number;
  peakAggregateRssMiB: number;
  peakJobCommitBytes: number;
  peakJobCommitMiB: number;
}

export interface GuardedProcessResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  watchdog: WatchdogSummary | null;
}

export interface BatchDescriptor {
  file: string;
  index: number;
  total: number;
  nodeArguments: string[];
  summaryFile: string;
  timeoutMs: number;
  memoryLimitMiB: number;
}

export interface BatchResult extends GuardedProcessResult {
  summary: TestSummary | null;
}

export interface TestSuiteResult {
  exitCode: number;
  discoveredFiles: string[];
  completedFiles: string[];
  failedFile: string | null;
  summary: TestSummary;
  peakSingleRssBytes: number;
  peakAggregateRssBytes: number;
}

export interface PreparedInvocation {
  files: string[];
  forwardedArguments: string[];
  helpRequested: boolean;
}

interface RunGuardedProcessOptions {
  command: string;
  arguments: string[];
  cwd: string;
  timeoutMs: number;
  memoryLimitMiB: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  writeOutput?: boolean;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

interface RunTestSuiteOptions {
  rootDir: string;
  callerArguments: string[];
  batchTimeoutMs: number;
  suiteTimeoutMs: number;
  memoryLimitMiB: number;
  universeFileCount?: number;
  signal?: AbortSignal;
  files?: string[];
  executeBatch?: (batch: BatchDescriptor) => Promise<BatchResult>;
  writeOutput?: boolean;
  /**
   * How many one-file batches may be in flight at once. Defaults to the bounded
   * value of 1 so that every caller - including the contract suite - has to opt
   * in explicitly; `main` is the only place that consults the host.
   */
  batchConcurrency?: number;
}

export interface BatchConcurrencyInputs {
  env?: NodeJS.ProcessEnv;
  availableParallelism?: number;
  freeMemoryBytes?: number;
  memoryLimitMiB?: number;
}

interface SignalSource {
  once(event: NodeJS.Signals, listener: () => void): EventEmitter;
  removeListener(event: NodeJS.Signals, listener: () => void): EventEmitter;
}

export class TestRunnerSignalError extends Error {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    super(`Test runner interrupted by ${signal}.`);
    this.name = "TestRunnerSignalError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function emptySummary(): TestSummary {
  return {
    tests: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
}

function addSummary(target: TestSummary, addition: TestSummary): void {
  for (const field of Object.keys(target) as Array<keyof TestSummary>) {
    target[field] += addition[field];
  }
}

function readPositiveInteger(
  name: string,
  fallback: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function signalExitCode(reason: unknown): number | null {
  return reason instanceof TestRunnerSignalError ? reason.exitCode : null;
}

/**
 * `CI` is the repository-wide signal for "bounded shared runner". `dev-port.mjs`
 * and `next.config.mjs` read it exactly the same way, so a value of `0`, `false`
 * or the empty string never counts as CI.
 */
export function isContinuousIntegration(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.CI;
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

/**
 * How many one-file batches may run at once.
 *
 * CI always gets {@link TEST_RUNNER_LIMITS}.maxWorkers - the enforced value of 1
 * - and returns before any host capability or override is even read, so a CI run
 * cannot be widened by an environment variable. A developer machine gets the
 * smallest of: half its logical CPUs, however many whole
 * {@link MAX_PROCESS_TREE_MEMORY_MIB} process trees fit in half of free memory,
 * and {@link MAX_BATCH_CONCURRENCY}. `TEST_BATCH_CONCURRENCY` overrides that
 * locally, still bounded by {@link MAX_BATCH_CONCURRENCY}.
 *
 * Note that this is *batch* concurrency, not `--test-concurrency`. Every batch
 * is a single file in its own process, so `--test-concurrency` - which caps how
 * many files one `node --test` process runs at once - has no effect on wall time
 * here and stays pinned at 1.
 */
export function resolveBatchConcurrency(
  inputs: BatchConcurrencyInputs = {},
): number {
  const env = inputs.env ?? process.env;
  if (isContinuousIntegration(env)) {
    return TEST_RUNNER_LIMITS.maxWorkers;
  }

  const memoryLimitMiB = inputs.memoryLimitMiB ?? MAX_PROCESS_TREE_MEMORY_MIB;
  const freeMemoryMiB = (inputs.freeMemoryBytes ?? os.freemem()) / 1024 / 1024;
  const memoryBudget = Math.floor(
    (freeMemoryMiB * BATCH_MEMORY_HEADROOM) / memoryLimitMiB,
  );
  const cpuBudget = Math.floor(
    (inputs.availableParallelism ?? os.availableParallelism()) / 2,
  );
  const ceiling = Math.max(
    1,
    Math.min(MAX_BATCH_CONCURRENCY, cpuBudget, memoryBudget),
  );

  const override = env.TEST_BATCH_CONCURRENCY;
  if (override === undefined || override.length === 0) {
    return ceiling;
  }
  const parsed = Number(override);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_BATCH_CONCURRENCY
  ) {
    throw new Error(
      `TEST_BATCH_CONCURRENCY must be an integer between 1 and ${MAX_BATCH_CONCURRENCY}.`,
    );
  }
  return parsed;
}

export function validateNodeOptions(nodeOptions: string | undefined): number {
  const limits = [
    ...(nodeOptions ?? "").matchAll(
      /(?:^|\s)--max-old-space-size(?:=|\s+)(?<limit>\d+)(?=\s|$)/gu,
    ),
  ].map((match) => Number.parseInt(match.groups?.limit ?? "", 10));
  if (limits.length === 0) {
    throw new Error(
      `NODE_OPTIONS must set --max-old-space-size=${MAX_OLD_SPACE_SIZE_MIB}.`,
    );
  }
  if (limits.some((limit) => limit > MAX_OLD_SPACE_SIZE_MIB)) {
    throw new Error(
      `NODE_OPTIONS old-space limit must not exceed ${MAX_OLD_SPACE_SIZE_MIB} MiB.`,
    );
  }
  return limits.at(-1) ?? MAX_OLD_SPACE_SIZE_MIB;
}

export function normalizeTestFilePath(file: string): string {
  const normalized = path.posix.normalize(
    file.replaceAll("\\", "/").replace(/^\.\/+/u, ""),
  );
  if (
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    (normalized !== RUNNER_CONTRACT_FILE &&
      !APP_TEST_FILE_PATTERN.test(normalized))
  ) {
    throw new Error(`Not an intended frontend test file: ${file}`);
  }
  return normalized;
}

export function discoverTestFiles(rootDir: string): string[] {
  const testDir = path.join(rootDir, "test");
  const entries = fs.readdirSync(testDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        APP_TEST_FILE_PATTERN.test(`test/${entry.name.replaceAll("\\", "/")}`),
    )
    .map((entry) => `test/${entry.name}`)
    .sort(compareOrdinal);
  const runnerContractPath = path.join(
    rootDir,
    ...RUNNER_CONTRACT_FILE.split("/"),
  );
  if (
    fs.existsSync(runnerContractPath) &&
    fs.statSync(runnerContractPath).isFile()
  ) {
    files.push(RUNNER_CONTRACT_FILE);
  }

  if (files.length === 0) {
    throw new Error(`No intended test files were discovered in ${testDir}.`);
  }
  return buildBatchPlan(files).flat();
}

export function buildBatchPlan(files: readonly string[]): string[][] {
  const normalizedFiles = files.map(normalizeTestFilePath);
  if (normalizedFiles.length === 0) {
    throw new Error("Cannot build an empty frontend test batch plan.");
  }
  const uniqueFiles = new Map<string, string>();
  for (const file of normalizedFiles) {
    const caseFolded = file.toLowerCase();
    const existing = uniqueFiles.get(caseFolded);
    if (existing !== undefined) {
      throw new Error(
        `Cannot build a batch plan containing duplicate test files: ${existing} and ${file}.`,
      );
    }
    uniqueFiles.set(caseFolded, file);
  }

  return normalizedFiles.sort(compareOrdinal).map((file) => [file]);
}

function optionName(argument: string): string {
  const equalsIndex = argument.indexOf("=");
  return equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
}

function optionValue(
  argument: string,
  nextArgument: string | undefined,
): string | undefined {
  const equalsIndex = argument.indexOf("=");
  return equalsIndex === -1 ? nextArgument : argument.slice(equalsIndex + 1);
}

export function matchesGlobPattern(value: string, pattern: string): boolean {
  const valueCodePoints = Array.from(value);
  const patternCodePoints = Array.from(pattern);
  let reachable = new Uint8Array(valueCodePoints.length + 1);
  reachable[0] = 1;

  for (
    let patternIndex = 0;
    patternIndex < patternCodePoints.length;
    patternIndex += 1
  ) {
    const character = patternCodePoints[patternIndex];
    const next = new Uint8Array(valueCodePoints.length + 1);
    const crossesDirectories =
      character === "*" && patternCodePoints[patternIndex + 1] === "*";
    if (crossesDirectories) {
      patternIndex += 1;
    }

    if (character === "*") {
      next[0] = reachable[0];
      for (
        let valueIndex = 1;
        valueIndex <= valueCodePoints.length;
        valueIndex += 1
      ) {
        next[valueIndex] =
          reachable[valueIndex] === 1 ||
          (next[valueIndex - 1] === 1 &&
            (crossesDirectories || valueCodePoints[valueIndex - 1] !== "/"))
            ? 1
            : 0;
      }
    } else {
      for (
        let valueIndex = 1;
        valueIndex <= valueCodePoints.length;
        valueIndex += 1
      ) {
        next[valueIndex] =
          reachable[valueIndex - 1] === 1 &&
          (character === "?"
            ? valueCodePoints[valueIndex - 1] !== "/"
            : valueCodePoints[valueIndex - 1] === character)
            ? 1
            : 0;
      }
    }
    reachable = next;
  }

  return reachable[valueCodePoints.length] === 1;
}

function matchesTestFilter(file: string, rawFilter: string): boolean {
  if (rawFilter.length > MAX_TEST_FILTER_LENGTH) {
    throw new Error(
      `Test filters must not exceed ${MAX_TEST_FILTER_LENGTH} characters.`,
    );
  }
  const filter = rawFilter
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
  const comparableFile = file.toLowerCase();
  if (filter === "test") {
    return comparableFile.startsWith("test/");
  }
  if (filter.includes("*") || filter.includes("?")) {
    return matchesGlobPattern(comparableFile, filter);
  }
  return comparableFile === filter || comparableFile.startsWith(`${filter}/`);
}

export function prepareTestInvocation(
  files: readonly string[],
  callerArguments: readonly string[],
): PreparedInvocation {
  const normalizedFiles = buildBatchPlan(files).flat();
  const forwardedArguments: string[] = [];
  const filters: string[] = [];
  let afterSeparator = false;
  let helpRequested = false;

  for (let index = 0; index < callerArguments.length; index += 1) {
    const argument = callerArguments[index];
    if (afterSeparator) {
      filters.push(argument);
      continue;
    }
    if (argument === "--") {
      afterSeparator = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      helpRequested = true;
      forwardedArguments.push(argument);
      continue;
    }
    if (argument.startsWith("-")) {
      const name = optionName(argument);
      if (UNSAFE_PERSISTENT_OPTIONS.has(name)) {
        throw new Error(
          `${name} is incompatible with the bounded one-shot test runner.`,
        );
      }
      if (UNSAFE_RESOURCE_OPTIONS.has(name)) {
        throw new Error(
          `${name} cannot override the bounded test-runner heap policy.`,
        );
      }

      forwardedArguments.push(argument);
      if (CALLER_OPTIONS_WITH_VALUES.has(name) && !argument.includes("=")) {
        const value = callerArguments[index + 1];
        if (value === undefined || value === "--") {
          throw new Error(`${name} requires a value.`);
        }
        forwardedArguments.push(value);
        index += 1;
      }

      if (name === "--test-concurrency") {
        const value = optionValue(argument, callerArguments[index]);
        if (value !== "1") {
          throw new Error(
            "--test-concurrency cannot override the enforced value of 1.",
          );
        }
      }
      continue;
    }

    filters.push(argument);
  }

  let selectedFiles = normalizedFiles;
  if (filters.length > 0 && !helpRequested) {
    for (const filter of filters) {
      if (!normalizedFiles.some((file) => matchesTestFilter(file, filter))) {
        throw new Error(`Test filter matched no intended files: ${filter}`);
      }
    }
    selectedFiles = normalizedFiles.filter((file) =>
      filters.some((filter) => matchesTestFilter(file, filter)),
    );
  }

  return {
    files: selectedFiles,
    forwardedArguments,
    helpRequested,
  };
}

function countCallerOption(
  callerArguments: readonly string[],
  name: string,
): number {
  return callerArguments.filter((argument) => optionName(argument) === name)
    .length;
}

export function buildNodeTestArguments(
  file: string,
  callerArguments: readonly string[],
  summaryFile: string,
): string[] {
  if (summaryFile.length === 0) {
    throw new Error("A TAP summary destination is required for every batch.");
  }
  const reporterCount = countCallerOption(callerArguments, "--test-reporter");
  const destinationCount = countCallerOption(
    callerArguments,
    "--test-reporter-destination",
  );
  if (destinationCount > reporterCount) {
    throw new Error(
      "Caller supplied more test reporter destinations than reporters.",
    );
  }
  const visibleReporterArguments =
    reporterCount === 0
      ? ["--test-reporter=spec", "--test-reporter-destination=stdout"]
      : Array.from(
          { length: reporterCount - destinationCount },
          () => "--test-reporter-destination=stdout",
        );

  return [
    "--import",
    "tsx",
    "--test",
    ...callerArguments,
    ...visibleReporterArguments,
    "--test-reporter=tap",
    `--test-reporter-destination=${summaryFile}`,
    "--test-concurrency=1",
    "--import",
    "./test/node-test-env.ts",
    normalizeTestFilePath(file),
  ];
}

export function parseTestSummary(output: string): TestSummary | null {
  const summary = emptySummary();
  const seen = new Set<keyof TestSummary>();
  const normalizedOutput = output.replace(ANSI_ESCAPE_PATTERN, "");

  for (const match of normalizedOutput.matchAll(SUMMARY_PATTERN)) {
    const field = match.groups?.field as keyof TestSummary | undefined;
    const count = match.groups?.count;
    if (field !== undefined && count !== undefined) {
      summary[field] = Number.parseInt(count, 10);
      seen.add(field);
    }
  }

  return seen.has("tests") && seen.has("pass") && seen.has("fail")
    ? summary
    : null;
}

export function parseWatchdogSummary(output: string): WatchdogSummary | null {
  const matches = [...output.matchAll(WATCHDOG_RESULT_PATTERN)];
  const match = matches.at(-1);
  if (match?.groups?.result === undefined) {
    return null;
  }

  const parsed = JSON.parse(match.groups.result) as Partial<WatchdogSummary>;
  if (
    typeof parsed.status !== "string" ||
    typeof parsed.exitCode !== "number" ||
    typeof parsed.hardMemoryLimitEnabled !== "boolean" ||
    typeof parsed.hardMemoryLimitBytes !== "number" ||
    typeof parsed.peakSingleRssBytes !== "number" ||
    typeof parsed.peakAggregateRssBytes !== "number" ||
    typeof parsed.peakJobCommitBytes !== "number"
  ) {
    throw new Error("The process-tree watchdog returned an invalid result.");
  }

  return {
    status: parsed.status,
    exitCode: parsed.exitCode,
    hardMemoryLimitEnabled: parsed.hardMemoryLimitEnabled,
    hardMemoryLimitBytes: parsed.hardMemoryLimitBytes,
    peakSingleRssBytes: parsed.peakSingleRssBytes,
    peakSingleRssMiB:
      parsed.peakSingleRssMiB ?? parsed.peakSingleRssBytes / 1024 / 1024,
    peakAggregateRssBytes: parsed.peakAggregateRssBytes,
    peakAggregateRssMiB:
      parsed.peakAggregateRssMiB ?? parsed.peakAggregateRssBytes / 1024 / 1024,
    peakJobCommitBytes: parsed.peakJobCommitBytes,
    peakJobCommitMiB:
      parsed.peakJobCommitMiB ?? parsed.peakJobCommitBytes / 1024 / 1024,
  };
}

function terminateProcessTree(
  processId: number,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    spawnSync(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/PID", String(processId), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    return;
  }

  signalPosixProcessGroup(processId, "SIGKILL");
}

function signalPosixProcessGroup(
  processId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function buildGuardedInvocation(options: RunGuardedProcessOptions): {
  command: string;
  arguments: string[];
  detached: boolean;
} {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      command: options.command,
      arguments: options.arguments,
      detached: true,
    };
  }

  const watchdogScript = path.join(
    options.cwd,
    "scripts",
    "run-with-process-tree-watchdog.ps1",
  );
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  return {
    command: powershell,
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      watchdogScript,
      "-FilePath",
      options.command,
      "-CommandArgumentsJson",
      JSON.stringify(options.arguments),
      "-WorkingDirectory",
      options.cwd,
      "-MemoryLimitMiB",
      String(options.memoryLimitMiB),
      "-TimeoutSeconds",
      String(Math.max(1, Math.ceil(options.timeoutMs / 1000))),
      "-PollIntervalMilliseconds",
      "100",
    ],
    detached: false,
  };
}

export async function runGuardedProcess(
  options: RunGuardedProcessOptions,
): Promise<GuardedProcessResult> {
  const platform = options.platform ?? process.platform;
  const invocation = buildGuardedInvocation(options);
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = spawn(invocation.command, invocation.arguments, {
    cwd: options.cwd,
    env: childEnvironment,
    detached: invocation.detached,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let abortedExitCode: number | null = null;
  let rootExitStatus: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  let settled = false;
  const writeOutput = options.writeOutput ?? true;

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    options.onStdout?.(text);
    if (writeOutput) {
      process.stdout.write(text);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    options.onStderr?.(text);
    if (writeOutput) {
      process.stderr.write(text);
    }
  });
  child.once("exit", (code, signal) => {
    rootExitStatus = { code, signal };
    if (platform !== "win32" && child.pid !== undefined) {
      signalPosixProcessGroup(child.pid, "SIGTERM");
    }
  });

  const abort = (): void => {
    if (settled || child.pid === undefined) {
      return;
    }
    if (rootExitStatus === null && abortedExitCode === null) {
      abortedExitCode = signalExitCode(options.signal?.reason) ?? 1;
    }
    terminateProcessTree(child.pid, platform);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    abort();
  }

  const emergencyTimeoutMs =
    platform === "win32" ? options.timeoutMs + 15_000 : options.timeoutMs;
  const emergencyTimeout = setTimeout(() => {
    if (child.pid !== undefined) {
      if (rootExitStatus === null && abortedExitCode === null) {
        abortedExitCode = 124;
      }
      terminateProcessTree(child.pid, platform);
    }
  }, emergencyTimeoutMs);
  emergencyTimeout.unref();

  return await new Promise<GuardedProcessResult>((resolve, reject) => {
    child.once("error", (error) => {
      settled = true;
      clearTimeout(emergencyTimeout);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      clearTimeout(emergencyTimeout);
      options.signal?.removeEventListener("abort", abort);

      const combinedOutput = `${stdout}\n${stderr}`;
      const rootCode = rootExitStatus === null ? code : rootExitStatus.code;
      const rootSignal =
        rootExitStatus === null ? signal : rootExitStatus.signal;
      resolve({
        exitCode:
          abortedExitCode ??
          rootCode ??
          (rootSignal === "SIGINT" ? 130 : rootSignal === "SIGTERM" ? 143 : 1),
        signal: rootSignal,
        stdout,
        stderr,
        watchdog: parseWatchdogSummary(combinedOutput),
      });
    });
  });
}

async function executeRealBatch(
  rootDir: string,
  batch: BatchDescriptor,
  signal: AbortSignal | undefined,
  writeOutput: boolean,
): Promise<BatchResult> {
  const result = await runGuardedProcess({
    command: process.execPath,
    arguments: batch.nodeArguments,
    cwd: rootDir,
    timeoutMs: batch.timeoutMs,
    memoryLimitMiB: batch.memoryLimitMiB,
    signal,
    writeOutput,
  });
  const summaryOutput = fs.existsSync(batch.summaryFile)
    ? fs.readFileSync(batch.summaryFile, "utf8")
    : "";

  return {
    ...result,
    summary: parseTestSummary(summaryOutput),
  };
}

export async function runTestSuite(
  options: RunTestSuiteOptions,
): Promise<TestSuiteResult> {
  const batches = buildBatchPlan(
    options.files ?? discoverTestFiles(options.rootDir),
  );
  const discoveredFiles = batches.flat();
  const completedFiles: string[] = [];
  const summary = emptySummary();
  const startedAt = Date.now();
  const universeFileCount = options.universeFileCount ?? discoveredFiles.length;
  const batchConcurrency = Math.max(
    1,
    options.batchConcurrency ?? TEST_RUNNER_LIMITS.maxWorkers,
  );
  let peakSingleRssBytes = 0;
  let peakAggregateRssBytes = 0;
  let firstFailure: { exitCode: number; file: string } | null = null;
  let failedBatches = 0;

  console.log(
    `[test-orchestrator] discovered=${universeFileCount} ` +
      `selected=${discoveredFiles.length} ` +
      `maxWorkers=${batchConcurrency} ` +
      `fileParallelism=${batchConcurrency > 1} ` +
      `filesPerBatch=${TEST_RUNNER_LIMITS.filesPerBatch}`,
  );

  const finish = (
    exitCode: number,
    failedFile: string | null,
  ): TestSuiteResult => {
    console.log(
      `[test-orchestrator] complete discovered=${universeFileCount} ` +
        `selected=${discoveredFiles.length} ` +
        `executed=${completedFiles.length}/${discoveredFiles.length} ` +
        `tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} ` +
        `cancelled=${summary.cancelled} skipped=${summary.skipped} todo=${summary.todo} ` +
        `failedBatches=${failedBatches} ` +
        `peakSingleRssMiB=${(peakSingleRssBytes / 1024 / 1024).toFixed(2)} ` +
        `peakAggregateRssMiB=${(peakAggregateRssBytes / 1024 / 1024).toFixed(2)}`,
    );
    return {
      exitCode,
      discoveredFiles,
      completedFiles,
      failedFile,
      summary,
      peakSingleRssBytes,
      peakAggregateRssBytes,
    };
  };

  // Results are recorded by batch index and only folded into the suite summary
  // once every worker has stopped, so the summary, the completed-file list and
  // the first-failure attribution are byte-for-byte independent of how many
  // batches ran side by side.
  const results: Array<BatchResult | null> = batches.map(() => null);
  let nextBatchIndex = 0;
  let stoppedFile: string | null = null;
  let timedOut = false;

  const runBatch = async (batchIndex: number, file: string): Promise<void> => {
    const summaryFile = path.join(
      os.tmpdir(),
      `better-cloudflare-test-summary-${process.pid}-${randomUUID()}.tap`,
    );
    const descriptor: BatchDescriptor = {
      file,
      index: batchIndex + 1,
      total: batches.length,
      nodeArguments: buildNodeTestArguments(
        file,
        options.callerArguments,
        summaryFile,
      ),
      summaryFile,
      timeoutMs: Math.min(
        options.batchTimeoutMs,
        options.suiteTimeoutMs - (Date.now() - startedAt),
      ),
      memoryLimitMiB: options.memoryLimitMiB,
    };
    console.log(
      `[test-orchestrator] batch=${descriptor.index}/${descriptor.total} file=${file}`,
    );

    try {
      results[batchIndex] = options.executeBatch
        ? await options.executeBatch(descriptor)
        : await executeRealBatch(
            options.rootDir,
            descriptor,
            options.signal,
            options.writeOutput ?? true,
          );
    } catch (error) {
      const detail =
        error instanceof Error ? (error.stack ?? error.message) : error;
      console.error(
        `[test-orchestrator] runner error file=${file}\n${String(detail)}`,
      );
      results[batchIndex] = {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: String(detail),
        watchdog: null,
        summary: null,
      };
    } finally {
      fs.rmSync(summaryFile, { force: true });
    }

    // Report the failure next to the output that produced it. Attribution of
    // the *first* failure still happens in the ordered pass below.
    const result = results[batchIndex];
    if (result !== null && result.exitCode !== 0) {
      console.error(
        `[test-orchestrator] failed file=${file} exitCode=${result.exitCode}`,
      );
    } else if (result !== null && result.summary === null) {
      console.error(
        `[test-orchestrator] missing node:test summary for passing file=${file}`,
      );
    }
  };

  const drainQueue = async (): Promise<void> => {
    while (nextBatchIndex < batches.length) {
      if (options.signal?.aborted || timedOut) {
        stoppedFile ??= batches[nextBatchIndex][0];
        return;
      }

      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      const [file] = batches[batchIndex];

      if (options.suiteTimeoutMs - (Date.now() - startedAt) <= 0) {
        timedOut = true;
        stoppedFile ??= file;
        failedBatches += 1;
        console.error(`[test-orchestrator] suite timeout before file=${file}`);
        return;
      }

      await runBatch(batchIndex, file);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(batchConcurrency, batches.length) }, () =>
      drainQueue(),
    ),
  );

  for (const [batchIndex, [file]] of batches.entries()) {
    const result = results[batchIndex];
    if (result === null) {
      continue;
    }

    if (result.watchdog !== null) {
      peakSingleRssBytes = Math.max(
        peakSingleRssBytes,
        result.watchdog.peakSingleRssBytes,
      );
      peakAggregateRssBytes = Math.max(
        peakAggregateRssBytes,
        result.watchdog.peakAggregateRssBytes,
      );
    }

    completedFiles.push(file);
    if (result.summary !== null) {
      addSummary(summary, result.summary);
    }

    if (result.exitCode !== 0) {
      firstFailure ??= { exitCode: result.exitCode, file };
      failedBatches += 1;
      continue;
    }

    if (result.summary === null) {
      firstFailure ??= { exitCode: 1, file };
      failedBatches += 1;
    }
  }

  if (options.signal?.aborted) {
    return finish(
      signalExitCode(options.signal.reason) ?? 1,
      firstFailure?.file ?? stoppedFile,
    );
  }
  if (timedOut) {
    return finish(124, firstFailure?.file ?? stoppedFile);
  }

  return finish(firstFailure?.exitCode ?? 0, firstFailure?.file ?? null);
}

export function installSignalHandlers(
  controller: AbortController,
  source: SignalSource = process,
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(new TestRunnerSignalError(signal));
      }
    };
    handlers.set(signal, handler);
    source.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      source.removeListener(signal, handler);
    }
  };
}

function runNodeHelp(
  callerArguments: readonly string[],
  rootDir: string,
): number {
  const result = spawnSync(process.execPath, [...callerArguments], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  return (
    result.status ??
    (result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1)
  );
}

async function main(): Promise<number> {
  const rootDir = process.cwd();
  const controller = new AbortController();
  const removeSignalHandlers = installSignalHandlers(controller);

  try {
    const universeFiles = discoverTestFiles(rootDir);
    const invocation = prepareTestInvocation(
      universeFiles,
      process.argv.slice(2),
    );
    if (invocation.helpRequested) {
      return runNodeHelp(process.argv.slice(2), rootDir);
    }
    validateNodeOptions(process.env.NODE_OPTIONS);

    const result = await runTestSuite({
      rootDir,
      callerArguments: invocation.forwardedArguments,
      batchTimeoutMs: readPositiveInteger("TEST_BATCH_TIMEOUT_MS", 180_000),
      suiteTimeoutMs: readPositiveInteger("TEST_SUITE_TIMEOUT_MS", 1_800_000),
      memoryLimitMiB: readPositiveInteger(
        "TEST_PROCESS_TREE_MEMORY_LIMIT_MIB",
        MAX_PROCESS_TREE_MEMORY_MIB,
        1,
        MAX_PROCESS_TREE_MEMORY_MIB,
      ),
      universeFileCount: universeFiles.length,
      files: invocation.files,
      signal: controller.signal,
      batchConcurrency: resolveBatchConcurrency(),
    });
    return signalExitCode(controller.signal.reason) ?? result.exitCode;
  } finally {
    removeSignalHandlers();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
