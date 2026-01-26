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
          ? "w-full bg-card/70 border border-border text-foreground/80 hover:bg-accent/70 hover:text-foreground hover:border-primary/30 hover:shadow-[0_0_14px_rgba(0,0,0,0.12)] transition-all"
          : "w-full bg-primary text-primary-foreground font-semibold shadow-[0_12px_24px_rgba(0,0,0,0.2)] hover:brightness-110 transition-all duration-300"
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
            className="w-full bg-card/70 border border-border text-foreground/80 hover:bg-accent/70 hover:text-foreground hover:border-primary/30 hover:shadow-[0_0_14px_rgba(0,0,0,0.12)] transition-all"
            disabled={!canManage}
          >
            Manage Key
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="bg-popover/95 border border-border text-foreground shadow-[0_0_20px_rgba(0,0,0,0.15)]"
        >
          <DropdownMenuItem
            onClick={() => selectedKey && onEditKey(selectedKey)}
            className="cursor-pointer focus:bg-primary/10"
          >
            <Sliders className="mr-2 h-3.5 w-3.5" />
            {t("Edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => selectedKey && onDeleteKey(selectedKey.id)}
            className="cursor-pointer text-red-500/90 focus:bg-red-500/10 hover:bg-red-500/5"
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
        className="w-full bg-card/70 border border-border text-foreground/80 hover:bg-accent/70 hover:text-foreground hover:border-primary/30 hover:shadow-[0_0_14px_rgba(0,0,0,0.12)] transition-all"
      >
        Settings
      </Button>
    </div>
  );
}
