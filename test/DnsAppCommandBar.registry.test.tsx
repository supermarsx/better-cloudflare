/**
 * The Registry Monitoring action, under the registry feature switch.
 *
 * The chrome is the last way into the Registry workspace, and that workspace
 * starts asking its registrars for domains the moment it mounts. So the switch
 * has to remove the button, not grey it out — and "absent" is the thing worth
 * pinning, because a disabled-looking control still tells the user the feature
 * is there.
 *
 * Absence is `assert.ok(node === null, …)`, never `assert.equal(node, null)`:
 * the latter deep-inspects a jsdom element on failure and can take the worker,
 * and the rest of the batch, with it.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DnsAppCommandBar } from "../src/components/dns/DnsAppCommandBar";

import { useEnglishLocale } from "./i18n-ready";

// Every action in this bar is an icon button whose accessible name comes from
// `t()` through a tooltip, so without i18n up the names resolve empty and a
// `name:` query finds nothing — which would make the absence assertion below
// pass for the wrong reason.
beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => cleanup());

function renderBar(
  overrides: Partial<React.ComponentProps<typeof DnsAppCommandBar>> = {},
) {
  const opened: string[] = [];
  render(
    <DnsAppCommandBar
      accountLabel="admin@example.test"
      sessionLabel="Active session"
      showAudit
      onOpenAudit={() => opened.push("audit")}
      onOpenRegistry={() => opened.push("registry")}
      onOpenSettings={() => opened.push("settings")}
      onOpenTags={() => opened.push("tags")}
      onLogout={() => opened.push("logout")}
      {...overrides}
    />,
  );
  return opened;
}

test("absent means on: the Registry action is offered and opens the workspace", () => {
  const opened = renderBar();
  const action = screen.getByRole("button", { name: "Registry Monitoring" });
  fireEvent.click(action);
  assert.deepEqual(opened, ["registry"]);
});

test("showRegistry false removes the action rather than disabling it", () => {
  renderBar({ showRegistry: false });
  assert.ok(
    screen.queryByRole("button", { name: "Registry Monitoring" }) === null,
    "the way into the Registry workspace must be gone, not greyed out",
  );
  // The rest of the chrome is untouched: this switch removes one action, not
  // the toolbar.
  assert.ok(screen.getByRole("button", { name: "Audit log" }));
  assert.ok(screen.getByRole("button", { name: "Settings" }));
  assert.ok(screen.getByRole("button", { name: "Tags" }));
});
