/**
 * Keyboard shortcut help dialog — shows available hotkeys.
 * Toggle with Shift+? (Shift+/) from anywhere in the app.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Shortcut {
  keys: string;
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "Ctrl+Z / ⌘Z", description: "Undo last DNS change" },
  { keys: "Ctrl+Shift+Z / ⌘⇧Z", description: "Redo last DNS change" },
  { keys: "Ctrl+N / ⌘N", description: "Add new DNS record" },
  { keys: "Ctrl+F / ⌘F", description: "Focus search / filter" },
  { keys: "Ctrl+E / ⌘E", description: "Export DNS records" },
  { keys: "Escape", description: "Cancel editing / Close dialog" },
  { keys: "Delete / Backspace", description: "Delete selected records" },
  { keys: "Shift+?", description: "Show this help dialog" },
];

export function HotkeyHelpDialog() {
  const [open, setOpen] = useState(false);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "?" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      // Don't trigger inside inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      setOpen((prev) => !prev);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          {SHORTCUTS.map((s) => (
            <div
              key={s.keys}
              className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50"
            >
              <span className="text-sm text-muted-foreground">
                {s.description}
              </span>
              <kbd className="ml-4 shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Press <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">Shift+?</kbd> to toggle
        </p>
      </DialogContent>
    </Dialog>
  );
}
