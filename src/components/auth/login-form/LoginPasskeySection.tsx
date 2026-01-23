import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
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
    <div className="space-y-2 pt-4 border-t border-orange-500/20">
      <div className="flex items-center gap-2 pl-1">
        <Shield className="h-4 w-4 text-orange-500/70" />
        <Label className="text-orange-100/60 text-xs uppercase tracking-wider font-semibold">
          Passwordless Login (Passkeys)
        </Label>
      </div>
      <p className="text-xs text-orange-100/40 pl-1 mb-3">
        Use biometric authentication or security keys for secure, password-free login
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRegister}
          disabled={!selectedKeyId || !password || registerLoading}
          className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80 transition-all"
        >
          <Fingerprint className="h-4 w-4 mr-1" />
          {registerLoading ? "Registering..." : "Register Passkey"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={onUsePasskey}
          disabled={!selectedKeyId || authLoading}
          className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80 transition-all"
        >
          {authLoading ? "Authenticating..." : "Use Passkey"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={onManagePasskeys}
          disabled={!selectedKeyId || !password}
          className="col-span-2 bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80 transition-all"
        >
          Manage Passkeys
        </Button>
      </div>
    </div>
  );
}
