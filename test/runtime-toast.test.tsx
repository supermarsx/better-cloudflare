import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Toaster } from "../src/components/ui/toaster";
import {
  reducer,
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

test("destructive runtime diagnostics are durable and expandable", () => {
  const diagnostic = createRuntimeDiagnostic(
    new Error("Runtime failed token=secret-value"),
    {
      source: "unhandled-rejection",
      label: "test",
    },
  );
  toast({
    title: "Contained failure",
    description: diagnostic.message,
    variant: "destructive",
    diagnostic,
    persistent: true,
  });

  render(<Toaster />);

  assert.ok(screen.getByText("Contained failure"));
  assert.ok(screen.getByText(/Technical details/));
  assert.equal(
    document
      .querySelector("[data-persistent-diagnostic='true']")
      ?.getAttribute("data-persistent-diagnostic"),
    "true",
  );
  assert.doesNotMatch(document.body.textContent ?? "", /secret-value/);
  assert.match(document.body.textContent ?? "", /\[redacted\]/);
});
