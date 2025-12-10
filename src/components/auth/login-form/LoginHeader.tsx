import { Key } from "lucide-react";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { useTranslation } from "react-i18next";

export function LoginHeader() {
  const { t } = useTranslation();
  
  return (
    <CardHeader className="text-center pb-2">
      <div className="flex justify-center mb-6 relative">
        <div className="absolute inset-0 bg-orange-500/10 blur-lg rounded-full transform scale-125" />
        <div className="p-4 bg-gradient-to-br from-orange-900/60 to-black rounded-full border border-orange-500/30 shadow-[0_0_10px_rgba(255,100,0,0.2)] relative z-10">
          <Key className="h-10 w-10 text-orange-500/90 drop-shadow-[0_0_4px_rgba(255,100,0,0.5)]" />
        </div>
      </div>
      <CardTitle className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-orange-400 via-red-500 to-orange-600 drop-shadow-sm">
        {t("Cloudflare DNS Manager")}
      </CardTitle>
      <CardDescription className="text-orange-100/60 mt-2">
        {t("Select your API key and enter your password to continue")}
      </CardDescription>
    </CardHeader>
  );
}
