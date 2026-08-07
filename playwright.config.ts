import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BASE_PORT,
  basePortFrom,
  isPinnedPort,
} from "./scripts/dev-port.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function normalizeStaticBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * Playwright's `webServer.url` is static configuration and the config module is
 * loaded synchronously, so this is the one consumer that cannot be handed a port
 * *after* its server bound. It resolves one up front instead:
 *
 *  - CI, or an explicit `PORT`, is used verbatim - no probing at all, so CI stays
 *    exactly as deterministic as it was.
 *  - Locally, an already running `npm run dev` is joined at whatever port it
 *    published (`reuseExistingServer` then skips starting a second one).
 *  - Otherwise a free port is reserved by really binding it, and passed down to
 *    `npm run dev` through `PORT`. That makes the port pinned for the child,
 *    which retries the *same* port on `EADDRINUSE` rather than drifting off it -
 *    so the brief gap between releasing the reservation and Next binding cannot
 *    silently desynchronise the two.
 *
 * The resolution runs in a child process because it needs a real socket bind,
 * which has no synchronous API.
 */
export function resolveDevServerPort(isCI: boolean): number {
  if (isCI || isPinnedPort()) return basePortFrom();

  try {
    const resolved = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "dev-port.mjs"), "--reuse"],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    ).trim();
    const port = Number.parseInt(resolved, 10);
    return Number.isSafeInteger(port) && port > 0 ? port : DEFAULT_BASE_PORT;
  } catch {
    return DEFAULT_BASE_PORT;
  }
}

export function createPlaywrightConfig(
  isCI = Boolean(process.env.CI),
  requestedStaticBasePath = process.env.PLAYWRIGHT_STATIC_BASE_PATH,
  port = resolveDevServerPort(isCI),
) {
  const staticBasePath = isCI
    ? normalizeStaticBasePath(requestedStaticBasePath)
    : "";
  const origin = `http://localhost:${port}`;
  const ciBaseURL = `${origin}${staticBasePath}`;

  return defineConfig({
    testDir: ".",
    testMatch: [
      "e2e/**/*.spec.ts",
      "test/ci-pages-base-path.spec.ts",
      "test/ci-playwright-runtime.spec.ts",
    ],
    timeout: 30_000,
    expect: { timeout: 5000 },
    fullyParallel: !isCI,
    forbidOnly: isCI,
    retries: 0,
    workers: isCI ? 1 : undefined,
    reporter: "line",
    outputDir: "test-results/playwright",
    projects: [
      {
        name: "chromium",
        use: { browserName: "chromium" },
      },
    ],
    use: {
      headless: true,
      viewport: { width: 1280, height: 720 },
      actionTimeout: 10_000,
      baseURL: isCI ? ciBaseURL : origin,
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "retain-on-failure",
    },
    webServer: {
      command: isCI ? "npm run serve:e2e:ci" : "npm run dev",
      url: isCI ? `${ciBaseURL}/` : origin,
      env: { PORT: String(port) },
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  });
}

export default createPlaywrightConfig();
