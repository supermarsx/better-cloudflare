import { CryptoManager, cryptoManager } from "./crypto";

/**
 * Upper limit for iterations used by the benchmark to avoid excessive CPU
 * usage in the browser.
 */
export const MAX_BENCHMARK_ITERATIONS = 1_000_000;

/**
 * Run a quick benchmark for the configured iterations value by performing
 * a single encrypt operation and returning the elapsed time in
 * milliseconds. This helps estimate the performance cost for PBKDF2
 * iteration settings.
 *
 * @param iterations - number of PBKDF2 iterations to benchmark
 * @returns elapsed time in milliseconds
 */
export async function benchmark(iterations: number = 10000): Promise<number> {
  if (
    !Number.isInteger(iterations) ||
    iterations <= 0 ||
    iterations > MAX_BENCHMARK_ITERATIONS
  ) {
    throw new Error(
      `Iterations must be a positive integer not exceeding ${MAX_BENCHMARK_ITERATIONS}`,
    );
  }

  const start = performance.now();
  const password = "test-password";
  const data = "test-data";

  const config = { ...cryptoManager.getConfig(), iterations };
  const tempCrypto = new CryptoManager(config);

  await tempCrypto.encrypt(data, password);
  return performance.now() - start;
}
