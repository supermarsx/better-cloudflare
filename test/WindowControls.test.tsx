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
