import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ApiKey } from "@/types/dns";

interface KeySelectorProps {
  apiKeys: ApiKey[];
  selectedKeyId: string;
  onSelectKey: (id: string) => void;
  onEditKey: (key: ApiKey) => void;
  onDeleteKey: (id: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onLogin: () => void;
  isLoading: boolean;
}

export function KeySelector({
  apiKeys,
  selectedKeyId,
  onSelectKey,
  onEditKey,
  onDeleteKey,
  password,
  onPasswordChange,
  onLogin,
  isLoading,
}: KeySelectorProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="api-key" className="text-orange-100/80">
          {t("API Key")}
        </Label>
        <Select value={selectedKeyId} onValueChange={onSelectKey}>
          <SelectTrigger className="bg-black/40 border-orange-500/20 focus:ring-orange-500/50 text-orange-50 h-11">
            <SelectValue placeholder={t("Select an API key")} />
          </SelectTrigger>
          <SelectContent className="bg-black/90 border-orange-500/30 text-orange-50">
            {apiKeys.map((key) => (
              <SelectItem
                key={key.id}
                value={key.id}
                className="focus:bg-orange-500/20 focus:text-orange-100 cursor-pointer"
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-medium">{key.label}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditKey(key);
                      }}
                      className="h-7 w-7 p-0 hover:bg-orange-500/20 hover:text-orange-300"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteKey(key.id);
                      }}
                      className="h-7 w-7 p-0 hover:bg-red-900/30 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password" className="text-orange-100/80">
          {t("Password")}
        </Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder={t("Enter your password")}
          onKeyDown={(e) => e.key === "Enter" && onLogin()}
          className="bg-black/40 border-orange-500/20 focus:border-orange-500/50 focus:ring-orange-500/20 text-orange-50 h-11 placeholder:text-orange-500/20"
        />
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
