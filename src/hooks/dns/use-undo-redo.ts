/**
 * Generic undo/redo stack hook for DNS record operations.
 *
 * Maintains a history of operations that can be undone/redone. Each entry
 * captures enough information to reverse or replay the operation.
 *
 * @example
 * ```tsx
 * const { push, undo, redo, canUndo, canRedo } = useUndoRedo<DNSOp>({
 *   onUndo: async (op) => { await revertOp(op); },
 *   onRedo: async (op) => { await applyOp(op); },
 *   maxHistory: 50,
 * });
 * ```
 */
import { useState, useCallback, useRef } from "react";

export interface UndoRedoEntry<T> {
  /** Unique id for the entry */
  id: string;
  /** Human-readable description of the operation */
  description: string;
  /** Timestamp when the operation was performed */
  timestamp: number;
  /** The forward operation data */
  forward: T;
  /** The reverse operation data */
  reverse: T;
}

export interface UndoRedoOptions<T> {
  /** Called when undoing an operation — should apply the reverse */
  onUndo: (reverse: T, entry: UndoRedoEntry<T>) => Promise<void> | void;
  /** Called when redoing an operation — should apply the forward */
  onRedo: (forward: T, entry: UndoRedoEntry<T>) => Promise<void> | void;
  /** Maximum number of entries to keep in history (default: 50) */
  maxHistory?: number;
}

export interface UndoRedoResult<T> {
  /** Push a new operation onto the stack */
  push: (entry: Omit<UndoRedoEntry<T>, "id" | "timestamp">) => void;
  /** Undo the last operation */
  undo: () => Promise<void>;
  /** Redo the last undone operation */
  redo: () => Promise<void>;
  /** Whether undo is possible */
  canUndo: boolean;
  /** Whether redo is possible */
  canRedo: boolean;
  /** Current undo stack (newest first) */
  undoStack: ReadonlyArray<UndoRedoEntry<T>>;
  /** Current redo stack (newest first) */
  redoStack: ReadonlyArray<UndoRedoEntry<T>>;
  /** Clear all history */
  clear: () => void;
}

let nextId = 1;

export function useUndoRedo<T>(options: UndoRedoOptions<T>): UndoRedoResult<T> {
  const { maxHistory = 50 } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [undoStack, setUndoStack] = useState<UndoRedoEntry<T>[]>([]);
  const [redoStack, setRedoStack] = useState<UndoRedoEntry<T>[]>([]);
  const [, setTick] = useState(0);

  const push = useCallback(
    (entry: Omit<UndoRedoEntry<T>, "id" | "timestamp">) => {
      const full: UndoRedoEntry<T> = {
        ...entry,
        id: `undo-${nextId++}`,
        timestamp: Date.now(),
      };
      setUndoStack((prev) => {
        const next = [full, ...prev];
        return next.length > maxHistory ? next.slice(0, maxHistory) : next;
      });
      // Push clears redo stack (new branch)
      setRedoStack([]);
    },
    [maxHistory],
  );

  const undo = useCallback(async () => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const [entry, ...rest] = prev;
      // Move to redo stack
      setRedoStack((r) => [entry, ...r]);
      // Fire the undo callback asynchronously
      Promise.resolve(optionsRef.current.onUndo(entry.reverse, entry)).catch(
        (err) => console.error("[useUndoRedo] undo failed:", err),
      );
      setTick((t) => t + 1);
      return rest;
    });
  }, []);

  const redo = useCallback(async () => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const [entry, ...rest] = prev;
      // Move back to undo stack
      setUndoStack((u) => [entry, ...u]);
      // Fire the redo callback asynchronously
      Promise.resolve(optionsRef.current.onRedo(entry.forward, entry)).catch(
        (err) => console.error("[useUndoRedo] redo failed:", err),
      );
      setTick((t) => t + 1);
      return rest;
    });
  }, []);

  const clear = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  return {
    push,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoStack,
    redoStack,
    clear,
  };
}
