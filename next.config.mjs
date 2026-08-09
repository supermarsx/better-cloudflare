import os from "node:os";

/**
 * `CI` is the repository-wide signal for "this is a bounded shared runner"
 * (see `scripts/dev-port.mjs` and `playwright.config.ts`, which read it the
 * same way). Anything that trades memory for speed stays off when it is set.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isContinuousIntegration(env = process.env) {
  const value = env.CI;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

const bounded = isContinuousIntegration();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  experimental: {
    // Keep static-export builds within the repository's CI memory budget: one
    // static worker, and no build-trace worker running alongside the compiler.
    // A developer machine is not memory-bound, so it gets one worker per page
    // (Next caps this at `pages + 1` anyway) and overlaps trace collection with
    // the rest of the build. Neither knob changes a single emitted byte - both
    // only decide how many processes do the same work.
    cpus: bounded ? 1 : Math.max(1, Math.min(8, os.availableParallelism())),
    parallelServerBuildTraces: !bounded,
  },
};

export default nextConfig;
