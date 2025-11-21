import * as React from 'react';
import i18n, { availableLanguages } from '@/i18n';
import { useTranslation } from 'react-i18next';

const languageNames: Record<string, string> = {
  'en-US': 'English',
  'pt-PT': 'Português',
};

export function LanguageSelector() {
  const { t } = useTranslation();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const lng = e.target.value;
    i18n.changeLanguage(lng);
    try { (globalThis as any).localStorage?.setItem('locale', lng); } catch (_) { /* ignore */ }
  };

  return (
    <div className="p-2">
      <label htmlFor="language" className="sr-only">
        {t('Language')}
      </label>
      <select
        id="language"
        className="border rounded p-1 text-sm"
        defaultValue={i18n.language}
        onChange={handleChange}
        aria-label="Select language"
      >
        {availableLanguages.map((lng) => (
          <option key={lng} value={lng}>
            {languageNames[lng] ?? lng}
          </option>
        ))}
      </select>
    </div>
  );
}
