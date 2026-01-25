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
      className="fixed inset-x-0 top-0 z-30 flex h-9 items-center justify-between border-b border-border bg-background/80 backdrop-blur"
      style={{ height: TITLEBAR_HEIGHT_PX }}
    >
      <div
        className="flex h-full flex-1 items-center px-3 text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground select-none cursor-default"
        data-tauri-drag-region
        onPointerDown={handleDragStart}
        onDoubleClick={handleToggleMaximize}
      >
        Better Cloudflare
      </div>
      <div className="flex h-full items-center gap-1 pr-2">
        <button
          className="h-7 w-9 rounded-sm text-xs text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
          onClick={() => void withWindow("minimize")}
          type="button"
          aria-label="Minimize window"
          title="Minimize"
        >
          -
        </button>
        <button
          className="h-7 w-9 rounded-sm text-xs text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
          onClick={() => void withWindow("toggle-maximize")}
          type="button"
          aria-label="Toggle maximize"
          title="Toggle maximize"
        >
          []
        </button>
        <button
          className="h-7 w-9 rounded-sm text-xs text-muted-foreground transition hover:bg-destructive/70 hover:text-destructive-foreground"
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
