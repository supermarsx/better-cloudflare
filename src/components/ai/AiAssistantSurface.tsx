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
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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

export interface AiAssistantSurfaceProps {
  presentation: AiAssistantPresentation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
      data-testid="ai-assistant-bubble"
      data-open={open}
      // Clear of the connection bar, which is `sticky bottom-0` and about
      // 2.5rem tall; there is no CSS variable for its height to read.
      className="pointer-events-none fixed right-4 bottom-16 z-[60] flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
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
      <Button
        type="button"
        size="icon"
        className="pointer-events-auto h-11 w-11 shrink-0 rounded-full shadow-lg"
        aria-expanded={open}
        aria-label={open ? t("Close assistant", "Close assistant") : label}
        onClick={() => onOpenChange(!open)}
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
