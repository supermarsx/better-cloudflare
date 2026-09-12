import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { basePortFrom, parsePort } from "./scripts/dev-port.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Enough for a cold identity probe on both loopback addresses - the first
 * request to a dev server compiles the route - plus a port search.
 */
const RESOLVER_TIMEOUT_MS = 90_000;

export interface DevServerResolution {
  port: number;
  /**
   * Whether a dev server already on `port` was verified as this checkout's.
   * Only then may Playwright reuse it.
   */
  reuse: boolean;
}

/**
 * Resolves the port *and* the reuse decision before Playwright sees the config.
 *
 * Both have to be decided here. Playwright's own `reuseExistingServer` check is
 * an HTTP status and nothing more - any 200-403 counts - so left to itself it
 * adopts whatever answers on the port. That is how a local run once executed
 * the whole suite against a different Next.js application that happened to hold
 * port 3000.
 *
 * `webServer.url` is static configuration and the config module loads
 * synchronously, so the resolution runs in a child process (it needs real
 * sockets and HTTP) and blocks:
 *
 *  - CI uses its fixed port verbatim and never reuses, with no probing at all,
 *    so CI stays exactly as deterministic as it was.
 *  - Locally, a dev server this checkout launched is reused only after it
 *    re-proves its identity token on every loopback address. Otherwise a port
 *    that is free on every loopback address is chosen, and Playwright starts
 *    `npm run dev` pinned to it - which verifies what it started. An explicit
 *    `PORT` is honoured the same way and never climbed.
 *  - A resolution that fails throws. Nothing is guessed: a guessed port is how
 *    a run ends up testing someone else's application.
 */
export function resolveDevServer(isCI: boolean): DevServerResolution {
  if (isCI) return { port: basePortFrom(), reuse: false };

  let printed: string;
  try {
    printed = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "dev-port.mjs"), "--reuse", "--json"],
      { cwd: repoRoot, encoding: "utf8", timeout: RESOLVER_TIMEOUT_MS },
    ).trim();
  } catch (error) {
    throw new Error(
      "Playwright could not resolve a dev server port it can trust: " +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "No port was guessed. Set PORT to pin a free port explicitly.",
      { cause: error },
    );
  }

  const resolution = parseResolution(printed);
  if (resolution === null) {
    throw new Error(
      `The dev port resolver printed an unusable answer: ${JSON.stringify(printed)}`,
    );
  }
  return resolution;
}

function parseResolution(printed: string): DevServerResolution | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(printed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { port, reuse } = parsed as { port?: unknown; reuse?: unknown };
  const validPort = parsePort(port);
  return validPort !== null && typeof reuse === "boolean"
    ? { port: validPort, reuse }
    : null;
}

/** The port half of {@link resolveDevServer}. */
export function resolveDevServerPort(isCI: boolean): number {
  return resolveDevServer(isCI).port;
}

/**
 * @param port When given, the resolution is skipped and `reuse` is taken as
 *   stated - it defaults to `false`, because an unverified server is never
 *   reused.
 */
export function createPlaywrightConfig(
  isCI = Boolean(process.env.CI),
  port?: number,
  reuse = false,
) {
  const resolution: DevServerResolution =
    port === undefined ? resolveDevServer(isCI) : { port, reuse };
  const origin = `http://localhost:${resolution.port}`;

  return defineConfig({
    testDir: ".",
    testMatch: ["e2e/**/*.spec.ts", "test/ci-playwright-runtime.spec.ts"],
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
      baseURL: origin,
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "retain-on-failure",
    },
    webServer: {
      command: isCI ? "npm run serve:e2e:ci" : "npm run dev",
      url: isCI ? `${origin}/` : origin,
      env: { PORT: String(resolution.port) },
      // Never in CI, and locally only for a server proven to be this checkout's.
      reuseExistingServer: !isCI && resolution.reuse,
      timeout: 120_000,
    },
  });
}

export default createPlaywrightConfig();
