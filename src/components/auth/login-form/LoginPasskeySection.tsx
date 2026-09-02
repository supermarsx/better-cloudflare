import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  passkeyStatusReason,
  type PasskeyStatusState,
} from "@/lib/auth/passkey-status";
import { AlertTriangle, Shield } from "lucide-react";

interface LoginPasskeySectionProps {
  onManagePasskeys: () => void;
  selectedKeyId: string;
  password?: string;
  hasKeys: boolean;
  status: PasskeyStatusState | null;
}

export function LoginPasskeySection({
  onManagePasskeys,
  selectedKeyId,
  password,
  hasKeys,
  status,
}: LoginPasskeySectionProps) {
  if (!hasKeys || !status) return null;

  const legacyRecoveryAvailable = status.legacyRecoveryAvailable;
  // `null` once passkeys are usable. The register and sign-in controls for that
  // branch are `t22-e6`'s work; this keeps the component honest in the meantime
  // by not claiming unavailability when the status says otherwise.
  const reason = passkeyStatusReason(status);

  return (
    <div className="space-y-2 pt-4 border-t border-border">
      <div className="flex items-center gap-2 pl-1">
        <Shield className="h-4 w-4 text-primary/70" />
        <Label className="text-foreground/70 text-xs uppercase tracking-wider font-semibold">
          Passkey security status
        </Label>
      </div>
      {reason !== null && (
        <div
          className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm text-foreground"
          role="alert"
        >
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Passkeys temporarily unavailable
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
        </div>
      )}
      {legacyRecoveryAvailable && (
        <Button
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
