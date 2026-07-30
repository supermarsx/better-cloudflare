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
const MAX_PROCESS_TREE_MEMORY_MIB = 1792;
const MAX_OLD_SPACE_SIZE_MIB = 1536;

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
  peakSingleRssBytes: number;
  peakSingleRssMiB: number;
  peakAggregateRssBytes: number;
  peakAggregateRssMiB: number;
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

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if ("\\^$+.|(){}[]".includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`${source}$`, "u");
}

function matchesTestFilter(file: string, rawFilter: string): boolean {
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
    return globPatternToRegExp(filter).test(comparableFile);
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
    typeof parsed.peakSingleRssBytes !== "number" ||
    typeof parsed.peakAggregateRssBytes !== "number"
  ) {
    throw new Error("The process-tree watchdog returned an invalid result.");
  }

  return {
    status: parsed.status,
    exitCode: parsed.exitCode,
    peakSingleRssBytes: parsed.peakSingleRssBytes,
    peakSingleRssMiB:
      parsed.peakSingleRssMiB ?? parsed.peakSingleRssBytes / 1024 / 1024,
    peakAggregateRssBytes: parsed.peakAggregateRssBytes,
    peakAggregateRssMiB:
      parsed.peakAggregateRssMiB ?? parsed.peakAggregateRssBytes / 1024 / 1024,
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

  try {
    process.kill(-processId, "SIGKILL");
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

  const abort = (): void => {
    if (settled || child.pid === undefined) {
      return;
    }
    abortedExitCode = signalExitCode(options.signal?.reason) ?? 1;
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
      abortedExitCode = 124;
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
      resolve({
        exitCode:
          abortedExitCode ??
          code ??
          (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
        signal,
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
  let peakSingleRssBytes = 0;
  let peakAggregateRssBytes = 0;
  let firstFailure: { exitCode: number; file: string } | null = null;
  let failedBatches = 0;

  console.log(
    `[test-orchestrator] discovered=${universeFileCount} ` +
      `selected=${discoveredFiles.length} ` +
      `maxWorkers=${TEST_RUNNER_LIMITS.maxWorkers} ` +
      `fileParallelism=${TEST_RUNNER_LIMITS.fileParallelism} ` +
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

  for (const [batchIndex, [file]] of batches.entries()) {
    if (options.signal?.aborted) {
      return finish(
        signalExitCode(options.signal.reason) ?? 1,
        firstFailure?.file ?? file,
      );
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingSuiteMs = options.suiteTimeoutMs - elapsedMs;
    if (remainingSuiteMs <= 0) {
      failedBatches += 1;
      console.error(`[test-orchestrator] suite timeout before file=${file}`);
      return finish(124, firstFailure?.file ?? file);
    }

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
      timeoutMs: Math.min(options.batchTimeoutMs, remainingSuiteMs),
      memoryLimitMiB: options.memoryLimitMiB,
    };
    console.log(
      `[test-orchestrator] batch=${descriptor.index}/${descriptor.total} file=${file}`,
    );

    let result: BatchResult;
    try {
      result = options.executeBatch
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
      result = {
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
      console.error(
        `[test-orchestrator] failed file=${file} exitCode=${result.exitCode}`,
      );
      continue;
    }

    if (result.summary === null) {
      firstFailure ??= { exitCode: 1, file };
      failedBatches += 1;
      console.error(
        `[test-orchestrator] missing node:test summary for passing file=${file}`,
      );
    }
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
