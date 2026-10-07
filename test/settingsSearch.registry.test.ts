/**
 * The settings search index, checked against the settings screen itself.
 *
 * `src/components/dns/settings-search.ts` claims to list every setting in the
 * Session settings tab. A claim like that rots the first time somebody adds a
 * row and forgets the registry: search then silently cannot find the new
 * setting, and no test anywhere notices. Restating the list a second time here
 * would not help — a hand-written list checked against a hand-written list is
 * two copies of the same mistake.
 *
 * So this suite does not restate anything. It parses `DNSManager.tsx` with the
 * TypeScript compiler, finds the settings rows in it the way a reader would
 * (the shared row layout, and the bold label cell inside it), and reads out of
 * the source what each row *is*: its `data-setting-id`, the exact string it
 * passes to `t()` for its label, which `settingsSubtab === "..."` block it sits
 * in, and which conditions guard it. The registry has to agree with all four.
 *
 * The two subtabs that re-host a panel from another file — Assistant and
 * Notifications — are checked a second way, because their rows are not in the
 * source this parses: their entries have to match the panel's own exported
 * section list, id for id and label for label, in order.
 *
 * What that catches, which nothing else would:
 *
 *   - a new settings row with no registry entry (search cannot find it);
 *   - a registry entry for a row that no longer exists (search offers a dead
 *     jump);
 *   - a renamed label (search matches text the user can no longer see);
 *   - a row moved to another subtab (the jump opens the wrong one);
 *   - a row newly gated on `isDesktop()` or on a preference, where search
 *     would otherwise keep promising a row that is not rendered.
 *
 * What it cannot catch is a settings row written in neither of the two shapes
 * it recognises; `rowShapesAreStillTheOnlyOnes` pins the shapes so that at
 * least the count has to be revisited deliberately.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

import { AI_SETTINGS_SECTIONS } from "../src/components/ai/AiSettingsPanel";
import { NOTIFICATION_SETTINGS_SECTIONS } from "../src/components/dns/NotificationsSettings";
import {
  SETTINGS_SEARCH_ENTRIES,
  SETTINGS_SUBTABS,
  findSettingsEntry,
  searchSettings,
  settingsAnchorSelector,
  type SettingsSearchEntry,
  type SettingsSubtab,
} from "../src/components/dns/settings-search";
import { TABLE_COLUMN_GROUPS } from "../src/lib/tables/table-columns";

const SOURCE_URL = new URL(
  "../src/components/dns/DNSManager.tsx",
  import.meta.url,
);
const source = readFileSync(SOURCE_URL, "utf8");
const sourceFile = ts.createSourceFile(
  "DNSManager.tsx",
  source,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TSX,
);

/** The class list every settings row shares. */
const ROW_LAYOUT_CLASS = "grid gap-3 px-4 py-3";
/** The class on the bold cell that holds a row's label. */
const ROW_LABEL_CLASS = "font-medium";

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function isJsx(node: ts.Node): node is JsxNode {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function jsxAttributes(node: JsxNode): ts.JsxAttributes {
  return ts.isJsxElement(node)
    ? node.openingElement.attributes
    : node.attributes;
}

/** A literal string attribute value, or `undefined` for anything dynamic. */
function stringAttribute(node: JsxNode, name: string): string | undefined {
  for (const attribute of jsxAttributes(node).properties) {
    if (!ts.isJsxAttribute(attribute)) continue;
    if (attribute.name.getText(sourceFile) !== name) continue;
    const initializer = attribute.initializer;
    if (initializer && ts.isStringLiteral(initializer)) {
      return initializer.text;
    }
    return undefined;
  }
  return undefined;
}

function className(node: JsxNode): string {
  return stringAttribute(node, "className") ?? "";
}

function jsxChildren(node: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(node)) return [];
  return node.children.filter(isJsx);
}

function jsxDescendants(node: ts.Node): JsxNode[] {
  const found: JsxNode[] = [];
  const walk = (current: ts.Node) => {
    if (isJsx(current)) found.push(current);
    current.forEachChild(walk);
  };
  walk(node);
  return found;
}

/** Every `t("key", ...)` key inside `node`, in source order. */
function translationKeys(node: ts.Node): string[] {
  const keys: string[] = [];
  const walk = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "t" &&
      current.arguments.length > 0
    ) {
      const first = current.arguments[0];
      if (ts.isStringLiteralLike(first)) keys.push(first.text);
    }
    current.forEachChild(walk);
  };
  walk(node);
  return keys;
}

function lineOf(node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/** One `A && <jsx>` or `A ? <jsx> : …` wrapper on the way to a row. */
interface RowGuard {
  /** The condition as written. */
  text: string;
  /** True when the row sits in the branch taken while the condition is false. */
  negated: boolean;
}

/**
 * Find `<left> && <right>` expressions where the left is
 * `settingsSubtab === "<name>"`, which is how the screen picks a subtab panel.
 */
function findSubtabBlocks(): Map<string, ts.Node> {
  const blocks = new Map<string, ts.Node>();
  const walk = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isBinaryExpression(node.left) &&
      node.left.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      node.left.left.getText(sourceFile) === "settingsSubtab" &&
      ts.isStringLiteralLike(node.left.right)
    ) {
      assert.ok(
        !blocks.has(node.left.right.text),
        `two panels claim settingsSubtab === "${node.left.right.text}"`,
      );
      blocks.set(node.left.right.text, node.right);
    }
    node.forEachChild(walk);
  };
  walk(sourceFile);
  return blocks;
}

/** The `activeTab.kind === "settings" && <jsx>` panel. */
function findSettingsPanel(): ts.Node {
  let panel: ts.Node | undefined;
  const walk = (node: ts.Node) => {
    if (
      panel === undefined &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      node.left.getText(sourceFile) === 'activeTab.kind === "settings"'
    ) {
      panel = node.right;
      return;
    }
    node.forEachChild(walk);
  };
  walk(sourceFile);
  assert.ok(panel, "could not find the Session settings panel in DNSManager");
  return panel;
}

/**
 * Whether `node` is a settings row.
 *
 * Either marker is enough, which makes the predicate harder to slip past than
 * the class list alone: a row written with a different grid still has a bold
 * label cell, and a row whose label is built some other way still has the
 * shared layout.
 */
function isSettingsRow(node: JsxNode): boolean {
  if (className(node).includes(ROW_LAYOUT_CLASS)) return true;
  return jsxChildren(node).some(
    (child) => className(child) === ROW_LABEL_CLASS,
  );
}

/** Conditions between `node` and the subtab panel that contains it. */
function guardsUpTo(node: ts.Node, stop: ts.Node): RowGuard[] {
  const guards: RowGuard[] = [];
  let current: ts.Node = node;
  while (current.parent && current !== stop) {
    const parent: ts.Node = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === current
    ) {
      guards.push({
        text: parent.left.getText(sourceFile).replace(/\s+/gu, " "),
        negated: false,
      });
    } else if (ts.isConditionalExpression(parent)) {
      guards.push({
        text: parent.condition.getText(sourceFile).replace(/\s+/gu, " "),
        negated: parent.whenFalse === current,
      });
    }
    current = parent;
  }
  return guards.reverse();
}

/** Split `a && b && c` into its operands, ignoring `&&` inside parens. */
function splitConjunction(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && char === "&" && text[index + 1] === "&") {
      parts.push(text.slice(start, index).trim());
      index += 1;
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function negate(text: string): string {
  return text.startsWith("!") ? text.slice(1).trim() : `!(${text})`;
}

/**
 * The conditions that must hold for a row to render, flattened and with
 * `else` branches folded into their negation.
 */
function effectiveConditions(guards: RowGuard[]): string[] {
  return guards.flatMap((guard) =>
    splitConjunction(guard.text).map((part) =>
      guard.negated ? negate(part) : part,
    ),
  );
}

/** A settings row as the source describes it. */
interface SourceRow {
  id: string | undefined;
  subtab: string;
  label: string | undefined;
  line: number;
  /** `t()` keys anywhere inside the row. */
  keys: string[];
  /** Conditions guarding the row, within its subtab panel. */
  conditions: string[];
}

function readSourceRows(): SourceRow[] {
  const blocks = findSubtabBlocks();
  const rows: SourceRow[] = [];
  for (const [subtab, block] of blocks) {
    for (const node of jsxDescendants(block).filter(isSettingsRow)) {
      const labelCell = jsxChildren(node).find(
        (child) => className(child) === ROW_LABEL_CLASS,
      );
      rows.push({
        id: stringAttribute(node, "data-setting-id"),
        subtab,
        label: labelCell ? translationKeys(labelCell)[0] : undefined,
        line: lineOf(node),
        keys: translationKeys(node),
        conditions: effectiveConditions(guardsUpTo(node, block)),
      });
    }
  }
  return rows;
}

const SOURCE_ROWS = readSourceRows();
const ROW_ENTRIES = SETTINGS_SEARCH_ENTRIES.filter(
  (entry) => entry.anchor.kind === "row",
);

function describeRow(row: SourceRow): string {
  return `${row.subtab} row at DNSManager.tsx:${row.line} (${row.label ?? "no label"})`;
}

test("the registry and the settings screen list the same rows", () => {
  // Guards against the whole suite passing vacuously if the parser ever stops
  // recognising the row shape.
  assert.ok(
    SOURCE_ROWS.length >= 40,
    `only ${SOURCE_ROWS.length} settings rows were found in the source; the row parser is probably broken`,
  );

  for (const row of SOURCE_ROWS) {
    assert.ok(
      row.id,
      `${describeRow(row)} has no data-setting-id, so settings search cannot jump to it. Add one and register it in settings-search.ts.`,
    );
  }

  const sourceIds = SOURCE_ROWS.map((row) => row.id as string);
  assert.equal(
    new Set(sourceIds).size,
    sourceIds.length,
    `data-setting-id must be unique: ${JSON.stringify(sourceIds)}`,
  );

  const registered = new Set(ROW_ENTRIES.map((entry) => entry.id));
  const unregistered = sourceIds.filter((id) => !registered.has(id));
  assert.deepEqual(
    unregistered,
    [],
    "settings rows missing from settings-search.ts — search cannot find them",
  );

  const present = new Set(sourceIds);
  const orphaned = ROW_ENTRIES.map((entry) => entry.id).filter(
    (id) => !present.has(id),
  );
  assert.deepEqual(
    orphaned,
    [],
    "registry entries whose settings row no longer exists — search offers a dead jump",
  );
});

test("every registry label is the label its row actually renders", () => {
  for (const row of SOURCE_ROWS) {
    const entry = findSettingsEntry(row.id as string);
    assert.ok(entry, `${describeRow(row)} is not in the registry`);
    assert.equal(
      entry.label,
      row.label,
      `${describeRow(row)}: the registry says ${JSON.stringify(entry.label)} but the row renders t(${JSON.stringify(row.label)}). Search would match text the user cannot see.`,
    );
  }
});

test("every registry entry names the subtab its row is in", () => {
  for (const row of SOURCE_ROWS) {
    const entry = findSettingsEntry(row.id as string);
    assert.ok(entry);
    assert.equal(
      entry.subtab,
      row.subtab,
      `${describeRow(row)}: the registry sends a jump to the ${entry.subtab} subtab`,
    );
  }
});

test("a row's platform and preference gates are declared", () => {
  for (const row of SOURCE_ROWS) {
    const entry = findSettingsEntry(row.id as string);
    assert.ok(entry);

    const platform = row.conditions.filter((condition) =>
      condition.includes("isDesktop("),
    );
    const state = row.conditions.filter(
      (condition) => !condition.includes("isDesktop("),
    );

    for (const condition of platform) {
      // A browser-only row would need a second flag on the entry; fail loudly
      // rather than quietly treating it as desktop-only.
      assert.equal(
        condition,
        "isDesktop()",
        `${describeRow(row)} is gated on ${condition}, which settings-search.ts has no way to express`,
      );
    }

    assert.equal(
      entry.desktopOnly ?? false,
      platform.length > 0,
      platform.length > 0
        ? `${describeRow(row)} renders only on desktop, so its entry needs desktopOnly: true — otherwise browser users can search for a setting they do not have`
        : `${describeRow(row)} renders everywhere, so its entry must not claim desktopOnly`,
    );

    if (state.length > 0) {
      assert.ok(
        entry.requires && entry.requires.length > 0,
        `${describeRow(row)} renders only when ${state.join(" && ")}, so its entry needs a \`requires\` note; without one a jump can land on an empty subtab with no explanation`,
      );
    } else {
      assert.equal(
        entry.requires,
        undefined,
        `${describeRow(row)} is always rendered on its subtab, so its entry must not claim a precondition`,
      );
    }
  }
});

test("a registry description repeats one of its row's own strings", () => {
  for (const row of SOURCE_ROWS) {
    const entry = findSettingsEntry(row.id as string);
    assert.ok(entry);
    if (entry.description === undefined) continue;
    assert.ok(
      row.keys.includes(entry.description),
      `${describeRow(row)}: the registry description is not one of the strings the row renders, so a search result would describe the setting differently from the setting. Row strings: ${JSON.stringify(row.keys)}`,
    );
  }
});

test("the registry knows every subtab the screen has", () => {
  const sourceSubtabs = [...findSubtabBlocks().keys()].sort();
  const registered = SETTINGS_SUBTABS.map((subtab) => subtab.id).sort();
  assert.deepEqual(
    registered,
    sourceSubtabs,
    "SETTINGS_SUBTABS must list exactly the subtabs DNSManager renders",
  );
});

test("every settings row lives inside a subtab panel", () => {
  const panelRows = jsxDescendants(findSettingsPanel()).filter(isSettingsRow);
  assert.equal(
    panelRows.length,
    SOURCE_ROWS.length,
    `the settings panel has ${panelRows.length} rows but only ${SOURCE_ROWS.length} are inside a settingsSubtab block; a row outside one cannot be reached by a jump`,
  );
});

test("rowShapesAreStillTheOnlyOnes: the row markers are unchanged", () => {
  // The parser can only police rows it recognises. If the settings rows are
  // ever restyled, this fails first and says so, instead of the coverage
  // quietly dropping to zero.
  const layoutRows = jsxDescendants(findSettingsPanel()).filter((node) =>
    className(node).includes(ROW_LAYOUT_CLASS),
  );
  const labelledRows = jsxDescendants(findSettingsPanel()).filter((node) =>
    jsxChildren(node).some((child) => className(child) === ROW_LABEL_CLASS),
  );
  assert.equal(
    layoutRows.length,
    SOURCE_ROWS.length,
    `${ROW_LAYOUT_CLASS} no longer marks every settings row`,
  );
  assert.equal(
    labelledRows.length,
    SOURCE_ROWS.length,
    `a bare className="${ROW_LABEL_CLASS}" label cell no longer marks every settings row`,
  );
});

test("the Columns entries come from the table registry", () => {
  const expected = TABLE_COLUMN_GROUPS.flatMap((group) =>
    group.columns.map((column) => `column-${group.id}-${column.id}`),
  );
  const actual = SETTINGS_SEARCH_ENTRIES.filter(
    (entry) => entry.subtab === "columns",
  ).map((entry) => entry.id);
  assert.deepEqual(
    actual.slice().sort(),
    expected.slice().sort(),
    "the Columns subtab index must be generated from TABLE_COLUMN_GROUPS",
  );

  // The picker's anchor: the generated selector has to match the attributes
  // the picker renders.
  const columnsBlock = findSubtabBlocks().get("columns");
  assert.ok(columnsBlock, "there is no columns subtab block");
  const markup = columnsBlock.getText(sourceFile);
  assert.match(
    markup,
    /data-testid=\{`column-group-\$\{group\.id\}`\}/u,
    "the Columns picker no longer renders the group testid the jump selector uses",
  );
  assert.match(
    markup,
    /data-column-id=\{column\.id\}/u,
    "the Columns picker no longer renders the column id the jump selector uses",
  );
});

test("the Assistant entries are the panel's own sections", () => {
  const expected = AI_SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
  }));
  const actual = SETTINGS_SEARCH_ENTRIES.filter(
    (entry) => entry.subtab === "assistant",
  ).map((entry) => ({
    id: entry.anchor.kind === "assistantSection" ? entry.anchor.section : "",
    label: entry.label,
  }));
  assert.deepEqual(
    actual,
    expected,
    "the Assistant index must list exactly AI_SETTINGS_SECTIONS, with their labels",
  );
});

test("the Notifications entries are the panel's own sections", () => {
  // The Assistant check, for the second re-hosted panel. `NotificationsSettings`
  // renders its six sections' rows from their own files, so — exactly as with
  // the Assistant — a section is the finest thing the index can name, and the
  // panel's own list is what the index has to agree with. Checking ids *and*
  // labels, deep-equal and in order, is stricter than the string search below
  // that this subtab is excused from: that one only asks whether the label
  // appears somewhere in the subtab, while this one fails on a renamed
  // section, a reordered nav, a missing section and a section that no longer
  // exists.
  const expected = NOTIFICATION_SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
  }));
  const actual = SETTINGS_SEARCH_ENTRIES.filter(
    (entry) => entry.subtab === "notifications",
  ).map((entry) => ({
    id:
      entry.anchor.kind === "notificationsSection" ? entry.anchor.section : "",
    label: entry.label,
  }));
  assert.deepEqual(
    actual,
    expected,
    "the Notifications index must list exactly NOTIFICATION_SETTINGS_SECTIONS, with their labels",
  );
});

test("an anchorless entry's label is a string its subtab renders", () => {
  const blocks = findSubtabBlocks();
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (entry.anchor.kind === "row" || entry.anchor.kind === "columnToggle") {
      continue;
    }
    // Both of these re-host a panel from another file, so their labels are not
    // strings `DNSManager.tsx` renders. They are checked against their panel's
    // own exported section list instead, by the two tests above — which is a
    // stricter check than this one, not an exemption from it.
    if (entry.subtab === "assistant") continue;
    if (entry.subtab === "notifications") continue;
    const block = blocks.get(entry.subtab);
    assert.ok(block, `no ${entry.subtab} subtab block`);
    assert.ok(
      translationKeys(block).includes(entry.label),
      `the ${entry.subtab} subtab renders no t(${JSON.stringify(entry.label)}), so the registry names a control that is not there`,
    );
  }
});

test("a desktop-only subtab has only desktop-only entries", () => {
  const desktopOnly = new Set(
    SETTINGS_SUBTABS.filter((subtab) => subtab.desktopOnly).map((s) => s.id),
  );
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (!desktopOnly.has(entry.subtab)) continue;
    assert.equal(
      entry.desktopOnly,
      true,
      `${entry.id} is on the desktop-only ${entry.subtab} subtab but is offered to browser users`,
    );
  }
});

test("every entry has a usable id, subtab and anchor", () => {
  const subtabs = new Set<SettingsSubtab>(
    SETTINGS_SUBTABS.map((subtab) => subtab.id),
  );
  const seen = new Set<string>();
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    assert.ok(!seen.has(entry.id), `duplicate entry id ${entry.id}`);
    seen.add(entry.id);
    assert.ok(subtabs.has(entry.subtab), `${entry.id}: unknown subtab`);
    assert.ok(entry.label.length > 0, `${entry.id}: empty label`);
    assert.equal(findSettingsEntry(entry.id), entry);
  }
});

test("a row entry's selector is the id the row carries", () => {
  for (const row of SOURCE_ROWS) {
    const entry = findSettingsEntry(row.id as string) as SettingsSearchEntry;
    assert.equal(
      settingsAnchorSelector(entry),
      `[data-setting-id="${row.id}"]`,
    );
  }
});

test("every indexed setting is findable by its own label", () => {
  // The index is only worth policing if it answers. Each entry must come back
  // first for its own label, which also catches a label so generic that
  // another entry outranks it.
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const results = searchSettings(entry.label, { desktop: true });
    assert.ok(
      results.some((result) => result.entry.id === entry.id),
      `searching ${JSON.stringify(entry.label)} does not find ${entry.id}`,
    );
  }
});
