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
import { TauriClient } from "@/lib/api/tauri-client";
import { useI18n } from "@/hooks/use-i18n";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

export type ThemeId = "sunset" | "oled" | "light";

const themeLabels: Record<ThemeId, string> = {
  sunset: "Sunset",
  oled: "Night",
  light: "Midday",
};

export interface StoredThemeResult {
  theme: ThemeId | null;
  storageAvailable: boolean;
}

export function readStoredTheme(
  storage: Pick<Storage, "getItem"> | undefined,
): StoredThemeResult {
  if (!storage) return { theme: null, storageAvailable: false };
  try {
    const saved = storage.getItem("theme");
    if (saved === null) return { theme: null, storageAvailable: true };
    if (saved in themeLabels) {
      return { theme: saved as ThemeId, storageAvailable: true };
    }
    reportRuntimeError(new SyntaxError("Unsupported saved theme value"), {
      source: "runtime",
      label: "Read saved theme: corrupt preference",
    });
    return { theme: null, storageAvailable: true };
  } catch (error) {
    reportRuntimeError(error, {
      source: "runtime",
      label: "Read saved theme: storage access denied",
    });
    return { theme: null, storageAvailable: false };
  }
}

export function persistTheme(
  theme: ThemeId,
  storage: Pick<Storage, "setItem"> | undefined,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem("theme", theme);
    return true;
  } catch (error) {
    reportRuntimeError(error, {
      source: "runtime",
      label: "Save theme preference",
    });
    return false;
  }
}

function getBrowserThemeStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch (error) {
    reportRuntimeError(error, {
      source: "runtime",
      label: "Access browser theme storage",
    });
    return undefined;
  }
}

interface ThemeToggleProps {
  compact?: boolean;
}

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<ThemeId>("sunset");
  const iconClass = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  const icons: Record<ThemeId, ReactNode> = {
    sunset: <Flame className={iconClass} />,
    oled: <Moon className={iconClass} />,
    light: <Sun className={iconClass} />,
  };

  useEffect(() => {
    let cancelled = false;
    const storage = getBrowserThemeStorage();
    const stored = readStoredTheme(storage);
    const apply = (next: ThemeId, saveLocally: boolean) => {
      if (cancelled) return;
      setTheme(next);
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = next;
      }
      if (saveLocally) persistTheme(next, storage);
    };

    if (stored.theme) {
      apply(stored.theme, false);
    } else if (isDesktop()) {
      void TauriClient.getPreferences()
        .then((prefs) => {
          const pref = prefs as { theme?: ThemeId };
          if (pref.theme && themeLabels[pref.theme]) {
            apply(pref.theme, stored.storageAvailable);
          } else {
            apply("sunset", stored.storageAvailable);
          }
        })
        .catch((error) => {
          reportRuntimeError(error, {
            source: "runtime",
            label: "Load desktop theme preference",
          });
          apply("sunset", stored.storageAvailable);
        });
    } else {
      apply("sunset", stored.storageAvailable);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const applyTheme = (next: ThemeId) => {
    setTheme(next);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
    }
    persistTheme(next, getBrowserThemeStorage());
    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({ theme: next }).catch((error) =>
        reportRuntimeError(error, {
          source: "runtime",
          label: "Save desktop theme preference",
        }),
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tooltip
          tip={t("Theme: {{name}}", {
            name: t(themeLabels[theme], themeLabels[theme]),
          })}
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            className={
              compact ? "ui-icon-button h-7 w-7" : "ui-icon-button h-8 w-8"
            }
            aria-label={t("Select theme", "Select theme")}
          >
            {icons[theme]}
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
            <span className="mr-2 text-primary">{icons[id]}</span>
            {t(themeLabels[id], themeLabels[id])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
