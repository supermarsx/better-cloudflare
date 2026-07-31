import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  TestRunnerSignalError,
  buildBatchPlan,
  buildNodeTestArguments,
  discoverTestFiles,
  installSignalHandlers,
  matchesGlobPattern,
  normalizeTestFilePath,
  prepareTestInvocation,
  runGuardedProcess,
  runTestSuite,
  validateNodeOptions,
  type BatchResult,
  type TestSummary,
} from "./run-tests-seq.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const liveFixtureProcessIds = new Set<number>();

function passingSummary(tests = 1): TestSummary {
  return {
    tests,
    pass: tests,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
}

function fakeBatchResult(
  exitCode: number,
  summary: TestSummary | null,
): BatchResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr: "",
    watchdog: null,
    summary,
  };
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killProcessTree(processId: number): void {
  if (!processExists(processId)) {
    liveFixtureProcessIds.delete(processId);
    return;
  }

  if (process.platform === "win32") {
    spawnSync(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/PID", String(processId), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
  } else {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  liveFixtureProcessIds.delete(processId);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function createProcessTreeFixture(directory: string): {
  parentScript: string;
  stateFile: string;
} {
  const childScript = path.join(directory, "child.mjs");
  const parentScript = path.join(directory, "parent.mjs");
  const stateFile = path.join(directory, "process-tree.json");

  fs.writeFileSync(
    childScript,
    [
      'import fs from "node:fs";',
      "fs.writeFileSync(process.argv[2], String(process.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    parentScript,
    [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'const childStdio = process.argv[6] === "inherit" ? "inherit" : "ignore";',
      "const exitCode = Number(process.argv[5]);",
      "const child = spawn(process.execPath, [process.argv[3], process.argv[2]], {",
      "  stdio: childStdio,",
      '  detached: process.platform === "win32",',
      "});",
      "if (Number.isInteger(exitCode)) child.unref();",
      "fs.writeFileSync(",
      "  process.argv[4],",
      "  JSON.stringify({ parent: process.pid, child: child.pid }),",
      ");",
      'console.log("PROCESS_TREE_FIXTURE_READY");',
      "if (Number.isInteger(exitCode)) {",
      "  setTimeout(() => process.exit(exitCode), 100);",
      "} else {",
      "setInterval(() => {}, 1000);",
      "}",
      "",
    ].join("\n"),
  );

  return { parentScript, stateFile };
}

function readFixtureProcessIds(stateFile: string): {
  parent: number;
  child: number;
} {
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    parent: number;
    child: number;
  };
  liveFixtureProcessIds.add(parsed.parent);
  liveFixtureProcessIds.add(parsed.child);
  return parsed;
}

test("discovery is deterministic and includes every intended file once", () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "better-cloudflare-discovery-"),
  );
  const testDir = path.join(fixtureRoot, "test");
  const scriptsDir = path.join(fixtureRoot, "scripts");
  fs.mkdirSync(path.join(testDir, "nested"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  try {
    for (const file of [
      "zeta.test.ts",
      "Alpha.test.tsx",
      "middle.test.ts",
      "ignored.spec.ts",
      "ignored.test.js",
      "helper.ts",
    ]) {
      fs.writeFileSync(path.join(testDir, file), "");
    }
    fs.writeFileSync(path.join(testDir, "nested", "nested.test.ts"), "");
    fs.writeFileSync(
      path.join(scriptsDir, "run-tests-seq.contract.test.ts"),
      "",
    );

    const firstDiscovery = discoverTestFiles(fixtureRoot);
    const secondDiscovery = discoverTestFiles(fixtureRoot);
    assert.deepEqual(firstDiscovery, [
      "scripts/run-tests-seq.contract.test.ts",
      "test/Alpha.test.tsx",
      "test/middle.test.ts",
      "test/zeta.test.ts",
    ]);
    assert.deepEqual(secondDiscovery, firstDiscovery);

    const batches = buildBatchPlan(firstDiscovery);
    assert.deepEqual(batches.flat(), firstDiscovery);
    assert.equal(new Set(batches.flat()).size, firstDiscovery.length);
    assert.ok(batches.every((batch) => batch.length === 1));
    assert.throws(
      () => buildBatchPlan([...firstDiscovery, firstDiscovery[0]]),
      /duplicate test files/u,
    );
    assert.throws(() => buildBatchPlan([]), /empty frontend test/u);
    assert.throws(
      () => buildBatchPlan(["test/Alpha.test.tsx", "test\\alpha.test.tsx"]),
      /duplicate test files/u,
    );
    assert.equal(
      normalizeTestFilePath(".\\test\\middle.test.ts"),
      "test/middle.test.ts",
    );
    assert.throws(
      () => normalizeTestFilePath("../test/middle.test.ts"),
      /Not an intended frontend test file/u,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("caller arguments are forwarded unchanged to every deterministic batch", async () => {
  const files = ["test/zeta.test.ts", "test/Alpha.test.tsx"];
  const callerArguments = [
    "--test-name-pattern",
    "preserves caller input",
    "--test-reporter=spec",
  ];
  const observedArguments: string[][] = [];
  const observedSummaryFiles: string[] = [];

  const result = await runTestSuite({
    rootDir: repositoryRoot,
    callerArguments,
    batchTimeoutMs: 10_000,
    suiteTimeoutMs: 20_000,
    memoryLimitMiB: 256,
    files,
    writeOutput: false,
    executeBatch: async (batch) => {
      observedArguments.push(batch.nodeArguments);
      observedSummaryFiles.push(batch.summaryFile);
      return fakeBatchResult(0, passingSummary(2));
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.discoveredFiles, [
    "test/Alpha.test.tsx",
    "test/zeta.test.ts",
  ]);
  assert.deepEqual(result.completedFiles, result.discoveredFiles);
  assert.equal(result.summary.tests, 4);
  assert.equal(result.summary.pass, 4);

  for (const [index, file] of result.discoveredFiles.entries()) {
    assert.deepEqual(
      observedArguments[index],
      buildNodeTestArguments(
        file,
        callerArguments,
        observedSummaryFiles[index],
      ),
    );
    assert.deepEqual(
      observedArguments[index].slice(3, 3 + callerArguments.length),
      callerArguments,
    );
    assert.ok(observedArguments[index].includes("--test-concurrency=1"));
    assert.equal(observedArguments[index].at(-1), file);
  }
});

test("filters, help, reporting, and concurrency overrides are handled safely", () => {
  const files = [
    "scripts/run-tests-seq.contract.test.ts",
    "test/Alpha.test.tsx",
    "test/zeta.test.ts",
  ];
  const callerArguments = [
    "--test-name-pattern",
    "preserves caller input",
    "--test-reporter=dot",
    "--",
    "test/zeta.test.ts",
  ];
  const prepared = prepareTestInvocation(files, callerArguments);

  assert.deepEqual(prepared.files, ["test/zeta.test.ts"]);
  assert.deepEqual(prepared.forwardedArguments, [
    "--test-name-pattern",
    "preserves caller input",
    "--test-reporter=dot",
  ]);
  assert.equal(prepared.helpRequested, false);

  const summaryFile = path.join(os.tmpdir(), "runner-summary.tap");
  const nodeArguments = buildNodeTestArguments(
    prepared.files[0],
    prepared.forwardedArguments,
    summaryFile,
  );
  assert.deepEqual(
    nodeArguments.slice(3, 3 + prepared.forwardedArguments.length),
    prepared.forwardedArguments,
  );
  assert.ok(nodeArguments.includes("--test-reporter=dot"));
  assert.ok(nodeArguments.includes("--test-reporter-destination=stdout"));
  assert.ok(nodeArguments.includes("--test-reporter=tap"));
  assert.ok(
    nodeArguments.includes(`--test-reporter-destination=${summaryFile}`),
  );
  assert.ok(
    nodeArguments.lastIndexOf("--test-concurrency=1") >
      nodeArguments.lastIndexOf("--test-reporter=dot"),
  );

  assert.equal(prepareTestInvocation(files, ["--help"]).helpRequested, true);
  assert.deepEqual(prepareTestInvocation(files, ["test/ZETA.test.ts"]).files, [
    "test/zeta.test.ts",
  ]);
  assert.deepEqual(
    prepareTestInvocation(
      [...files, "test/meta+[1].test.ts"],
      ["test/meta+[?].test.ts"],
    ).files,
    ["test/meta+[1].test.ts"],
  );
  assert.deepEqual(
    [
      matchesGlobPattern("test/😀.test.ts", "test/?.test.ts"),
      matchesGlobPattern("test/😀.test.ts", "test?😀.test.ts"),
    ],
    [true, false],
  );
  assert.throws(
    () => prepareTestInvocation(files, ["*".repeat(1025)]),
    /must not exceed 1024/u,
  );
  assert.throws(
    () => prepareTestInvocation(files, ["--test-concurrency=8"]),
    /cannot override/u,
  );
  assert.throws(
    () => prepareTestInvocation(files, ["--watch"]),
    /incompatible/u,
  );
  assert.throws(
    () => prepareTestInvocation(files, ["--max-old-space-size=4096"]),
    /heap policy/u,
  );
  assert.throws(
    () => prepareTestInvocation(files, ["--", "test/missing.test.ts"]),
    /matched no intended files/u,
  );

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(
    packageJson.scripts.test,
    /NODE_OPTIONS=--max-old-space-size=1536/u,
  );
  assert.equal(
    validateNodeOptions("--trace-warnings --max-old-space-size=1536"),
    1536,
  );
  assert.throws(
    () => validateNodeOptions("--max-old-space-size=1537"),
    /must not exceed 1536/u,
  );
  assert.throws(() => validateNodeOptions(undefined), /must set/u);
});

test("a failing batch propagates its exit code without omitting later files", async () => {
  const files = ["test/01.test.ts", "test/02.test.ts", "test/03.test.ts"];
  const executedFiles: string[] = [];

  const result = await runTestSuite({
    rootDir: repositoryRoot,
    callerArguments: [],
    batchTimeoutMs: 10_000,
    suiteTimeoutMs: 20_000,
    memoryLimitMiB: 256,
    files,
    writeOutput: false,
    executeBatch: async (batch) => {
      executedFiles.push(batch.file);
      return batch.file.endsWith("02.test.ts")
        ? fakeBatchResult(37, null)
        : fakeBatchResult(0, passingSummary());
    },
  });

  assert.equal(result.exitCode, 37);
  assert.equal(result.failedFile, "test/02.test.ts");
  assert.deepEqual(executedFiles, files);
  assert.deepEqual(result.completedFiles, files);
  assert.equal(result.summary.tests, 2);
  assert.equal(result.summary.pass, 2);
});

test(
  "a custom visible reporter still produces an exact machine summary",
  { timeout: 45_000 },
  async () => {
    const fixtureFile = `test/.runner-reporter-${process.pid}-${randomUUID()}.test.ts`;
    const fixturePath = path.join(repositoryRoot, ...fixtureFile.split("/"));
    fs.writeFileSync(
      fixturePath,
      [
        'import { test } from "node:test";',
        'test("runner reporter fixture", () => {});',
        "",
      ].join("\n"),
      { flag: "wx" },
    );
    assert.throws(
      () => fs.writeFileSync(fixturePath, "collision", { flag: "wx" }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
    );

    try {
      const result = await runTestSuite({
        rootDir: repositoryRoot,
        callerArguments: ["--test-reporter=dot"],
        batchTimeoutMs: 30_000,
        suiteTimeoutMs: 40_000,
        memoryLimitMiB: 512,
        files: [fixtureFile],
        writeOutput: false,
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.completedFiles, [fixtureFile]);
      assert.deepEqual(result.summary, passingSummary());
    } finally {
      fs.rmSync(fixturePath, { force: true });
    }
  },
);

test(
  "guarded invocation preserves spaces, quotes, slashes, and Unicode",
  { timeout: 30_000 },
  async () => {
    const expected = ["space value", 'quote"value', "trailing\\", "Unicode ✓"];
    const result = await runGuardedProcess({
      command: process.execPath,
      arguments: [
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1)))",
        "--",
        ...expected,
      ],
      cwd: repositoryRoot,
      timeoutMs: 15_000,
      memoryLimitMiB: 512,
      writeOutput: false,
    });
    const argumentLine = result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith("["));

    assert.equal(result.exitCode, 0);
    if (process.platform === "win32") {
      assert.equal(result.watchdog?.hardMemoryLimitEnabled, true);
      assert.equal(result.watchdog?.hardMemoryLimitBytes, 512 * 1024 * 1024);
      assert.ok((result.watchdog?.peakJobCommitBytes ?? 0) > 0);
      assert.ok(
        (result.watchdog?.peakJobCommitBytes ?? Number.POSITIVE_INFINITY) <=
          512 * 1024 * 1024,
      );
    }
    assert.notEqual(argumentLine, undefined);
    assert.deepEqual(JSON.parse(argumentLine ?? "[]"), expected);
  },
);

test(
  "normal and failing roots release inherited-output descendants",
  { timeout: 30_000 },
  async () => {
    for (const exitCode of [0, 37]) {
      const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `better-cloudflare-release-${exitCode}-`),
      );
      const { parentScript, stateFile } = createProcessTreeFixture(fixtureRoot);
      const childPidFile = path.join(fixtureRoot, "child.pid");

      try {
        const resultPromise = runGuardedProcess({
          command: process.execPath,
          arguments: [
            parentScript,
            childPidFile,
            path.join(fixtureRoot, "child.mjs"),
            stateFile,
            String(exitCode),
            "inherit",
          ],
          cwd: repositoryRoot,
          timeoutMs: 10_000,
          memoryLimitMiB: 512,
          writeOutput: false,
        });
        await waitFor(
          () => fs.existsSync(stateFile),
          15_000,
          `the exit-${exitCode} fixture to start`,
        );
        const processIds = readFixtureProcessIds(stateFile);
        const result = await resultPromise;

        assert.equal(result.exitCode, exitCode);
        assert.match(result.stdout, /PROCESS_TREE_FIXTURE_READY/u);
        await waitFor(
          () =>
            !processExists(processIds.parent) &&
            !processExists(processIds.child),
          5_000,
          `the exit-${exitCode} process tree to be released`,
        );
      } finally {
        for (const processId of [...liveFixtureProcessIds]) {
          killProcessTree(processId);
        }
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  },
);

test(
  "watchdog streams child output before terminating a timed-out tree",
  { timeout: 30_000 },
  async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "better-cloudflare-streaming-"),
    );
    const { parentScript, stateFile } = createProcessTreeFixture(fixtureRoot);
    const childPidFile = path.join(fixtureRoot, "child.pid");
    let streamedOutput = "";

    try {
      const resultPromise = runGuardedProcess({
        command: process.execPath,
        arguments: [
          parentScript,
          childPidFile,
          path.join(fixtureRoot, "child.mjs"),
          stateFile,
        ],
        cwd: repositoryRoot,
        timeoutMs: 5_000,
        memoryLimitMiB: 512,
        writeOutput: false,
        onStdout: (text) => {
          streamedOutput += text;
        },
      });
      await waitFor(
        () => streamedOutput.includes("PROCESS_TREE_FIXTURE_READY"),
        4_000,
        "the watchdog to stream child output before timeout",
      );
      const processIds = readFixtureProcessIds(stateFile);
      const result = await resultPromise;

      assert.equal(result.exitCode, 124);
      await waitFor(
        () =>
          !processExists(processIds.parent) && !processExists(processIds.child),
        5_000,
        "the streamed timeout process tree to exit",
      );
    } finally {
      for (const processId of [...liveFixtureProcessIds]) {
        killProcessTree(processId);
      }
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a timed-out command kills its complete process tree",
  { timeout: 30_000 },
  async () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "better-cloudflare-timeout-"),
    );
    const { parentScript, stateFile } = createProcessTreeFixture(fixtureRoot);
    const childPidFile = path.join(fixtureRoot, "child.pid");

    try {
      const resultPromise = runGuardedProcess({
        command: process.execPath,
        arguments: [
          parentScript,
          childPidFile,
          path.join(fixtureRoot, "child.mjs"),
          stateFile,
        ],
        cwd: repositoryRoot,
        timeoutMs: 5_000,
        memoryLimitMiB: 512,
        writeOutput: false,
      });
      await waitFor(
        () => fs.existsSync(stateFile),
        15_000,
        "the timeout fixture to start",
      );
      const processIds = readFixtureProcessIds(stateFile);
      const result = await resultPromise;

      assert.equal(result.exitCode, 124);
      await waitFor(
        () =>
          !processExists(processIds.parent) && !processExists(processIds.child),
        5_000,
        "the timed-out process tree to exit",
      );
    } finally {
      for (const processId of [...liveFixtureProcessIds]) {
        killProcessTree(processId);
      }
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test("suite cancellation propagates signal exit and identifies the active file", async () => {
  const controller = new AbortController();
  const files = ["test/01.test.ts", "test/02.test.ts"];
  const executedFiles: string[] = [];

  const result = await runTestSuite({
    rootDir: repositoryRoot,
    callerArguments: [],
    batchTimeoutMs: 10_000,
    suiteTimeoutMs: 20_000,
    memoryLimitMiB: 256,
    signal: controller.signal,
    files,
    writeOutput: false,
    executeBatch: async (batch) => {
      executedFiles.push(batch.file);
      controller.abort(new TestRunnerSignalError("SIGTERM"));
      return fakeBatchResult(143, null);
    },
  });

  assert.equal(result.exitCode, 143);
  assert.equal(result.failedFile, "test/01.test.ts");
  assert.deepEqual(executedFiles, ["test/01.test.ts"]);
  assert.deepEqual(result.completedFiles, ["test/01.test.ts"]);
});

test(
  "signal cancellation cleans the active process tree and handlers",
  { timeout: 30_000 },
  async () => {
    const source = new EventEmitter();
    const controller = new AbortController();
    const removeSignalHandlers = installSignalHandlers(controller, source);
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "better-cloudflare-signal-"),
    );
    const { parentScript, stateFile } = createProcessTreeFixture(fixtureRoot);
    const childPidFile = path.join(fixtureRoot, "child.pid");

    try {
      const resultPromise = runGuardedProcess({
        command: process.execPath,
        arguments: [
          parentScript,
          childPidFile,
          path.join(fixtureRoot, "child.mjs"),
          stateFile,
        ],
        cwd: repositoryRoot,
        timeoutMs: 20_000,
        memoryLimitMiB: 512,
        signal: controller.signal,
        writeOutput: false,
      });
      await waitFor(
        () => fs.existsSync(stateFile),
        15_000,
        "the signal fixture to start",
      );
      const processIds = readFixtureProcessIds(stateFile);

      source.emit("SIGTERM");
      const result = await resultPromise;
      assert.equal(result.exitCode, 143);
      assert.ok(controller.signal.reason instanceof TestRunnerSignalError);
      assert.equal(controller.signal.reason.signal, "SIGTERM");

      await waitFor(
        () =>
          !processExists(processIds.parent) && !processExists(processIds.child),
        5_000,
        "the signalled process tree to exit",
      );

      removeSignalHandlers();
      assert.equal(source.listenerCount("SIGINT"), 0);
      assert.equal(source.listenerCount("SIGTERM"), 0);
    } finally {
      removeSignalHandlers();
      for (const processId of [...liveFixtureProcessIds]) {
        killProcessTree(processId);
      }
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
