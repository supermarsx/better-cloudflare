import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

interface LoginVaultSectionProps {
  onRemoveVaultSecret: () => void;
}

export function LoginVaultSection({ onRemoveVaultSecret }: LoginVaultSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="pt-2">
      <Button
        variant="destructive"
        size="sm"
        onClick={onRemoveVaultSecret}
        className="w-full bg-red-900/20 border border-red-500/30 hover:bg-red-900/40 text-red-200"
      >
        {t("Remove Vault Secret")}
      </Button>
    </div>
  );
}
