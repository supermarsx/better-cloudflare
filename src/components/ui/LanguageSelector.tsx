import * as React from "react";
import i18n, { availableLanguages } from "@/i18n";
import { useI18n } from "@/hooks/use-i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Button } from "@/components/ui/button";
import { Globe } from "lucide-react";
import { isDesktop } from "@/lib/environment";
import { TauriClient } from "@/lib/tauri-client";

const languageNames: Record<string, string> = {
  "en-US": "English",
  "pt-PT": "Português",
  "zh-CN": "简体中文",
  "es-ES": "Español",
  "hi-IN": "हिन्दी",
  "ar-SA": "العربية",
  "fr-FR": "Français",
  "de-DE": "Deutsch",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
  "ru-RU": "Русский",
  "id-ID": "Bahasa Indonesia",
};

export function LanguageSelector() {
  const { t } = useI18n();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
    try {
      const storageAvailable =
        typeof globalThis !== "undefined" && "localStorage" in globalThis;
      const storage = storageAvailable
        ? (globalThis as { localStorage: Storage }).localStorage
        : undefined;
      storage?.setItem("locale", lng);
    } catch {
      /* ignore */
    }
    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({ locale: lng });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="ui-icon-button h-8 w-8"
          aria-label={t("Select language")}
        >
          <Globe className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-popover/70 text-foreground"
      >
        {availableLanguages.map((lng) => (
          <DropdownMenuItem
            key={lng}
            onClick={() => changeLanguage(lng)}
            className="focus:bg-accent/70 focus:text-foreground cursor-pointer hover:pl-4 transition-all duration-200"
          >
            <span className="mr-2 text-primary">●</span>
            {languageNames[lng] ?? lng}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
