import assert from "node:assert/strict";

import {
  reportRuntimeError,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting.ts";
import { createTrackedRuntimeResources } from "../src/lib/runtime/resource-scope.ts";

if (typeof globalThis.gc !== "function") {
  throw new Error(
    "The memory smoke requires --expose-gc so retained heap can be sampled after collection.",
  );
}

const cycles = Number.parseInt(process.env.MEMORY_SMOKE_CYCLES ?? "25", 10);
const resourcesPerCycle = Number.parseInt(
  process.env.MEMORY_SMOKE_RESOURCES ?? "1000",
  10,
);

if (
  !Number.isSafeInteger(cycles) ||
  cycles < 1 ||
  !Number.isSafeInteger(resourcesPerCycle) ||
  resourcesPerCycle < 1
) {
  throw new Error("Memory smoke cycle and resource counts must be positive.");
}

let nextId = 1;
const timeouts = new Map();
const frames = new Map();
const host = {
  setTimeout(callback) {
    const id = nextId++;
    timeouts.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    timeouts.delete(id);
  },
  requestAnimationFrame(callback) {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  },
  cancelAnimationFrame(id) {
    frames.delete(id);
  },
};

function exerciseCycle(cycle) {
  const resources = createTrackedRuntimeResources(host);
  for (let index = 0; index < resourcesPerCycle; index += 1) {
    resources.setTimeout(() => index + cycle, 60_000);
    resources.requestAnimationFrame(() => index + cycle);
  }
  resources.dispose();
  resources.dispose();

  for (let index = 0; index < 150; index += 1) {
    reportRuntimeError(new Error(`memory smoke ${cycle}:${index}`), {
      source: "runtime",
      label: "Manual memory growth smoke",
    });
  }
  resetRuntimeReportingForTests();

  assert.deepEqual(resources.snapshot(), {
    timeouts: 0,
    animationFrames: 0,
  });
  assert.equal(timeouts.size, 0);
  assert.equal(frames.size, 0);
}

for (let warmup = 0; warmup < 3; warmup += 1) {
  exerciseCycle(-warmup - 1);
}
globalThis.gc();
const baselineHeap = process.memoryUsage().heapUsed;
const samples = [];

for (let cycle = 0; cycle < cycles; cycle += 1) {
  exerciseCycle(cycle);
  globalThis.gc();
  samples.push(process.memoryUsage().heapUsed);
}

const finalHeap = samples.at(-1) ?? baselineHeap;
const peakHeap = Math.max(baselineHeap, ...samples);
const retainedDelta = finalHeap - baselineHeap;

console.log(
  JSON.stringify(
    {
      cycles,
      resourcesPerCycle,
      baselineHeapBytes: baselineHeap,
      finalHeapBytes: finalHeap,
      retainedDeltaBytes: retainedDelta,
      peakHeapBytes: peakHeap,
      deterministicResourcesRetained: {
        timeouts: timeouts.size,
        animationFrames: frames.size,
      },
      note: "Heap values are informational; CI gates deterministic resource counts, not runner-dependent RSS.",
    },
    null,
    2,
  ),
);
