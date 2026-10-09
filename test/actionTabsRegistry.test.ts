/**
 * Every zone subtab's name and hint has to be reachable by the i18n scanner.
 *
 * `ACTION_TABS` in `DNSManager.tsx` holds the fifteen zone subtabs as
 * `{ id, label, hint }` data, and the tablist renders `t(tab.label, tab.label)`
 * — a *variable*, which `scripts/i18n-coverage.mjs` cannot see. So the strings
 * are catalogued only because that file is listed in `REGISTRY_FILES` and the
 * scanner reads `label` and `hint` out of object literals. Six subtab labels
 * and thirteen hints had been shipping in English in eleven locales behind a
 * green coverage report before it was.
 *
 * That makes the registry the scanner's only view of what the tablist says,
 * and this file is what keeps the two honest. It is the same job
 * `settingsSearch.registry.test.ts` does for `settings-search.ts`, and the
 * reason the comment beside `REGISTRY_FILES` trusts that one.
 *
 * Specifically it fails when:
 *
 *   - a member is added to the `ActionTab` union with no `ACTION_TABS` row, so
 *     a new subtab renders with no catalogued label or hint;
 *   - a row's `label` or `hint` stops being a plain string literal — a
 *     template literal or a concatenation is invisible to the scanner even
 *     inside a file it reads;
 *   - a row loses its `hint`, which is rendered as the subtab's one-line
 *     description and would otherwise just vanish.
 *
 * It deliberately does not check that `ACTION_TABS` matches what is on screen
 * the way the settings test does, because here it cannot diverge: the tablist
 * maps over this exact array rather than keeping a parallel list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const SOURCE_URL = new URL(
  "../src/components/dns/DNSManager.tsx",
  import.meta.url,
);
const source = readFileSync(SOURCE_URL, "utf8");
const sourceFile = ts.createSourceFile(
  "DNSManager.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

interface ActionTabRow {
  id: string;
  label: string;
  hint: string;
}

/** Members of the `ActionTab` union, which is what the render switches on. */
function actionTabUnion(): string[] {
  const members: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "ActionTab" &&
      ts.isUnionTypeNode(node.type)
    ) {
      for (const member of node.type.types) {
        assert.ok(
          ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
          "every ActionTab member should be a string literal",
        );
        if (
          ts.isLiteralTypeNode(member) &&
          ts.isStringLiteral(member.literal)
        ) {
          members.push(member.literal.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
}

/** Rows of the `ACTION_TABS` array literal, read as the scanner reads them. */
function actionTabRows(): ActionTabRow[] {
  const rows: ActionTabRow[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ACTION_TABS" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        assert.ok(
          ts.isObjectLiteralExpression(element),
          "every ACTION_TABS entry should be an object literal",
        );
        if (!ts.isObjectLiteralExpression(element)) continue;
        const row: Partial<ActionTabRow> = {};
        for (const property of element.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
          ) {
            continue;
          }
          const key = property.name.text;
          if (key !== "id" && key !== "label" && key !== "hint") continue;
          // A string *literal* specifically. The scanner reads quoted values
          // and nothing else, so a template literal here would catalogue
          // nothing while still compiling and rendering.
          assert.ok(
            ts.isStringLiteral(property.initializer),
            `ACTION_TABS.${key} must be a plain string literal for the i18n scanner to see it, not ${ts.SyntaxKind[property.initializer.kind]}`,
          );
          if (ts.isStringLiteral(property.initializer)) {
            row[key] = property.initializer.text;
          }
        }
        assert.ok(row.id, "an ACTION_TABS row has no id");
        assert.ok(row.label, `ACTION_TABS row ${row.id} has no label`);
        assert.ok(row.hint, `ACTION_TABS row ${row.id} has no hint`);
        rows.push(row as ActionTabRow);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rows;
}

test("the registry parser finds both the union and the rows", () => {
  // Guards the parser itself: a rename or a refactor that made either walk
  // return nothing would otherwise make every assertion below vacuously true.
  const union = actionTabUnion();
  const rows = actionTabRows();
  assert.ok(union.length >= 10, `found only ${union.length} ActionTab members`);
  assert.ok(rows.length >= 10, `found only ${rows.length} ACTION_TABS rows`);
});

test("every zone subtab has a catalogued label and hint", () => {
  const union = actionTabUnion();
  const rows = actionTabRows();
  const byId = new Set(rows.map((row) => row.id));

  const missing = union.filter((id) => !byId.has(id));
  assert.deepEqual(
    missing,
    [],
    `these ActionTab members have no ACTION_TABS row, so their label and hint are not catalogued and would render in English in every locale: ${missing.join(", ")}`,
  );

  const unknown = rows.map((row) => row.id).filter((id) => !union.includes(id));
  assert.deepEqual(
    unknown,
    [],
    `these ACTION_TABS rows name no ActionTab member, so their strings are translated but never shown: ${unknown.join(", ")}`,
  );
});

test("every subtab label and hint is in the base catalogue", () => {
  const base = JSON.parse(
    readFileSync(new URL("../src/locales/en-US.json", import.meta.url), "utf8"),
  ) as Record<string, string>;

  const absent: string[] = [];
  for (const row of actionTabRows()) {
    if (!(row.label in base)) absent.push(`${row.id}.label: ${row.label}`);
    if (!(row.hint in base)) absent.push(`${row.id}.hint: ${row.hint}`);
  }
  assert.deepEqual(
    absent,
    [],
    `uncatalogued subtab strings — run \`node scripts/i18n-coverage.mjs fill-base\`:\n${absent.join("\n")}`,
  );
});
