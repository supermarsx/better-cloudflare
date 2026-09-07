/**
 * The collapsed pill at the top-left of the login screen that expands on hover
 * to reveal the preference controls.
 *
 * It used to live inline in `App`, holding only the language and theme
 * toggles. It moved here so the login screen can put its own controls in it —
 * `App` has none of the handlers those need, and lifting the login form's
 * state up to `App` to reach them would have been the wrong direction.
 *
 * The dock renders exactly when the login screen does, which is what it did
 * before: `App` gated it on `!showingAuthenticatedApp`, and that is the same
 * condition under which `LoginForm` is mounted. The authenticated view has its
 * own copies of these controls in `DnsAppCommandBar`.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LanguageSelector } from "@/components/layout/LanguageSelector";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { TITLEBAR_HEIGHT_PX } from "@/components/layout/WindowTitleBar";
import {
  createTrackedRuntimeResources,
  type TrackedRuntimeResources,
} from "@/lib/runtime/resource-scope";
import { cn } from "@/lib/utils";

/** How long the dock stays open after the pointer leaves it. */
const HIDE_DELAY_MS = 1800;

interface PreferencesDockProps {
  /** Desktop draws a title bar above this, so the dock sits below it. */
  desktop: boolean;
  /**
   * Hold the dock open regardless of the pointer.
   *
   * A menu opened from inside the dock is portalled out of it, so the pointer
   * moving onto that menu counts as leaving the dock. Without this the dock
   * would collapse out from under its own open menu.
   */
  keepOpen?: boolean;
  /** Extra controls, shown after the language and theme toggles. */
  children?: ReactNode;
}

export function PreferencesDock({
  desktop,
  keepOpen = false,
  children,
}: PreferencesDockProps) {
  const [open, setOpen] = useState(false);
  const hideTimeout = useRef<number | null>(null);
  const runtimeResourcesRef = useRef<TrackedRuntimeResources | null>(null);

  if (!runtimeResourcesRef.current) {
    runtimeResourcesRef.current = createTrackedRuntimeResources(window);
  }
  const runtimeResources = runtimeResourcesRef.current;

  useEffect(
    () => () => {
      runtimeResources.dispose();
      hideTimeout.current = null;
    },
    [runtimeResources],
  );

  const clearHideTimer = useCallback(() => {
    if (hideTimeout.current === null) return;
    runtimeResources.clearTimeout(hideTimeout.current);
    hideTimeout.current = null;
  }, [runtimeResources]);

  const scheduleHide = () => {
    clearHideTimer();
    hideTimeout.current = runtimeResources.setTimeout(() => {
      hideTimeout.current = null;
      setOpen(false);
    }, HIDE_DELAY_MS);
  };

  // A hide scheduled just before the menu opened must not still be pending, or
  // the dock collapses out from under a menu the user is reading.
  useEffect(() => {
    if (keepOpen) clearHideTimer();
  }, [clearHideTimer, keepOpen]);

  const expanded = open || keepOpen;

  return (
    <div
      className="fixed left-3 z-20"
      style={{ top: (desktop ? TITLEBAR_HEIGHT_PX : 0) + 12 }}
    >
      <div
        className="flex items-center rounded-full border border-transparent bg-transparent px-1 py-0.5 text-[10px] text-muted-foreground/35 opacity-80 backdrop-blur-sm transition hover:opacity-100"
        onMouseEnter={() => {
          clearHideTimer();
          setOpen(true);
        }}
        onMouseLeave={() => {
          if (keepOpen) return;
          scheduleHide();
        }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="ui-icon-button h-6 w-6"
          aria-label="Preferences"
          aria-expanded={expanded}
          onClick={() => {
            clearHideTimer();
            setOpen((previous) => !previous);
          }}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        </Button>
        <div
          className={cn(
            "flex items-center gap-2 overflow-hidden transition-all duration-300",
            expanded
              ? "ml-1 max-w-[200px] opacity-100"
              : "ml-0 max-w-0 opacity-0 pointer-events-none",
          )}
        >
          <LanguageSelector compact />
          <ThemeToggle compact />
          {children}
        </div>
      </div>
    </div>
  );
}

export default PreferencesDock;
