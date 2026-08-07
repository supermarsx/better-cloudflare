import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { isDesktop } from "@/lib/environment";
import { cn } from "@/lib/utils";

export type WindowAction =
  | "close"
  | "minimize"
  | "maximize"
  | "toggle-maximize"
  | "start-dragging"
  | "center"
  | "destroy";
type WindowActionFailure = WindowAction | "toggle-always-on-top";

export type WindowActionRunner = (action: WindowAction) => Promise<void>;
export type WindowActionErrorHandler = (
  action: WindowAction,
  error: unknown,
) => void;

const WINDOW_ACTION_LABELS: Record<WindowActionFailure, string> = {
  close: "close the window",
  minimize: "minimize the window",
  maximize: "maximize the window",
  "toggle-maximize": "maximize or restore the window",
  "start-dragging": "move the window",
  center: "center the window",
  destroy: "force close the window",
  "toggle-always-on-top": "change the always-on-top setting",
};

/** The subset of the Tauri window API the titlebar controls drive. */
export interface WindowActionTarget {
  close(): Promise<void>;
  destroy(): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isResizable(): Promise<boolean>;
  isMaximizable(): Promise<boolean>;
  startDragging(): Promise<void>;
  center(): Promise<void>;
}

export type WindowActionTargetResolver = () => Promise<WindowActionTarget>;

async function resolveCurrentWindow(): Promise<WindowActionTarget> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function runWindowAction(
  action: WindowAction,
  resolveWindow: WindowActionTargetResolver = resolveCurrentWindow,
): Promise<void> {
  const appWindow = await resolveWindow();

  switch (action) {
    case "close":
      await appWindow.close();
      return;
    case "minimize":
      await appWindow.minimize();
      return;
    case "maximize":
      await appWindow.maximize();
      return;
    case "toggle-maximize":
      // Mirror Tauri's own `internal_toggle_maximize` (the command its
      // `data-tauri-drag-region` script runs on a double click) so the button
      // and the drag region cannot disagree: decide from the window's real
      // state, honour `resizable`, and never maximize a non-maximizable
      // window. `appWindow.toggleMaximize()` skips both guards.
      if (!(await appWindow.isResizable())) return;
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
      } else if (await appWindow.isMaximizable()) {
        await appWindow.maximize();
      }
      return;
    case "start-dragging":
      await appWindow.startDragging();
      return;
    case "center":
      await appWindow.center();
      return;
    case "destroy":
      await appWindow.destroy();
  }
}

export function reportWindowActionError(
  action: WindowActionFailure,
  error: unknown,
): void {
  const reason =
    error instanceof Error && error.message ? ` ${error.message}` : "";
  toast({
    title: "Window action failed",
    description: `Could not ${WINDOW_ACTION_LABELS[action]}.${reason}`,
    variant: "destructive",
  });
}

export async function executeWindowAction(
  action: WindowAction,
  actionRunner: WindowActionRunner = runWindowAction,
  onActionError: WindowActionErrorHandler = reportWindowActionError,
): Promise<boolean> {
  try {
    await actionRunner(action);
    return true;
  } catch (error) {
    onActionError(action, error);
    return false;
  }
}

export type MaximizedChangeHandler = (maximized: boolean) => void;
export type MaximizedSubscriber = (
  onChange: MaximizedChangeHandler,
) => () => void;

/**
 * Tracks the window's real maximized state.
 *
 * The maximize/restore icon must stay correct when the user maximizes or
 * restores by OS means (Win+Up, Aero snap, dragging to the top edge, the
 * native drag-region double click), none of which round-trip through React.
 * Every one of those paths resizes the window, so `onResized` is the reliable
 * signal; the state itself is always re-read from the window rather than
 * derived locally.
 */
export function subscribeWindowMaximized(
  onChange: MaximizedChangeHandler,
): () => void {
  if (!isDesktop()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | undefined;

  void (async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();

    const publish = async () => {
      try {
        const maximized = await appWindow.isMaximized();
        if (!disposed) onChange(maximized);
      } catch {
        // Keep the last known state rather than flipping the icon on a
        // transient bridge failure.
      }
    };

    await publish();
    const stopListening = await appWindow.onResized(() => {
      void publish();
    });
    if (disposed) {
      stopListening();
    } else {
      unlisten = stopListening;
    }
  })().catch(() => {
    // No window bridge: leave the control in its default restored state.
  });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}

interface WindowControlsProps {
  className?: string;
  onClose?: () => void | Promise<void>;
  actionRunner?: WindowActionRunner;
  onActionError?: WindowActionErrorHandler;
  subscribeMaximized?: MaximizedSubscriber;
}

export function WindowControls({
  className,
  onClose,
  actionRunner = runWindowAction,
  onActionError = reportWindowActionError,
  subscribeMaximized = subscribeWindowMaximized,
}: WindowControlsProps) {
  const { t } = useI18n();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => subscribeMaximized(setIsMaximized), [subscribeMaximized]);

  const preventWindowDrag = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const invoke = useCallback(
    (action: "minimize" | "toggle-maximize" | "close") => {
      if (action === "close" && onClose) {
        void Promise.resolve()
          .then(onClose)
          .catch((error) => onActionError(action, error));
        return;
      }
      void executeWindowAction(action, actionRunner, onActionError);
    },
    [actionRunner, onActionError, onClose],
  );

  return (
    <div
      className={cn(
        "titlebar-actions flex h-full items-center gap-1 text-[10px] uppercase",
        className,
      )}
      onPointerDown={preventWindowDrag}
      onMouseDown={preventWindowDrag}
      onDoubleClick={preventWindowDrag}
    >
      <Tooltip tip={t("Minimize", "Minimize")} side="bottom">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-9 px-0 text-muted-foreground/80"
          onClick={() => invoke("minimize")}
          aria-label={t("Minimize window", "Minimize window")}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip
        tip={
          isMaximized
            ? t("Restore down", "Restore down")
            : t("Maximize", "Maximize")
        }
        side="bottom"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-9 px-0 text-muted-foreground/80"
          onClick={() => invoke("toggle-maximize")}
          aria-label={t("Toggle maximize", "Toggle maximize")}
          data-window-maximized={isMaximized ? "true" : "false"}
        >
          {isMaximized ? (
            <Copy className="h-3.5 w-3.5" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </Button>
      </Tooltip>
      <Tooltip tip={t("Close", "Close")} side="bottom">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-7 w-9 px-0"
          onClick={() => invoke("close")}
          aria-label={t("Close window", "Close window")}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * Props that mark an element as the window's drag handle.
 *
 * `data-tauri-drag-region` is the single authority for both gestures. Tauri's
 * injected `drag.js` listens for `mousedown` on the document and, for a drag
 * region, invokes `plugin:window|start_dragging` on a single click and
 * `plugin:window|internal_toggle_maximize` on a double click (`event.detail
 * === 2`).
 *
 * This hook therefore attaches NO JavaScript handlers. It previously added an
 * `onPointerDown` that called `startDragging()` and an `onDoubleClick` that
 * called `toggleMaximize()` on the very same element. React's delegated
 * listeners run at the React root, i.e. before Tauri's document-level
 * listener, so `stopImmediatePropagation()` in `drag.js` could not suppress
 * them: a single double click fired the toggle twice and the window maximized
 * and immediately restored, which reads as a flicker.
 *
 * Native handling is also the more correct of the two: `internal_toggle_maximize`
 * reads the window's actual state and refuses to maximize a window that is not
 * resizable or not maximizable.
 *
 * Pass `enabled: false` to opt an element out (`data-tauri-drag-region="false"`
 * also blocks ancestors, per `drag.js`).
 */
export function useWindowDragRegion(enabled = true) {
  return useMemo(
    () => ({ "data-tauri-drag-region": enabled ? "" : "false" }) as const,
    [enabled],
  );
}
