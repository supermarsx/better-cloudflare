import { Button } from "@/components/ui/button";
import { Plus, Sliders, Trash2 } from "lucide-react";
import type { ApiKey } from "@/types/dns";
import { useEffect, useRef, useState } from "react";
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
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const pendingManageAction = useRef<(() => void) | null>(null);
  const handoffFrame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (handoffFrame.current !== null) {
        window.cancelAnimationFrame(handoffFrame.current);
      }
    },
    [],
  );

  const queueManageAction = (event: Event, action: () => void) => {
    event.preventDefault();
    pendingManageAction.current = action;
    setManageMenuOpen(false);
  };

  const finishManageActionHandoff = (event: Event) => {
    const action = pendingManageAction.current;
    if (!action) return;

    event.preventDefault();
    pendingManageAction.current = null;
    if (handoffFrame.current !== null) {
      window.cancelAnimationFrame(handoffFrame.current);
    }
    handoffFrame.current = window.requestAnimationFrame(() => {
      handoffFrame.current = null;
      action();
    });
  };

  return (
    <div className="grid grid-cols-3 gap-3 pt-2">
      <Button
        type="button"
        variant={hasKeys ? "secondary" : "default"}
        size={hasKeys ? "sm" : "default"}
        onClick={onAddKey}
        className="w-full"
      >
        {!hasKeys && <Plus className="h-4 w-4 mr-2" />}
        Add New Key
      </Button>
      <DropdownMenu open={manageMenuOpen} onOpenChange={setManageMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={!canManage}
          >
            Manage Key
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="bg-popover/70 text-foreground"
          onCloseAutoFocus={finishManageActionHandoff}
        >
          <DropdownMenuItem
            onSelect={(event) => {
              if (!selectedKey) return;
              queueManageAction(event, () => onEditKey(selectedKey));
            }}
            className="cursor-pointer focus:bg-primary/10"
          >
            <Sliders className="mr-2 h-3.5 w-3.5" />
            {t("Edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              if (!selectedKey) return;
              queueManageAction(event, () => onDeleteKey(selectedKey.id));
            }}
            className="cursor-pointer text-red-500/90 focus:bg-red-500/10 hover:bg-red-500/5"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            {t("Delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onSettings}
        className="w-full"
      >
        Settings
      </Button>
    </div>
  );
}
