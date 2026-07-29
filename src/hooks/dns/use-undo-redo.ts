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
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import { boundedResourceCount, RESOURCE_LIMITS } from "@/lib/resource-limits";

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
  /** Maximum entries to retain (default: 50; always capped at 100) */
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

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The operation returned an unknown error.";
}

function reportHistoryFailure<T>(
  action: "undo" | "redo",
  entry: UndoRedoEntry<T>,
  error: unknown,
): void {
  reportRuntimeError(
    new Error(
      `Could not ${action} "${entry.description}". History was left unchanged, so you can retry. Reason: ${failureReason(error)}`,
    ),
    {
      source: "runtime",
      label: `${action === "undo" ? "Undo" : "Redo"} DNS history operation`,
    },
  );
}

function boundedHistoryLimit(requested?: number): number {
  return boundedResourceCount(
    requested,
    RESOURCE_LIMITS.undoRedo.defaultEntries,
    RESOURCE_LIMITS.undoRedo.hardEntries,
  );
}

export function useUndoRedo<T>(options: UndoRedoOptions<T>): UndoRedoResult<T> {
  const maxHistory: number = boundedHistoryLimit(options.maxHistory);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [undoStack, setUndoStack] = useState<UndoRedoEntry<T>[]>([]);
  const [redoStack, setRedoStack] = useState<UndoRedoEntry<T>[]>([]);
  const undoStackRef = useRef<UndoRedoEntry<T>[]>([]);
  const redoStackRef = useRef<UndoRedoEntry<T>[]>([]);
  const historyActionInFlightRef = useRef(false);

  const replaceUndoStack = useCallback((next: UndoRedoEntry<T>[]) => {
    undoStackRef.current = next;
    setUndoStack(next);
  }, []);

  const replaceRedoStack = useCallback((next: UndoRedoEntry<T>[]) => {
    redoStackRef.current = next;
    setRedoStack(next);
  }, []);

  const push = useCallback(
    (entry: Omit<UndoRedoEntry<T>, "id" | "timestamp">) => {
      if (historyActionInFlightRef.current) return;
      const full: UndoRedoEntry<T> = {
        ...entry,
        id: `undo-${nextId++}`,
        timestamp: Date.now(),
      };
      const next = [full, ...undoStackRef.current];
      replaceUndoStack(
        next.length > maxHistory ? next.slice(0, maxHistory) : next,
      );
      // Push clears redo stack (new branch)
      replaceRedoStack([]);
    },
    [maxHistory, replaceRedoStack, replaceUndoStack],
  );

  const undo = useCallback(async () => {
    if (historyActionInFlightRef.current) return;
    const entry = undoStackRef.current[0];
    if (!entry) return;

    historyActionInFlightRef.current = true;
    try {
      await optionsRef.current.onUndo(entry.reverse, entry);
      const currentIndex = undoStackRef.current.findIndex(
        (candidate) => candidate.id === entry.id,
      );
      if (currentIndex < 0) return;

      replaceUndoStack([
        ...undoStackRef.current.slice(0, currentIndex),
        ...undoStackRef.current.slice(currentIndex + 1),
      ]);
      replaceRedoStack([entry, ...redoStackRef.current].slice(0, maxHistory));
    } catch (error) {
      reportHistoryFailure("undo", entry, error);
    } finally {
      historyActionInFlightRef.current = false;
    }
  }, [maxHistory, replaceRedoStack, replaceUndoStack]);

  const redo = useCallback(async () => {
    if (historyActionInFlightRef.current) return;
    const entry = redoStackRef.current[0];
    if (!entry) return;

    historyActionInFlightRef.current = true;
    try {
      await optionsRef.current.onRedo(entry.forward, entry);
      const currentIndex = redoStackRef.current.findIndex(
        (candidate) => candidate.id === entry.id,
      );
      if (currentIndex < 0) return;

      replaceRedoStack([
        ...redoStackRef.current.slice(0, currentIndex),
        ...redoStackRef.current.slice(currentIndex + 1),
      ]);
      replaceUndoStack([entry, ...undoStackRef.current].slice(0, maxHistory));
    } catch (error) {
      reportHistoryFailure("redo", entry, error);
    } finally {
      historyActionInFlightRef.current = false;
    }
  }, [maxHistory, replaceRedoStack, replaceUndoStack]);

  const clear = useCallback(() => {
    if (historyActionInFlightRef.current) return;
    replaceUndoStack([]);
    replaceRedoStack([]);
  }, [replaceRedoStack, replaceUndoStack]);

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
