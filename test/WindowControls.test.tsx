import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { WindowControls } from "../src/components/layout/WindowControls";
import { useToast } from "../src/hooks/use-toast";

afterEach(() => {
  cleanup();
});

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
