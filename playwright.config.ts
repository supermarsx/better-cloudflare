import { defineConfig } from "@playwright/test";

export function createPlaywrightConfig(isCI = Boolean(process.env.CI)) {
  return defineConfig({
    testDir: ".",
    testMatch: ["e2e/**/*.spec.ts", "test/ci-playwright-runtime.spec.ts"],
    timeout: 30_000,
    expect: { timeout: 5000 },
    fullyParallel: true,
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
      baseURL: "http://localhost:3000",
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "retain-on-failure",
    },
    webServer: {
      command: isCI ? "npm run serve:e2e:ci" : "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  });
}

export default createPlaywrightConfig();
