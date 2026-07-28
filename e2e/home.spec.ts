import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const staticResourceTypes = new Set([
  "document",
  "font",
  "image",
  "script",
  "stylesheet",
]);

function monitorStaticResourceFailures(page: Page) {
  const failures: string[] = [];

  page.on("requestfailed", (request) => {
    if (staticResourceTypes.has(request.resourceType())) {
      failures.push(
        `${request.resourceType()} request failed: ${request.url()} (${
          request.failure()?.errorText ?? "unknown error"
        })`,
      );
    }
  });

  page.on("response", (response) => {
    const request = response.request();
    if (
      response.status() === 404 &&
      staticResourceTypes.has(request.resourceType())
    ) {
      failures.push(
        `${request.resourceType()} returned 404: ${response.url()}`,
      );
    }
  });

  return failures;
}

test("homepage loads its metadata icon and static resources without 404s", async ({
  page,
}) => {
  const staticFailures = monitorStaticResourceFailures(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page).toHaveTitle(/Better Cloudflare/);

  const iconLinks = page.locator('link[rel~="icon"]');
  await expect(iconLinks).not.toHaveCount(0);

  const iconUrls = await iconLinks.evaluateAll((links) =>
    links.map((link) => (link as HTMLLinkElement).href),
  );
  for (const iconUrl of iconUrls) {
    const iconResponse = await page.request.get(iconUrl);
    expect(
      iconResponse.status(),
      `metadata icon request failed: ${iconUrl}`,
    ).toBeLessThan(400);
  }

  expect(staticFailures).toEqual([]);
});

test("accessibility: homepage has no a11y violations", async ({ page }) => {
  await page.goto("/");
  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
  const violationDetails = accessibilityScanResults.violations.map(
    ({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ target, html, failureSummary }) => ({
        target,
        html,
        failureSummary,
      })),
    }),
  );

  expect(
    violationDetails,
    `Axe violations:\n${JSON.stringify(violationDetails, null, 2)}`,
  ).toEqual([]);
});
