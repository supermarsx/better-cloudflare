import { useCallback, useState } from "react";
import type { PointerEvent } from "react";

const TITLEBAR_HEIGHT_PX = 36;

type WindowAction = "close" | "minimize" | "toggle-maximize" | "start-dragging";

async function withWindow(action: WindowAction) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  switch (action) {
    case "close":
      await appWindow.close();
      break;
    case "minimize":
      await appWindow.minimize();
      break;
    case "toggle-maximize":
      await appWindow.toggleMaximize();
      break;
    case "start-dragging":
      await appWindow.startDragging();
      break;
    default:
      break;
  }
}

export function WindowTitleBar() {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragStart = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (isDragging) return;
      setIsDragging(true);
      void withWindow("start-dragging").finally(() => setIsDragging(false));
    },
    [isDragging],
  );

  const handleToggleMaximize = useCallback(() => {
    void withWindow("toggle-maximize");
  }, []);

  return (
    <div
      className="titlebar fixed inset-x-0 top-0 z-30 flex h-10 items-center justify-between border-b border-border/60 backdrop-blur-xl"
      style={{ height: TITLEBAR_HEIGHT_PX }}
    >
      <div
        className="titlebar-title flex h-full flex-1 items-center px-4 text-[11px] font-semibold uppercase text-muted-foreground/90 select-none cursor-default"
        data-tauri-drag-region
        onPointerDown={handleDragStart}
        onDoubleClick={handleToggleMaximize}
      >
        Better Cloudflare Console
      </div>
      <div className="titlebar-actions flex h-full items-center gap-1 pr-2 text-[10px] uppercase">
        <button
          className="h-7 w-9 cursor-pointer rounded-md border border-border/60 bg-background/30 text-muted-foreground/80 transition hover:scale-[1.04] hover:bg-muted/60 hover:text-foreground hover:shadow-[0_0_18px_rgba(255,140,90,0.35)] active:scale-[0.98]"
          onClick={() => void withWindow("minimize")}
          type="button"
          aria-label="Minimize window"
          title="Minimize"
        >
          -
        </button>
        <button
          className="h-7 w-9 cursor-pointer rounded-md border border-border/60 bg-background/30 text-muted-foreground/80 transition hover:scale-[1.04] hover:bg-muted/60 hover:text-foreground hover:shadow-[0_0_18px_rgba(255,140,90,0.35)] active:scale-[0.98]"
          onClick={() => void withWindow("toggle-maximize")}
          type="button"
          aria-label="Toggle maximize"
          title="Toggle maximize"
        >
          []
        </button>
        <button
          className="h-7 w-9 cursor-pointer rounded-md border border-border/60 bg-background/30 text-muted-foreground/80 transition hover:scale-[1.04] hover:bg-destructive/70 hover:text-destructive-foreground hover:shadow-[0_0_18px_rgba(255,90,50,0.4)] active:scale-[0.98]"
          onClick={() => void withWindow("close")}
          type="button"
          aria-label="Close window"
          title="Close"
        >
          X
        </button>
      </div>
    </div>
  );
}
