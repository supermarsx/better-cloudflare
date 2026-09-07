import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, EyeOff, Plus } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";
import type { ApiKey } from "@/types/dns";
import { useState } from "react";

/**
 * The value carried by the "Add new key" row.
 *
 * It is a real `SelectItem` rather than a button appended under the list so
 * that keyboard users reach it the same way they reach a key — Radix owns
 * arrow-key movement and typeahead inside the listbox, and a stray `button`
 * in there is reachable by mouse only. The cost is that it is announced as an
 * option, which is why `onValueChange` filters it out before it can ever be
 * mistaken for a selected key.
 *
 * Exported so a test can name the row without hard-coding the string.
 */
export const ADD_KEY_OPTION_VALUE = "__add-new-key__";

interface LoginKeySelectorProps {
  apiKeys: ApiKey[];
  selectedKeyId: string;
  onSelectKey: (id: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onLogin: () => void;
  isLoading: boolean;
  /**
   * Open the add-key dialog straight from the list. Optional so the component
   * still renders standalone; the row is only offered when it is supplied.
   */
  onAddKey?: () => void;
}

export function LoginKeySelector({
  apiKeys,
  selectedKeyId,
  onSelectKey,
  password,
  onPasswordChange,
  onLogin,
  isLoading,
  onAddKey,
}: LoginKeySelectorProps) {
  const { t } = useI18n();
  const hasKeys = apiKeys.length > 0;
  const [showPassword, setShowPassword] = useState(false);
  const apiKeyLabel = t("API Key", "API Key") || "API Key";

  return (
    <>
      <div className="space-y-2">
        <Label
          id="api-key-label"
          htmlFor="api-key"
          className={
            hasKeys ? "text-foreground/80" : "text-muted-foreground/60"
          }
        >
          {apiKeyLabel}
        </Label>
        <Select
          value={selectedKeyId}
          onValueChange={(value) => {
            if (value === ADD_KEY_OPTION_VALUE) {
              onAddKey?.();
              return;
            }
            onSelectKey(value);
          }}
          disabled={!hasKeys || isLoading}
        >
          <SelectTrigger
            id="api-key"
            aria-labelledby="api-key-label"
            aria-label={apiKeyLabel}
            className="bg-card/70 border-border text-foreground h-11 transition-colors hover:bg-accent/70 hover:border-primary/30 focus:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <SelectValue placeholder={t("Select an API key")} />
          </SelectTrigger>
          <SelectContent className="bg-popover/95 border border-border text-foreground">
            {apiKeys.map((key) => (
              <SelectItem
                key={key.id}
                value={key.id}
                className="cursor-pointer focus:bg-primary/10 focus:text-foreground hover:bg-primary/5"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-medium">{key.label}</span>
                </div>
              </SelectItem>
            ))}
            {onAddKey && (
              <SelectItem
                value={ADD_KEY_OPTION_VALUE}
                className="mt-1 cursor-pointer border-t border-border/60 text-muted-foreground focus:bg-primary/10 focus:text-foreground hover:bg-primary/5"
              >
                <div className="flex items-center gap-2">
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="font-medium">
                    {t("Add new key", "Add new key")}
                  </span>
                </div>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label
          htmlFor="password"
          className={
            hasKeys ? "text-foreground/80" : "text-muted-foreground/60"
          }
        >
          {t("Password", "Password")}
        </Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder={
              hasKeys
                ? t("Enter your password", "Enter your password")
                : t("Add an API key first", "Add an API key first")
            }
            onKeyDown={(e) =>
              e.key === "Enter" && hasKeys && !isLoading && onLogin()
            }
            disabled={!hasKeys || isLoading}
            className="bg-card/70 border-border text-foreground h-11 pr-10 placeholder:text-muted-foreground/70 transition-colors hover:border-primary/30 focus:border-primary/50 focus:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            className="ui-icon-button absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 p-0 text-muted-foreground/80 hover:text-foreground"
            aria-label={
              showPassword
                ? t("Hide password", "Hide password")
                : t("Show password", "Show password")
            }
            disabled={!hasKeys || isLoading}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      <Button
        onClick={onLogin}
        className="w-full h-12 text-lg font-semibold"
        disabled={isLoading || !selectedKeyId || !password}
      >
        {isLoading ? t("Logging in...", "Logging in...") : t("Login", "Login")}
      </Button>
    </>
  );
}
