import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TABLE_COLUMN_GROUPS,
  buildGridTemplateColumns,
  canHideTableColumn,
  getDefaultTableColumns,
  getRequiredTableColumns,
  getTableColumnGroup,
  normalizeTableColumnMap,
  resolveTableColumns,
  toggleTableColumn,
} from "../src/lib/tables/table-columns";

test("the DNS records default layout shows comment and hides actions", () => {
  const defaults = getDefaultTableColumns("dnsRecords");
  assert.ok(defaults.includes("comment"));
  assert.ok(!defaults.includes("actions"));
  assert.deepEqual(defaults, [
    "select",
    "type",
    "name",
    "content",
    "comment",
    "ttl",
    "proxied",
  ]);
});

test("preferences saved before this feature hydrate to defaults, not an empty table", () => {
  for (const group of TABLE_COLUMN_GROUPS) {
    assert.deepEqual(
      resolveTableColumns(group.id, undefined),
      getDefaultTableColumns(group.id),
      `${group.id} must fall back to defaults for undefined`,
    );
    assert.deepEqual(
      resolveTableColumns(group.id, null),
      getDefaultTableColumns(group.id),
      `${group.id} must fall back to defaults for null`,
    );
  }

  // A whole legacy preference blob with no table entries at all.
  const hydrated = normalizeTableColumnMap(undefined);
  for (const group of TABLE_COLUMN_GROUPS) {
    assert.deepEqual(hydrated[group.id], getDefaultTableColumns(group.id));
  }
});

test("an empty or unrecognized stored list can never blank the table", () => {
  assert.deepEqual(
    resolveTableColumns("dnsRecords", []),
    getDefaultTableColumns("dnsRecords"),
  );
  assert.deepEqual(
    resolveTableColumns("dnsRecords", ["nope", "gone"]),
    getDefaultTableColumns("dnsRecords"),
  );
  assert.deepEqual(resolveTableColumns("unknownTable", ["a"]), []);
});

test("required columns survive a stored list that omits them", () => {
  const resolved = resolveTableColumns("dnsRecords", ["ttl"]);
  for (const required of getRequiredTableColumns("dnsRecords")) {
    assert.ok(resolved.includes(required), `${required} must stay visible`);
  }
  assert.ok(resolved.includes("ttl"));
});

test("stored order is normalized to the canonical column order and deduplicated", () => {
  assert.deepEqual(
    resolveTableColumns("dnsRecords", [
      "proxied",
      "name",
      "type",
      "name",
      "content",
    ]),
    ["type", "name", "content", "proxied"],
  );
});

test("required columns cannot be hidden", () => {
  const visible = getDefaultTableColumns("dnsRecords");
  assert.equal(canHideTableColumn("dnsRecords", visible, "name"), false);
  assert.deepEqual(
    toggleTableColumn("dnsRecords", visible, "name", false),
    visible,
  );
});

test("the last remaining column cannot be hidden", () => {
  // Drive the table down to only its required columns, then to one column.
  let visible = resolveTableColumns("dnsRecords", ["type"]);
  assert.deepEqual(visible, ["type", "name", "content"]);

  // Required columns keep three visible here, so assert the guard on a table
  // reduced to a single optional column instead.
  const single = ["ttl"];
  assert.equal(canHideTableColumn("dnsRecords", single, "ttl"), false);
  assert.deepEqual(toggleTableColumn("dnsRecords", single, "ttl", false), [
    "ttl",
  ]);

  visible = toggleTableColumn("dnsRecords", visible, "ttl", true);
  assert.ok(visible.includes("ttl"));
  assert.equal(canHideTableColumn("dnsRecords", visible, "ttl"), true);
});

test("toggling a column on and off round-trips", () => {
  const start = getDefaultTableColumns("dnsRecords");
  const withActions = toggleTableColumn("dnsRecords", start, "actions", true);
  assert.ok(withActions.includes("actions"));
  // Canonical order places actions last.
  assert.equal(withActions[withActions.length - 1], "actions");

  const withoutComment = toggleTableColumn(
    "dnsRecords",
    withActions,
    "comment",
    false,
  );
  assert.ok(!withoutComment.includes("comment"));
  assert.ok(withoutComment.includes("actions"));
});

test("toggling an unknown column or table is inert", () => {
  const start = getDefaultTableColumns("dnsRecords");
  assert.deepEqual(
    toggleTableColumn("dnsRecords", start, "bogus", true),
    start,
  );
  assert.deepEqual(toggleTableColumn("nope", start, "type", false), start);
});

test("every registered table has defaults that satisfy its own rules", () => {
  for (const group of TABLE_COLUMN_GROUPS) {
    const defaults = getDefaultTableColumns(group.id);
    assert.ok(defaults.length > 0, `${group.id} needs at least one default`);
    for (const required of getRequiredTableColumns(group.id)) {
      assert.ok(
        defaults.includes(required),
        `${group.id} default set must include required ${required}`,
      );
    }
    for (const id of defaults) {
      assert.ok(
        group.columns.some((column) => column.id === id),
        `${group.id} default ${id} must be a declared column`,
      );
    }
  }
});

test("grid templates track the visible subset", () => {
  const all = buildGridTemplateColumns(
    "dnsRecords",
    getDefaultTableColumns("dnsRecords"),
  );
  assert.equal(all.split(" ").length >= 7, true);

  const narrow = buildGridTemplateColumns("dnsRecords", ["type", "name"]);
  assert.equal(narrow, "56px minmax(140px, 1.4fr)");
  assert.equal(buildGridTemplateColumns("unknownTable", ["a"]), "");
});

test("zone compare and audit log are registered with pickers", () => {
  assert.ok(getTableColumnGroup("zoneCompare"));
  assert.ok(getTableColumnGroup("auditLog"));
  assert.equal(getTableColumnGroup("nope"), undefined);
});
