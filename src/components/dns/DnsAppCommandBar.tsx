import type { ReactNode } from "react";
import {
  Bell,
  Globe,
  LogOut,
  Settings,
  Shield,
  Sparkles,
  Tags,
} from "lucide-react";

import { LanguageSelector } from "@/components/layout/LanguageSelector";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";

/**
 * What the assistant control does, which depends on where the assistant lives.
 *
 * The distinction is carried in the props rather than worked out inside this
 * component, because the two are not the same kind of control and only one of
 * them can honestly report a pressed state:
 *
 * - `reveal` — the assistant is a workspace tab, and activating the control
 *   activates that tab. You do not un-activate a tab, so there is nothing for
 *   `aria-pressed` to describe and claiming one would be a lie.
 * - `toggle` — the assistant is a dock or a bubble, which are shown and hidden
 *   in place. The control is a real toggle and says which state it is in.
 *   `surface` is carried because closing a dock and dismissing a bubble are
 *   different enough that one shared name would not tell you what will happen.
 */
export type AssistantCommandControl =
  | { mode: "reveal" }
  | { mode: "toggle"; surface: "sidebar" | "bubble"; open: boolean };

interface DnsAppCommandBarProps {
  accountLabel: string;
  sessionLabel: string;
  showAudit: boolean;
  /** Desktop only: the notifications bell (hidden on the web build). */
  showNotifications?: boolean;
  unreadCount?: number;
  onOpenNotifications?: () => void;
  /** Desktop only: the AI assistant. Every `ai_*` command is Tauri-only. */
  showAssistant?: boolean;
  /**
   * Reveal the assistant. Used in `reveal` mode — the open-only path.
   *
   * Deliberately *not* reused for the toggle: overloading one handler is what
   * left the dock with no way to be hidden from the chrome, so the two
   * semantics have two handlers.
   */
  onOpenAssistant?: () => void;
  /** Show or hide the dock or bubble. Required in `toggle` mode. */
  onToggleAssistant?: () => void;
  /**
   * Which of the two the control is. Defaults to `reveal`, which is what the
   * workspace tab needs and what every caller wanted before the dock existed.
   */
  assistantControl?: AssistantCommandControl;
  onOpenAudit: () => void;
  onOpenRegistry: () => void;
  onOpenSettings: () => void;
  onOpenTags: () => void;
  onLogout: () => void;
}

interface CommandActionProps {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /**
   * Toggle state, when this action is a toggle. `undefined` means it is not
   * one, and no `aria-pressed` is emitted at all — an action button that
   * reports `aria-pressed="false"` is announced as an unpressed toggle, which
   * is worse than silence.
   */
  pressed?: boolean;
  /** Stable hook for tests, independent of the translated name. */
  testId?: string;
}

function CommandAction({
  label,
  icon,
  onClick,
  pressed,
  testId,
}: CommandActionProps) {
  return (
    <Tooltip tip={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          "ui-icon-button h-8 w-8 shrink-0",
          // The pressed treatment is background and text only. The toolbar is
          // `overflow-x: auto` with a 0.375rem clip allowance sized for the
          // focus ring, the hover lift and the unread badge (see
          // `.app-command-toolbar` in `index.css`), so a pressed state that
          // painted outside the button's own box would be the fourth thing
          // fighting for that space — and the first one to need the allowance
          // widened.
          pressed === true && "bg-accent/60 text-foreground",
        )}
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        data-pressed={pressed === undefined ? undefined : pressed}
        onClick={onClick}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}

export function DnsAppCommandBar({
  accountLabel,
  sessionLabel,
  showAudit,
  showNotifications = false,
  unreadCount = 0,
  onOpenNotifications,
  showAssistant = false,
  onOpenAssistant,
  onToggleAssistant,
  assistantControl = { mode: "reveal" },
  onOpenAudit,
  onOpenRegistry,
  onOpenSettings,
  onOpenTags,
  onLogout,
}: DnsAppCommandBarProps) {
  const { t } = useI18n();

  /**
   * The assistant control, or `null` when there is nothing to offer.
   *
   * The handler is chosen by mode rather than by whichever one happens to be
   * wired, so a host that passes only the reveal handler while asking for a
   * toggle gets no control instead of a control that cannot close anything.
   */
  const assistantAction = (() => {
    if (!showAssistant) return null;
    if (assistantControl.mode === "toggle") {
      if (!onToggleAssistant) return null;
      const open = assistantControl.open;
      const dock = assistantControl.surface === "sidebar";
      // The name says what activating it will do, and to which surface:
      // "Assistant" alone cannot distinguish showing a dock from hiding a
      // bubble, and this control now does all four.
      const label = open
        ? dock
          ? t("Hide the docked assistant", "Hide the docked assistant")
          : t("Hide the floating assistant", "Hide the floating assistant")
        : dock
          ? t("Show the docked assistant", "Show the docked assistant")
          : t("Show the floating assistant", "Show the floating assistant");
      return { label, pressed: open, onClick: onToggleAssistant };
    }
    if (!onOpenAssistant) return null;
    return {
      label: t("Assistant", "Assistant"),
      pressed: undefined,
      onClick: onOpenAssistant,
    };
  })();

  return (
    <div className="mx-auto flex w-full max-w-[1600px] min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-4">
      <div aria-hidden="true" className="min-w-0 flex-1" />

      <div
        role="toolbar"
        aria-label={t(
          "Global application controls",
          "Global application controls",
        )}
        className="app-command-toolbar scrollbar-themed flex max-w-full items-center gap-1 overflow-x-auto"
      >
        {showNotifications && onOpenNotifications ? (
          <span className="relative inline-flex shrink-0">
            <CommandAction
              label={
                unreadCount > 0
                  ? t("Notifications, {{count}} unread", {
                      count: unreadCount,
                      defaultValue: `Notifications, ${unreadCount} unread`,
                    })
                  : t("Notifications", "Notifications")
              }
              icon={<Bell aria-hidden="true" className="h-4 w-4" />}
              onClick={onOpenNotifications}
            />
            {unreadCount > 0 ? (
              <span
                aria-hidden="true"
                data-testid="notifications-unread-badge"
                className="notifications-unread-badge"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            ) : null}
          </span>
        ) : null}
        {assistantAction ? (
          <CommandAction
            label={assistantAction.label}
            icon={<Sparkles aria-hidden="true" className="h-4 w-4" />}
            pressed={assistantAction.pressed}
            testId="command-bar-assistant"
            onClick={assistantAction.onClick}
          />
        ) : null}
        {showAudit ? (
          <CommandAction
            label={t("Audit log", "Audit log")}
            icon={<Shield aria-hidden="true" className="h-4 w-4" />}
            onClick={onOpenAudit}
          />
        ) : null}
        <CommandAction
          label={t("Registry Monitoring", "Registry Monitoring")}
          icon={<Globe aria-hidden="true" className="h-4 w-4" />}
          onClick={onOpenRegistry}
        />
        <CommandAction
          label={t("Settings", "Settings")}
          icon={<Settings aria-hidden="true" className="h-4 w-4" />}
          onClick={onOpenSettings}
        />
        <CommandAction
          label={t("Tags", "Tags")}
          icon={<Tags aria-hidden="true" className="h-4 w-4" />}
          onClick={onOpenTags}
        />
        <span
          aria-hidden="true"
          className="mx-1 h-5 w-px shrink-0 bg-border/80"
        />
        <LanguageSelector compact />
        <ThemeToggle compact />
        <div className="ml-1 min-w-0 max-w-40 border-l border-border/70 pl-2">
          <p
            className="truncate text-[11px] font-medium text-foreground"
            title={accountLabel}
          >
            {accountLabel}
          </p>
          <p
            className="truncate text-[10px] text-muted-foreground"
            title={sessionLabel}
          >
            {sessionLabel}
          </p>
        </div>
        <CommandAction
          label={t("Logout", "Logout")}
          icon={<LogOut aria-hidden="true" className="h-4 w-4" />}
          onClick={onLogout}
        />
      </div>
    </div>
  );
}
