import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";

interface LoginVaultSectionProps {
  /** Whether the OS vault preference is currently on. */
  vaultEnabled: boolean;
  onRemoveVaultSecret: () => void;
}

/**
 * Vault controls.
 *
 * This section stays mounted when the vault preference is off. Hiding it there
 * would take away the only control that deletes a secret the app already wrote,
 * leaving the user to assume that switching the vault off had removed it.
 */
export function LoginVaultSection({
  vaultEnabled,
  onRemoveVaultSecret,
}: LoginVaultSectionProps) {
  const { t } = useI18n();

  return (
    <div className="space-y-2 pt-2">
      {!vaultEnabled && (
        <p
          data-testid="vault-disabled-notice"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-muted-foreground"
        >
          {t(
            "The OS vault is off, so passkey login is unavailable. An API key saved to the vault earlier remains in the system keychain until you remove it here.",
          )}
        </p>
      )}
      <Button
        variant="destructive"
        size="sm"
        onClick={onRemoveVaultSecret}
        className="w-full"
      >
        {t("Remove Vault Secret")}
      </Button>
    </div>
  );
}
