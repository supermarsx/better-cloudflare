import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Fingerprint, Shield } from "lucide-react";

interface LoginPasskeySectionProps {
  onRegister: () => void;
  onUsePasskey: () => void;
  onManagePasskeys: () => void;
  selectedKeyId: string;
  password?: string;
  registerLoading: boolean;
  authLoading: boolean;
  hasKeys: boolean;
}

export function LoginPasskeySection({
  onRegister,
  onUsePasskey,
  onManagePasskeys,
  selectedKeyId,
  password,
  registerLoading,
  authLoading,
  hasKeys,
}: LoginPasskeySectionProps) {
  if (!hasKeys) return null;

  return (
    <div className="space-y-2 pt-4 border-t border-border">
      <div className="flex items-center gap-2 pl-1">
        <Shield className="h-4 w-4 text-primary/70" />
        <Label className="text-foreground/70 text-xs uppercase tracking-wider font-semibold">
          Passwordless Login (Passkeys)
        </Label>
      </div>
      <p className="text-xs text-muted-foreground pl-1 mb-3">
        Use biometric authentication or security keys for secure, password-free login
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRegister}
          disabled={!selectedKeyId || !password || registerLoading}
          className="w-full bg-card/70 border border-border text-foreground/80 hover:bg-accent/70 hover:text-foreground hover:border-primary/30 hover:shadow-[0_0_14px_rgba(0,0,0,0.12)] transition-all"
        >
          <Fingerprint className="h-4 w-4 mr-1" />
          {registerLoading ? "Registering..." : "Register Passkey"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={onUsePasskey}
          disabled={!selectedKeyId || authLoading}
          className="w-full bg-card/70 border border-border text-foreground/80 hover:bg-accent/70 hover:text-foreground hover:border-primary/30 hover:shadow-[0_0_14px_rgba(0,0,0,0.12)] transition-all"
        >
          {authLoading ? "Authenticating..." : "Use Passkey"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={onManagePasskeys}
          disabled={!selectedKeyId || !password}
          className="col-span-2 bg-card/70 border border-border text-foreground/80 hover:bg-accent/70 hover:text-foreground hover:border-primary/30 hover:shadow-[0_0_14px_rgba(0,0,0,0.12)] transition-all"
        >
          Manage Passkeys
        </Button>
      </div>
    </div>
  );
}
