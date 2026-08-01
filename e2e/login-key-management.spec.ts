import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

type RuntimeFailures = {
  console: string[];
  page: string[];
  requests: string[];
  responses: string[];
};

async function installDesktopMock(page: Page, apiKeyCount = 1) {
  await page.addInitScript((requestedKeyCount) => {
    type Callback = (...args: unknown[]) => unknown;
    type TauriInternals = {
      callbacks: Map<number, Callback>;
      metadata: {
        currentWindow: { label: string };
        currentWebview: { windowLabel: string; label: string };
      };
      transformCallback: (callback: Callback, once?: boolean) => number;
      unregisterCallback: (id: number) => void;
      runCallback: (id: number, data: unknown) => void;
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
      convertFileSrc: (path: string) => string;
    };
    const callbacks = new Map<number, Callback>();
    let callbackId = 0;
    let passkeyListCalls = 0;
    const windowCommands: string[] = [];
    Object.defineProperty(window, "__windowCommands", {
      configurable: true,
      value: windowCommands,
    });

    const internals: TauriInternals = {
      callbacks,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      transformCallback(callback, once = false) {
        callbackId += 1;
        const id = callbackId;
        callbacks.set(
          id,
          once
            ? (...args: unknown[]) => {
                callbacks.delete(id);
                return callback(...args);
              }
            : callback,
        );
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      runCallback(id, data) {
        callbacks.get(id)?.(data);
      },
      async invoke(command) {
        switch (command) {
          case "get_api_keys":
            return Array.from({ length: requestedKeyCount }, (_, index) => ({
              id: index === 0 ? "desktop-key" : `desktop-key-${index}`,
              label: index === 0 ? "Desktop key" : `Desktop key ${index}`,
              encrypted_key: "ciphertext",
              email: null,
              iterations: 100000,
              key_length: 256,
              algorithm: "AES-GCM",
            }));
          case "get_encryption_settings":
            return {
              iterations: 100000,
              key_length: 256,
              algorithm: "AES-GCM",
            };
          case "get_preferences":
            return {};
          case "get_passkey_status":
            return {
              registrationAvailable: false,
              authenticationAvailable: false,
              legacyCredentialsRequireReregistration: true,
              unavailableReason:
                "Legacy passkeys require review before re-enrollment.",
            };
          case "biometric_status":
            return { available: false, biometricType: "none" };
          case "decrypt_api_key":
            return "desktop-token";
          case "list_passkeys":
            passkeyListCalls += 1;
            if (passkeyListCalls === 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 300));
            }
            return [
              {
                id: `credential-${passkeyListCalls}`,
                label: `Credential ${passkeyListCalls}`,
                requiresReregistration: true,
              },
            ];
          case "plugin:window|is_always_on_top":
          case "plugin:window|is_maximized":
          case "plugin:window|is_minimized":
          case "plugin:window|is_focused":
            return false;
          case "plugin:event|listen":
            return 1;
          case "plugin:event|unlisten":
            return undefined;
          default:
            if (command.startsWith("plugin:window|")) {
              windowCommands.push(command);
              return undefined;
            }
            throw new Error(`Unexpected Tauri command: ${command}`);
        }
      },
      convertFileSrc(path) {
        return `asset://localhost/${encodeURIComponent(path)}`;
      },
    };

    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: internals,
    });
  }, apiKeyCount);
}

function monitorRuntime(page: Page): {
  failures: RuntimeFailures;
  assertClean: () => void;
} {
  const failures: RuntimeFailures = {
    console: [],
    page: [],
    requests: [],
    responses: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error") failures.console.push(message.text());
  });
  page.on("pageerror", (error) => failures.page.push(error.message));
  page.on("requestfailed", (request) => {
    failures.requests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failures.responses.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });

  return {
    failures,
    assertClean: () => {
      expect(failures).toEqual({
        console: [],
        page: [],
        requests: [],
        responses: [],
      });
    },
  };
}

async function expectNoAccessibilityViolations(page: Page, context: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    nodes: nodes.map(({ target, html, failureSummary }) => ({
      target,
      html,
      failureSummary,
    })),
  }));

  expect(
    violations,
    `${context} accessibility violations:\n${JSON.stringify(violations, null, 2)}`,
  ).toEqual([]);
}

async function selectDesktopKey(page: Page) {
  const keySelect = page.getByRole("combobox").first();
  await expect(keySelect).toBeEnabled();
  await keySelect.click();
  await page.getByRole("option", { name: "Desktop key" }).click();
  await expect(keySelect).toContainText("Desktop key");
}

async function openManageAction(page: Page, action: "Edit" | "Delete") {
  const manage = page.getByRole("button", { name: "Manage Key" });
  await manage.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await page.waitForTimeout(250);
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("visibility", "visible");
  await expect(page.getByRole("menu")).toHaveCount(1);

  await page.getByRole("menuitem", { name: action }).click();
}

async function dismissViaBackdrop(page: Page) {
  const backdrop = page.getByTestId("dialog-backdrop");
  await expect(backdrop).toBeVisible();
  await expect(backdrop).toHaveAttribute("data-state", "open");
  await backdrop.click({ position: { x: 8, y: 8 } });
}

test("auth and nested modal scroll owners use the themed scrollbar", async ({
  page,
}) => {
  await installDesktopMock(page, 32);
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto("/");

  const authScrollRegion = page.locator('[data-auth-scroll-region="body"]');
  await expect(authScrollRegion).toHaveClass(/\bscrollbar-themed\b/);
  const authEvidence = await authScrollRegion.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      scrollbarWidth: style.getPropertyValue("scrollbar-width").trim(),
    };
  });
  expect(authEvidence.scrollHeight).toBeGreaterThan(authEvidence.clientHeight);
  expect(authEvidence.overflowY).toBe("auto");
  expect(authEvidence.scrollbarWidth).toBe("thin");

  const keySelect = page.getByRole("combobox", { name: "API Key" });
  await keySelect.click();
  const selectScrollRegion = page.locator("[data-select-scroll-region]");
  await expect(selectScrollRegion).toBeVisible();
  await expect(selectScrollRegion).toHaveClass(/\bscrollbar-themed\b/);
  const selectEvidence = await selectScrollRegion.evaluate((element) => {
    const style = getComputedStyle(element);
    const webkitScrollbar = getComputedStyle(element, "::-webkit-scrollbar");
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      scrollbarWidth: style.getPropertyValue("scrollbar-width").trim(),
      webkitDisplay: webkitScrollbar.display,
    };
  });
  expect(selectEvidence.scrollHeight).toBeGreaterThan(
    selectEvidence.clientHeight,
  );
  expect(selectEvidence.overflowY).toBe("auto");
  expect(selectEvidence.scrollbarWidth).toBe("thin");
  expect(selectEvidence.webkitDisplay).toBe("block");
  await page.keyboard.press("Escape");
  await expect(selectScrollRegion).toBeHidden();

  await page.getByRole("button", { name: "Add New Key" }).click();
  await expect(
    page.getByRole("dialog", { name: "Add New API Key" }),
  ).toBeVisible();
  const dialogScrollRegion = page.locator("[data-dialog-scroll-region]");
  await expect(dialogScrollRegion).toHaveClass(/\bscrollbar-themed\b/);
  const dialogEvidence = await dialogScrollRegion.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      overscrollBehaviorY: style.overscrollBehaviorY,
      scrollbarWidth: style.getPropertyValue("scrollbar-width").trim(),
    };
  });
  expect(dialogEvidence.scrollHeight).toBeGreaterThan(
    dialogEvidence.clientHeight,
  );
  expect(dialogEvidence.overflowY).toBe("auto");
  expect(dialogEvidence.overscrollBehaviorY).toBe("contain");
  expect(dialogEvidence.scrollbarWidth).toBe("thin");
});

test("Manage Key hands off to persistent Edit and Delete dialogs", async ({
  page,
}) => {
  await installDesktopMock(page);
  const runtime = monitorRuntime(page);
  await page.goto("/");
  await selectDesktopKey(page);

  for (const action of ["Edit", "Delete"] as const) {
    const dialogName = action === "Edit" ? "Edit API Key" : "Delete API Key";

    await openManageAction(page, action);
    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);

    await expect(page.getByRole("button", { name: "Manage Key" })).toHaveCount(
      0,
    );
    const backgroundManageButton = page
      .locator("button")
      .filter({ hasText: /^Manage Key$/ })
      .first();
    await backgroundManageButton.evaluate((button) => button.focus());
    await expect(dialog).toBeVisible();
    await expect(backgroundManageButton).not.toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest("[role=dialog]")),
        ),
      )
      .toBe(true);
    await expectNoAccessibilityViolations(page, `${dialogName} dialog`);

    const minimize = page.locator('button[aria-label="Minimize window"]');
    await minimize.click();
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as Window & { __windowCommands?: string[] }
          ).__windowCommands?.includes("plugin:window|minimize"),
        ),
      )
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await openManageAction(page, action);
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);

    await dismissViaBackdrop(page);
    await expect(dialog).toBeHidden();
  }

  runtime.assertClean();
});

test("passkey manager survives focus changes and ignores stale closed loads", async ({
  page,
}) => {
  await installDesktopMock(page);
  const runtime = monitorRuntime(page);
  await page.goto("/");
  await selectDesktopKey(page);
  await page.locator("#password").fill("password");

  const review = page.getByRole("button", {
    name: "Review legacy passkeys",
  });
  await expect(review).toBeEnabled();
  await review.click();

  const dialog = page.getByRole("dialog", {
    name: "Legacy passkey recovery",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText(
    "Loading legacy passkeys",
  );

  await expect(page.getByRole("button", { name: "Manage Key" })).toHaveCount(0);
  const backgroundManageButton = page
    .locator("button")
    .filter({ hasText: /^Manage Key$/ })
    .first();
  await backgroundManageButton.evaluate((button) => button.focus());
  await expect(dialog).toBeVisible();
  await expect(backgroundManageButton).not.toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest("[role=dialog]")),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.waitForTimeout(350);
  await expect(page.getByText("Credential 1")).toHaveCount(0);

  await review.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Credential 2")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expectNoAccessibilityViolations(page, "Legacy passkey recovery dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await review.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Credential 3")).toBeVisible();
  await dismissViaBackdrop(page);
  await expect(dialog).toBeHidden();

  runtime.assertClean();
});
