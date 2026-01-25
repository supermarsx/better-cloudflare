import { Button } from "@/components/ui/button";
import { Plus, Sliders, Trash2 } from "lucide-react";
import type { ApiKey } from "@/types/dns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { useI18n } from "@/hooks/use-i18n";

interface LoginActionButtonsProps {
  onAddKey: () => void;
  onSettings: () => void;
  hasKeys: boolean;
  selectedKey: ApiKey | null;
  onEditKey: (key: ApiKey) => void;
  onDeleteKey: (id: string) => void;
}

export function LoginActionButtons({
  onAddKey,
  onSettings,
  hasKeys,
  selectedKey,
  onEditKey,
  onDeleteKey,
}: LoginActionButtonsProps) {
  const { t } = useI18n();
  const canManage = Boolean(selectedKey && hasKeys);

  return (
    <div className="grid grid-cols-3 gap-3 pt-2">
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
            disabled={!canManage}
          >
            Manage Key
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="bg-black/90 border border-orange-500/20 text-orange-100 shadow-[0_0_20px_rgba(255,80,0,0.2)]"
        >
          <DropdownMenuItem
            onClick={() => selectedKey && onEditKey(selectedKey)}
            className="cursor-pointer focus:bg-orange-500/15"
          >
            <Sliders className="mr-2 h-3.5 w-3.5" />
            {t("Edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => selectedKey && onDeleteKey(selectedKey.id)}
            className="cursor-pointer text-red-300 focus:bg-red-500/15"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t("Delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
