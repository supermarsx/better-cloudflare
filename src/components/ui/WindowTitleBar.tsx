import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { storageManager } from "@/lib/storage";
import { TauriClient } from "@/lib/tauri-client";

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
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [confirmWindowClose, setConfirmWindowClose] = useState(
    storageManager.getConfirmWindowClose(),
  );
  const allowCloseRef = useRef(false);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty(
      "--app-top-inset",
      `${TITLEBAR_HEIGHT_PX}px`,
    );
    return () => {
      document.documentElement.style.setProperty("--app-top-inset", "0px");
    };
  }, []);

  useEffect(() => {
    const onPrefs = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { confirmWindowClose?: unknown }
        | undefined;
      if (!detail) return;
      if (typeof detail.confirmWindowClose === "boolean") {
        setConfirmWindowClose(detail.confirmWindowClose);
      }
    };
    window.addEventListener("preferences-changed", onPrefs);
    return () => window.removeEventListener("preferences-changed", onPrefs);
  }, []);

  const requestClose = useCallback(async () => {
    const enabled = confirmWindowClose;
    if (!enabled) {
      allowCloseRef.current = true;
      await withWindow("close");
      return;
    }
    setDontAskAgain(false);
    setConfirmCloseOpen(true);
  }, [confirmWindowClose]);

  const persistConfirmWindowClose = useCallback(async (enabled: boolean) => {
    storageManager.setConfirmWindowClose(enabled);
    setConfirmWindowClose(enabled);
    if (!TauriClient.isTauri()) return;
    await TauriClient.updatePreferenceFields({
      confirm_window_close: enabled,
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!TauriClient.isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested((event) => {
        if (allowCloseRef.current) {
          allowCloseRef.current = false;
          return;
        }
        event.preventDefault();
        void requestClose();
      });
    })().catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [requestClose]);

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
      className="titlebar fixed inset-x-0 top-0 z-[2147483000] flex h-10 items-center justify-between border-b border-border/60 backdrop-blur-xl"
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
        <Tooltip tip="Minimize" side="bottom">
          <button
            className="h-7 w-9 cursor-pointer rounded-md border border-border/60 bg-background/30 text-muted-foreground/80 transition hover:scale-[1.04] hover:bg-muted/60 hover:text-foreground hover:shadow-[0_0_18px_rgba(255,140,90,0.35)] active:scale-[0.98]"
            onClick={() => void withWindow("minimize")}
            type="button"
            aria-label="Minimize window"
          >
            -
          </button>
        </Tooltip>
        <Tooltip tip="Toggle maximize" side="bottom">
          <button
            className="h-7 w-9 cursor-pointer rounded-md border border-border/60 bg-background/30 text-muted-foreground/80 transition hover:scale-[1.04] hover:bg-muted/60 hover:text-foreground hover:shadow-[0_0_18px_rgba(255,140,90,0.35)] active:scale-[0.98]"
            onClick={() => void withWindow("toggle-maximize")}
            type="button"
            aria-label="Toggle maximize"
          >
            []
          </button>
        </Tooltip>
        <Tooltip tip="Close" side="bottom">
          <button
            className="h-7 w-9 cursor-pointer rounded-md border border-border/60 bg-background/30 text-muted-foreground/80 transition hover:scale-[1.04] hover:bg-destructive/70 hover:text-destructive-foreground hover:shadow-[0_0_18px_rgba(255,90,50,0.4)] active:scale-[0.98]"
            onClick={() => void requestClose()}
            type="button"
            aria-label="Close window"
          >
            X
          </button>
        </Tooltip>
      </div>
      <Dialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close Better Cloudflare?</DialogTitle>
            <DialogDescription>
              Unsaved edits may be lost. Are you sure you want to close the window?
            </DialogDescription>
          </DialogHeader>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="checkbox-themed"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            Don&apos;t ask again
          </label>
          <DialogFooter className="mt-2 gap-2 sm:gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmCloseOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void (async () => {
                  if (dontAskAgain) {
                    await persistConfirmWindowClose(false);
                  }
                  allowCloseRef.current = true;
                  await withWindow("close");
                })();
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
