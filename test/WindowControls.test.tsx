import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  runWindowAction,
  useWindowDragRegion,
  WindowControls,
  type MaximizedChangeHandler,
  type WindowActionTarget,
} from "../src/components/layout/WindowControls";
import { useToast } from "../src/hooks/use-toast";

afterEach(() => {
  cleanup();
});

/**
 * Faithful stand-in for the `mousedown` half of Tauri's injected drag-region
 * script (tauri 2.11.5, `src/window/scripts/drag.js`) on Windows/Linux:
 * a document-level bubble-phase listener that invokes `start_dragging` for a
 * single click on a `data-tauri-drag-region` element and
 * `internal_toggle_maximize` for a double click, then stops propagation.
 *
 * jsdom does not run Tauri's real init script, so the tests install this to
 * reproduce the environment the titlebar actually lives in and prove the React
 * tree does not toggle maximize a second time on top of it.
 */
function installNativeDragRegionScript(invocations: string[]): () => void {
  const CLICKABLE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "LABEL",
    "SUMMARY",
  ]);

  const isDragRegion = (path: EventTarget[]): boolean => {
    for (const node of path) {
      if (!(node instanceof HTMLElement)) continue;
      const attr = node.getAttribute("data-tauri-drag-region");
      const clickable =
        CLICKABLE_TAGS.has(node.tagName) ||
        (node.hasAttribute("tabindex") &&
          node.getAttribute("tabindex") !== "-1");
      if (clickable && attr === null) return false;
      if (attr === null) continue;
      if (attr === "false") return false;
      if (attr === "deep") return true;
      if (attr === "" || attr === "true") return node === path[0];
    }
    return false;
  };

  const onMouseDown = (event: Event) => {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.button !== 0) return;
    if (mouseEvent.detail !== 1 && mouseEvent.detail !== 2) return;
    if (!isDragRegion(event.composedPath())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invocations.push(
      mouseEvent.detail === 2 ? "internal_toggle_maximize" : "start_dragging",
    );
  };

  document.addEventListener("mousedown", onMouseDown);
  return () => document.removeEventListener("mousedown", onMouseDown);
}

function mouseEventOn(
  element: Element,
  type: string,
  detail: number,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail,
  });
  element.dispatchEvent(event);
  return event;
}

/** Dispatches the full Windows double-click sequence over an element. */
function doubleClick(element: Element): void {
  mouseEventOn(element, "pointerdown", 1);
  mouseEventOn(element, "mousedown", 1);
  mouseEventOn(element, "mouseup", 1);
  mouseEventOn(element, "click", 1);
  mouseEventOn(element, "pointerdown", 2);
  mouseEventOn(element, "mousedown", 2);
  mouseEventOn(element, "mouseup", 2);
  mouseEventOn(element, "click", 2);
  mouseEventOn(element, "dblclick", 2);
}

function DragRegionProbe({
  onAction,
}: {
  onAction?: (action: string) => void;
}) {
  const dragRegion = useWindowDragRegion();
  return (
    <div data-testid="drag-region" {...dragRegion}>
      <WindowControls
        actionRunner={async (action) => {
          onAction?.(action);
        }}
        subscribeMaximized={() => () => {}}
      />
    </div>
  );
}

test("WindowControls reports native action failures", async () => {
  const failure = new Error("native bridge unavailable");

  function ToastProbe() {
    const { toasts } = useToast();
    return (
      <>
        {toasts.map(({ id, title, description }) => (
          <div key={id}>
            <span>{title}</span>
            <span>{description}</span>
          </div>
        ))}
      </>
    );
  }

  render(
    <>
      <WindowControls
        actionRunner={async () => {
          throw failure;
        }}
      />
      <ToastProbe />
    </>,
  );

  const minimizeButton = screen.getAllByRole("button")[0];
  assert.ok(minimizeButton);
  fireEvent.click(minimizeButton);

  await waitFor(() => {
    assert.ok(screen.getByText("Window action failed"));
    assert.ok(
      screen.getByText(
        "Could not minimize the window. native bridge unavailable",
      ),
    );
  });
});

test("WindowControls cancel drag gestures without blocking button activation", async () => {
  const actions: string[] = [];
  let parentPointerDowns = 0;
  let parentMouseDowns = 0;

  render(
    <div
      data-tauri-drag-region
      onPointerDown={() => {
        parentPointerDowns += 1;
      }}
      onMouseDown={() => {
        parentMouseDowns += 1;
      }}
    >
      <WindowControls
        actionRunner={async (action) => {
          actions.push(action);
        }}
      />
    </div>,
  );

  const minimizeButton = screen.getByRole("button", {
    name: "Minimize window",
  });
  const pointerDown = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  const mouseDown = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });

  minimizeButton.dispatchEvent(pointerDown);
  minimizeButton.dispatchEvent(mouseDown);

  assert.equal(pointerDown.defaultPrevented, true);
  assert.equal(mouseDown.defaultPrevented, true);
  assert.equal(parentPointerDowns, 0);
  assert.equal(parentMouseDowns, 0);
  assert.equal(minimizeButton.tagName, "BUTTON");
  assert.equal(minimizeButton.tabIndex, 0);

  fireEvent.click(minimizeButton);
  await waitFor(() => {
    assert.deepEqual(actions, ["minimize"]);
  });
});

test("useWindowDragRegion marks the element without attaching gesture handlers", () => {
  let received: Record<string, unknown> = {};

  function Probe() {
    received = useWindowDragRegion();
    return null;
  }

  render(<Probe />);

  assert.deepEqual(received, { "data-tauri-drag-region": "" });
  assert.equal("onPointerDown" in received, false);
  assert.equal("onDoubleClick" in received, false);
  assert.equal("onMouseDown" in received, false);
});

test("double-clicking the drag region toggles maximize exactly once", async () => {
  const nativeInvocations: string[] = [];
  const jsActions: string[] = [];
  const uninstall = installNativeDragRegionScript(nativeInvocations);

  try {
    render(<DragRegionProbe onAction={(action) => jsActions.push(action)} />);
    doubleClick(screen.getByTestId("drag-region"));

    await waitFor(() => {
      assert.equal(
        nativeInvocations.filter((c) => c === "internal_toggle_maximize")
          .length,
        1,
      );
    });
    // The React tree must contribute no second toggle and no duplicate drag.
    assert.deepEqual(jsActions, []);
    assert.deepEqual(nativeInvocations, [
      "start_dragging",
      "internal_toggle_maximize",
    ]);
  } finally {
    uninstall();
  }
});

test("double-clicking the window controls never reaches the drag region", async () => {
  const nativeInvocations: string[] = [];
  const jsActions: string[] = [];
  const uninstall = installNativeDragRegionScript(nativeInvocations);

  try {
    render(<DragRegionProbe onAction={(action) => jsActions.push(action)} />);
    const maximizeButton = screen.getByRole("button", {
      name: "Toggle maximize",
    });
    doubleClick(maximizeButton);

    await waitFor(() => {
      // Two clicks on the button => two explicit toggles, and nothing native.
      assert.deepEqual(jsActions, ["toggle-maximize", "toggle-maximize"]);
    });
    assert.deepEqual(nativeInvocations, []);
  } finally {
    uninstall();
  }
});

test("the maximize control follows the window's real state, including OS-driven changes", async () => {
  const actions: string[] = [];
  let publish: MaximizedChangeHandler | undefined;
  let unsubscribed = 0;

  const { unmount } = render(
    <WindowControls
      actionRunner={async (action) => {
        actions.push(action);
      }}
      subscribeMaximized={(onChange) => {
        publish = onChange;
        return () => {
          unsubscribed += 1;
        };
      }}
    />,
  );

  const maximizeButton = screen.getByRole("button", {
    name: "Toggle maximize",
  });
  assert.equal(maximizeButton.dataset.windowMaximized, "false");
  assert.equal(maximizeButton.querySelectorAll(".lucide-square").length, 1);

  // The user maximizes by OS means (Win+Up, snap, native drag-region dblclick).
  assert.ok(publish);
  act(() => publish?.(true));
  await waitFor(() => {
    assert.equal(maximizeButton.dataset.windowMaximized, "true");
  });
  assert.equal(maximizeButton.querySelectorAll(".lucide-square").length, 0);
  assert.equal(maximizeButton.querySelectorAll(".lucide-copy").length, 1);

  // Restoring from maximized issues exactly one toggle.
  fireEvent.click(maximizeButton);
  await waitFor(() => {
    assert.deepEqual(actions, ["toggle-maximize"]);
  });

  act(() => publish?.(false));
  await waitFor(() => {
    assert.equal(maximizeButton.dataset.windowMaximized, "false");
  });
  assert.equal(maximizeButton.querySelectorAll(".lucide-square").length, 1);

  unmount();
  assert.equal(unsubscribed, 1);
});

test("runWindowAction toggles from the window's own state and honours resizable", async () => {
  const calls: string[] = [];
  const makeWindow = (state: {
    maximized: boolean;
    resizable?: boolean;
    maximizable?: boolean;
  }): WindowActionTarget => {
    const record = <T,>(name: string, value: T) => {
      calls.push(name);
      return Promise.resolve(value);
    };
    return {
      close: () => record("close", undefined),
      destroy: () => record("destroy", undefined),
      minimize: () => record("minimize", undefined),
      maximize: () => record("maximize", undefined),
      unmaximize: () => record("unmaximize", undefined),
      isMaximized: () => Promise.resolve(state.maximized),
      isResizable: () => Promise.resolve(state.resizable ?? true),
      isMaximizable: () => Promise.resolve(state.maximizable ?? true),
      startDragging: () => record("startDragging", undefined),
      center: () => record("center", undefined),
    };
  };

  await runWindowAction("toggle-maximize", async () =>
    makeWindow({ maximized: false }),
  );
  assert.deepEqual(calls, ["maximize"]);

  calls.length = 0;
  await runWindowAction("toggle-maximize", async () =>
    makeWindow({ maximized: true }),
  );
  assert.deepEqual(calls, ["unmaximize"]);

  // A non-resizable window must not maximize or restore.
  calls.length = 0;
  await runWindowAction("toggle-maximize", async () =>
    makeWindow({ maximized: false, resizable: false }),
  );
  assert.deepEqual(calls, []);

  // Nor must a resizable-but-not-maximizable window.
  calls.length = 0;
  await runWindowAction("toggle-maximize", async () =>
    makeWindow({ maximized: false, maximizable: false }),
  );
  assert.deepEqual(calls, []);

  // Restoring stays available even when maximizing is not.
  calls.length = 0;
  await runWindowAction("toggle-maximize", async () =>
    makeWindow({ maximized: true, maximizable: false }),
  );
  assert.deepEqual(calls, ["unmaximize"]);
});
