import { expect, test, type Page } from "@playwright/test";

const nativeSecret = "cf-native-secret-must-not-render";

async function installAuthenticatedDesktop(page: Page) {
  await page.addInitScript(
    ({ secret }) => {
      type Callback = (...args: unknown[]) => unknown;
      type NativeCall = {
        command: string;
        args?: Record<string, unknown>;
      };

      const callbacks = new Map<number, Callback>();
      const calls: NativeCall[] = [];
      const unhandledCalls: NativeCall[] = [];
      let callbackId = 0;
      const mcpStatus = (enabledTools: string[] = []) => ({
        running: false,
        host: "127.0.0.1",
        port: 8788,
        url: "http://127.0.0.1:8788/mcp",
        enabledTools,
        tools: [
          {
            name: "dns_read",
            title: "Read DNS",
            description: "Read DNS records",
            enabled: enabledTools.includes("dns_read"),
          },
        ],
        lastError: null,
      });

      Object.defineProperty(window, "__nativeCalls", {
        configurable: true,
        value: calls,
      });
      Object.defineProperty(window, "__unhandledNativeCalls", {
        configurable: true,
        value: unhandledCalls,
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
          async invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown> {
            calls.push({ command, args });

            switch (command) {
              case "get_api_keys":
                return [
                  {
                    id: "primary-key",
                    label: "Primary account",
                    encrypted_key: "ciphertext",
                    email: "operator@example.test",
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
                return {
                  theme: "sunset",
                  locale: "en",
                  last_zone: "zone-primary",
                  default_per_page: 50,
                  confirm_logout: true,
                  confirmLogout: true,
                  mcp_server_enabled: false,
                  mcp_enabled_tools: [],
                };
              case "get_passkey_status":
                return {
                  registrationAvailable: false,
                  authenticationAvailable: false,
                  legacyCredentialsRequireReregistration: false,
                  unavailableReason: "Passkeys are unavailable in this test.",
                };
              case "biometric_status":
                return { available: false, biometricType: "none" };
              case "decrypt_api_key":
                return secret;
              case "verify_token":
                return true;
              case "get_zones":
                return [
                  {
                    id: "zone-primary",
                    name: "example.test",
                    status: "active",
                    paused: false,
                    type: "full",
                    development_mode: 0,
                    name_servers: ["ada.ns.cloudflare.com"],
                  },
                ];
              case "get_dns_records":
                return [
                  {
                    id: "record-www",
                    type: "A",
                    name: "www.example.test",
                    content: "203.0.113.10",
                    ttl: 300,
                    proxied: true,
                    zone_id: "zone-primary",
                    zone_name: "example.test",
                    created_on: "2026-01-01T00:00:00.000Z",
                    modified_on: "2026-01-01T00:00:00.000Z",
                  },
                  {
                    id: "record-mail",
                    type: "MX",
                    name: "example.test",
                    content: "mail.example.test",
                    priority: 10,
                    ttl: 3600,
                    proxied: false,
                    zone_id: "zone-primary",
                    zone_name: "example.test",
                    created_on: "2026-01-01T00:00:00.000Z",
                    modified_on: "2026-01-01T00:00:00.000Z",
                  },
                ];
              case "get_audit_entries":
              case "run_domain_audit":
              case "list_registrar_credentials":
              case "registrar_list_all_domains":
                return [];
              case "mcp_get_server_status":
              case "mcp_stop_server":
                return mcpStatus();
              case "mcp_set_enabled_tools":
                return mcpStatus(
                  Array.isArray(args?.enabledTools)
                    ? (args.enabledTools as string[])
                    : [],
                );
              case "plugin:window|is_always_on_top":
              case "plugin:window|is_maximized":
              case "plugin:window|is_minimized":
              case "plugin:window|is_focused":
                return false;
              case "plugin:event|listen":
                return 1;
              case "plugin:event|unlisten":
              case "update_preferences":
              case "update_preference_fields":
                return undefined;
              default: {
                const unhandledCall = { command, args };
                unhandledCalls.push(unhandledCall);
                throw new Error(`Unhandled Tauri command: ${command}`);
              }
            }
          },
          convertFileSrc(path: string) {
            return `asset://localhost/${encodeURIComponent(path)}`;
          },
        },
      });
    },
    { secret: nativeSecret },
  );
}

async function login(page: Page) {
  await page.goto("/");

  const keySelect = page.getByRole("combobox", { name: "API Key" });
  await expect(keySelect).toBeEnabled();
  await keySelect.click();
  await page.getByRole("option", { name: "Primary account" }).click();
  await page.locator("#password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Login", exact: true }).click();

  await expect(page.getByTestId("authenticated-app-shell")).toBeVisible();
}

async function openActiveWorkspace(
  page: Page,
  buttonName: RegExp,
  tabName: RegExp,
) {
  await page
    .getByTestId("app-command-bar")
    .getByRole("button", { name: buttonName })
    .click();

  const tab = page
    .getByRole("tablist", { name: "DNS workspaces" })
    .getByRole("tab", { name: tabName });
  await expect(tab).toHaveAttribute("aria-selected", "true");

  const panelId = await tab.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  const panel = page.locator(`[id="${panelId}"]`);
  await expect(panel).toBeVisible();
  return panel;
}

async function expectNoUnhandledNativeCalls(page: Page) {
  const unhandledCalls = await page.evaluate(
    () =>
      (
        window as Window & {
          __unhandledNativeCalls?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__unhandledNativeCalls,
  );
  expect(unhandledCalls).toEqual([]);
}

test("successful desktop login loads the last zone and logs out cleanly", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installAuthenticatedDesktop(page);
  await login(page);

  await expect(page.getByTestId("app-command-bar")).toBeVisible();
  await expect(page.getByTestId("dns-workspace-tab-bar")).toBeVisible();
  await expect(page.getByTestId("dns-workspace-scroll-region")).toBeVisible();
  await expect(page.getByTestId("dns-connection-bar")).toBeVisible();
  await expect(
    page
      .getByRole("tablist", { name: "DNS workspaces" })
      .getByRole("tab", { name: /example\.test/i }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("www.example.test", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("203.0.113.10", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(nativeSecret);

  const nativeCalls = await page.evaluate(
    () =>
      (
        window as Window & {
          __nativeCalls?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__nativeCalls,
  );
  const commands = nativeCalls?.map(({ command }) => command) ?? [];
  expect(commands).toEqual(
    expect.arrayContaining(["verify_token", "get_zones", "get_dns_records"]),
  );
  expect(
    nativeCalls?.find(({ command }) => command === "get_dns_records")?.args,
  ).toMatchObject({ zoneId: "zone-primary" });

  await page
    .getByTestId("app-command-bar")
    .getByRole("button", { name: /^logout$/i })
    .click();
  const logoutDialog = page
    .getByRole("dialog")
    .filter({ hasText: /need to sign in again/i });
  await expect(logoutDialog).toBeVisible();
  await logoutDialog.getByRole("button", { name: /^log out$/i }).click();

  await expect(page.getByTestId("auth-card")).toBeVisible();
  await expect(page.getByTestId("authenticated-app-shell")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(nativeSecret);
  await expectNoUnhandledNativeCalls(page);
  expect(pageErrors).toEqual([]);
});

test("authenticated command bar opens each global workspace", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installAuthenticatedDesktop(page);
  await login(page);

  const settingsPanel = await openActiveWorkspace(
    page,
    /settings/i,
    /^settings$/i,
  );
  await expect(
    settingsPanel.getByText("Session settings", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsPanel.getByRole("button", { name: "General", exact: true }),
  ).toBeVisible();

  const tagsPanel = await openActiveWorkspace(page, /tags/i, /^tags$/i);
  await expect(
    tagsPanel.getByText("Tag manager", { exact: true }),
  ).toBeVisible();
  await expect(tagsPanel.getByText("Zone", { exact: true })).toBeVisible();

  const auditPanel = await openActiveWorkspace(page, /audit/i, /audit/i);
  await expect(
    auditPanel.getByText("Audit log", { exact: true }),
  ).toBeVisible();

  const registrarPanel = await openActiveWorkspace(
    page,
    /registr/i,
    /registr/i,
  );
  await expect(
    registrarPanel.getByText("Registry Monitoring", { exact: true }),
  ).toBeVisible();
  const addRegistrarActions = registrarPanel.getByRole("button", {
    name: "Add Registrar",
    exact: true,
  });
  await expect(addRegistrarActions).toHaveCount(2);
  await expect(addRegistrarActions.first()).toBeVisible();

  await expectNoUnhandledNativeCalls(page);
  expect(pageErrors).toEqual([]);
});
