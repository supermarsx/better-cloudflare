import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
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
import { useI18n } from "@/hooks/use-i18n";

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
  const { t } = useI18n();
  const [isDragging, setIsDragging] = useState(false);
  const [isTopmost, setIsTopmost] = useState(false);
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const [windowMenuPos, setWindowMenuPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);
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

      try {
        const current = await (appWindow as any).isAlwaysOnTop?.();
        if (typeof current === "boolean") setIsTopmost(current);
      } catch {
        // ignore
      }

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

  const handleWindowContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      // Close first so repeated right-clicks feel snappy.
      setWindowMenuOpen(false);

      const x = event.clientX;
      const y = event.clientY;
      setWindowMenuPos({ x, y });

      // Ensure position state is committed before opening.
      requestAnimationFrame(() => setWindowMenuOpen(true));
    },
    [],
  );

  const handleToggleTopmost = useCallback(() => {
    if (!TauriClient.isTauri()) return;
    setIsTopmost((prev) => {
      const next = !prev;
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const appWindow = getCurrentWindow();
          await (appWindow as any).setAlwaysOnTop?.(next);
        } catch {
          setIsTopmost(prev);
        }
      })();
      return next;
    });
  }, []);

  const handleCenterWindow = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      await (appWindow as any).center?.();
    } catch {
      // ignore
    }
  }, []);

  const handleMaximize = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      await appWindow.maximize();
    } catch {
      // ignore
    }
  }, []);

  const handleMinimize = useCallback(() => {
    void withWindow("minimize");
  }, []);

  const handleForceClose = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    try {
      allowCloseRef.current = true;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      await appWindow.destroy();
    } catch {
      // ignore
    }
  }, []);

  const handleRestart = useCallback(() => {
    setConfirmRestartOpen(true);
  }, []);

  const confirmRestart = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    try {
      await TauriClient.restartApp();
    } catch {
      // Fallback: just close and let user manually restart
      allowCloseRef.current = true;
      await withWindow("close");
    }
  }, []);

  return (
    <div
      className="titlebar fixed inset-x-0 top-0 z-[2147483000] flex h-10 items-center justify-between border-b border-border/60 backdrop-blur-xl"
      style={{ height: TITLEBAR_HEIGHT_PX }}
    >
      <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            style={{
              position: "fixed",
              left: windowMenuPos.x,
              top: windowMenuPos.y,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="w-56">
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              handleRestart();
            }}
          >
            {t("Restart Application", "Restart Application")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              handleToggleTopmost();
            }}
          >
            {isTopmost
              ? t("Disable Always on Top", "Disable Always on Top")
              : t("Enable Always on Top", "Enable Always on Top")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              void withWindow("start-dragging");
            }}
          >
            {t("Move Window", "Move Window")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              void handleCenterWindow();
            }}
          >
            {t("Center Window", "Center Window")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              handleMinimize();
            }}
          >
            {t("Minimize", "Minimize")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              void handleMaximize();
            }}
          >
            {t("Maximize", "Maximize")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              void requestClose();
            }}
          >
            {t("Close", "Close")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setWindowMenuOpen(false);
              void handleForceClose();
            }}
            className="text-destructive focus:text-destructive"
          >
            {t("Force Close", "Force Close")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div
        className="titlebar-title flex h-full flex-1 items-center px-4 text-[11px] font-semibold uppercase text-muted-foreground/90 select-none cursor-default"
        data-tauri-drag-region
        onPointerDown={handleDragStart}
        onDoubleClick={handleToggleMaximize}
        onContextMenu={handleWindowContextMenu}
      >
        {t("Better Cloudflare Console", "Better Cloudflare Console")}
      </div>
      <div className="titlebar-actions flex h-full items-center gap-1 pr-2 text-[10px] uppercase">
        <Tooltip
          tip={
            isTopmost
              ? t("Always on top: On", "Always on top: On")
              : t("Always on top: Off", "Always on top: Off")
          }
          side="bottom"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`h-7 w-9 px-0 text-[10px] ${
              isTopmost ? "bg-muted/60 text-foreground" : "text-muted-foreground/80"
            }`}
            onClick={() => void handleToggleTopmost()}
            aria-label={
              isTopmost
                ? t("Disable always on top", "Disable always on top")
                : t("Enable always on top", "Enable always on top")
            }
          >
            T
          </Button>
        </Tooltip>
        <Tooltip tip={t("Minimize", "Minimize")} side="bottom">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-9 px-0 text-[10px] text-muted-foreground/80"
            onClick={() => void withWindow("minimize")}
            aria-label={t("Minimize window", "Minimize window")}
          >
            -
          </Button>
        </Tooltip>
        <Tooltip tip={t("Toggle maximize", "Toggle maximize")} side="bottom">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 w-9 px-0 text-[10px] text-muted-foreground/80"
            onClick={() => void withWindow("toggle-maximize")}
            aria-label={t("Toggle maximize", "Toggle maximize")}
          >
            []
          </Button>
        </Tooltip>
        <Tooltip tip={t("Close", "Close")} side="bottom">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-7 w-9 px-0 text-[10px]"
            onClick={() => void requestClose()}
            aria-label={t("Close window", "Close window")}
          >
            X
          </Button>
        </Tooltip>
      </div>
      <Dialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Close Better Cloudflare?", "Close Better Cloudflare?")}</DialogTitle>
            <DialogDescription>
              {t(
                "Unsaved edits may be lost. Are you sure you want to close the window?",
                "Unsaved edits may be lost. Are you sure you want to close the window?",
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="checkbox-themed"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            {t("Don't ask again", "Don't ask again")}
          </label>
          <DialogFooter className="mt-2 gap-2 sm:gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmCloseOpen(false)}
            >
              {t("Cancel", "Cancel")}
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
              {t("Close", "Close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmRestartOpen} onOpenChange={setConfirmRestartOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Restart Application?", "Restart Application?")}</DialogTitle>
            <DialogDescription>
              {t(
                "The application will close and attempt to restart. Any unsaved changes may be lost.",
                "The application will close and attempt to restart. Any unsaved changes may be lost.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2 sm:gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmRestartOpen(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setConfirmRestartOpen(false);
                void confirmRestart();
              }}
            >
              {t("Restart", "Restart")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
