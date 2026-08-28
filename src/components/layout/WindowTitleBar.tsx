import { useCallback, useEffect, useRef, useState } from "react";
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
import { storageManager } from "@/lib/storage/storage";
import { TauriClient } from "@/lib/api/tauri-client";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import {
  createTrackedRuntimeResources,
  type TrackedRuntimeResources,
} from "@/lib/runtime/resource-scope";
import { useI18n } from "@/hooks/use-i18n";
import {
  executeWindowAction,
  reportWindowActionError,
  WindowControls,
  useWindowDragRegion,
} from "./WindowControls";

export const TITLEBAR_HEIGHT_PX = 36;

interface ClosePreferencePersistence {
  persistLocal: (enabled: boolean) => void;
  persistNative?: (enabled: boolean) => Promise<void>;
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The desktop runtime returned an unknown error.";
}

function reportTitlebarFailure(
  error: unknown,
  label: string,
  guidance: string,
): void {
  reportRuntimeError(new Error(`${guidance} Reason: ${failureReason(error)}`), {
    source: "runtime",
    label,
  });
}

function readConfirmWindowCloseSafely(
  readPreference: () => boolean = () => storageManager.getConfirmWindowClose(),
): boolean {
  try {
    return readPreference();
  } catch (error) {
    reportTitlebarFailure(
      error,
      "Read titlebar close confirmation preference",
      "The close confirmation preference could not be read. Confirmation remains enabled for safety.",
    );
    return true;
  }
}

async function persistClosePreference(
  enabled: boolean,
  persistence: ClosePreferencePersistence,
): Promise<boolean> {
  try {
    await persistence.persistNative?.(enabled);
    persistence.persistLocal(enabled);
    return true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      persistence.persistLocal(true);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await persistence.persistNative?.(true);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }

    const rollbackGuidance =
      rollbackErrors.length === 0
        ? "Close confirmation remains enabled for safety. Retry the preference change."
        : `Close confirmation was enabled in the UI, but some persistence rollback steps failed. Restart the app before retrying. Rollback errors: ${rollbackErrors
            .map(failureReason)
            .join("; ")}`;
    reportTitlebarFailure(
      error,
      "Save titlebar close confirmation preference",
      rollbackGuidance,
    );
    return false;
  }
}

export function WindowTitleBar() {
  const { t } = useI18n();
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
    readConfirmWindowCloseSafely,
  );
  const allowCloseRef = useRef(false);
  const contextMenuFrameRef = useRef<number | null>(null);
  const runtimeResourcesRef = useRef<TrackedRuntimeResources | null>(null);
  const dragRegion = useWindowDragRegion();

  if (!runtimeResourcesRef.current) {
    runtimeResourcesRef.current = createTrackedRuntimeResources(window);
  }
  const runtimeResources = runtimeResourcesRef.current;

  useEffect(
    () => () => {
      runtimeResources.dispose();
      contextMenuFrameRef.current = null;
    },
    [runtimeResources],
  );

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
        { confirmWindowClose?: unknown } | undefined;
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
      const closed = await executeWindowAction("close");
      if (!closed) allowCloseRef.current = false;
      return;
    }
    setDontAskAgain(false);
    setConfirmCloseOpen(true);
  }, [confirmWindowClose]);

  const persistConfirmWindowClose = useCallback(async (enabled: boolean) => {
    const persisted = await persistClosePreference(enabled, {
      persistLocal: (next) => storageManager.setConfirmWindowClose(next),
      ...(TauriClient.isTauri()
        ? {
            persistNative: (next: boolean) =>
              TauriClient.updatePreferenceFields({
                confirm_window_close: next,
              }),
          }
        : {}),
    });
    setConfirmWindowClose(persisted ? enabled : true);
  }, []);

  const enableSafeCloseFallback = useCallback(
    (error: unknown, label: string) => {
      setConfirmWindowClose(true);
      let fallbackError: unknown;
      try {
        storageManager.setConfirmWindowClose(true);
      } catch (storageError) {
        fallbackError = storageError;
      }
      reportTitlebarFailure(
        error,
        label,
        fallbackError
          ? `Close interception failed, so confirmation was enabled in the UI. Persisting that safe fallback also failed: ${failureReason(
              fallbackError,
            )}. Restart the app before closing the window.`
          : "Close interception failed. Confirmation remains enabled for the custom close controls; retry or restart the app before closing.",
      );
    },
    [],
  );

  useEffect(() => {
    if (!TauriClient.isTauri()) return;
    let disposed = false;
    let unlisten: (() => void | Promise<void>) | undefined;

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const appWindow = getCurrentWindow();

        try {
          const current = await appWindow.isAlwaysOnTop();
          if (!disposed && typeof current === "boolean") {
            setIsTopmost(current);
          }
        } catch (error) {
          if (disposed) return;
          reportTitlebarFailure(
            error,
            "Read titlebar always-on-top state",
            "The always-on-top state could not be read. It was left disabled in the UI.",
          );
        }

        const stopListening = await appWindow.onCloseRequested((event) => {
          if (disposed) return;
          if (allowCloseRef.current) {
            allowCloseRef.current = false;
            return;
          }
          event.preventDefault();
          void requestClose().catch((error) => {
            enableSafeCloseFallback(error, "Handle titlebar close request");
          });
        });

        if (disposed) {
          await stopListening();
        } else {
          unlisten = stopListening;
        }
      } catch (error) {
        if (disposed) return;
        enableSafeCloseFallback(
          error,
          "Register titlebar close-request listener",
        );
      }
    })();

    return () => {
      disposed = true;
      if (!unlisten) return;
      void Promise.resolve(unlisten()).catch((error) => {
        reportTitlebarFailure(
          error,
          "Remove titlebar close-request listener",
          "The close-request listener could not be removed cleanly. Restart the app before continuing.",
        );
      });
    };
  }, [enableSafeCloseFallback, requestClose]);

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
      if (contextMenuFrameRef.current !== null) {
        runtimeResources.cancelAnimationFrame(contextMenuFrameRef.current);
      }
      contextMenuFrameRef.current = runtimeResources.requestAnimationFrame(
        () => {
          contextMenuFrameRef.current = null;
          setWindowMenuOpen(true);
        },
      );
    },
    [runtimeResources],
  );

  const handleToggleTopmost = useCallback(() => {
    if (!TauriClient.isTauri()) return;
    setIsTopmost((prev) => {
      const next = !prev;
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const appWindow = getCurrentWindow();
          await appWindow.setAlwaysOnTop(next);
        } catch (error) {
          setIsTopmost(prev);
          reportWindowActionError("toggle-always-on-top", error);
        }
      })();
      return next;
    });
  }, []);

  const handleCenterWindow = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    await executeWindowAction("center");
  }, []);

  const handleMaximize = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    await executeWindowAction("maximize");
  }, []);

  const handleMinimize = useCallback(() => {
    void executeWindowAction("minimize");
  }, []);

  const handleForceClose = useCallback(async () => {
    if (!TauriClient.isTauri()) return;
    allowCloseRef.current = true;
    const closed = await executeWindowAction("destroy");
    if (!closed) allowCloseRef.current = false;
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
      const closed = await executeWindowAction("close");
      if (!closed) allowCloseRef.current = false;
    }
  }, []);

  return (
    <div
      className="titlebar fixed inset-x-0 top-0 z-[2147483000] flex h-9 items-center justify-between border-b border-border/60 backdrop-blur-xl"
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
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-56"
        >
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
              void executeWindowAction("start-dragging");
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
        {...dragRegion}
        onContextMenu={handleWindowContextMenu}
      >
        {t("Better Cloudflare Console", "Better Cloudflare Console")}
      </div>
      <div className="titlebar-actions flex h-full items-center gap-1 pr-2">
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
              isTopmost
                ? "bg-muted/60 text-foreground"
                : "text-muted-foreground/80"
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
        <WindowControls onClose={requestClose} />
      </div>
      <Dialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("Close Better Cloudflare?", "Close Better Cloudflare?")}
            </DialogTitle>
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
                  const closed = await executeWindowAction("close");
                  if (!closed) allowCloseRef.current = false;
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
            <DialogTitle>
              {t("Restart Application?", "Restart Application?")}
            </DialogTitle>
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

WindowTitleBar.persistClosePreference = persistClosePreference;
WindowTitleBar.readConfirmWindowCloseSafely = readConfirmWindowCloseSafely;
