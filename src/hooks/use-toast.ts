import * as React from "react";

import type { ToastActionElement, ToastProps } from "@/components/ui/toast";
import {
  RUNTIME_REPORT_DEDUPLICATION_WINDOW_MS,
  type RuntimeDiagnostic,
} from "@/lib/errors/runtime-reporting";

/**
 * Small in-memory toast manager used by the UI. It supports adding,
 * updating, dismissing and removing toasts and provides a `useToast` hook
 * so components can subscribe to updates.
 */
export const TOAST_LIMIT = 4;
const TOAST_REMOVE_DELAY = 5000;
export const TOAST_DEDUPE_WINDOW_MS = RUNTIME_REPORT_DEDUPLICATION_WINDOW_MS;
export const TOAST_DURATION_MIN_MS = 4000;
export const TOAST_DURATION_MAX_MS = 15000;

const DEFAULT_TOAST_DURATION_MS = 5500;
const DESTRUCTIVE_TOAST_DURATION_MS = 9000;
const DIAGNOSTIC_TOAST_DURATION_MS = 12000;

export type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  diagnostic?: RuntimeDiagnostic;
  persistent?: boolean;
  dedupeKey?: string;
  occurrenceCount?: number;
  dedupeFingerprint?: string;
  lastOccurrenceAt?: number;
};

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type Action =
  | {
      type: "ADD_TOAST";
      toast: ToasterToast;
    }
  | {
      type: "UPDATE_TOAST";
      toast: Partial<ToasterToast>;
    }
  | {
      type: "DISMISS_TOAST";
      toastId?: ToasterToast["id"];
    }
  | {
      type: "REMOVE_TOAST";
      toastId?: ToasterToast["id"];
    };

export interface ToastState {
  toasts: ToasterToast[];
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const clearRemovalTimer = (toastId: string) => {
  const timeout = toastTimeouts.get(toastId);
  if (timeout === undefined) return;
  clearTimeout(timeout);
  toastTimeouts.delete(toastId);
};

const clearAllRemovalTimers = () => {
  for (const toastId of [...toastTimeouts.keys()]) {
    clearRemovalTimer(toastId);
  }
};

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

/**
 * Reducer implementing the core toast state transitions for the in-memory
 * toast manager. The reducer supports the following actions:
 * - ADD_TOAST: add a new toast to the list
 * - UPDATE_TOAST: patch an existing toast
 * - DISMISS_TOAST: schedule a toast for removal and mark its open state
 * - REMOVE_TOAST: remove toast from state
 */
/**
 * Reducer implementing the core toast state transitions for the in-memory
 * toast manager. The reducer supports the following actions:
 * - ADD_TOAST: add a new toast to the list
 * - UPDATE_TOAST: patch an existing toast
 * - DISMISS_TOAST: schedule a toast for removal and mark its open state
 * - REMOVE_TOAST: remove toast from state
 *
 * @param state - current toast state
 * @param action - action to apply
 * @returns new state after applying the action
 */
export const reducer = (state: ToastState, action: Action): ToastState => {
  switch (action.type) {
    case "ADD_TOAST": {
      const toasts = [
        action.toast,
        ...state.toasts.filter((toast) => toast.id !== action.toast.id),
      ].slice(0, TOAST_LIMIT);
      const retainedIds = new Set(toasts.map((toast) => toast.id));
      for (const existing of state.toasts) {
        if (!retainedIds.has(existing.id)) {
          clearRemovalTimer(existing.id);
        }
      }
      return {
        ...state,
        toasts,
      };
    }

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t,
        ),
      };

    case "DISMISS_TOAST": {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t,
        ),
      };
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        clearAllRemovalTimers();
        return {
          ...state,
          toasts: [],
        };
      }
      clearRemovalTimer(action.toastId);
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners = new Set<(state: ToastState) => void>();

let memoryState: ToastState = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  for (const listener of [...listeners]) {
    listener(memoryState);
  }
}

export type Toast = Omit<ToasterToast, "id">;

function reactNodeText(node: React.ReactNode): string {
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(reactNodeText).join("");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return reactNodeText(node.props.children);
  }
  return "";
}

function getToastDedupeFingerprint(props: Toast): string | undefined {
  if (props.diagnostic) {
    return `diagnostic:${props.diagnostic.fingerprint}`;
  }
  if (props.dedupeKey?.trim()) return `explicit:${props.dedupeKey.trim()}`;

  const title = reactNodeText(props.title).trim();
  const description = reactNodeText(props.description).trim();
  if (!title && !description) return undefined;

  const severity = props.variant === "destructive" ? "destructive" : "default";
  return `message:${severity}:${title}:${description}`;
}

export function resolveToastDuration(
  props: Pick<
    ToasterToast,
    "diagnostic" | "duration" | "persistent" | "variant"
  >,
): number {
  if (props.persistent) return TOAST_DURATION_MAX_MS;

  const requested = props.duration;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.min(
      TOAST_DURATION_MAX_MS,
      Math.max(TOAST_DURATION_MIN_MS, requested),
    );
  }

  if (props.diagnostic) return DIAGNOSTIC_TOAST_DURATION_MS;
  if (props.variant === "destructive") return DESTRUCTIVE_TOAST_DURATION_MS;
  return DEFAULT_TOAST_DURATION_MS;
}

/**
 * Create and dispatch a new toast.
 *
 * @param props - toast props such as title, description, and optional action
 * @returns an object allowing callers to dismiss or update the toast
 */
function toast({ ...props }: Toast) {
  const now = Date.now();
  const dedupeFingerprint = getToastDedupeFingerprint(props);
  const duplicate = dedupeFingerprint
    ? memoryState.toasts.find(
        (item) =>
          item.open !== false &&
          item.dedupeFingerprint === dedupeFingerprint &&
          typeof item.lastOccurrenceAt === "number" &&
          now - item.lastOccurrenceAt <= TOAST_DEDUPE_WINDOW_MS,
      )
    : undefined;
  const id = duplicate?.id ?? genId();
  const occurrenceCount = (duplicate?.occurrenceCount ?? 0) + 1;

  const update = (props: ToasterToast) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    });
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });

  const onOpenChange = props.onOpenChange;
  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      dedupeFingerprint,
      duration: resolveToastDuration(props),
      lastOccurrenceAt: now,
      occurrenceCount,
      open: true,
      onOpenChange: (open) => {
        onOpenChange?.(open);
        if (!open) dismiss();
      },
    },
  });

  return {
    id: id,
    dismiss,
    update,
  };
}

/**
 * Hook for subscribing to the global toast manager.
 *
 * Usage:
 * const { toasts, toast, dismiss } = useToast()
 *
 * This hook returns the current list of toasts and helper functions to add
 * or dismiss toasts programmatically.
 */
function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState);

  React.useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
    // run only once on mount/unmount
  }, []);

  /**
   * @returns {object} an object containing `toasts`, `toast` and `dismiss` helpers
   */
  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export function getToastRuntimeSnapshot(): {
  listeners: number;
  removalTimers: number;
  toasts: number;
} {
  return {
    listeners: listeners.size,
    removalTimers: toastTimeouts.size,
    toasts: memoryState.toasts.length,
  };
}

export function resetToastRuntimeForTests(): void {
  clearAllRemovalTimers();
  listeners.clear();
  memoryState = { toasts: [] };
  count = 0;
}

export { useToast, toast };
