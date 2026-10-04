/**
 * Wait for i18n before asserting on any user-visible string.
 *
 * `src/i18n.ts` loads its resource bundles with a dynamic `import`, so for the
 * first few microtasks of a suite `t("Refused", "Refused")` returns an empty
 * string rather than either the translation or the default. Any synchronous
 * test that renders and asserts immediately therefore sees blank labels — and,
 * worse, only the *first* such test in a file does, because the bundle has
 * settled by the time the second one runs. That makes it look like an
 * ordering fluke instead of a missing await.
 *
 * `test/AppShellLayout.test.tsx` grew its own copy of this; this is the same
 * thing, shared, so the next suite does not have to rediscover it.
 */
import i18n from "../src/i18n";

const INITIALIZATION_TIMEOUT_MS = 5_000;

export async function waitForI18nInitialization(): Promise<void> {
  if (i18n.isInitialized) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      i18n.off("initialized", onInitialized);
      reject(new Error("Timed out waiting for i18n initialization"));
    }, INITIALIZATION_TIMEOUT_MS);
    const onInitialized = () => {
      clearTimeout(timeout);
      i18n.off("initialized", onInitialized);
      resolve();
    };
    i18n.on("initialized", onInitialized);
  });
}

/** Initialize i18n and pin the locale, so assertions read en-US strings. */
export async function useEnglishLocale(): Promise<void> {
  await waitForI18nInitialization();
  if (i18n.language !== "en-US") await i18n.changeLanguage("en-US");
}
