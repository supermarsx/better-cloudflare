import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useI18n } from "@/hooks/use-i18n";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import {
  describeTabMove,
  moveItemBy,
  moveItemRelativeTo,
  moveItemToIndex,
  type DropPosition,
} from "@/lib/tabs/tab-order";

export interface DnsWorkspaceTabItem {
  id: string;
  label: string;
  kind:
    | "zone"
    | "settings"
    | "audit"
    | "tags"
    | "registry"
    | "notifications"
    | "assistant";
  status?: string;
}

interface DnsWorkspaceTabsProps {
  items: DnsWorkspaceTabItem[];
  activeId: string | null;
  closeOnMiddleClick: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Commit a new tab order. Receives the full ordered id list. */
  onOrderChange: (orderedIds: string[]) => void;
}

const REORDER_DURATION_MS = 180;

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => {
    const codePoint = character.codePointAt(0)?.toString(16) ?? "0";
    return `-${codePoint}-`;
  });
}

function shouldRenderStatusBadge(status: string | undefined): status is string {
  const normalizedStatus = status?.trim().toLowerCase();
  return Boolean(normalizedStatus) && normalizedStatus !== "active";
}

export function getDnsWorkspaceTabId(id: string): string {
  return `dns-workspace-tab-${safeDomId(id)}`;
}

export function getDnsWorkspacePanelId(id: string): string {
  return `dns-workspace-panel-${safeDomId(id)}`;
}

export function getNextActiveTabIdAfterClose(
  items: readonly { id: string }[],
  activeId: string | null,
  closedId: string,
): string | null {
  if (activeId !== closedId) return activeId;

  const closedIndex = items.findIndex((item) => item.id === closedId);
  if (closedIndex < 0) return activeId;

  return items[closedIndex + 1]?.id ?? items[closedIndex - 1]?.id ?? null;
}

export function DnsWorkspaceTabs({
  items,
  activeId,
  closeOnMiddleClick,
  onActivate,
  onClose,
  onOrderChange,
}: DnsWorkspaceTabsProps) {
  const { t } = useI18n();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: DropPosition;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const isDragging = draggedId !== null;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const offsetsRef = useRef(new Map<string, number>());
  // A completed drag must not also read as a click on the tab button.
  const suppressNextActivateRef = useRef(false);
  const refocusIdRef = useRef<string | null>(null);
  const pendingCloseFocusRef = useRef<{
    closedId: string;
    closedIndex: number;
  } | null>(null);

  // FLIP: play the tabs from their previous offsets to their new ones so a
  // reorder glides instead of snapping. Skipped entirely under reduced motion,
  // and a no-op wherever Element.animate is unavailable (jsdom included).
  useLayoutEffect(() => {
    const previous = offsetsRef.current;
    const next = new Map<string, number>();
    itemRefs.current.forEach((node, id) => {
      next.set(id, node.getBoundingClientRect().left);
    });

    if (!prefersReducedMotion) {
      next.forEach((left, id) => {
        const previousLeft = previous.get(id);
        if (previousLeft === undefined || previousLeft === left) return;
        const node = itemRefs.current.get(id);
        if (!node || typeof node.animate !== "function") return;
        node.animate(
          [
            { transform: `translateX(${previousLeft - left}px)` },
            { transform: "translateX(0)" },
          ],
          {
            duration: REORDER_DURATION_MS,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
          },
        );
      });
    }

    offsetsRef.current = next;
  }, [items, prefersReducedMotion]);

  useEffect(() => {
    const pendingFocus = pendingCloseFocusRef.current;
    if (
      !pendingFocus ||
      items.some((item) => item.id === pendingFocus.closedId)
    ) {
      return;
    }

    const activeItem = items.find((item) => item.id === activeId);
    if (activeId !== null && !activeItem) return;

    pendingCloseFocusRef.current = null;
    const nearestItem =
      items[Math.min(pendingFocus.closedIndex, items.length - 1)];
    const targetId = activeItem?.id ?? nearestItem?.id;
    if (targetId) tabRefs.current.get(targetId)?.focus();
  }, [activeId, items]);

  // The grabbing cursor belongs to a real drag session, not to `:active` (which
  // also fires on a plain click to switch tabs). Painting it on <body> keeps it
  // consistent once the pointer leaves the tab mid-drag.
  useEffect(() => {
    if (!isDragging || typeof document === "undefined") return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    body.style.cursor = "grabbing";
    return () => {
      body.style.cursor = previousCursor;
    };
  }, [isDragging]);

  // Keyboard reordering moves the DOM node; keep focus on the tab that moved.
  useEffect(() => {
    const refocusId = refocusIdRef.current;
    if (!refocusId) return;
    refocusIdRef.current = null;
    tabRefs.current.get(refocusId)?.focus();
  }, [items]);

  const commitOrder = useCallback(
    (nextItems: readonly DnsWorkspaceTabItem[]) => {
      if (
        nextItems.length === items.length &&
        nextItems.every((item, index) => item.id === items[index]?.id)
      ) {
        return false;
      }
      onOrderChange(nextItems.map((item) => item.id));
      return true;
    },
    [items, onOrderChange],
  );

  const closeWithFocusRecovery = (
    id: string,
    index: number,
    trigger: HTMLButtonElement,
  ) => {
    if (
      typeof document !== "undefined" &&
      (document.activeElement === trigger ||
        document.activeElement === tabRefs.current.get(id))
    ) {
      pendingCloseFocusRef.current = {
        closedId: id,
        closedIndex: index,
      };
    }
    onClose(id);
  };

  const activateAndFocus = (index: number) => {
    const item = items[index];
    if (!item) return;
    onActivate(item.id);
    tabRefs.current.get(item.id)?.focus();
  };

  const moveByKeyboard = (id: string, delta: number) => {
    const next = moveItemBy(items, id, delta);
    if (!commitOrder(next)) return;
    const label = items.find((item) => item.id === id)?.label ?? id;
    const nextIndex = next.findIndex((item) => item.id === id);
    refocusIdRef.current = id;
    setAnnouncement(describeTabMove(label, nextIndex, next.length));
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    id: string,
  ) => {
    if (items.length === 0) return;

    const reorderModifier = (event.ctrlKey || event.metaKey) && event.shiftKey;
    if (
      reorderModifier &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      moveByKeyboard(id, event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (reorderModifier && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const next = moveItemToIndex(
        items,
        id,
        event.key === "Home" ? 0 : items.length - 1,
      );
      if (commitOrder(next)) {
        const label = items.find((item) => item.id === id)?.label ?? id;
        refocusIdRef.current = id;
        setAnnouncement(
          describeTabMove(
            label,
            next.findIndex((item) => item.id === id),
            next.length,
          ),
        );
      }
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      activateAndFocus((index + 1) % items.length);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      activateAndFocus((index - 1 + items.length) % items.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      activateAndFocus(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      activateAndFocus(items.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(id);
      return;
    }
    if (event.key === "Escape" && draggedId) {
      event.preventDefault();
      setDraggedId(null);
      setDropTarget(null);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      closeWithFocusRecovery(id, index, event.currentTarget);
    }
  };

  const endDrag = () => {
    setDraggedId(null);
    setDropTarget(null);
  };

  if (items.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[1600px] px-3 py-1.5 text-[11px] text-muted-foreground sm:px-4">
        {t(
          "Select a domain to open a DNS workspace.",
          "Select a domain to open a DNS workspace.",
        )}
      </div>
    );
  }

  const dropIndicator = (key: string) => (
    <span
      key={key}
      aria-hidden="true"
      data-testid="dns-tab-drop-indicator"
      className="h-6 w-0.5 shrink-0 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
    />
  );

  return (
    <>
      <div
        role="tablist"
        aria-label={t("DNS workspaces", "DNS workspaces")}
        aria-orientation="horizontal"
        data-responsive-overflow="horizontal"
        data-dragging={isDragging ? "true" : "false"}
        className={cn(
          "scrollbar-themed mx-auto flex w-full max-w-[1600px] items-center gap-1 overflow-x-auto whitespace-nowrap px-3 py-1.5 sm:px-4",
          isDragging && "cursor-grabbing",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId =
            draggedId || event.dataTransfer.getData("text/plain");
          if (sourceId)
            commitOrder(moveItemToIndex(items, sourceId, items.length - 1));
          endDrag();
        }}
      >
        {items.map((item, index) => {
          const isActive = item.id === activeId;
          const isDragged = draggedId === item.id;
          const showBefore =
            dropTarget?.id === item.id && dropTarget.position === "before";
          const showAfter =
            dropTarget?.id === item.id && dropTarget.position === "after";
          return [
            showBefore ? dropIndicator(`${item.id}-before`) : null,
            <div
              key={item.id}
              ref={(node) => {
                if (node) itemRefs.current.set(item.id, node);
                else itemRefs.current.delete(item.id);
              }}
              role="presentation"
              draggable
              data-tab-id={item.id}
              data-dragging={isDragged ? "true" : "false"}
              className={cn(
                "flex h-8 shrink-0 items-center rounded-md border",
                prefersReducedMotion
                  ? "transition-none"
                  : "transition duration-150",
                isActive
                  ? "border-primary/35 bg-primary/10 text-foreground shadow-sm"
                  : "border-transparent bg-transparent text-muted-foreground hover:border-border/70 hover:bg-accent/45 hover:text-foreground",
                isDragged &&
                  "opacity-50 shadow-[0_10px_24px_hsl(0_0%_0%_/_0.35)] ring-1 ring-primary/50",
              )}
              onDragStart={(event) => {
                setDraggedId(item.id);
                suppressNextActivateRef.current = true;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                if (draggedId === item.id) {
                  setDropTarget(null);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                const position: DropPosition =
                  event.clientX < rect.left + rect.width / 2
                    ? "before"
                    : "after";
                setDropTarget((previous) =>
                  previous?.id === item.id && previous.position === position
                    ? previous
                    : { id: item.id, position },
                );
              }}
              onDragLeave={(event) => {
                event.stopPropagation();
                setDropTarget((previous) =>
                  previous?.id === item.id ? null : previous,
                );
              }}
              onDragEnd={() => {
                endDrag();
                // Release the click guard after the browser's click would have
                // fired, so a real click right after a drag still activates.
                setTimeout(() => {
                  suppressNextActivateRef.current = false;
                }, 0);
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const sourceId =
                  draggedId || event.dataTransfer.getData("text/plain");
                const position = dropTarget?.position ?? "before";
                if (sourceId && sourceId !== item.id) {
                  commitOrder(
                    moveItemRelativeTo(items, sourceId, item.id, position),
                  );
                }
                endDrag();
              }}
            >
              <button
                ref={(node) => {
                  if (node) tabRefs.current.set(item.id, node);
                  else tabRefs.current.delete(item.id);
                }}
                id={getDnsWorkspaceTabId(item.id)}
                type="button"
                role="tab"
                aria-controls={getDnsWorkspacePanelId(item.id)}
                aria-selected={isActive}
                aria-keyshortcuts="Control+Shift+ArrowLeft Control+Shift+ArrowRight"
                tabIndex={isActive ? 0 : -1}
                className={cn(
                  "flex h-full min-w-0 items-center gap-1.5 rounded-l-md px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                  isDragging ? "cursor-grabbing" : "cursor-default",
                )}
                onClick={() => {
                  if (suppressNextActivateRef.current) return;
                  onActivate(item.id);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1 || !closeOnMiddleClick) return;
                  event.preventDefault();
                }}
                onMouseDown={(event) => {
                  if (event.button !== 1 || !closeOnMiddleClick) return;
                  event.preventDefault();
                  closeWithFocusRecovery(item.id, index, event.currentTarget);
                }}
                onKeyDown={(event) => handleKeyDown(event, index, item.id)}
              >
                <span className="max-w-36 truncate">{item.label}</span>
                {item.kind === "zone" &&
                shouldRenderStatusBadge(item.status) ? (
                  <span className="hidden text-[9px] uppercase tracking-wider opacity-60 sm:inline">
                    {item.status}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="mr-1 rounded p-1 text-muted-foreground outline-none transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
                aria-label={`${t("Close tab", "Close tab")}: ${item.label}`}
                onClick={(event) =>
                  closeWithFocusRecovery(item.id, index, event.currentTarget)
                }
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </div>,
            showAfter ? dropIndicator(`${item.id}-after`) : null,
          ];
        })}
      </div>
      <div
        role="status"
        aria-live="polite"
        data-testid="dns-tab-reorder-status"
        className="sr-only"
      >
        {announcement}
      </div>
    </>
  );
}
