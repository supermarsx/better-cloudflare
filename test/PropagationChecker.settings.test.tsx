import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { PropagationChecker } from "../src/components/dns/PropagationChecker";
import {
  DEFAULT_PROPAGATION_RESOLVER_IDS,
  PROPAGATION_RESOLVER_CATALOGUE,
  PROPAGATION_SETTING_LIMITS,
} from "../src/lib/dns/propagation-resolvers";
import { storageManager } from "../src/lib/storage/storage";

beforeEach(() => {
  storageManager.resetPropagationSettings();
});

afterEach(() => {
  cleanup();
  storageManager.resetPropagationSettings();
});

function renderWithPanelOpen() {
  const view = render(
    <PropagationChecker
      zoneName="example.com"
      checkDnsPropagation={async () => ({ results: [], consistent: false })}
    />,
  );
  fireEvent.click(screen.getByTestId("propagation-settings-toggle"));
  return view;
}

function optionCheckbox(id: string): HTMLInputElement {
  return screen.getByTestId(
    `propagation-resolver-option-${id}`,
  ) as HTMLInputElement;
}

test("renders the catalogue with the default selection and a summary", () => {
  render(
    <PropagationChecker
      zoneName="example.com"
      checkDnsPropagation={async () => undefined}
    />,
  );
  const toggle = screen.getByTestId("propagation-settings-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByTestId("propagation-settings-body"), null);
  assert.match(
    screen.getByTestId("propagation-settings-summary").textContent ?? "",
    /12 of 23 catalogue entries enabled · 0 custom · 3000 ms · 1× · 100% consensus/,
  );

  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByTestId("propagation-settings-body"));

  for (const entry of PROPAGATION_RESOLVER_CATALOGUE) {
    assert.equal(
      optionCheckbox(entry.id).checked,
      entry.defaultEnabled,
      `${entry.id} default state`,
    );
  }
  assert.equal(
    screen.getAllByRole("checkbox").length,
    PROPAGATION_RESOLVER_CATALOGUE.length,
  );
});

test("toggling a resolver persists through the settings hook", () => {
  renderWithPanelOpen();

  fireEvent.click(optionCheckbox("1.1.1.1"));
  assert.equal(optionCheckbox("1.1.1.1").checked, false);
  assert.ok(!storageManager.getPropagationResolvers().includes("1.1.1.1"));

  fireEvent.click(optionCheckbox("45.90.28.0"));
  assert.equal(optionCheckbox("45.90.28.0").checked, true);
  assert.ok(storageManager.getPropagationResolvers().includes("45.90.28.0"));
  assert.match(
    screen.getByTestId("propagation-settings-summary").textContent ?? "",
    /12 of 23/,
  );
});

test("quick actions select all, none, and restore the defaults", () => {
  renderWithPanelOpen();

  fireEvent.click(screen.getByRole("button", { name: "None" }));
  assert.deepEqual(storageManager.getPropagationResolvers(), []);
  assert.ok(screen.getByTestId("propagation-no-resolvers"));
  assert.equal(
    (screen.getByRole("button", { name: "Check" }) as HTMLButtonElement)
      .disabled,
    true,
  );

  fireEvent.click(screen.getByRole("button", { name: "All" }));
  assert.equal(
    storageManager.getPropagationResolvers().length,
    PROPAGATION_RESOLVER_CATALOGUE.length,
  );
  assert.equal(screen.queryByTestId("propagation-no-resolvers"), null);

  storageManager.setPropagationConsensusPercent(50);
  fireEvent.click(screen.getByRole("button", { name: "Defaults" }));
  assert.deepEqual(storageManager.getPropagationResolvers(), [
    ...DEFAULT_PROPAGATION_RESOLVER_IDS,
  ]);
  assert.equal(storageManager.getPropagationConsensusPercent(), 100);
});

test("custom resolvers are validated, deduplicated, listed and removable", () => {
  renderWithPanelOpen();
  const input = screen.getByTestId(
    "propagation-custom-resolver-input",
  ) as HTMLInputElement;
  const add = () =>
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", charCode: 13 });

  fireEvent.change(input, { target: { value: "not-an-ip" } });
  add();
  assert.match(
    screen.getByTestId("propagation-custom-resolver-error").textContent ?? "",
    /bare IPv4 or IPv6 address/,
  );
  assert.deepEqual(storageManager.getPropagationCustomResolvers(), []);

  fireEvent.change(input, { target: { value: "8.8.8.8" } });
  add();
  assert.match(
    screen.getByTestId("propagation-custom-resolver-error").textContent ?? "",
    /already in the catalogue/,
  );

  fireEvent.change(input, { target: { value: " 203.0.113.53 " } });
  add();
  assert.equal(screen.queryByTestId("propagation-custom-resolver-error"), null);
  assert.deepEqual(storageManager.getPropagationCustomResolvers(), [
    "203.0.113.53",
  ]);
  assert.equal(input.value, "");

  fireEvent.change(input, { target: { value: "203.0.113.53" } });
  add();
  assert.match(
    screen.getByTestId("propagation-custom-resolver-error").textContent ?? "",
    /already listed/,
  );

  fireEvent.change(input, { target: { value: "2001:db8::53" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  assert.equal(
    screen.getAllByTestId("propagation-custom-resolver-chip").length,
    2,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Remove custom resolver 203.0.113.53" }),
  );
  assert.deepEqual(storageManager.getPropagationCustomResolvers(), [
    "2001:db8::53",
  ]);
  assert.equal(
    screen.getAllByTestId("propagation-custom-resolver-chip").length,
    1,
  );
});

test("timeout, attempts and consensus controls clamp and persist", () => {
  renderWithPanelOpen();
  const timeout = screen.getByTestId(
    "propagation-timeout-input",
  ) as HTMLInputElement;

  fireEvent.change(timeout, { target: { value: "99999" } });
  fireEvent.blur(timeout);
  assert.equal(
    storageManager.getPropagationTimeoutMs(),
    PROPAGATION_SETTING_LIMITS.timeoutMs.max,
  );
  assert.equal(timeout.value, String(PROPAGATION_SETTING_LIMITS.timeoutMs.max));

  fireEvent.change(timeout, { target: { value: "abc" } });
  fireEvent.blur(timeout);
  assert.equal(timeout.value, String(PROPAGATION_SETTING_LIMITS.timeoutMs.max));

  fireEvent.click(screen.getByTestId("propagation-attempts-3"));
  assert.equal(storageManager.getPropagationAttempts(), 3);
  assert.equal(
    screen.getByTestId("propagation-attempts-3").getAttribute("aria-pressed"),
    "true",
  );

  fireEvent.click(screen.getByTestId("propagation-consensus-75"));
  assert.equal(storageManager.getPropagationConsensusPercent(), 75);
  assert.match(
    screen.getByTestId("propagation-settings-summary").textContent ?? "",
    /15000 ms · 3× · 75% consensus/,
  );
});

test("reflects settings changed elsewhere via preferences-changed", () => {
  renderWithPanelOpen();
  act(() => {
    storageManager.setPropagationResolvers(["9.9.9.9"]);
    window.dispatchEvent(
      new window.CustomEvent("preferences-changed", {
        detail: { propagationResolvers: ["9.9.9.9"] },
      }),
    );
  });
  assert.equal(optionCheckbox("9.9.9.9").checked, true);
  assert.equal(optionCheckbox("1.1.1.1").checked, false);
  assert.match(
    screen.getByTestId("propagation-settings-summary").textContent ?? "",
    /1 of 23/,
  );
});
