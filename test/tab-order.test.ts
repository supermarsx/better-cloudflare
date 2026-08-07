import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeTabMove,
  moveItemBy,
  moveItemRelativeTo,
  moveItemToIndex,
  reconcileTabOrder,
} from "../src/lib/tabs/tab-order";

const tabs = () => [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id);

test("moveItemBy shifts one slot in each direction", () => {
  assert.deepEqual(ids(moveItemBy(tabs(), "b", 1)), ["a", "c", "b", "d"]);
  assert.deepEqual(ids(moveItemBy(tabs(), "c", -1)), ["a", "c", "b", "d"]);
});

test("moveItemBy clamps at the ends instead of wrapping", () => {
  assert.deepEqual(ids(moveItemBy(tabs(), "a", -1)), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(moveItemBy(tabs(), "d", 1)), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(moveItemBy(tabs(), "a", 0)), ["a", "b", "c", "d"]);
});

test("moveItemBy ignores unknown ids", () => {
  assert.deepEqual(ids(moveItemBy(tabs(), "zzz", 1)), ["a", "b", "c", "d"]);
});

test("moveItemToIndex clamps out-of-range targets", () => {
  assert.deepEqual(ids(moveItemToIndex(tabs(), "d", 0)), ["d", "a", "b", "c"]);
  assert.deepEqual(ids(moveItemToIndex(tabs(), "a", 99)), ["b", "c", "d", "a"]);
  assert.deepEqual(ids(moveItemToIndex(tabs(), "a", -5)), ["a", "b", "c", "d"]);
});

test("moveItemRelativeTo drops before and after the anchor", () => {
  assert.deepEqual(ids(moveItemRelativeTo(tabs(), "a", "c", "before")), [
    "b",
    "a",
    "c",
    "d",
  ]);
  assert.deepEqual(ids(moveItemRelativeTo(tabs(), "a", "c", "after")), [
    "b",
    "c",
    "a",
    "d",
  ]);
  assert.deepEqual(ids(moveItemRelativeTo(tabs(), "d", "b", "before")), [
    "a",
    "d",
    "b",
    "c",
  ]);
});

test("moveItemRelativeTo is a no-op for self or unknown anchors", () => {
  assert.deepEqual(ids(moveItemRelativeTo(tabs(), "a", "a", "before")), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual(ids(moveItemRelativeTo(tabs(), "a", "zzz", "after")), [
    "a",
    "b",
    "c",
    "d",
  ]);
});

test("reconcileTabOrder applies a persisted order", () => {
  assert.deepEqual(ids(reconcileTabOrder(tabs(), ["d", "c", "b", "a"])), [
    "d",
    "c",
    "b",
    "a",
  ]);
});

test("reconcileTabOrder tolerates preferences that predate the feature", () => {
  // No persisted order at all: keep the current order rather than blanking or
  // randomizing the tab strip.
  assert.deepEqual(ids(reconcileTabOrder(tabs(), undefined)), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual(ids(reconcileTabOrder(tabs(), null)), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(reconcileTabOrder(tabs(), [])), ["a", "b", "c", "d"]);
});

test("reconcileTabOrder ignores stale ids and appends unknown tabs", () => {
  assert.deepEqual(ids(reconcileTabOrder(tabs(), ["c", "gone", "a"])), [
    "c",
    "a",
    "b",
    "d",
  ]);
  assert.deepEqual(ids(reconcileTabOrder(tabs(), ["b", "b", "b"])), [
    "b",
    "a",
    "c",
    "d",
  ]);
});

test("reconcileTabOrder never drops or duplicates a tab", () => {
  const result = reconcileTabOrder(tabs(), ["d", "gone", "d", "a"]);
  assert.equal(result.length, 4);
  assert.equal(new Set(ids(result)).size, 4);
});

test("describeTabMove announces a one-based position", () => {
  assert.equal(
    describeTabMove("example.com", 0, 3),
    "example.com moved to position 1 of 3",
  );
});
