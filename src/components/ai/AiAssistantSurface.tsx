/**
 * The two chromes that are not the workspace tab: a docked sidebar and a
 * floating bubble.
 *
 * There is one assistant. `AiAssistantPanel` is rendered exactly once here, and
 * `presentation` only tells it how to size and scroll itself, so switching
 * chrome cannot produce two conversations, two event subscriptions or two
 * settings screens.
 *
 * Three things this file is careful about:
 *
 * **Clipping.** The bubble is portaled to `document.body`. Its natural
 * declaration site sits inside `AuthenticatedAppShell`, whose `<section>` is
 * `overflow-hidden` and whose body region is `overflow-x-hidden
 * overflow-y-auto`; the workspace panel inside it also runs the `fade-in-up`
 * keyframes, and an element animating `transform` becomes the containing block
 * for `position: fixed` descendants while it does. A portal is immune to all
 * three. The sidebar is *not* portaled, because a dock has to take part in the
 * layout it docks into — at narrow widths it switches to `position: fixed`
 * instead, which leaves the flow rather than squeezing the workspace.
 *
 * **Focus.** Neither surface traps focus: both are non-modal, and the workspace
 * behind them stays usable. Focus moves in once per *opening* — guarded by a
 * ref, not recomputed per render, because a surface that re-focuses itself on
 * every render makes the page unusable — and returns to whatever opened it when
 * it closes.
 *
 * **Movement.** The bubble is movable by its launcher — dragged with a pointer
 * or nudged with the arrow keys — and remembers where it was put. Three things
 * that make it more than a `mousemove` handler: a drag must not read as a
 * click, or moving the assistant would open and close it; the point must be
 * clamped to the viewport, or a bubble dragged to an edge and then persisted
 * survives a window resize as something the user cannot reach or un-stick
 * without clearing their settings; and "movable" has to include people who do
 * not use a pointer. See {@link useBubbleDrag}. The dock is deliberately not
 * movable — it is docked.
 *
 * **State across tabs.** Once opened, the panel stays mounted and is hidden
 * with the `hidden` attribute rather than unmounted. Closing the bubble during
 * a streaming turn therefore does not abandon the run, and the first open does
 * not happen until the user asks for it, so an install that never opens the
 * assistant never issues an `ai_*` call.
 *
 * **Changing chrome does remount.** The three chromes are three different
 * parents — a flow-level `aside`, a `document.body` portal, and (for `panel`)
 * a workspace tab body this component does not own at all — and React cannot
 * carry one instance between them, so switching placement unmounts the panel
 * and mounts a new one. That is bounded, not lossy: unmounting only drops the
 * `ai:event` subscription, never cancels the turn (see `useAiChat`'s cleanup),
 * so the run continues in the backend and the remounted panel reloads the
 * conversation and re-subscribes. What is lost is the provisional, not-yet-
 * persisted stream buffer for the few milliseconds of the swap; the completed
 * message still arrives with the refresh that `turnComplete` triggers.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { PanelRight, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/hooks/use-i18n";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { AiLinkNavigation } from "@/lib/ai/links";
import type { AiAssistantPresentation } from "@/lib/ai/presentation";
import { cn } from "@/lib/utils";

import { AiAssistantPanel, type AiSettingsSection } from "./AiAssistantPanel";

/**
 * Where the floating bubble sits: pixel insets from the viewport's
 * bottom-right corner.
 *
 * That corner rather than the top-left, for two reasons. It is the one the
 * default `right-4 bottom-16` already measures from, so "nothing stored" and
 * "stored at the default" describe the same place. And the stack grows *away*
 * from it — the panel opens upwards and leftwards out of the launcher — so
 * insets from this corner leave the launcher exactly where it is when the
 * panel opens. A top-left origin would slide the thing under the user's
 * pointer down by the height of the panel every time they opened it.
 */
export interface AiAssistantBubblePosition {
  right: number;
  bottom: number;
}

export interface AiAssistantSurfaceProps {
  presentation: AiAssistantPresentation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The stored bubble position, or `null`/absent to keep the default corner.
   *
   * Restored rather than controlled: the drag runs on local state so that a
   * pointer move does not round-trip through the host and into user settings
   * sixty times a second. The host sees one `onPositionChange` per gesture.
   * A value arriving after mount is adopted, because preference hydration is
   * asynchronous and lands a tick or two after the first render.
   */
  bubblePosition?: AiAssistantBubblePosition | null;
  /**
   * Store a bubble position. Called once per drag, on release, with the
   * already-clamped point — so what is persisted is always somewhere the user
   * can reach it again.
   */
  onBubblePositionChange?: (position: AiAssistantBubblePosition) => void;
  /**
   * Forwarded to the panel: the app's MCP tool permissions, which a blocked
   * plan step refused by `mcpGrants` has to point at and which nothing under
   * `ai_*` can change.
   */
  onOpenMcpPermissions?: () => void;
  /**
   * Forwarded to the panel: the app's Settings workspace, on the assistant's
   * own settings. The assistant no longer holds them, so the one pointer into
   * them — a blocked plan step — goes through the host.
   */
  onOpenAssistantSettings?: (section: AiSettingsSection) => void;
  /** Forwarded to the panel: how to follow an assistant-offered link. */
  linkNavigation?: AiLinkNavigation;
  /** Forwarded to the panel so a test can shorten the stall watchdog. */
  watchdogMs?: number;
}

const FOCUSABLE_SELECTOR =
  'textarea:not([disabled]), input:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function firstFocusable(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

/**
 * Move focus into a surface that has just opened, and hand it back when the
 * surface closes. Keyed on `open` alone, so it fires once per transition.
 */
function useSurfaceFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
): void {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      const trigger = restoreRef.current;
      restoreRef.current = null;
      // `isConnected` matters: the trigger may have been a control inside a
      // workspace tab the user has since closed.
      if (trigger?.isConnected) trigger.focus();
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    (firstFocusable(container) ?? container).focus();
  }, [containerRef, open]);
}

/** Below this much travel a pointer gesture is a click, not a drag. */
const BUBBLE_DRAG_SLOP_PX = 4;

/**
 * How far one arrow key moves the bubble, and how far with Shift held.
 *
 * 16px is the default corner's own inline inset (`right-4`) and 64px is its
 * block one (`bottom-16`), so a keyboard user moves the bubble on the grid the
 * design already places it on rather than on a number invented here.
 */
const BUBBLE_NUDGE_PX = 16;
const BUBBLE_NUDGE_COARSE_PX = 64;

/**
 * Hold an inset inside the viewport.
 *
 * `extent - size` goes negative whenever the surface is bigger than the window
 * — an open panel is up to 40rem tall — and clamping that ceiling at zero pins
 * the bubble flush to the corner instead of inverting the range and throwing
 * the bubble to the opposite edge.
 */
function clampInset(value: number, extent: number, size: number): number {
  return Math.min(Math.max(value, 0), Math.max(extent - size, 0));
}

interface BubbleDrag {
  /** The positioning override, or `undefined` to leave the default corner. */
  style: CSSProperties | undefined;
  dragging: boolean;
  /** Attach to the element the user grabs. */
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * Attach to the same element. Arrow keys move the bubble; everything else,
   * Enter and Space included, is left to the button.
   */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /**
   * True exactly once, for the click a finished drag leaves behind. Call it
   * from the handle's own `onClick` and do nothing else when it answers true.
   */
  consumeDragClick: () => boolean;
  /** The positioned container, measured for clamping. */
  attach: (node: HTMLElement | null) => void;
}

/**
 * Make the bubble movable, and keep it somewhere the user can get it back.
 *
 * Two properties this is built around:
 *
 * **A drag is not a click.** The launcher is a real button, so a pointer
 * release over it produces a `click` whatever the pointer did in between. A
 * gesture that travelled is reported through {@link BubbleDrag.consumeDragClick}
 * so the toggle can decline it — otherwise the assistant would open or close
 * every time it was moved, and there would be no way to move it without that.
 *
 * **It cannot be stranded.** The point is clamped against the viewport on
 * release, on mount, on resize and whenever the panel opens or closes (which
 * changes the surface's height by up to 40rem). Only the release clamp is
 * persisted: a window the user temporarily made small must not quietly rewrite
 * where they put the bubble, so the stored point stays their intent and the
 * clamp is applied on the way to the screen.
 */
function useBubbleDrag(
  enabled: boolean,
  surfaceVisible: boolean,
  position: AiAssistantBubblePosition | null | undefined,
  onPositionChange: ((position: AiAssistantBubblePosition) => void) | undefined,
): BubbleDrag {
  const nodeRef = useRef<HTMLElement | null>(null);
  const [placed, setPlaced] = useState<AiAssistantBubblePosition | null>(
    position ?? null,
  );
  const [dragging, setDragging] = useState(false);
  // Written when a gesture ends having moved, read by the handle's click
  // handler in the same task. A ref because the click is dispatched before any
  // re-render a state update could cause.
  const draggedRef = useRef(false);

  const restoredRight = position?.right ?? null;
  const restoredBottom = position?.bottom ?? null;

  /**
   * Adopt a restored point.
   *
   * Keyed on the two numbers, not on the object: the host rebuilds it from two
   * stored fields, so an identity dependency would fire on every unrelated
   * host render and throw away the drag the user had just finished.
   */
  useEffect(() => {
    if (restoredRight === null || restoredBottom === null) return;
    setPlaced({ right: restoredRight, bottom: restoredBottom });
  }, [restoredBottom, restoredRight]);

  const clampToViewport = useCallback(() => {
    const node = nodeRef.current;
    if (node === null || typeof window === "undefined") return;
    setPlaced((current) => {
      if (current === null) return null;
      const right = clampInset(
        current.right,
        window.innerWidth,
        node.offsetWidth,
      );
      const bottom = clampInset(
        current.bottom,
        window.innerHeight,
        node.offsetHeight,
      );
      return right === current.right && bottom === current.bottom
        ? current
        : { right, bottom };
    });
  }, []);

  // Mount, every resize, and every open or close. The last one matters as much
  // as the resize: a bubble parked near the top of a short window has room for
  // its launcher and none for the panel that appears above it.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [clampToViewport, enabled, surfaceVisible]);

  /**
   * Where the bubble is, measured rather than remembered.
   *
   * Both gestures start here, and they have to ask the DOM rather than read
   * `placed` back: until something has moved it there is no `placed` at all,
   * and the corner it is sitting in is a rem inset while all of this works in
   * pixels. Measuring also means a nudge picks up where the last one left off
   * without the two having to agree about anything but the rendered box.
   */
  const measureInsets = useCallback(
    (node: HTMLElement): AiAssistantBubblePosition => {
      const rect = node.getBoundingClientRect();
      return {
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
      };
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Primary button only: a right-click still belongs to the context menu,
      // and a middle-click is not a drag either.
      if (!enabled || event.button !== 0) return;
      const node = nodeRef.current;
      if (node === null || typeof window === "undefined") return;

      const origin = measureInsets(node);
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;
      let latest = origin;
      draggedRef.current = false;

      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < BUBBLE_DRAG_SLOP_PX) return;
        moved = true;
        setDragging(true);
        // Insets shrink as the pointer travels towards their own edge.
        latest = {
          right: clampInset(
            origin.right - dx,
            window.innerWidth,
            node.offsetWidth,
          ),
          bottom: clampInset(
            origin.bottom - dy,
            window.innerHeight,
            node.offsetHeight,
          ),
        };
        setPlaced(latest);
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setDragging(false);
        if (!moved) return;
        draggedRef.current = true;
        // Disarmed on the next task. The click that follows a release over the
        // handle is dispatched in this one, so anything later is a different
        // gesture — including a keyboard activation, which must still toggle
        // even if this drag ended somewhere off the handle entirely.
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
        onPositionChange?.(latest);
      };

      // On `window` rather than through pointer capture: the gesture has to
      // survive the pointer leaving a 44px button, and `setPointerCapture` is
      // not implemented everywhere this renders.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [enabled, measureInsets, onPositionChange],
  );

  /**
   * Move the bubble from the keyboard.
   *
   * A pointer-only "movable" surface is not movable for anyone who does not
   * use a pointer, so the launcher answers the arrow keys too. Three things
   * this is careful about:
   *
   * **It takes only the four arrows, and only unmodified.** `Ctrl`, `Alt` and
   * `Meta` arrows belong to the browser and the window manager — `Alt`+`Left`
   * is Back — so they are left alone. `Shift` is ours and means a coarser
   * step. Everything else falls through untouched, which is what keeps `Enter`
   * and `Space` activating the button.
   *
   * **It only swallows the key when it actually moves something.** The
   * `preventDefault` that stops the page scrolling sits after the decision,
   * not before it, so an arrow this handler is not going to act on still
   * scrolls the page.
   *
   * **A keypress is a whole gesture.** There is no release to wait for, so
   * each one persists — ten nudges are ten writes, the same rate at which the
   * host stores every other preference, and the position of someone who
   * nudges the bubble and walks away is already saved.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!enabled || event.ctrlKey || event.altKey || event.metaKey) return;
      const step = event.shiftKey ? BUBBLE_NUDGE_COARSE_PX : BUBBLE_NUDGE_PX;
      let dx = 0;
      let dy = 0;
      switch (event.key) {
        case "ArrowLeft":
          dx = -step;
          break;
        case "ArrowRight":
          dx = step;
          break;
        case "ArrowUp":
          dy = -step;
          break;
        case "ArrowDown":
          dy = step;
          break;
        default:
          return;
      }
      const node = nodeRef.current;
      if (node === null || typeof window === "undefined") return;
      event.preventDefault();

      // The same sign convention as the drag: an inset shrinks as the bubble
      // travels towards its own edge.
      const origin = measureInsets(node);
      const next: AiAssistantBubblePosition = {
        right: clampInset(
          origin.right - dx,
          window.innerWidth,
          node.offsetWidth,
        ),
        bottom: clampInset(
          origin.bottom - dy,
          window.innerHeight,
          node.offsetHeight,
        ),
      };
      setPlaced(next);
      onPositionChange?.(next);
    },
    [enabled, measureInsets, onPositionChange],
  );

  const consumeDragClick = useCallback(() => {
    if (!draggedRef.current) return false;
    draggedRef.current = false;
    return true;
  }, []);

  return {
    style:
      placed === null
        ? undefined
        : { right: `${placed.right}px`, bottom: `${placed.bottom}px` },
    dragging,
    onPointerDown,
    onKeyDown,
    consumeDragClick,
    attach: (node) => {
      nodeRef.current = node;
    },
  };
}

/** A body-level host for the bubble, created once and cleaned up on unmount. */
function usePortalHost(enabled: boolean): HTMLElement | null {
  const host = useMemo(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.dataset.aiAssistantPortal = "true";
    return element;
  }, []);

  useEffect(() => {
    if (!enabled || host === null || typeof document === "undefined") return;
    document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, [enabled, host]);

  return enabled ? host : null;
}

export function AiAssistantSurface({
  presentation,
  open,
  onOpenChange,
  bubblePosition,
  onBubblePositionChange,
  onOpenMcpPermissions,
  onOpenAssistantSettings,
  linkNavigation,
  watchdogMs,
}: AiAssistantSurfaceProps) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  // One ref for two different element types (`aside` and `div`), so it is
  // assigned through a callback rather than typed to either of them.
  const containerRef = useRef<HTMLElement | null>(null);
  const setContainer = (node: HTMLElement | null) => {
    containerRef.current = node;
  };
  const [everOpened, setEverOpened] = useState(open);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  /**
   * On screen *and* mounted.
   *
   * The distinction matters for the focus move. On the render where `open`
   * first becomes true the panel does not exist yet — `everOpened` is still
   * false, so there is no container to put focus in. Keying the focus effect
   * on `open` alone therefore missed the very first opening entirely, which
   * also meant nothing was recorded to hand focus back to on close.
   */
  const visible = open && everOpened;

  useSurfaceFocus(visible, containerRef);
  const host = usePortalHost(presentation === "bubble");
  const drag = useBubbleDrag(
    presentation === "bubble",
    visible,
    bubblePosition,
    onBubblePositionChange,
  );

  // The workspace tab needs no chrome of its own: the tab bar is its frame and
  // its dismissal, and `DNSManager` renders the panel there directly.
  if (presentation === "panel") return null;

  const label = t("Assistant", "Assistant");

  /**
   * Escape is handled on the surface rather than on `document`. A global
   * listener would also swallow the key for every dialog and menu in the app,
   * which is a worse bug than needing focus inside the thing you are closing.
   */
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
  };

  const panel = everOpened ? (
    <AiAssistantPanel
      presentation={presentation}
      onDismiss={() => onOpenChange(false)}
      onOpenMcpPermissions={onOpenMcpPermissions}
      onOpenAssistantSettings={onOpenAssistantSettings}
      linkNavigation={linkNavigation}
      watchdogMs={watchdogMs}
    />
  ) : null;

  if (presentation === "sidebar") {
    return (
      <aside
        ref={setContainer}
        tabIndex={-1}
        role="complementary"
        aria-label={label}
        data-testid="ai-assistant-sidebar"
        data-open={open}
        hidden={!visible}
        onKeyDown={handleKeyDown}
        className={cn(
          "min-h-0 flex-col border-l border-border/60 bg-background/95 backdrop-blur-xl",
          // Narrow windows: leave the flow rather than squeeze the workspace
          // into a column too narrow to read a DNS record in.
          "fixed right-0 bottom-0 top-[var(--app-top-inset)] z-40 w-[min(24rem,100vw)] shadow-2xl",
          // Wide windows: a real dock, sized in the row next to the workspace.
          "lg:static lg:inset-auto lg:z-auto lg:w-[22rem] lg:shrink-0 lg:shadow-none",
          // `display` is applied only while visible: a Tailwind `flex` utility
          // outranks the user-agent `[hidden] { display: none }` rule, so a
          // permanent one would keep a "hidden" dock on screen.
          visible && "flex",
          !reducedMotion && visible && "fade-in",
        )}
      >
        {panel}
      </aside>
    );
  }

  if (host === null) return null;

  return createPortal(
    <div
      ref={drag.attach}
      data-testid="ai-assistant-bubble"
      data-open={open}
      data-dragging={drag.dragging}
      // The utility insets are the default corner, clear of the connection bar
      // — `sticky bottom-0` and about 2.5rem tall, with no CSS variable for its
      // height to read. Once the user has moved the bubble the inline style
      // from the drag outranks them; until then there is no inline style at
      // all, so an undragged bubble keeps exactly the corner it always had.
      className="pointer-events-none fixed right-4 bottom-16 z-[60] flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
      style={drag.style}
    >
      {panel === null ? null : (
        <div
          ref={setContainer}
          tabIndex={-1}
          role="complementary"
          aria-label={label}
          hidden={!visible}
          onKeyDown={handleKeyDown}
          className={cn(
            "pointer-events-auto max-h-[min(80vh,40rem)] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur-xl",
            // See the dock above: `flex` would defeat `hidden`.
            visible && "flex",
            !reducedMotion && visible && "fade-in-up",
          )}
        >
          {panel}
        </div>
      )}
      {/* The launcher is also the grab handle, by pointer and by keyboard.
          `touch-none` keeps a touch drag from scrolling the page out from
          under it, and `cursor-grab` says the thing is movable before anyone
          tries. It stays a real button, so Enter and Space still toggle the
          assistant and the arrow keys only reach it while it has focus;
          `pointerdown` is deliberately not default-prevented, which would take
          the click focus with it. */}
      <Button
        type="button"
        size="icon"
        data-testid="ai-assistant-bubble-launcher"
        className={cn(
          "pointer-events-auto h-11 w-11 shrink-0 touch-none rounded-full shadow-lg",
          drag.dragging ? "cursor-grabbing select-none" : "cursor-grab",
        )}
        aria-expanded={open}
        aria-label={open ? t("Close assistant", "Close assistant") : label}
        // How anyone finds out the bubble moves at all. A `title` and not
        // `aria-keyshortcuts`, which is specified for shortcuts that focus or
        // activate an element — arrow keys steering an already-focused widget
        // are not that, and claiming otherwise would put a false statement in
        // the accessibility tree. The `aria-label` above keeps its job as the
        // accessible name, so this lands as a description rather than
        // competing with it.
        title={t(
          "Drag or use arrow keys to move",
          "Drag or use arrow keys to move",
        )}
        onPointerDown={drag.onPointerDown}
        onKeyDown={drag.onKeyDown}
        onClick={(event) => {
          // A drag that ends over the launcher still produces a click. Letting
          // it through would mean the assistant opened or closed every time it
          // was moved — and that there was no way to move it without that.
          if (drag.consumeDragClick()) {
            event.preventDefault();
            return;
          }
          onOpenChange(!open);
        }}
      >
        <Sparkles aria-hidden="true" className="h-5 w-5" />
      </Button>
    </div>,
    host,
  );
}

export interface AiAssistantRelocatedNoticeProps {
  presentation: Exclude<AiAssistantPresentation, "panel">;
  onReveal: () => void;
}

/**
 * What the assistant workspace tab shows while the assistant lives somewhere
 * else.
 *
 * The tab can still be open — restored from `reopen_last_tabs`, or opened
 * before the preference changed — and rendering a second `AiAssistantPanel` in
 * it would duplicate the conversation, the event subscription and the settings
 * screens. So the tab points at the real one instead.
 */
export function AiAssistantRelocatedNotice({
  presentation,
  onReveal,
}: AiAssistantRelocatedNoticeProps) {
  const { t } = useI18n();
  return (
    <Card
      className="border-border/60 bg-card/70"
      data-testid="ai-assistant-relocated"
      data-presentation={presentation}
    >
      <CardHeader>
        <CardTitle className="text-lg">{t("Assistant", "Assistant")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          {presentation === "sidebar"
            ? t(
                "The assistant is docked beside the workspace, so it stays open while you move between tabs.",
                "The assistant is docked beside the workspace, so it stays open while you move between tabs.",
              )
            : t(
                "The assistant is floating over the workspace, so it stays open while you move between tabs.",
                "The assistant is floating over the workspace, so it stays open while you move between tabs.",
              )}
        </p>
        <p>
          {t(
            "Change where it appears in Settings, under General.",
            "Change where it appears in Settings, under General.",
          )}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onReveal}>
          <PanelRight aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
          {t("Show the assistant", "Show the assistant")}
        </Button>
      </CardContent>
    </Card>
  );
}
