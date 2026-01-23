import { Button } from "@/components/ui/Button";
import { Plus } from "lucide-react";

interface LoginActionButtonsProps {
  onAddKey: () => void;
  onSettings: () => void;
  hasKeys: boolean;
}

export function LoginActionButtons({ onAddKey, onSettings, hasKeys }: LoginActionButtonsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 pt-2">
      <Button
        variant={hasKeys ? "secondary" : "default"}
        size={hasKeys ? "sm" : "default"}
        onClick={onAddKey}
        className={hasKeys 
          ? "w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
          : "w-full bg-gradient-to-r from-orange-600 to-orange-500 hover:from-orange-500 hover:to-orange-400 text-white font-semibold shadow-[0_0_20px_rgba(255,80,0,0.4)] hover:shadow-[0_0_30px_rgba(255,80,0,0.6)] transition-all duration-300 animate-pulse"
        }
      >
        {!hasKeys && <Plus className="h-4 w-4 mr-2" />}
        Add New Key
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={onSettings}
        className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
      >
        Settings
      </Button>
    </div>
  );
}
