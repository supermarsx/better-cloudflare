import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

// Dynamically load translation resources from `src/locales` files. This
// allows us to keep translations in dedicated JSON files, decoupled from the
// JavaScript initialization code. We use the language keys `en-US` and
// `pt-PT` for now but the structure is flexible for more locales.
const loadResources = async () => {
  const [en, pt, zhCN, esES, hiIN, arSA, frFR, deDE, jaJP, koKR, ruRU, idID] =
    await Promise.all([
      import("./locales/en-US.json"),
      import("./locales/pt-PT.json"),
      import("./locales/zh-CN.json"),
      import("./locales/es-ES.json"),
      import("./locales/hi-IN.json"),
      import("./locales/ar-SA.json"),
      import("./locales/fr-FR.json"),
      import("./locales/de-DE.json"),
      import("./locales/ja-JP.json"),
      import("./locales/ko-KR.json"),
      import("./locales/ru-RU.json"),
      import("./locales/id-ID.json"),
    ]);
  function extractDefault<T>(m: unknown): T {
    if (m && typeof m === "object" && "default" in m)
      return (m as { default: T }).default;
    return m as T;
  }
  return {
    "en-US": { translation: extractDefault<Record<string, string>>(en) },
    "pt-PT": { translation: extractDefault<Record<string, string>>(pt) },
    "zh-CN": { translation: extractDefault<Record<string, string>>(zhCN) },
    "es-ES": { translation: extractDefault<Record<string, string>>(esES) },
    "hi-IN": { translation: extractDefault<Record<string, string>>(hiIN) },
    "ar-SA": { translation: extractDefault<Record<string, string>>(arSA) },
    "fr-FR": { translation: extractDefault<Record<string, string>>(frFR) },
    "de-DE": { translation: extractDefault<Record<string, string>>(deDE) },
    "ja-JP": { translation: extractDefault<Record<string, string>>(jaJP) },
    "ko-KR": { translation: extractDefault<Record<string, string>>(koKR) },
    "ru-RU": { translation: extractDefault<Record<string, string>>(ruRU) },
    "id-ID": { translation: extractDefault<Record<string, string>>(idID) },
  };
};

type TranslationResources = Awaited<ReturnType<typeof loadResources>>;

export function readSavedLocale(
  resources: TranslationResources,
  storage?: Pick<Storage, "getItem">,
): string | undefined {
  try {
    const selectedStorage =
      storage ??
      (typeof globalThis !== "undefined" && "localStorage" in globalThis
        ? (globalThis as { localStorage: Storage }).localStorage
        : undefined);
    const saved = selectedStorage?.getItem("locale");
    if (
      typeof saved === "string" &&
      Object.prototype.hasOwnProperty.call(resources, saved)
    ) {
      return saved;
    }
  } catch (error) {
    reportRuntimeError(error, {
      source: "runtime",
      label: "Read saved language preference",
    });
  }
  return undefined;
}

export async function initializeI18n(): Promise<void> {
  let resources: TranslationResources;
  try {
    resources = await loadResources();
    await i18n.use(initReactI18next).init({
      resources,
      lng: "en-US",
      fallbackLng: "en-US",
      interpolation: { escapeValue: false },
    });
  } catch (error) {
    reportRuntimeError(error, {
      source: "runtime",
      label: "Initialize translations",
    });
    try {
      await i18n.use(initReactI18next).init({
        resources: {},
        lng: "en-US",
        fallbackLng: "en-US",
        interpolation: { escapeValue: false },
      });
    } catch (fallbackError) {
      reportRuntimeError(fallbackError, {
        source: "runtime",
        label: "Initialize fallback translations",
      });
    }
    return;
  }

  const saved = readSavedLocale(resources);
  if (!saved) return;

  try {
    await i18n.changeLanguage(saved);
  } catch (error) {
    reportRuntimeError(error, {
      source: "runtime",
      label: "Apply saved language preference",
    });
  }
}

void initializeI18n().catch((error) => {
  reportRuntimeError(error, {
    source: "runtime",
    label: "Start translation initialization",
  });
});

export default i18n;

export const availableLanguages = [
  "en-US",
  "pt-PT",
  "zh-CN",
  "es-ES",
  "hi-IN",
  "ar-SA",
  "fr-FR",
  "de-DE",
  "ja-JP",
  "ko-KR",
  "ru-RU",
  "id-ID",
] as const;
