import { Button } from "@/components/ui/Button";
import { useTranslation } from "react-i18next";

interface VaultSectionProps {
  onRemoveVaultSecret: () => void;
}

export function VaultSection({ onRemoveVaultSecret }: VaultSectionProps) {
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
