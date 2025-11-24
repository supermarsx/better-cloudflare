import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Dynamically load translation resources from `src/locales` files. This
// allows us to keep translations in dedicated JSON files, decoupled from the
// JavaScript initialization code. We use the language keys `en-US` and
// `pt-PT` for now but the structure is flexible for more locales.
const loadResources = async () => {
  const en = await import('./locales/en-US.json');
  const pt = await import('./locales/pt-PT.json');
  function extractDefault<T>(m: unknown): T {
    if (m && typeof m === 'object' && 'default' in m) return (m as { default: T }).default;
    return m as T;
  }
  return {
    'en-US': { translation: extractDefault<Record<string, string>>(en) },
    'pt-PT': { translation: extractDefault<Record<string, string>>(pt) },
  };
};

(async () => {
  const resources = await loadResources();
  i18n.use(initReactI18next).init({
    resources,
    lng: 'en-US',
    fallbackLng: 'en-US',
    interpolation: { escapeValue: false },
  });
  try {
  const saved = typeof globalThis !== 'undefined' && 'localStorage' in globalThis ? (globalThis as { localStorage: Storage }).localStorage.getItem('locale') : undefined;
    if (typeof saved === 'string' && Object.prototype.hasOwnProperty.call(resources, saved)) {
      void i18n.changeLanguage(saved);
    }
  } catch {
    // Ignore storage access errors in test or SSR environments
  }
})();

export default i18n;

export const availableLanguages = ['en-US', 'pt-PT'] as const;
