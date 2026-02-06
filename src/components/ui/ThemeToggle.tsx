import { useEffect, useState, type ReactNode } from "react";
import { Moon, Sun, Flame } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { isDesktop } from "@/lib/environment";
import { TauriClient } from "@/lib/tauri-client";
import { useI18n } from "@/hooks/use-i18n";

type ThemeId = "sunset" | "oled" | "light";

const themeLabels: Record<ThemeId, string> = {
  sunset: "Sunset",
  oled: "Night",
  light: "Midday",
};

const themeIcons: Record<ThemeId, ReactNode> = {
  sunset: <Flame className="h-4 w-4" />,
  oled: <Moon className="h-4 w-4" />,
  light: <Sun className="h-4 w-4" />,
};

export function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<ThemeId>("sunset");

  useEffect(() => {
    const apply = (next: ThemeId) => {
      setTheme(next);
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = next;
      }
      if (typeof window !== "undefined") {
        window.localStorage.setItem("theme", next);
      }
    };

    const saved =
      typeof window !== "undefined"
        ? (window.localStorage.getItem("theme") as ThemeId | null)
        : null;
    if (saved) {
      apply(saved);
    } else if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) => {
          const pref = prefs as { theme?: ThemeId };
          if (pref.theme && themeLabels[pref.theme]) {
            apply(pref.theme);
          } else {
            apply("sunset");
          }
        })
        .catch(() => apply("sunset"));
    } else {
      apply("sunset");
    }
  }, []);

  const applyTheme = (next: ThemeId) => {
    setTheme(next);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("theme", next);
    }
    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({ theme: next });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tooltip
          tip={t("Theme: {{name}}", { name: t(themeLabels[theme], themeLabels[theme]) })}
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            className="ui-icon-button h-8 w-8"
            aria-label={t("Select theme", "Select theme")}
          >
            {themeIcons[theme]}
          </Button>
        </Tooltip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-popover/70 text-foreground"
      >
        {(Object.keys(themeLabels) as ThemeId[]).map((id) => (
          <DropdownMenuItem
            key={id}
            onClick={() => applyTheme(id)}
            className="cursor-pointer"
          >
            <span className="mr-2 text-primary">{themeIcons[id]}</span>
            {t(themeLabels[id], themeLabels[id])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
