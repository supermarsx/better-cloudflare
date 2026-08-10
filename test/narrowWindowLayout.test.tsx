/**
 * Layout contract tests for the 800x600 minimum window.
 *
 * The authenticated shell sets `overflow-x-hidden` app-wide, so any row that
 * overflows horizontally is clipped with no scrollbar rather than merely
 * looking cramped. These tests pin the class contracts that keep long
 * Cloudflare strings (filter expressions, worker patterns, routing addresses,
 * EPP status codes) from pushing sibling controls off-screen.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { BulkEditBar } from "../src/components/dns/BulkEditBar";
import { FirewallPanel } from "../src/components/firewall/FirewallPanel";
import { WorkersPanel } from "../src/components/workers/WorkersPanel";
import { EmailRoutingPanel } from "../src/components/email/EmailRoutingPanel";
import { clampContextMenuPosition } from "../src/components/dns/ZoneTopologyTab";

afterEach(() => {
  cleanup();
});

/** Walks up from `el` looking for the first ancestor carrying `className`. */
function hasAncestorClass(el: Element | null, className: string): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.classList.contains(className)) return true;
    node = node.parentElement;
  }
  return false;
}

test("BulkEditBar wraps instead of pushing destructive actions off-screen", () => {
  render(
    <BulkEditBar
      selectedCount={12}
      onBulkDelete={async () => {}}
      onDeselectAll={() => {}}
      onBulkSetTTL={async () => {}}
      onBulkSetProxy={async () => {}}
      onBulkExport={() => {}}
    />,
  );

  const label = screen.getByText(/12 records selected/);
  // The count label must yield rather than hold the row at its intrinsic width.
  assert.ok(label.classList.contains("min-w-0"));
  assert.ok(label.classList.contains("truncate"));

  const bar = label.parentElement;
  assert.ok(bar, "bulk bar wrapper is present");
  assert.ok(bar.classList.contains("flex-wrap"), "outer bar wraps");

  const deleteButton = screen.getByRole("button", { name: /Delete 12/ });
  const actionRow = deleteButton.parentElement;
  assert.ok(actionRow, "action row is present");
  assert.ok(actionRow.classList.contains("flex-wrap"), "action row wraps");
});

test("FirewallPanel rule row lets a long filter expression truncate", async () => {
  const expression = `(http.request.uri.path contains "${"a".repeat(400)}")`;
  render(
    <FirewallPanel
      zoneId="zone-1"
      getFirewallRules={async () => [
        {
          id: "rule-1",
          action: "block",
          paused: false,
          description: "b".repeat(200),
          filter: { id: "filter-1", expression },
        },
      ]}
      createFirewallRule={async () => ({})}
      deleteFirewallRule={async () => {}}
      getIpAccessRules={async () => []}
      createIpAccessRule={async () => ({})}
      deleteIpAccessRule={async () => {}}
      getWafRulesets={async () => []}
    />,
  );

  const expressionEl = await screen.findByText(expression);
  assert.ok(expressionEl.classList.contains("truncate"));
  // A `truncate` inside a flex child never fires unless the child can shrink.
  const column = expressionEl.parentElement;
  assert.ok(column, "rule text column is present");
  assert.ok(column.classList.contains("min-w-0"), "rule column can shrink");
  assert.ok(column.classList.contains("flex-1"));
});

test("WorkersPanel route row can shrink and truncates pattern and script", async () => {
  const pattern = `${"route".repeat(40)}.example.com/*`;
  render(
    <WorkersPanel
      zoneId="zone-1"
      getWorkerRoutes={async () => [
        { id: "route-1", pattern, script: "s".repeat(120) },
      ]}
      createWorkerRoute={async () => ({})}
      deleteWorkerRoute={async () => {}}
    />,
  );

  const patternEl = await screen.findByText(pattern);
  assert.ok(patternEl.classList.contains("truncate"));
  const column = patternEl.parentElement;
  assert.ok(column, "route text column is present");
  assert.ok(column.classList.contains("min-w-0"));
  assert.ok(column.classList.contains("flex-1"));
});

test("EmailRoutingPanel address list wraps and truncates", async () => {
  const address = `${"forwarding-address".repeat(6)}@example.com`;
  render(
    <EmailRoutingPanel
      zoneId="zone-1"
      getEmailRoutingSettings={async () => ({ enabled: true, status: "ready" })}
      getEmailRoutingRules={async () => [
        {
          id: "rule-1",
          tag: "rule-1",
          name: "Catch all",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: address }],
          actions: [{ type: "forward", value: [address] }],
        },
      ]}
      createEmailRoutingRule={async () => ({})}
      deleteEmailRoutingRule={async () => {}}
    />,
  );

  await waitFor(() => {
    assert.ok(screen.getAllByText(address).length > 0);
  });
  const [matcher] = screen.getAllByText(address);
  assert.ok(matcher.classList.contains("truncate"));
  const addressRow = matcher.parentElement;
  assert.ok(addressRow, "address row is present");
  assert.ok(addressRow.classList.contains("flex-wrap"));
  assert.ok(addressRow.classList.contains("min-w-0"));
  // And the whole rule column must be shrinkable for those to take effect.
  assert.ok(hasAncestorClass(addressRow, "min-w-0"));
});

test("topology context menu is clamped inside the viewport", () => {
  const width = 800;
  const height = 600;

  // Right/bottom edge: the 220px menu would otherwise be clipped away with no
  // scrollbar to reach it.
  const corner = clampContextMenuPosition(795, 595, width, height);
  assert.equal(corner.left, width - 220 - 8);
  assert.equal(corner.top, height - 120 - 8);

  // Top-left edge keeps the existing 8px margin.
  assert.deepEqual(clampContextMenuPosition(-40, -40, width, height), {
    left: 8,
    top: 8,
  });

  // Comfortably interior coordinates are untouched.
  assert.deepEqual(clampContextMenuPosition(100, 120, width, height), {
    left: 100,
    top: 120,
  });

  // A viewport that cannot be measured falls back to the lower bound only.
  assert.deepEqual(clampContextMenuPosition(795, 595, 0, 0), {
    left: 795,
    top: 595,
  });
});
