/**
 * Tests for AnalyticsPanel, PropagationChecker, ZoneCompare, BulkEditBar
 * component interfaces and i18n integration.
 *
 * These are lightweight structure/contract tests that verify component
 * exports and prop interfaces without fully rendering (which would need
 * mocked API functions).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// Verify all panel components export correctly
test("AnalyticsPanel exports a named component", async () => {
  const mod = await import("../src/components/dns/AnalyticsPanel");
  assert.equal(typeof mod.AnalyticsPanel, "function");
});

test("FirewallPanel exports a named component", async () => {
  const mod = await import("../src/components/dns/FirewallPanel");
  assert.equal(typeof mod.FirewallPanel, "function");
});

test("WorkersPanel exports a named component", async () => {
  const mod = await import("../src/components/dns/WorkersPanel");
  assert.equal(typeof mod.WorkersPanel, "function");
});

test("EmailRoutingPanel exports a named component", async () => {
  const mod = await import("../src/components/dns/EmailRoutingPanel");
  assert.equal(typeof mod.EmailRoutingPanel, "function");
});

test("PropagationChecker exports a named component", async () => {
  const mod = await import("../src/components/dns/PropagationChecker");
  assert.equal(typeof mod.PropagationChecker, "function");
});

test("ZoneCompare exports a named component", async () => {
  const mod = await import("../src/components/dns/ZoneCompare");
  assert.equal(typeof mod.ZoneCompare, "function");
});

test("BulkEditBar exports a named component", async () => {
  const mod = await import("../src/components/dns/BulkEditBar");
  assert.equal(typeof mod.BulkEditBar, "function");
});

test("HotkeyHelpDialog exports a named component", async () => {
  const mod = await import("../src/components/dns/HotkeyHelpDialog");
  assert.equal(typeof mod.HotkeyHelpDialog, "function");
});

// Verify useUndoRedo hook export
test("useUndoRedo hook exports correctly", async () => {
  const mod = await import("../src/hooks/use-undo-redo");
  assert.equal(typeof mod.useUndoRedo, "function");
});

// Verify offline-cache exports  
test("offline-cache module exports all functions", async () => {
  const mod = await import("../src/lib/storage/offline-cache");
  assert.equal(typeof mod.cacheZoneRecords, "function");
  assert.equal(typeof mod.getCachedZoneRecords, "function");
  assert.equal(typeof mod.hasCachedRecords, "function");
  assert.equal(typeof mod.removeCachedZone, "function");
  assert.equal(typeof mod.getCacheIndex, "function");
});
