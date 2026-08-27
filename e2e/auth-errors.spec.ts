import { expect, test, type Locator, type Page } from "@playwright/test";
import { installTauriEventPluginInternals } from "./fixtures/tauri-event-plugin";

type AuthFailureMode = "invalid" | "provider-object" | "provider-json";

const desktopSecret = "desktop-secret-token-never-render";
const nativeAuthErrorEnvelope = {
  code: "AUTH_REQUEST_FAILED",
  kind: "authentication",
  message: "Cloudflare rejected the supplied credentials (HTTP 403).",
  status: 403,
  source: "cloudflare",
  operation: "auth:verify_token",
  retryable: false,
  retry_after: "7",
  details: {
    provider_errors: [
      {
        code: "10000",
        message: "Authentication error: token=[redacted]",
      },
    ],
    provider_codes: ["10000"],
    provider_messages: ["Authentication error: token=[redacted]"],
    retry_after_secs: 7,
    remediation: "Create a token with the required Cloudflare permissions.",
  },
  request_id: "cf-ray-safe-123",
} as const;

async function installFailingDesktopAuth(
  page: Page,
  initialMode: AuthFailureMode,
) {
  await installTauriEventPluginInternals(page);
  await page.addInitScript(
    ({
      mode,
      nativeEnvelope,
      decryptedSecret,
    }: {
      mode: AuthFailureMode;
      nativeEnvelope: typeof nativeAuthErrorEnvelope;
      decryptedSecret: string;
    }) => {
      type Callback = (...args: unknown[]) => unknown;
      const callbacks = new Map<number, Callback>();
      let callbackId = 0;

      Object.defineProperty(window, "__authFailureMode", {
        configurable: true,
        writable: true,
        value: mode,
      });
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        configurable: true,
        value: {
          callbacks,
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { windowLabel: "main", label: "main" },
          },
          transformCallback(callback: Callback, once = false) {
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
          unregisterCallback(id: number) {
            callbacks.delete(id);
          },
          runCallback(id: number, data: unknown) {
            callbacks.get(id)?.(data);
          },
          async invoke(command: string) {
            switch (command) {
              case "get_api_keys":
                return [
                  {
                    id: "desktop-key",
                    label: "Desktop key",
                    encrypted_key: "ciphertext",
                    email: null,
                    iterations: 100000,
                    key_length: 256,
                    algorithm: "AES-GCM",
                  },
                ];
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
                  unavailableReason: "Legacy passkeys require review.",
                };
              case "biometric_status":
                return { available: false, biometricType: "none" };
              case "decrypt_api_key":
                return decryptedSecret;
              case "verify_token": {
                const failureMode = (
                  window as Window & {
                    __authFailureMode?: AuthFailureMode;
                  }
                ).__authFailureMode;
                if (failureMode === "invalid") return false;
                if (failureMode === "provider-json") {
                  throw JSON.stringify(nativeEnvelope);
                }
                throw nativeEnvelope;
              }
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
                if (command.startsWith("plugin:window|")) return undefined;
                throw new Error(`Unexpected Tauri command: ${command}`);
            }
          },
          convertFileSrc(path: string) {
            return `asset://localhost/${encodeURIComponent(path)}`;
          },
        },
      });
    },
    {
      mode: initialMode,
      nativeEnvelope: nativeAuthErrorEnvelope,
      decryptedSecret: desktopSecret,
    },
  );
}

async function selectDesktopKey(page: Page) {
  const keySelect = page.getByRole("combobox", { name: "API Key" });
  await expect(keySelect).toBeEnabled();
  await keySelect.click();
  await page.getByRole("option", { name: "Desktop key" }).click();
  await page.locator("#password").fill("password");
}

function visibleLoginFailureToast(page: Page) {
  return page
    .getByText("Login could not be completed", { exact: true })
    .locator("xpath=ancestor::*[@data-state='open'][1]");
}

async function openToastDetailsIfAvailable(
  page: Page,
  toast: Locator,
): Promise<Locator> {
  const moreInfo = toast.getByRole("button", { name: /more info/i });
  if ((await moreInfo.count()) > 0 && (await moreInfo.first().isVisible())) {
    await moreInfo.first().click();
    const modal = page
      .getByRole("dialog")
      .filter({ hasText: /safe technical details|diagnostic/i });
    if ((await modal.count()) > 0) return modal.first();
  }
  return toast;
}

test("invalid and native provider login failures remain actionable and sanitized", async ({
  page,
}) => {
  await installFailingDesktopAuth(page, "invalid");
  await page.goto("/");
  await selectDesktopKey(page);

  await page.getByRole("button", { name: "Login" }).click();
  let error = visibleLoginFailureToast(page);
  await expect(error).toHaveCount(1);
  await expect(page.getByTestId("login-error")).toHaveCount(0);
  await expect(error).toBeVisible();
  await expect(error).toContainText("Login could not be completed");
  await expect(error).toContainText("Cloudflare rejected");
  await expect(error).toContainText("Check the token or key");
  await page.waitForTimeout(1_200);
  await expect(error).toBeVisible();

  await error.locator("[toast-close]").click();
  await expect(error).toBeHidden();
  for (const rejectionMode of [
    "provider-object",
    "provider-json",
  ] satisfies AuthFailureMode[]) {
    await page.evaluate((mode: AuthFailureMode) => {
      (
        window as Window & { __authFailureMode?: AuthFailureMode }
      ).__authFailureMode = mode;
    }, rejectionMode);
    await page.getByRole("button", { name: "Login" }).click();

    error = visibleLoginFailureToast(page);
    await expect(error).toHaveCount(1);
    await expect(error).toBeVisible();
    await expect(page.getByTestId("login-error")).toHaveCount(0);
    await expect(error).toContainText(
      "Cloudflare rejected the supplied credentials",
    );
    const details = await openToastDetailsIfAvailable(page, error);
    await expect(details).toContainText("source cloudflare");
    await expect(details).toContainText("operation auth:verify_token");
    await expect(details).toContainText("HTTP 403");
    await expect(details).toContainText("request ID cf-ray-safe-123");
    await expect(details).toContainText("retry after 7");
    await expect(details).toContainText("provider codes 10000");
    await expect(details).toContainText(
      "Authentication error: token=[redacted]",
    );
    await expect(details).toContainText(
      "Create a token with the required Cloudflare permissions",
    );
    await expect(page.locator("body")).not.toContainText(desktopSecret);
    await page.waitForTimeout(1_200);
    await expect(error).toBeVisible();

    const detailsModal = page
      .getByRole("dialog")
      .filter({ hasText: /safe technical details|diagnostic/i });
    if (
      (await detailsModal.count()) > 0 &&
      (await detailsModal.first().isVisible())
    ) {
      await page.keyboard.press("Escape");
      await expect(detailsModal.first()).toBeHidden();
    }

    if (rejectionMode === "provider-object") {
      await error.locator("[toast-close]").click();
      await expect(error).toBeHidden();
    }
  }
});

test("missing web backend fails locally with visible configuration guidance", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/localhost:8787/.test(request.url())) requests.push(request.url());
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add New Key" }).click();
  await page.locator("#new-label").fill("Test key");
  await page.locator("#new-api-key").fill("web-secret-never-render");
  await page.locator("#new-password").fill("password");
  await page
    .getByRole("dialog", { name: "Add New API Key" })
    .getByRole("button", { name: "Add API Key" })
    .click();

  const error = visibleLoginFailureToast(page);
  await expect(error).toHaveCount(1);
  await expect(page.getByTestId("login-error")).toHaveCount(0);
  await expect(error).toBeVisible();
  const details = await openToastDetailsIfAvailable(page, error);
  await expect(details).toContainText("No public server API base");
  await expect(details).toContainText("NEXT_PUBLIC_SERVER_API_BASE");
  await expect(page.locator("body")).not.toContainText(
    "web-secret-never-render",
  );
  expect(requests).toEqual([]);
});
