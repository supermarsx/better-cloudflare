import { defineConfig } from "@playwright/test";

function normalizeStaticBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return "";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

export function createPlaywrightConfig(
  isCI = Boolean(process.env.CI),
  requestedStaticBasePath = process.env.PLAYWRIGHT_STATIC_BASE_PATH,
) {
  const staticBasePath = isCI
    ? normalizeStaticBasePath(requestedStaticBasePath)
    : "";
  const ciBaseURL = `http://localhost:3000${staticBasePath}`;

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
      baseURL: isCI ? ciBaseURL : "http://localhost:3000",
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "retain-on-failure",
    },
    webServer: {
      command: isCI ? "npm run serve:e2e:ci" : "npm run dev",
      url: isCI ? `${ciBaseURL}/` : "http://localhost:3000",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  });
}

export default createPlaywrightConfig();
