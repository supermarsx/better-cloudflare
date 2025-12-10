import * as React from "react";
import i18n, { availableLanguages } from "@/i18n";
import { useTranslation } from "react-i18next";

const languageNames: Record<string, string> = {
  "en-US": "English",
  "pt-PT": "Português",
};

import { Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export function LanguageSelector() {
  const { t } = useTranslation();

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
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-orange-500/30 bg-black/40 text-orange-500 hover:bg-orange-500/20 hover:text-orange-400 shadow-[0_0_10px_rgba(255,100,0,0.2)] transition-all duration-300"
          aria-label={t("Select language")}
        >
          <Globe className="h-5 w-5 animate-pulse-slow" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-black/80 border-orange-500/30 backdrop-blur-xl text-orange-100">
        {availableLanguages.map((lng) => (
          <DropdownMenuItem
            key={lng}
            onClick={() => changeLanguage(lng)}
            className="focus:bg-orange-500/20 focus:text-orange-200 cursor-pointer"
          >
            {languageNames[lng] ?? lng}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
