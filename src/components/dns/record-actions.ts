/**
 * Single source of truth for the DNS record row actions.
 *
 * Both the (optional) Actions column dropdown and the row right-click context
 * menu render from this list, so the two can never drift apart.
 */

/** Stable action ids, also emitted as `data-record-action` for tests. */
export type RecordActionId =
  | "edit"
  | "copy"
  | "open-in-browser"
  | "clone"
  | "delete";

export interface RecordAction {
  id: RecordActionId;
  /** English label; render through `t(label, label)`. */
  label: string;
  /** Render a separator immediately above this item. */
  separatorBefore?: boolean;
  /** Destructive items get the destructive styling. */
  destructive?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface RecordActionHandlers {
  onEdit: () => void;
  onDelete: () => void | Promise<void>;
  onCopy?: () => void | Promise<void>;
  onClone?: () => void | Promise<void>;
  /** Only provided when the record has a resolvable Cloudflare URL. */
  onOpenInBrowser?: () => void;
}

/**
 * Build the ordered action list for a record row. Actions whose handler is not
 * supplied are either omitted (browser/clone, which are contextual) or rendered
 * disabled (copy, which is always meaningful to show).
 */
export function buildRecordActions(
  handlers: RecordActionHandlers,
): RecordAction[] {
  const actions: RecordAction[] = [
    { id: "edit", label: "Edit", run: () => handlers.onEdit() },
    {
      id: "copy",
      label: "Copy",
      disabled: !handlers.onCopy,
      run: () => {
        void handlers.onCopy?.();
      },
    },
  ];

  if (handlers.onOpenInBrowser) {
    actions.push({
      id: "open-in-browser",
      label: "Open in browser",
      run: () => handlers.onOpenInBrowser?.(),
    });
  }
  if (handlers.onClone) {
    actions.push({
      id: "clone",
      label: "Clone",
      run: () => {
        void handlers.onClone?.();
      },
    });
  }

  actions.push({
    id: "delete",
    label: "Delete",
    separatorBefore: true,
    destructive: true,
    run: () => {
      void handlers.onDelete();
    },
  });

  return actions;
}
