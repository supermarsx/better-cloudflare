import { useCallback, useRef } from "react";
import type { PointerEvent } from "react";
import { Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
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

export async function runWindowAction(action: WindowAction): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

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
      await appWindow.toggleMaximize();
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

interface WindowControlsProps {
  className?: string;
  onClose?: () => void | Promise<void>;
  actionRunner?: WindowActionRunner;
  onActionError?: WindowActionErrorHandler;
}

export function WindowControls({
  className,
  onClose,
  actionRunner = runWindowAction,
  onActionError = reportWindowActionError,
}: WindowControlsProps) {
  const { t } = useI18n();

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
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
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
      <Tooltip tip={t("Toggle maximize", "Toggle maximize")} side="bottom">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-9 px-0 text-muted-foreground/80"
          onClick={() => invoke("toggle-maximize")}
          aria-label={t("Toggle maximize", "Toggle maximize")}
        >
          <Square className="h-3.5 w-3.5" />
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

export function useWindowDragRegion(
  enabled = true,
  actionRunner: WindowActionRunner = runWindowAction,
  onActionError: WindowActionErrorHandler = reportWindowActionError,
) {
  const isDraggingRef = useRef(false);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!enabled || event.button !== 0 || isDraggingRef.current) return;
      isDraggingRef.current = true;
      void executeWindowAction(
        "start-dragging",
        actionRunner,
        onActionError,
      ).finally(() => {
        isDraggingRef.current = false;
      });
    },
    [actionRunner, enabled, onActionError],
  );

  const onDoubleClick = useCallback(() => {
    if (!enabled) return;
    void executeWindowAction("toggle-maximize", actionRunner, onActionError);
  }, [actionRunner, enabled, onActionError]);

  return { onPointerDown, onDoubleClick };
}
