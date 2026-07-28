import { expect, test, type Page } from "@playwright/test";

const projectBasePath = "/better-cloudflare";

type RuntimeFailure = {
  kind: "console" | "page" | "request" | "response";
  detail: string;
  url?: string;
  status?: number;
};

function monitorRuntime(page: Page): {
  failures: RuntimeFailure[];
  assertClean: () => void;
} {
  const failures: RuntimeFailure[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push({
        kind: "console",
        detail: message.text(),
        url: message.location().url,
      });
    }
  });
  page.on("pageerror", (error) => {
    failures.push({ kind: "page", detail: error.message });
  });
  page.on("requestfailed", (request) => {
    failures.push({
      kind: "request",
      detail: `${request.method()} ${request.failure()?.errorText ?? "failed"}`,
      url: request.url(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failures.push({
        kind: "response",
        detail: `${response.status()} ${response.request().method()}`,
        url: response.url(),
        status: response.status(),
      });
    }
  });

  return {
    failures,
    assertClean: () => expect(failures).toEqual([]),
  };
}

test("Pages export loads every browser asset from the project base path", async ({
  page,
  request,
}) => {
  const origin = "http://localhost:3000";
  const runtime = monitorRuntime(page);

  const rootResponse = await request.get(`${origin}/`);
  expect(rootResponse.status()).toBe(404);

  const navigation = await page.goto(`${projectBasePath}/`, {
    waitUntil: "networkidle",
  });
  expect(navigation?.status()).toBe(200);
  await expect(page).toHaveURL(`${origin}${projectBasePath}/`);
  await expect(page).toHaveTitle(/Better Cloudflare/);

  const assetUrls = await page
    .locator("link[href], script[src], img[src]")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          if (element instanceof HTMLLinkElement) return element.href;
          if (element instanceof HTMLScriptElement) return element.src;
          if (element instanceof HTMLImageElement) return element.src;
          return "";
        })
        .filter(Boolean),
    );
  expect(assetUrls.length).toBeGreaterThan(0);

  const sameOriginAssetPaths = assetUrls
    .map((value) => new URL(value))
    .filter((url) => url.origin === origin)
    .map((url) => url.pathname);
  expect(sameOriginAssetPaths.length).toBeGreaterThan(0);
  for (const pathname of sameOriginAssetPaths) {
    expect(pathname).toMatch(/^\/better-cloudflare(?:\/|$)/);
  }

  const loadedResources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(window.location.origin)),
  );
  expect(loadedResources.length).toBeGreaterThan(0);
  for (const resource of loadedResources) {
    expect(new URL(resource).pathname).toMatch(/^\/better-cloudflare(?:\/|$)/);
  }

  runtime.assertClean();
});
