import { expect, test, type Page } from "@playwright/test";

type AuthFailureMode = "invalid" | "provider";

async function installFailingDesktopAuth(
  page: Page,
  initialMode: AuthFailureMode,
) {
  await page.addInitScript((mode: AuthFailureMode) => {
    type Callback = (...args: unknown[]) => unknown;
    const callbacks = new Map<number, Callback>();
    let callbackId = 0;
    const desktopSecret = "desktop-secret-token-never-render";

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
              return desktopSecret;
            case "verify_token":
              if (
                (
                  window as Window & {
                    __authFailureMode?: AuthFailureMode;
                  }
                ).__authFailureMode === "invalid"
              ) {
                return false;
              }
              throw JSON.stringify({
                kind: "authentication",
                message: "Cloudflare rejected the credentials.",
                details: {
                  operation: "verify token",
                  status: 403,
                  request_id: "cf-ray-safe-123",
                  retry_after_secs: 7,
                  retryable: false,
                  provider_errors: [
                    {
                      code: 10000,
                      message: `Authentication error: token=${desktopSecret}`,
                    },
                  ],
                  remediation:
                    "Create a token with the required Cloudflare permissions.",
                },
              });
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
  }, initialMode);
}

async function selectDesktopKey(page: Page) {
  const keySelect = page.getByRole("combobox", { name: "API Key" });
  await expect(keySelect).toBeEnabled();
  await keySelect.click();
  await page.getByRole("option", { name: "Desktop key" }).click();
  await page.locator("#password").fill("password");
}

test("invalid and native provider login failures remain actionable and sanitized", async ({
  page,
}) => {
  await installFailingDesktopAuth(page, "invalid");
  await page.goto("/");
  await selectDesktopKey(page);

  await page.getByRole("button", { name: "Login" }).click();
  const error = page.getByTestId("login-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("Cloudflare rejected");
  await expect(error).toContainText("Check the token or key");
  await page.waitForTimeout(1_200);
  await expect(error).toBeVisible();

  await page.getByRole("button", { name: "Dismiss login error" }).click();
  await page.evaluate(() => {
    (
      window as Window & { __authFailureMode?: AuthFailureMode }
    ).__authFailureMode = "provider";
  });
  await page.getByRole("button", { name: "Login" }).click();

  await expect(error).toBeVisible();
  await expect(error).toContainText("Cloudflare rejected the credentials");
  await error.getByText("Safe technical details").click();
  await expect(error).toContainText("HTTP 403");
  await expect(error).toContainText("request ID cf-ray-safe-123");
  await expect(error).toContainText("provider codes 10000");
  await expect(error).toContainText(
    "Create a token with the required Cloudflare permissions",
  );
  await expect(error).not.toContainText("desktop-secret-token-never-render");
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

  await page.keyboard.press("Escape");
  const error = page.getByTestId("login-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("No public server API base");
  await expect(error).toContainText("NEXT_PUBLIC_SERVER_API_BASE");
  await expect(error).not.toContainText("web-secret-never-render");
  expect(requests).toEqual([]);
});
