import { JSDOM } from "jsdom";
import React from "react";
import { createRequire } from "module";

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
  url: "http://localhost",
  pretendToBeVisual: true,
});

const jsdomWindow = dom.window;
const browserWindow = jsdomWindow as unknown as Window & {
  __TAURI__?: unknown;
};

function setGlobalDescriptor(
  key: string,
  descriptor: PropertyDescriptor,
): void {
  if (key === "window") {
    return;
  }
  if (descriptor.value === undefined && descriptor.get === undefined) {
    return;
  }
  if (key in globalThis) {
    return;
  }

  try {
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get: descriptor.get,
        set: descriptor.set,
      });
      return;
    }

    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      writable: descriptor.writable ?? true,
      value: descriptor.value,
    });
  } catch {
    try {
      if (descriptor.value !== undefined) {
        (globalThis as Record<string, unknown>)[key] = descriptor.value;
      }
    } catch {
      // Ignore globals that cannot be patched safely.
    }
  }
}

function setWindowOverride(value: unknown): void {
  if (value === undefined || value === null) {
    try {
      delete browserWindow.__TAURI__;
    } catch {
      // Ignore when descriptor is not configurable.
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const tauriValue = (value as { __TAURI__?: unknown }).__TAURI__;
  if (tauriValue !== undefined) {
    browserWindow.__TAURI__ = tauriValue;
    return;
  }
  try {
    delete browserWindow.__TAURI__;
  } catch {
    // Ignore when descriptor is not configurable.
  }
}

Object.getOwnPropertyNames(browserWindow).forEach((key) => {
  setGlobalDescriptor(
    key,
    Object.getOwnPropertyDescriptor(browserWindow, key)!,
  );
});

Object.defineProperty(globalThis, "window", {
  configurable: true,
  enumerable: true,
  get: () => browserWindow,
  set: (value) => setWindowOverride(value),
});

if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: browserWindow.navigator,
  });
}

if (!globalThis.document) {
  (globalThis as Record<string, unknown>).document = browserWindow.document;
}

if (!globalThis.NodeFilter) {
  globalThis.NodeFilter = browserWindow.NodeFilter;
}
if (!globalThis.DocumentFragment) {
  globalThis.DocumentFragment = browserWindow.DocumentFragment;
}
if (!globalThis.Document) {
  globalThis.Document = browserWindow.Document;
}
if (!globalThis.Element) {
  globalThis.Element = browserWindow.Element;
}
if (!globalThis.MutationObserver) {
  globalThis.MutationObserver = browserWindow.MutationObserver;
}

Object.entries({
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}).forEach(([name, fallback]) => {
  const key = name as keyof typeof browserWindow;
  if (!(key in browserWindow)) {
    (browserWindow as Record<string, unknown>)[key] = fallback as never;
  } else if (
    typeof (browserWindow as Record<string, unknown>)[key] !== "function" &&
    typeof fallback === "function"
  ) {
    (browserWindow as Record<string, unknown>)[key] = (
      fallback as (...args: unknown[]) => unknown
    ).bind(globalThis);
  }
});

if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () =>
      ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        addListener: () => {},
        removeListener: () => {},
      }) as MediaQueryList,
  });
}

if (!globalThis.React) {
  globalThis.React = React;
}

if (!(globalThis as Record<PropertyKey, unknown>).IS_REACT_ACT_ENVIRONMENT) {
  (globalThis as Record<PropertyKey, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

const originalCreateElement = React.createElement.bind(React);
const shimmedDialogDisplayNames = new Set([
  "Dialog",
  "DialogPortal",
  "DialogClose",
  "DialogOverlay",
  "DialogContent",
  "DialogHeader",
  "DialogFooter",
  "DialogTitle",
  "DialogDescription",
  "DialogTrigger",
]);
const shimmedSelectDisplayNames = new Set([
  "Select",
  "SelectValue",
  "SelectTrigger",
  "SelectContent",
  "SelectItem",
  "SelectLabel",
  "SelectGroup",
  "SelectSeparator",
  "SelectScrollUpButton",
  "SelectScrollDownButton",
  "SelectViewport",
  "SelectItemIndicator",
  "SelectItemText",
]);
const shimmedDropdownDisplayNames = new Set([
  "DropdownMenu",
  "DropdownMenuTrigger",
  "DropdownMenuContent",
  "DropdownMenuItem",
  "DropdownMenuCheckboxItem",
  "DropdownMenuRadioItem",
  "DropdownMenuLabel",
  "DropdownMenuSeparator",
  "DropdownMenuShortcut",
  "DropdownMenuGroup",
  "DropdownMenuPortal",
  "DropdownMenuSub",
  "DropdownMenuSubContent",
  "DropdownMenuSubTrigger",
  "DropdownMenuRadioGroup",
]);
const shimmedContextDisplayNames = new Set([
  "ContextMenu",
  "ContextMenuTrigger",
  "ContextMenuContent",
  "ContextMenuItem",
  "ContextMenuCheckboxItem",
  "ContextMenuRadioItem",
  "ContextMenuLabel",
  "ContextMenuSeparator",
  "ContextMenuGroup",
  "ContextMenuPortal",
  "ContextMenuSub",
  "ContextMenuSubContent",
  "ContextMenuSubTrigger",
  "ContextMenuRadioGroup",
]);
const shimmedSwitchDisplayNames = new Set(["Switch", "SwitchThumb"]);
const dialogTagByName: Record<string, string> = {
  Dialog: "div",
  DialogPortal: "div",
  DialogClose: "button",
  DialogOverlay: "div",
  DialogContent: "div",
  DialogHeader: "div",
  DialogFooter: "div",
  DialogTitle: "h2",
  DialogDescription: "p",
  DialogTrigger: "button",
  Select: "div",
  SelectTrigger: "button",
  SelectContent: "div",
  SelectValue: "span",
  SelectItem: "div",
  SelectLabel: "span",
  SelectGroup: "div",
  SelectSeparator: "hr",
  SelectScrollUpButton: "button",
  SelectScrollDownButton: "button",
  SelectViewport: "div",
  SelectItemIndicator: "span",
  SelectItemText: "span",
  DropdownMenu: "div",
  DropdownMenuTrigger: "button",
  DropdownMenuContent: "div",
  DropdownMenuItem: "div",
  DropdownMenuCheckboxItem: "div",
  DropdownMenuRadioItem: "div",
  DropdownMenuLabel: "span",
  DropdownMenuSeparator: "hr",
  DropdownMenuShortcut: "span",
  DropdownMenuGroup: "div",
  DropdownMenuPortal: "div",
  DropdownMenuSub: "div",
  DropdownMenuSubContent: "div",
  DropdownMenuSubTrigger: "button",
  DropdownMenuRadioGroup: "div",
  ContextMenu: "div",
  ContextMenuTrigger: "button",
  ContextMenuContent: "div",
  ContextMenuItem: "div",
  ContextMenuCheckboxItem: "div",
  ContextMenuRadioItem: "div",
  ContextMenuLabel: "span",
  ContextMenuSeparator: "hr",
  ContextMenuGroup: "div",
  ContextMenuPortal: "div",
  ContextMenuSub: "div",
  ContextMenuSubContent: "div",
  ContextMenuSubTrigger: "button",
  ContextMenuRadioGroup: "div",
  Switch: "button",
  SwitchThumb: "span",
};

const shimmedDisplayNames = new Set([
  ...shimmedDialogDisplayNames,
  ...shimmedSelectDisplayNames,
  ...shimmedDropdownDisplayNames,
  ...shimmedContextDisplayNames,
  ...shimmedSwitchDisplayNames,
]);

function isRadixDisplayName(displayName?: string): boolean {
  if (!displayName) {
    return false;
  }

  if (shimmedDisplayNames.has(displayName)) {
    return true;
  }

  if (displayName === "Primitive" || displayName.startsWith("Primitive.")) {
    return true;
  }

  const radixPrefixes = [
    "Dialog",
    "DropdownMenu",
    "ContextMenu",
    "Select",
    "Switch",
    "Menu",
    "Presence",
    "FocusScope",
    "DismissableLayer",
    "FocusGuards",
    "Portal",
    "Popper",
    "Selector",
    "Arrow",
    "Slot",
    "Separator",
    "Group",
    "Label",
    "Item",
    "Sub",
    "Radio",
    "Checkbox",
  ];
  if (radixPrefixes.some((prefix) => displayName.startsWith(prefix))) {
    return true;
  }
  return false;
}

function tagForDisplayName(displayName: string): string {
  if (displayName === "Primitive") return "div";
  const primitiveMatch = /^Primitive\.(.+)$/.exec(displayName);
  if (primitiveMatch && primitiveMatch[1]) {
    return primitiveMatch[1];
  }
  if (/^Menu/.test(displayName)) return "div";
  if (/^Portal/.test(displayName)) return "div";
  if (/^Presence/.test(displayName)) return "div";
  if (/^FocusScope/.test(displayName)) return "div";
  if (/^DismissableLayer/.test(displayName)) return "div";
  if (/^Select(?:Separator|ItemIndicator|ItemText)$/.test(displayName))
    return "span";
  if (/Trigger$/.test(displayName)) return "button";
  if (/^DialogTitle/.test(displayName)) return "h2";
  if (/^DialogDescription/.test(displayName)) return "p";
  return dialogTagByName[displayName] ?? "div";
}

function getDisplayName(type: unknown): string | undefined {
  if (typeof type === "function") {
    return (
      (type as { displayName?: string; name?: string }).displayName ??
      (type as { displayName?: string; name?: string }).name
    );
  }
  if (typeof type === "object" && type !== null) {
    const wrapped = type as {
      displayName?: string;
      render?: { displayName?: string; name?: string };
      name?: string;
    };
    return (
      wrapped.displayName ??
      wrapped.render?.displayName ??
      wrapped.render?.name ??
      wrapped.name
    );
  }
  return undefined;
}

function stripDialogProps(
  props: Record<string, unknown> | null,
): Record<string, unknown> {
  const passthrough = { ...(props ?? {}) } as Record<string, unknown>;
  delete passthrough.onOpenAutoFocus;
  delete passthrough.onCloseAutoFocus;
  delete passthrough.onPointerDownOutside;
  delete passthrough.onInteractOutside;
  delete passthrough.forceMount;
  delete passthrough.ref;
  return passthrough;
}

const requireModule = createRequire(import.meta.url);
const composeRefsId = "@radix-ui/react-compose-refs";
try {
  const composeRefsUrl = requireModule.resolve(composeRefsId);
  const composeRefsModule = require(composeRefsUrl) as {
    composeRefs?: (...refs: unknown[]) => (node: unknown) => void;
  };
  const originalComposeRefs = composeRefsModule.composeRefs;
  if (typeof originalComposeRefs === "function") {
    composeRefsModule.composeRefs = (...refs: unknown[]) => {
      const composed = originalComposeRefs(...refs);
      let lastNode: unknown;
      return (node: unknown) => {
        if (node === lastNode) {
          return;
        }
        lastNode = node;
        return composed(node);
      };
    };
  }
} catch {
  // If compose-refs internals change, continue with default behavior.
}

React.createElement = (
  type: React.ElementType,
  props: object | null,
  ...children: unknown[]
) => {
  const displayName = getDisplayName(type);
  if (displayName && isRadixDisplayName(displayName)) {
    const tag = tagForDisplayName(displayName);
    return originalCreateElement(
      tag,
      {
        ...stripDialogProps(props as Record<string, unknown> | null),
        "data-radix-test-shim": displayName,
      },
      ...children,
    );
  }
  return originalCreateElement(type, props as never, ...children);
};

const requireReactDom = createRequire(import.meta.url);
const reactDom = requireReactDom("react-dom");
if (reactDom && typeof reactDom.createPortal === "function") {
  const createPortal = reactDom.createPortal.bind(reactDom);
  reactDom.createPortal = (children: unknown) =>
    children as ReturnType<typeof createPortal>;
}

const createNodeMockForType = (type: unknown) =>
  browserWindow.document.createElement(
    typeof type === "string" && type.length > 0 ? type : "div",
  );

if (!browserWindow.document.body.createNodeMock) {
  Object.defineProperty(browserWindow.Element.prototype, "createNodeMock", {
    configurable: true,
    writable: true,
    value: ({ type }: { type: unknown }) => createNodeMockForType(type),
  });
  Object.defineProperty(browserWindow.Document.prototype, "createNodeMock", {
    configurable: true,
    writable: true,
    value: ({ type }: { type: unknown }) => createNodeMockForType(type),
  });
  Object.defineProperty(
    browserWindow.DocumentFragment.prototype,
    "createNodeMock",
    {
      configurable: true,
      writable: true,
      value: ({ type }: { type: unknown }) => createNodeMockForType(type),
    },
  );
}

const originalElementDispatchEvent =
  browserWindow.Element.prototype.dispatchEvent;
const originalDocumentDispatchEvent =
  browserWindow.Document.prototype.dispatchEvent;
const originalWindowDispatchEvent = browserWindow.dispatchEvent;

browserWindow.Element.prototype.dispatchEvent = function (
  this: Element,
  event: Event,
) {
  try {
    return originalElementDispatchEvent.call(this, event);
  } catch {
    return true;
  }
} as (event: Event) => boolean;

browserWindow.Document.prototype.dispatchEvent = function (
  this: Document,
  event: Event,
) {
  try {
    return originalDocumentDispatchEvent.call(this, event);
  } catch {
    return true;
  }
} as (event: Event) => boolean;

browserWindow.dispatchEvent = function (this: Window, event: Event) {
  try {
    return originalWindowDispatchEvent.call(this, event);
  } catch {
    return true;
  }
} as (event: Event) => boolean;
