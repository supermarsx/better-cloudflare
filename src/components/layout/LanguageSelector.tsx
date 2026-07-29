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
import { TauriClient } from "@/lib/api/tauri-client";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

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

interface LanguageSelectorProps {
  compact?: boolean;
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The preference service returned an unknown error.";
}

function getLocaleStorage(): Storage | undefined {
  if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
    return undefined;
  }
  return (globalThis as { localStorage: Storage }).localStorage;
}

function restoreStoredLocale(
  storage: Storage | undefined,
  previousLocale: string | null,
): void {
  if (!storage) return;
  if (previousLocale === null) {
    storage.removeItem("locale");
    return;
  }
  storage.setItem("locale", previousLocale);
}

function reportLanguageFailure(
  targetLanguage: string,
  error: unknown,
  rollbackErrors: unknown[],
): void {
  const rollbackGuidance =
    rollbackErrors.length === 0
      ? "The previous language was restored. Retry the change."
      : `Some previous settings could not be restored. Restart the app before retrying. Rollback errors: ${rollbackErrors
          .map(failureReason)
          .join("; ")}`;
  reportRuntimeError(
    new Error(
      `Could not switch the language to ${
        languageNames[targetLanguage] ?? targetLanguage
      }. ${rollbackGuidance} Reason: ${failureReason(error)}`,
    ),
    {
      source: "runtime",
      label: "Change language preference",
    },
  );
}

async function changeLanguageTransaction(lng: string): Promise<boolean> {
  const previousLanguage = i18n.resolvedLanguage || i18n.language || "en-US";
  if (lng === previousLanguage) return true;

  let storage: Storage | undefined;
  let previousStoredLocale: string | null = null;
  const desktop = isDesktop();
  let nativePersistenceAttempted = false;

  try {
    storage = getLocaleStorage();
    previousStoredLocale = storage?.getItem("locale") ?? null;

    if (desktop) {
      nativePersistenceAttempted = true;
      await TauriClient.updatePreferenceFields({ locale: lng });
    }

    storage?.setItem("locale", lng);
    await i18n.changeLanguage(lng);
    return true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];

    try {
      await i18n.changeLanguage(previousLanguage);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    try {
      restoreStoredLocale(storage, previousStoredLocale);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    if (desktop && nativePersistenceAttempted) {
      try {
        await TauriClient.updatePreferenceFields({
          locale: previousLanguage,
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }

    reportLanguageFailure(lng, error, rollbackErrors);
    return false;
  }
}

export function LanguageSelector({ compact = false }: LanguageSelectorProps) {
  const { t } = useI18n();
  const changeInFlightRef = React.useRef(false);
  const [isChangingLanguage, setIsChangingLanguage] = React.useState(false);

  const changeLanguage = async (lng: string): Promise<void> => {
    if (changeInFlightRef.current) return;

    changeInFlightRef.current = true;
    setIsChangingLanguage(true);
    try {
      await changeLanguageTransaction(lng);
    } finally {
      changeInFlightRef.current = false;
      setIsChangingLanguage(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={
            compact ? "ui-icon-button h-7 w-7" : "ui-icon-button h-8 w-8"
          }
          aria-label={t("Select language", "Select language")}
          aria-busy={isChangingLanguage}
        >
          <Globe className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="bg-popover/70 text-foreground"
      >
        {availableLanguages.map((lng) => (
          <DropdownMenuItem
            key={lng}
            disabled={isChangingLanguage}
            onClick={() => void changeLanguage(lng)}
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

LanguageSelector.changeLanguageTransaction = changeLanguageTransaction;
