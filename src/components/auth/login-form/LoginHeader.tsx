import { Key } from "lucide-react";
import { CardDescription, CardHeader } from "@/components/ui/card";
import { useI18n } from "@/hooks/use-i18n";

export function LoginHeader() {
  const { t } = useI18n();
  
  return (
    <CardHeader className="text-center pb-2">
      <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground/60">
        {t("Authentication")}
      </div>
      <div className="flex justify-center mb-6">
        <div className="p-4">
          <Key className="h-10 w-10 text-primary" />
        </div>
      </div>
      <CardDescription className="mt-2">
        {t("Select your API key and enter your password to continue")}
      </CardDescription>
    </CardHeader>
  );
}
