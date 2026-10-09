/**
 * The login screen's key and settings menu, shown as one gear button in the
 * preferences dock beside the language and theme toggles.
 *
 * This replaces the three-button row that sat under the password field. The
 * row cost a third of the card's height to controls that are used once or
 * twice in the life of an install, and pushed the passkey and biometric
 * sections below the fold on a short window.
 *
 * The deferred-action dance below is not incidental. Opening a dialog directly
 * from `onSelect` races the menu's own closing focus restore: the menu returns
 * focus to its trigger after the dialog has mounted and taken it, which drops
 * focus out of the dialog and back onto a button behind the overlay. So the
 * action is queued, the menu is closed, and the action runs from
 * `onCloseAutoFocus` — after focus restore has been suppressed — on the next
 * frame. `e2e/login-key-management.spec.ts` pins exactly this.
 */
import { useEffect, useRef, useState } from "react";
import {
  CloudDownload,
  KeyRound,
  Plus,
  Settings2,
  Sliders,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { useI18n } from "@/hooks/use-i18n";
import type { ApiKey } from "@/types/dns";

interface LoginSettingsMenuProps {
  onAddKey: () => void;
  onSettings: () => void;
  /**
   * Opens cloud sync. Omitted on the web build, where the item is not shown.
   *
   * A callback rather than a `boolean` beside one, so there is no way to be
   * told the item is available and then have nothing to call — and so this
   * menu needs to know nothing about why it is unavailable. Sync is
   * desktop-only (it speaks WebDAV and keeps secrets in the OS keyring), and
   * the caller is the one that knows which build this is.
   */
  onCloudSync?: () => void;
  hasKeys: boolean;
  selectedKey: ApiKey | null;
  onEditKey: (key: ApiKey) => void;
  onDeleteKey: (id: string) => void;
  /** Lets the dock hold itself open while this menu is showing. */
  onOpenChange?: (open: boolean) => void;
}

export function LoginSettingsMenu({
  onAddKey,
  onSettings,
  onCloudSync,
  hasKeys,
  selectedKey,
  onEditKey,
  onDeleteKey,
  onOpenChange,
}: LoginSettingsMenuProps) {
  const { t } = useI18n();
  // i18n resolves asynchronously, and `t` returns an empty string until it
  // does. On an icon-only button that leaves the control with no accessible
  // name at all for the first paint, so each call keeps the literal as a
  // floor — the same guard `LoginKeySelector` uses for the key label.
  //
  // Written out as a bare `t(…) || "…"` at every call site rather than routed
  // through a one-argument helper, which is what this file used to do. The
  // helper read better and hid every string in this menu from
  // `scripts/i18n-coverage.mjs`: that scanner finds literal `t(` call sites
  // and deliberately rejects any with an identifier character in front, so an
  // aliased call matched nothing. "Keys and settings" — this menu's
  // accessible name — was therefore uncatalogued and shipped in English in
  // all twelve locales while the coverage report read `0 uncatalogued
  // strings`. The other six survived only by being catalogued from other
  // files, which is luck rather than a mechanism.
  const menuLabel =
    t("Keys and settings", "Keys and settings") || "Keys and settings";
  const canManage = Boolean(selectedKey && hasKeys);
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const handoffFrame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (handoffFrame.current !== null) {
        window.cancelAnimationFrame(handoffFrame.current);
      }
    },
    [],
  );

  const setOpen = (open: boolean) => {
    setMenuOpen(open);
    onOpenChange?.(open);
  };

  const queueAction = (event: Event, action: () => void) => {
    event.preventDefault();
    pendingAction.current = action;
    setOpen(false);
  };

  const finishActionHandoff = (event: Event) => {
    const action = pendingAction.current;
    if (!action) return;

    event.preventDefault();
    pendingAction.current = null;
    if (handoffFrame.current !== null) {
      window.cancelAnimationFrame(handoffFrame.current);
    }
    handoffFrame.current = window.requestAnimationFrame(() => {
      handoffFrame.current = null;
      action();
    });
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setOpen}>
      <Tooltip tip={menuLabel} side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ui-icon-button h-7 w-7"
            aria-label={menuLabel}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-52 bg-popover/70 text-foreground"
        onCloseAutoFocus={finishActionHandoff}
      >
        <DropdownMenuItem
          onSelect={(event) => queueAction(event, onAddKey)}
          className="cursor-pointer focus:bg-primary/10"
        >
          <Plus className="mr-2 h-3.5 w-3.5" />
          {t("Add New Key", "Add New Key") || "Add New Key"}
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={!canManage}
            className="cursor-pointer px-2 py-1.5 focus:bg-primary/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            <KeyRound className="mr-2 h-3.5 w-3.5" />
            {t("Manage Key", "Manage Key") || "Manage Key"}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="bg-popover/70 text-foreground">
              <DropdownMenuItem
                onSelect={(event) => {
                  if (!selectedKey) return;
                  queueAction(event, () => onEditKey(selectedKey));
                }}
                className="cursor-pointer focus:bg-primary/10"
              >
                <Sliders className="mr-2 h-3.5 w-3.5" />
                {t("Edit", "Edit") || "Edit"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(event) => {
                  if (!selectedKey) return;
                  queueAction(event, () => onDeleteKey(selectedKey.id));
                }}
                className="cursor-pointer text-red-500/90 focus:bg-red-500/10 hover:bg-red-500/5"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {t("Delete", "Delete") || "Delete"}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        {/* Above Settings rather than below it: on a machine with no keys
            this is the only item that leads anywhere useful, and it is what
            someone restoring an install is looking for. Queued through
            `queueAction` like every other item here — see the file header on
            why opening a dialog straight from `onSelect` loses focus. */}
        {onCloudSync ? (
          <DropdownMenuItem
            onSelect={(event) => queueAction(event, onCloudSync)}
            className="cursor-pointer focus:bg-primary/10"
            data-testid="login-menu-cloud-sync"
          >
            <CloudDownload className="mr-2 h-3.5 w-3.5" />
            {t("Cloud sync", "Cloud sync") || "Cloud sync"}
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuItem
          onSelect={(event) => queueAction(event, onSettings)}
          className="cursor-pointer focus:bg-primary/10"
        >
          <Settings2 className="mr-2 h-3.5 w-3.5" />
          {t("Settings", "Settings") || "Settings"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default LoginSettingsMenu;
