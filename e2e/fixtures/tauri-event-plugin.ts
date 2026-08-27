import type { Page } from "@playwright/test";

/**
 * Installs the `window.__TAURI_EVENT_PLUGIN_INTERNALS__` shim that
 * `@tauri-apps/api/event` reaches for when an `unlisten` handle is dropped.
 *
 * The desktop mocks in the specs only define `window.__TAURI_INTERNALS__`, so
 * without this every real unlisten (window listeners disposed on unmount, or
 * replayed by React StrictMode under the dev server) rejects with
 * `Cannot read properties of undefined (reading 'unregisterListener')` and
 * surfaces as a `pageerror`. Call it from every desktop mock installer.
 */
export async function installTauriEventPluginInternals(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { unregisterListener: () => {} },
    });
  });
}
