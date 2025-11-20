import * as React from "react";
/**
 * Small in-memory toast manager used by the UI. It supports adding,
 * updating, dismissing and removing toasts and provides a `useToast` hook
 * so components can subscribe to updates.
 */
const TOAST_LIMIT = 1;
const TOAST_REMOVE_DELAY = 5000;
let count = 0;
function genId() {
    count = (count + 1) % Number.MAX_SAFE_INTEGER;
    return count.toString();
}
const toastTimeouts = new Map();
const addToRemoveQueue = (toastId) => {
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
export const reducer = (state, action) => {
    switch (action.type) {
        case "ADD_TOAST":
            return {
                ...state,
                toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
            };
        case "UPDATE_TOAST":
            return {
                ...state,
                toasts: state.toasts.map((t) => t.id === action.toast.id ? { ...t, ...action.toast } : t),
            };
        case "DISMISS_TOAST": {
            const { toastId } = action;
            // ! Side effects ! - This could be extracted into a dismissToast() action,
            // but I'll keep it here for simplicity
            if (toastId) {
                addToRemoveQueue(toastId);
            }
            else {
                state.toasts.forEach((toast) => {
                    addToRemoveQueue(toast.id);
                });
            }
            return {
                ...state,
                toasts: state.toasts.map((t) => t.id === toastId || toastId === undefined
                    ? {
                        ...t,
                        open: false,
                    }
                    : t),
            };
        }
        case "REMOVE_TOAST":
            if (action.toastId === undefined) {
                return {
                    ...state,
                    toasts: [],
                };
            }
            return {
                ...state,
                toasts: state.toasts.filter((t) => t.id !== action.toastId),
            };
    }
};
const listeners = [];
let memoryState = { toasts: [] };
function dispatch(action) {
    memoryState = reducer(memoryState, action);
    listeners.forEach((listener) => {
        listener(memoryState);
    });
}
/**
 * Create and dispatch a new toast.
 *
 * @param props - toast props such as title, description, and optional action
 * @returns an object allowing callers to dismiss or update the toast
 */
function toast({ ...props }) {
    const id = genId();
    const update = (props) => dispatch({
        type: "UPDATE_TOAST",
        toast: { ...props, id },
    });
    const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });
    dispatch({
        type: "ADD_TOAST",
        toast: {
            ...props,
            id,
            open: true,
            onOpenChange: (open) => {
                if (!open)
                    dismiss();
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
    const [state, setState] = React.useState(memoryState);
    React.useEffect(() => {
        listeners.push(setState);
        return () => {
            const index = listeners.indexOf(setState);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        };
        // run only once on mount/unmount
    }, []);
    /**
     * @returns {object} an object containing `toasts`, `toast` and `dismiss` helpers
     */
    return {
        ...state,
        toast,
        dismiss: (toastId) => dispatch({ type: "DISMISS_TOAST", toastId }),
    };
}
export { useToast, toast };
