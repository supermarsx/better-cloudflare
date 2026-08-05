/**
 * Global keyboard shortcut registry hook.
 *
 * Provides a declarative way to bind keyboard shortcuts to actions throughout
 * the application. Supports modifier keys (Ctrl/Cmd, Shift, Alt) and
 * automatically handles macOS vs. other OS differences (Meta vs. Ctrl).
 *
 * @example
 * ```tsx
 * useHotkeys([
 *   { key: "s", ctrl: true, handler: () => save(), description: "Save" },
 *   { key: "z", ctrl: true, handler: () => undo(), description: "Undo" },
 *   { key: "z", ctrl: true, shift: true, handler: () => redo(), description: "Redo" },
 *   { key: "/", handler: () => focusSearch(), description: "Focus search" },
 * ]);
 * ```
 */
import { useEffect, useRef } from "react";

export interface HotkeyBinding {
  /** The key to listen for (e.g. "s", "z", "/", "Escape", "Delete") */
  key: string;
  /** Require Ctrl (Windows/Linux) or Cmd (macOS) */
  ctrl?: boolean;
  /** Require Shift */
  shift?: boolean;
  /** Require Alt/Option */
  alt?: boolean;
  /** Handler to call when the hotkey is triggered */
  handler: (e: KeyboardEvent) => void;
  /** Human-readable description for help dialogs */
  description?: string;
  /** If true, hotkey works even when an input/textarea is focused */
  allowInInput?: boolean;
  /** If true, the hotkey is disabled */
  disabled?: boolean;
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? navigator.userAgent ?? "");

function isInputElement(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function matchesBinding(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  // A ctrl binding means exactly Cmd on Apple platforms or Ctrl elsewhere.
  // Reject the other platform modifier so Ctrl+Meta cannot trigger a binding.
  const expectsPrimaryModifier = binding.ctrl === true;
  const expectsCtrl = !isMac && expectsPrimaryModifier;
  const expectsMeta = isMac && expectsPrimaryModifier;
  if (e.ctrlKey !== expectsCtrl || e.metaKey !== expectsMeta) return false;
  if (e.shiftKey !== (binding.shift === true)) return false;
  if (e.altKey !== (binding.alt === true)) return false;

  return e.key.toLowerCase() === binding.key.toLowerCase();
}

/**
 * Register global keyboard shortcuts. Bindings are updated on every render
 * via a ref so the handler closures always see the latest state.
 *
 * @param bindings - Array of hotkey bindings to register
 * @param enabled - Master switch; set to false to disable all hotkeys
 */
export function useHotkeys(bindings: HotkeyBinding[], enabled = true): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      for (const binding of bindingsRef.current) {
        if (binding.disabled) continue;
        if (!binding.allowInInput && isInputElement(e.target)) continue;
        if (matchesBinding(e, binding)) {
          e.preventDefault();
          e.stopPropagation();
          binding.handler(e);
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);
}

/**
 * Return a human-readable representation of a hotkey binding.
 * Useful for rendering shortcut hints in tooltips and help dialogs.
 */
export function formatHotkey(
  binding: Pick<HotkeyBinding, "key" | "ctrl" | "shift" | "alt">,
): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(isMac ? "⇧" : "Shift");
  if (binding.alt) parts.push(isMac ? "⌥" : "Alt");

  let key = binding.key;
  // Pretty-print common keys
  const prettyKeys: Record<string, string> = {
    delete: isMac ? "⌫" : "Del",
    backspace: "⌫",
    escape: "Esc",
    enter: "↵",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    " ": "Space",
  };
  key = prettyKeys[key.toLowerCase()] ?? key.toUpperCase();
  parts.push(key);

  return parts.join(isMac ? "" : "+");
}
