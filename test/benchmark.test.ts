import assert from "node:assert/strict";
import { test } from "node:test";
import {
  benchmark,
  MAX_BENCHMARK_ITERATIONS,
} from "../src/lib/crypto-benchmark.ts";

const TOLERANCE_MS = 50;

test("benchmark returns positive duration", async () => {
  const result = await benchmark(10);
  assert.ok(result >= 0);
});

test("benchmark timing roughly matches external measurement", async () => {
  const start = performance.now();
  const result = await benchmark(10);
  const total = performance.now() - start;
  assert.ok(Math.abs(total - result) < TOLERANCE_MS);
});

test("benchmark rejects invalid iterations", async () => {
  await assert.rejects(() => benchmark(0), /positive integer/);
  await assert.rejects(
    () => benchmark(MAX_BENCHMARK_ITERATIONS + 1),
    /not exceeding/,
  );
  await assert.rejects(() => benchmark(1.5), /positive integer/);
});
