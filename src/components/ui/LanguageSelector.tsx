import * as React from "react";
import i18n, { availableLanguages } from "@/i18n";
import { useI18n } from "@/hooks/use-i18n";

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
} from "@/components/ui/DropdownMenu";
import { Button } from "@/components/ui/button";

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
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full border border-orange-500/30 bg-black/40 text-orange-200/70 hover:text-orange-100 hover:border-orange-400/50 shadow-[0_0_12px_rgba(255,80,0,0.25)] hover:shadow-[0_0_18px_rgba(255,100,0,0.45)] transition-all duration-300 group relative overflow-hidden"
          aria-label={t("Select language")}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,100,0,0.15),transparent)] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <Globe className="h-4 w-4 drop-shadow-[0_0_4px_rgba(255,100,0,0.6)] group-hover:rotate-180 transition-transform duration-700 ease-in-out" />
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
