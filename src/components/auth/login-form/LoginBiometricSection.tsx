import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { Fingerprint, ShieldCheck, Trash2 } from "lucide-react";

interface LoginBiometricSectionProps {
  /** Whether biometrics are available on this device. */
  biometricAvailable: boolean;
  /** Human-readable type label, e.g. "Touch ID". */
  biometricLabel: string;
  /** Whether a biometric-protected key already exists for the selected key. */
  biometricEnrolled: boolean;
  /** Login via biometric (Touch ID / Windows Hello). */
  onBiometricLogin: () => void;
  /** Enroll the current key for biometric unlock (after password login). */
  onBiometricEnroll: () => void;
  /** Remove biometric enrolment for the current key. */
  onBiometricRemove: () => void;
  /** True while a biometric operation is in-flight. */
  biometricLoading: boolean;
  /** A key must be selected for any action. */
  selectedKeyId: string;
  /** Password is needed for enrolment (so we can decrypt the key first). */
  password: string;
  /** Whether the user has any stored keys at all. */
  hasKeys: boolean;
  /** Whether this is a desktop (Tauri) environment. */
  desktop: boolean;
}

export function LoginBiometricSection({
  biometricAvailable,
  biometricLabel,
  biometricEnrolled,
  onBiometricLogin,
  onBiometricEnroll,
  onBiometricRemove,
  biometricLoading,
  selectedKeyId,
  password,
  hasKeys,
  desktop,
}: LoginBiometricSectionProps) {
  const { t } = useI18n();
  // `biometricLabel` is the platform's own name for the hardware — "Touch ID",
  // "Windows Hello" — so it is interpolated rather than translated, and the
  // surrounding sentence is a key with a `{{label}}` slot. A locale that needs
  // the label somewhere other than where English puts it can move the slot,
  // which is the whole reason this is one key and not a concatenation.
  //
  // The button labels keep their English as a floor, the same guard
  // `LoginSettingsMenu` uses: `t` is an empty string until `src/i18n.ts`
  // finishes its dynamic `import`, and a button's text is its accessible name.
  const loginLabel =
    t("Login with {{label}}", {
      label: biometricLabel,
      defaultValue: `Login with ${biometricLabel}`,
    }) || `Login with ${biometricLabel}`;
  const verifyingLabel = t("Verifying…", "Verifying…") || "Verifying…";
  const enableLabel =
    t("Enable {{label}} Unlock", {
      label: biometricLabel,
      defaultValue: `Enable ${biometricLabel} Unlock`,
    }) || `Enable ${biometricLabel} Unlock`;
  const enrollingLabel = t("Enrolling…", "Enrolling…") || "Enrolling…";
  const removeLabel = t("Remove", "Remove") || "Remove";

  // Only render on desktop with biometric hardware and at least one key
  if (!desktop || !biometricAvailable || !hasKeys) return null;

  return (
    <div className="space-y-2 pt-4 border-t border-border">
      <div className="flex items-center gap-2 pl-1">
        <ShieldCheck className="h-4 w-4 text-primary/70" />
        <Label className="text-foreground/70 text-xs uppercase tracking-wider font-semibold">
          {t("{{label}} Unlock", {
            label: biometricLabel,
            defaultValue: `${biometricLabel} Unlock`,
          })}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground pl-1 mb-3">
        {t(
          "Use {{label}} to instantly unlock your API key without typing a password",
          {
            label: biometricLabel,
            defaultValue: `Use ${biometricLabel} to instantly unlock your API key without typing a password`,
          },
        )}
      </p>

      {biometricEnrolled ? (
        <div className="grid grid-cols-2 gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={onBiometricLogin}
            disabled={!selectedKeyId || biometricLoading}
            className="w-full"
          >
            <Fingerprint className="h-4 w-4 mr-1" />
            {biometricLoading ? verifyingLabel : loginLabel}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={onBiometricRemove}
            disabled={!selectedKeyId || biometricLoading}
            className="w-full text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {removeLabel}
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={onBiometricEnroll}
          disabled={!selectedKeyId || !password || biometricLoading}
          className="w-full"
        >
          <Fingerprint className="h-4 w-4 mr-1" />
          {biometricLoading ? enrollingLabel : enableLabel}
        </Button>
      )}
    </div>
  );
}
