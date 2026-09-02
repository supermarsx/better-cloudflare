import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasskeyStatusNotice } from "@/components/auth/PasskeyStatusNotice";
import type { PasskeyStatusState } from "@/lib/auth/passkey-status";
import { Fingerprint, KeyRound, Shield } from "lucide-react";

interface LoginPasskeySectionProps {
  /** Open the legacy credential review dialog. */
  onManagePasskeys: () => void;
  /** Start a registration ceremony for the selected key. */
  onRegisterPasskey: () => void;
  /** Start an authentication ceremony for the selected key. */
  onUsePasskey: () => void;
  /** True while a registration ceremony is in flight. */
  registerLoading: boolean;
  /** True while an authentication ceremony is in flight. */
  authLoading: boolean;
  selectedKeyId: string;
  password?: string;
  hasKeys: boolean;
  status: PasskeyStatusState | null;
}

export function LoginPasskeySection({
  onManagePasskeys,
  onRegisterPasskey,
  onUsePasskey,
  registerLoading,
  authLoading,
  selectedKeyId,
  password,
  hasKeys,
  status,
}: LoginPasskeySectionProps) {
  if (!hasKeys || !status) return null;

  const legacyRecoveryAvailable = status.legacyRecoveryAvailable;

  // Registration is offered whenever the state says registration is open. That
  // is the `available` branch, and also the `legacy-credentials` branch — where
  // enrolling a new passkey is precisely the way out of the state, so gating it
  // on the state it fixes would strand the user.
  const canRegister = status.kind !== "error" && status.registration;

  // Signing in is stricter: only the `available` branch, which already folds in
  // this webview's client probe, so there is no second check to make here.
  const canAuthenticate = status.kind === "available" && status.authentication;

  const busy = registerLoading || authLoading;
  const offersCeremony = canRegister || canAuthenticate;

  return (
    <div className="space-y-2 pt-4 border-t border-border">
      <div className="flex items-center gap-2 pl-1">
        <Shield aria-hidden="true" className="h-4 w-4 text-primary/70" />
        <Label className="text-foreground/70 text-xs uppercase tracking-wider font-semibold">
          Passkey security status
        </Label>
      </div>

      {offersCeremony && (
        <p className="text-xs text-muted-foreground pl-1 mb-3">
          Sign in with your device instead of typing this key&apos;s password.
        </p>
      )}

      <PasskeyStatusNotice state={status} />

      {offersCeremony && (
        <div
          className={
            canRegister && canAuthenticate
              ? "grid grid-cols-2 gap-3"
              : undefined
          }
        >
          {canRegister && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRegisterPasskey}
              // Registration decrypts the stored key to seed the OS vault, so
              // it needs the password; signing in does not.
              disabled={!selectedKeyId || !password || busy}
              className="w-full"
            >
              <KeyRound aria-hidden="true" className="h-4 w-4 mr-1" />
              {registerLoading ? "Registering…" : "Register passkey"}
            </Button>
          )}

          {canAuthenticate && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onUsePasskey}
              disabled={!selectedKeyId || busy}
              className="w-full"
            >
              <Fingerprint aria-hidden="true" className="h-4 w-4 mr-1" />
              {authLoading ? "Signing in…" : "Use passkey"}
            </Button>
          )}
        </div>
      )}

      {legacyRecoveryAvailable && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onManagePasskeys}
          disabled={!selectedKeyId || !password}
          className="w-full"
        >
          Review legacy passkeys
        </Button>
      )}
    </div>
  );
}
