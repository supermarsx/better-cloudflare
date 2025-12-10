import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";

interface PasskeySectionProps {
  onRegister: () => void;
  onUsePasskey: () => void;
  onManagePasskeys: () => void;
  selectedKeyId: string;
  password?: string;
  registerLoading: boolean;
  authLoading: boolean;
}

export function PasskeySection({
  onRegister,
  onUsePasskey,
  onManagePasskeys,
  selectedKeyId,
  password,
  registerLoading,
  authLoading,
}: PasskeySectionProps) {
  return (
    <div className="space-y-2 pt-4 border-t border-orange-500/20">
      <Label className="text-orange-100/60 text-xs uppercase tracking-wider font-semibold pl-1">
        Passkeys
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRegister}
          disabled={!selectedKeyId || !password || registerLoading}
          className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
        >
          {registerLoading ? "Registering..." : "Register"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={onUsePasskey}
          disabled={!selectedKeyId || authLoading}
          className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
        >
          {authLoading ? "Authenticating..." : "Use Passkey"}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={onManagePasskeys}
          disabled={!selectedKeyId || !password}
          className="col-span-2 bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
        >
          Manage Passkeys
        </Button>
      </div>
    </div>
  );
}
