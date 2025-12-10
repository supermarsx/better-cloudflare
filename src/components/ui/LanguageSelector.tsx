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
          className="h-10 w-10 rounded-full border-2 border-orange-500/50 bg-gradient-to-br from-black to-orange-950 text-orange-500 hover:bg-orange-900/30 hover:text-orange-300 hover:border-orange-400 shadow-[0_0_15px_rgba(255,80,0,0.4)] hover:shadow-[0_0_25px_rgba(255,100,0,0.6)] transition-all duration-500 group relative overflow-hidden"
          aria-label={t("Select language")}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,100,0,0.2),transparent)] opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
          <Globe className="h-6 w-6 drop-shadow-[0_0_5px_rgba(255,100,0,0.8)] group-hover:rotate-180 transition-transform duration-700 ease-in-out" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-black/90 border border-orange-500/30 backdrop-blur-xl text-orange-100 shadow-[0_0_30px_rgba(255,60,0,0.2)]">
        {availableLanguages.map((lng) => (
          <DropdownMenuItem
            key={lng}
            onClick={() => changeLanguage(lng)}
            className="focus:bg-orange-500/20 focus:text-orange-100 cursor-pointer hover:pl-4 transition-all duration-200"
          >
            <span className="mr-2 text-orange-500">●</span>
            {languageNames[lng] ?? lng}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
