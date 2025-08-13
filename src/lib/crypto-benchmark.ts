import { CryptoManager, cryptoManager } from './crypto.ts';

export const MAX_BENCHMARK_ITERATIONS = 1_000_000;

export async function benchmark(iterations: number = 10000): Promise<number> {
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > MAX_BENCHMARK_ITERATIONS) {
    throw new Error(`Iterations must be a positive integer not exceeding ${MAX_BENCHMARK_ITERATIONS}`);
  }

  const start = performance.now();
  const password = 'test-password';
  const data = 'test-data';

  const config = { ...cryptoManager.getConfig(), iterations };
  const tempCrypto = new CryptoManager(config);

  await tempCrypto.encrypt(data, password);
  return performance.now() - start;
}
