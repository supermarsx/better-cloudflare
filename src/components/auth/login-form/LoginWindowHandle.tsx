import { useCallback, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/hooks/use-i18n";

type WindowAction = "start-dragging" | "toggle-maximize" | "minimize" | "close";

interface LoginWindowHandleProps {
  desktop: boolean;
}

async function runWindowAction(action: WindowAction) {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();

    if (action === "start-dragging") {
      await appWindow.startDragging();
      return;
    }
    if (action === "minimize") {
      await appWindow.minimize();
      return;
    }
    if (action === "close") {
      await appWindow.close();
      return;
    }

    await appWindow.toggleMaximize();
  } catch {
    // The declarative drag region remains inert if the native window API is
    // unavailable (for example during a web preview or a desktop shutdown).
  }
}

/**
 * Supplementary native drag affordance embedded into the desktop login card.
 * The main titlebar keeps the keyboard-accessible window controls, so this
 * pointer-only region stays out of the tab order and accessibility tree.
 */
export function LoginWindowHandle({ desktop }: LoginWindowHandleProps) {
  const isDraggingRef = useRef(false);
  const { t } = useI18n();

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!desktop || event.button !== 0 || isDraggingRef.current) return;

      isDraggingRef.current = true;
      void runWindowAction("start-dragging").finally(() => {
        isDraggingRef.current = false;
      });
    },
    [desktop],
  );

  const handleDoubleClick = useCallback(() => {
    if (!desktop) return;
    void runWindowAction("toggle-maximize");
  }, [desktop]);

  const handleControlPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      event.preventDefault();
    },
    [],
  );

  const handleControlMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const handleMinimize = useCallback(() => {
    if (!desktop) return;
    void runWindowAction("minimize");
  }, [desktop]);

  const handleMaximize = useCallback(() => {
    if (!desktop) return;
    void runWindowAction("toggle-maximize");
  }, [desktop]);

  const handleClose = useCallback(() => {
    if (!desktop) return;
    void runWindowAction("close");
  }, [desktop]);

  if (!desktop) return null;

  return (
    <div
      className="login-window-handle titlebar relative z-10 flex h-8 w-full items-center justify-between rounded-t-[inherit] border-b border-border/60 px-3 select-none"
      data-tauri-drag-region
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      <span
        className="login-window-handle-grip pointer-events-none"
        data-tauri-drag-region
      />
      <div className="flex items-center gap-1" onPointerDown={handleControlPointerDown}>
        <Tooltip tip={t("Minimize", "Minimize")} side="bottom">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="login-window-control-button h-6 w-6 bg-background/45 p-0"
            onPointerDown={handleControlPointerDown}
            onDoubleClick={handleControlMouseDown}
            onClick={handleMinimize}
            aria-label={t("Minimize window", "Minimize window")}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip tip={t("Toggle maximize", "Toggle maximize")} side="bottom">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="login-window-control-button h-6 w-6 bg-background/45 p-0"
            onPointerDown={handleControlPointerDown}
            onDoubleClick={handleControlMouseDown}
            onClick={handleMaximize}
            aria-label={t("Toggle maximize", "Toggle maximize")}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip tip={t("Close", "Close")} side="bottom">
          <Button
            type="button"
            size="icon"
            variant="destructive"
            className="login-window-control-button h-6 w-6 p-0"
            onPointerDown={handleControlPointerDown}
            onDoubleClick={handleControlMouseDown}
            onClick={handleClose}
            aria-label={t("Close window", "Close window")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
