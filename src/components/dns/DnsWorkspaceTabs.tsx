import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { GripVertical, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useI18n } from "@/hooks/use-i18n";

export interface DnsWorkspaceTabItem {
  id: string;
  label: string;
  kind: "zone" | "settings" | "audit" | "tags" | "registry";
  status?: string;
}

interface DnsWorkspaceTabsProps {
  items: DnsWorkspaceTabItem[];
  activeId: string | null;
  closeOnMiddleClick: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onMoveToEnd: (sourceId: string) => void;
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => {
    const codePoint = character.codePointAt(0)?.toString(16) ?? "0";
    return `-${codePoint}-`;
  });
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
  onReorder,
  onMoveToEnd,
}: DnsWorkspaceTabsProps) {
  const { t } = useI18n();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingCloseFocusRef = useRef<{
    closedId: string;
    closedIndex: number;
  } | null>(null);

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

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    id: string,
  ) => {
    if (items.length === 0) return;

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
    if (event.key === "Delete") {
      event.preventDefault();
      closeWithFocusRecovery(id, index, event.currentTarget);
    }
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

  return (
    <div
      role="tablist"
      aria-label={t("DNS workspaces", "DNS workspaces")}
      aria-orientation="horizontal"
      data-responsive-overflow="horizontal"
      className="scrollbar-themed mx-auto flex w-full max-w-[1600px] items-center gap-1 overflow-x-auto whitespace-nowrap px-3 py-1.5 sm:px-4"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const sourceId = draggedId || event.dataTransfer.getData("text/plain");
        if (sourceId) onMoveToEnd(sourceId);
        setDraggedId(null);
        setDragOverId(null);
      }}
    >
      {items.map((item, index) => {
        const isActive = item.id === activeId;
        return (
          <div
            key={item.id}
            role="presentation"
            draggable
            className={cn(
              "group flex h-8 shrink-0 items-center rounded-md border transition",
              isActive
                ? "border-primary/35 bg-primary/10 text-foreground shadow-sm"
                : "border-transparent bg-transparent text-muted-foreground hover:border-border/70 hover:bg-accent/45 hover:text-foreground",
              dragOverId === item.id && "ring-1 ring-primary/40",
            )}
            onDragStart={(event) => {
              setDraggedId(item.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.id);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setDragOverId(item.id);
            }}
            onDragEnd={() => {
              setDraggedId(null);
              setDragOverId(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const sourceId =
                draggedId || event.dataTransfer.getData("text/plain");
              if (sourceId) onReorder(sourceId, item.id);
              setDraggedId(null);
              setDragOverId(null);
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
              tabIndex={isActive ? 0 : -1}
              className="flex h-full min-w-0 cursor-grab items-center gap-1.5 rounded-l-md px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              onClick={() => onActivate(item.id)}
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
              <GripVertical
                aria-hidden="true"
                className="h-3 w-3 shrink-0 opacity-50"
              />
              <span className="max-w-36 truncate">{item.label}</span>
              {item.kind === "zone" && item.status ? (
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
          </div>
        );
      })}
    </div>
  );
}
