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
import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";
import type { ApiKey } from "@/types/dns";
import { useState } from "react";

interface LoginKeySelectorProps {
  apiKeys: ApiKey[];
  selectedKeyId: string;
  onSelectKey: (id: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onLogin: () => void;
  isLoading: boolean;
}

export function LoginKeySelector({
  apiKeys,
  selectedKeyId,
  onSelectKey,
  password,
  onPasswordChange,
  onLogin,
  isLoading,
}: LoginKeySelectorProps) {
  const { t } = useI18n();
  const hasKeys = apiKeys.length > 0;
  const [showPassword, setShowPassword] = useState(false);

  return (
    <>
      <div className="space-y-2">
        <Label
          htmlFor="api-key"
          className={hasKeys ? "text-foreground/80" : "text-muted-foreground/60"}
        >
          {t("API Key")}
        </Label>
        <Select value={selectedKeyId} onValueChange={onSelectKey} disabled={!hasKeys}>
          <SelectTrigger className="bg-card/70 border-border text-foreground h-11 transition-colors hover:bg-accent/50 hover:border-primary/30 focus:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed">
            <SelectValue placeholder={t("Select an API key")} />
          </SelectTrigger>
          <SelectContent className="bg-popover/95 border border-border text-foreground">
            {apiKeys.map((key) => (
              <SelectItem
                key={key.id}
                value={key.id}
                className="cursor-pointer focus:bg-accent/60 focus:text-foreground hover:bg-accent/40"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-medium">{key.label}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label
          htmlFor="password"
          className={hasKeys ? "text-foreground/80" : "text-muted-foreground/60"}
        >
          {t("Password")}
        </Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder={hasKeys ? t("Enter your password") : t("Add an API key first")}
            onKeyDown={(e) => e.key === "Enter" && hasKeys && onLogin()}
            disabled={!hasKeys}
            className="bg-card/70 border-border text-foreground h-11 pr-10 placeholder:text-muted-foreground/70 transition-colors hover:border-primary/30 focus:border-primary/50 focus:ring-primary/30 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
            aria-label={showPassword ? t("Hide password") : t("Show password")}
            disabled={!hasKeys}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <Button
        onClick={onLogin}
        className="w-full h-12 text-lg font-semibold shadow-[0_0_20px_rgba(255,80,0,0.3)] hover:shadow-[0_0_30px_rgba(255,80,0,0.5)] transition-all duration-300"
        disabled={isLoading || !selectedKeyId || !password}
      >
        {isLoading ? t("Logging in...") : t("Login")}
      </Button>
    </>
  );
}
