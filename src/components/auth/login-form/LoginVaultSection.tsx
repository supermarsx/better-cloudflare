import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";

interface LoginVaultSectionProps {
  onRemoveVaultSecret: () => void;
}

export function LoginVaultSection({ onRemoveVaultSecret }: LoginVaultSectionProps) {
  const { t } = useI18n();

  return (
    <div className="pt-2">
      <Button
        variant="destructive"
        size="sm"
        onClick={onRemoveVaultSecret}
        className="w-full bg-destructive/10 border border-destructive/30 text-destructive-foreground/80 hover:bg-destructive/20 hover:text-destructive-foreground transition-colors"
      >
        {t("Remove Vault Secret")}
      </Button>
    </div>
  );
}
