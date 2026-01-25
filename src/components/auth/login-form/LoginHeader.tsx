import { Key } from "lucide-react";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/hooks/use-i18n";

export function LoginHeader() {
  const { t } = useI18n();
  
  return (
    <CardHeader className="text-center pb-2">
      <div className="flex justify-center mb-6">
        <div className="p-4">
          <Key className="h-10 w-10 text-orange-500" />
        </div>
      </div>
      <CardTitle className="text-3xl font-bold">
        {t("Cloudflare DNS Manager")}
      </CardTitle>
      <CardDescription className="mt-2">
        {t("Select your API key and enter your password to continue")}
      </CardDescription>
    </CardHeader>
  );
}
