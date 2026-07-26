import { useCallback, useRef } from "react";
import type { PointerEvent } from "react";

type WindowAction = "start-dragging" | "toggle-maximize";

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

  if (!desktop) return null;

  return (
    <div
      aria-hidden="true"
      className="login-window-handle titlebar relative z-10 flex h-8 w-full items-center justify-center rounded-t-[inherit] border-b border-border/60 px-4 select-none"
      data-tauri-drag-region
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
    >
      <span
        className="login-window-handle-grip pointer-events-none"
        data-tauri-drag-region
      />
    </div>
  );
}
