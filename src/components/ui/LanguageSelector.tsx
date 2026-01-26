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
import { isDesktop } from "@/lib/environment";
import { TauriClient } from "@/lib/tauri-client";

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
          className="h-8 w-8 rounded-full border border-border/70 bg-card/70 text-foreground/70 hover:text-foreground hover:border-primary/40 hover:bg-accent/70 shadow-sm transition-all duration-300 group relative overflow-hidden"
          aria-label={t("Select language")}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.2),transparent)] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          <Globe className="h-4 w-4 group-hover:rotate-180 transition-transform duration-700 ease-in-out" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-popover/95 border border-border/60 backdrop-blur-xl text-foreground shadow-[0_12px_28px_rgba(0,0,0,0.18)]"
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
