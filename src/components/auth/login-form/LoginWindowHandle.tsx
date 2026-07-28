import {
  WindowControls,
  useWindowDragRegion,
} from "@/components/layout/WindowControls";
import { useI18n } from "@/hooks/use-i18n";

interface LoginWindowHandleProps {
  desktop: boolean;
}

/**
 * Supplementary native window chrome embedded into the desktop login card.
 */
export function LoginWindowHandle({ desktop }: LoginWindowHandleProps) {
  const { t } = useI18n();
  const dragRegion = useWindowDragRegion(desktop);

  if (!desktop) return null;

  return (
    <div
      className="login-window-handle titlebar relative z-10 flex h-10 w-full items-center justify-between rounded-t-[inherit] border-b border-border/60 pl-4 pr-2 select-none"
      data-testid="auth-window-handle"
      data-tauri-drag-region
      {...dragRegion}
    >
      <span
        className="titlebar-title pointer-events-none text-[10px] font-semibold uppercase text-muted-foreground/90"
        data-tauri-drag-region
      >
        {t("Better Cloudflare Console", "Better Cloudflare Console")}
      </span>
      <WindowControls />
    </div>
  );
}
