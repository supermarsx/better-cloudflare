import { useEffect, useState } from "react";
import { Moon, Sun, Flame } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { isDesktop } from "@/lib/environment";
import { TauriClient } from "@/lib/tauri-client";

type ThemeId = "sunset" | "oled" | "light";

const themeLabels: Record<ThemeId, string> = {
  sunset: "Sunset",
  oled: "OLED",
  light: "Light",
};

const themeIcons: Record<ThemeId, JSX.Element> = {
  sunset: <Flame className="h-4 w-4" />,
  oled: <Moon className="h-4 w-4" />,
  light: <Sun className="h-4 w-4" />,
};

export function ThemeToggle() {
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
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full border border-orange-500/20 bg-black/40 text-orange-200/70 hover:text-orange-100 hover:border-orange-400/50 shadow-[0_0_12px_rgba(255,80,0,0.2)] hover:shadow-[0_0_18px_rgba(255,100,0,0.4)] transition-all duration-300"
          aria-label="Select theme"
          title={`Theme: ${themeLabels[theme]}`}
        >
          {themeIcons[theme]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-black/90 border border-orange-500/20 text-orange-100 shadow-[0_0_20px_rgba(255,80,0,0.2)]"
      >
        {(Object.keys(themeLabels) as ThemeId[]).map((id) => (
          <DropdownMenuItem
            key={id}
            onClick={() => applyTheme(id)}
            className="cursor-pointer focus:bg-orange-500/15"
          >
            <span className="mr-2 text-orange-300">{themeIcons[id]}</span>
            {themeLabels[id]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
