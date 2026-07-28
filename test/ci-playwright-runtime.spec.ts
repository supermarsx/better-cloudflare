import { expect, test, type Page } from "@playwright/test";

type FailureKind = "console" | "page" | "request" | "response";

type RuntimeFailure = {
  kind: FailureKind;
  detail: string;
  url?: string;
  status?: number;
};

// Keep this list empty by default. A future test may add a narrowly scoped
// expectation only when it deliberately intercepts or provokes that failure.
const expectedFailures: ReadonlyArray<{
  kind: FailureKind;
  url: RegExp;
  status?: number;
}> = [];

function isExpected(failure: RuntimeFailure): boolean {
  return expectedFailures.some(
    (expected) =>
      expected.kind === failure.kind &&
      expected.url.test(failure.url ?? "") &&
      (expected.status === undefined || expected.status === failure.status),
  );
}

function monitorRuntime(page: Page): {
  failures: RuntimeFailure[];
  assertClean: () => void;
} {
  const failures: RuntimeFailure[] = [];
  const capture = (failure: RuntimeFailure) => {
    if (!isExpected(failure)) failures.push(failure);
  };

  page.on("console", (message) => {
    if (message.type() === "error") {
      capture({
        kind: "console",
        detail: message.text(),
        url: message.location().url,
      });
    }
  });
  page.on("pageerror", (error) => {
    capture({ kind: "page", detail: error.message });
  });
  page.on("requestfailed", (request) => {
    capture({
      kind: "request",
      detail: `${request.method()} ${request.failure()?.errorText ?? "failed"}`,
      url: request.url(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      capture({
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

test("homepage runtime has no unexpected browser or network failures", async ({
  page,
}) => {
  const runtime = monitorRuntime(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page).toHaveTitle(/Better Cloudflare/);
  await page.waitForTimeout(250);

  runtime.assertClean();
});
