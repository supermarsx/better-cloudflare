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
import { Toaster } from "../src/components/ui/toaster";
import {
  reducer,
  resetToastRuntimeForTests,
  toast,
  TOAST_LIMIT,
  type ToastState,
  type ToasterToast,
} from "../src/hooks/use-toast";
import {
  createRuntimeDiagnostic,
  resetRuntimeReportingForTests,
} from "../src/lib/errors/runtime-reporting";

afterEach(() => {
  cleanup();
  resetToastRuntimeForTests();
  resetRuntimeReportingForTests();
});

test("toast reducer retains several concurrent notifications", () => {
  let state: ToastState = { toasts: [] };
  for (let index = 0; index < TOAST_LIMIT + 2; index += 1) {
    state = reducer(state, {
      type: "ADD_TOAST",
      toast: {
        id: String(index),
        title: `Toast ${index}`,
        open: true,
      } as ToasterToast,
    });
  }

  assert.equal(state.toasts.length, TOAST_LIMIT);
  assert.deepEqual(
    state.toasts.map((item) => item.id),
    ["5", "4", "3", "2"],
  );
});

test("toasts contain long text and keep full diagnostics in an accessible modal", async () => {
  const longText = "diagnostic".repeat(120);
  toast({
    title: longText,
    description: longText,
  });

  render(<Toaster />);

  const title = screen.getByText(longText, { selector: "[data-toast-title]" });
  const description = screen.getByText(longText, {
    selector: "[data-toast-description]",
  });
  const viewport = document.querySelector("[data-toast-viewport]");

  assert.match(title.className, /overflow-wrap:anywhere/);
  assert.match(description.className, /overflow-wrap:anywhere/);
  assert.match(title.className, /max-w-full/);
  assert.match(description.className, /max-w-full/);
  assert.match(viewport?.className ?? "", /overflow-x-hidden/);
  assert.equal(screen.queryByRole("button", { name: "More info" }), null);

  const diagnostic = createRuntimeDiagnostic(
    new Error("Runtime failed token=secret-value"),
    {
      source: "unhandled-rejection",
      label: "test",
    },
  );
  act(() => {
    toast({
      title: "Contained failure",
      description: diagnostic.message,
      variant: "destructive",
      diagnostic,
      persistent: true,
    });
  });

  assert.ok(screen.getByText("Contained failure"));
  assert.ok(screen.getByRole("button", { name: "More info" }));
  assert.equal(screen.queryByText(/Stack:/), null);
  assert.equal(screen.queryByTestId("toast-diagnostic-dialog"), null);
  assert.equal(
    document
      .querySelector("[data-persistent-diagnostic='true']")
      ?.getAttribute("data-persistent-diagnostic"),
    "true",
  );
  assert.doesNotMatch(document.body.textContent ?? "", /secret-value/);
  assert.match(document.body.textContent ?? "", /\[redacted\]/);

  fireEvent.click(screen.getByRole("button", { name: "More info" }));

  const dialog = screen.getByRole("dialog", { name: "Error details" });
  assert.ok(dialog);
  assert.match(dialog.textContent ?? "", /Diagnostic ID:/);
  assert.match(dialog.textContent ?? "", /Time:/);
  assert.match(dialog.textContent ?? "", /Source:/);
  assert.match(dialog.textContent ?? "", /Area:/);
  assert.match(dialog.textContent ?? "", /Error:/);
  assert.match(dialog.textContent ?? "", /Message:/);
  assert.match(dialog.textContent ?? "", /Stack:/);
  assert.doesNotMatch(dialog.textContent ?? "", /secret-value/);

  const writeTextCalls: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writeTextCalls.push(value);
      },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
  await waitFor(() => {
    assert.equal(
      screen.getByRole("button", { name: "Copied" }).textContent,
      "Copied",
    );
  });
  assert.equal(writeTextCalls.length, 1);
  assert.match(writeTextCalls[0] ?? "", /Diagnostic ID:/);
  assert.doesNotMatch(writeTextCalls[0] ?? "", /secret-value/);

  fireEvent.click(screen.getByRole("button", { name: "Close error details" }));
  assert.equal(screen.queryByTestId("toast-diagnostic-dialog"), null);
  assert.equal(
    screen
      .getByRole("button", { name: "More info" })
      .getAttribute("aria-expanded"),
    "false",
  );
});
