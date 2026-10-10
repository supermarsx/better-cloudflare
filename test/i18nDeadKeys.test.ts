/**
 * The other direction of i18n coverage: a catalogued key with no live call
 * site, and a live call site that does not go through `t()`.
 *
 * `auditCoverage()` reports **code without catalogue** — a `t()` call whose key
 * is missing from a locale — and deliberately never the reverse. That
 * asymmetry is explained at length in `scripts/i18n-coverage.mjs` and it is
 * right: "no call site found" is not evidence a key is dead, because hundreds
 * of keys reach `t()` through a variable. But it leaves two real defects
 * invisible to every gate in this project:
 *
 *   1. A string is catalogued, translated into eleven languages, **and also
 *      rendered somewhere as a bare English literal**. The translation exists
 *      and is never used. `EditKeyDialog.tsx` did this with seven strings
 *      through six rounds of twelve people reading them, because nothing
 *      looked.
 *   2. The catalogue only grows. A key whose call site was deleted or reworded
 *      stays, and eleven translators keep carrying it.
 *
 * ## Why this is not the scanner asserting on itself
 *
 * The first two tests do not use `extractStrings()` at all, and that is the
 * point: a gate that imported the scanner and then asserted on the scanner
 * could not dissent. They parse the source with the TypeScript compiler and
 * compare against `src/locales/*.json`, so the two sides of the comparison come
 * from the compiler and from the twelve translators' files respectively, and
 * neither is the thing under test.
 *
 * ## Why the AST and not grep
 *
 * Grep is the wrong oracle here and has already been wrong in this repo three
 * times. Comments are not AST nodes, so a `t("…")` quoted in a doc comment —
 * which the comments in this codebase do constantly — cannot be mistaken for a
 * call site. `StringLiteral.text` is the *unescaped* value, which is what
 * `t()` receives and therefore what a locale file keys on, so a key like
 * `C:\Users\You\Documents\Audit Exports` is compared correctly against source
 * carrying doubled backslashes. And a literal in type position
 * (`type TabKind = "zone" | …`) is structurally distinguishable from one that
 * renders, which a substring sweep called live for both `"zone"` and
 * `"records"`.
 *
 * ## Why "catalogued" is not enough on its own, and what makes a hit real
 *
 * A key being in `en-US.json` does not prove it is user-visible text — the
 * catalogue holds `"PNG"` and `"SSH (22)"`. So the evidence used here is
 * stronger: **at least one of the eleven other locales translates it to
 * something different**. A human translator looked at that string and wrote
 * another language's version of it. That makes "this exact text is rendered
 * from a bare literal" a statement about a translation that exists and is not
 * being used, rather than a guess about whether a string is UI text.
 *
 * ## The gap this suite does *not* close: `REGISTRY_TEXT_FIELDS` drift
 *
 * `scripts/i18n-coverage.mjs` sweeps registry files for a hand-kept list of
 * property names. Five have been missing from it — `group`, `saved`,
 * `consequence`, `synonyms`, and `requires` is still missing as of writing —
 * and **no test in this project can catch the next one**, including the ones
 * below. Removing a field makes the scanner find *fewer* strings, so
 * `i18nCoverage.contract`'s uncatalogued count goes *down*: the only test in
 * the area moves in the reassuring direction. Measured, not assumed.
 *
 * The obvious test — fail when a registry file has a string-valued property
 * not in the list — is not worth building: there are 70 distinct such property
 * names across the registry files and 63 would need an opt-out, so the opt-out
 * list becomes the same hand-kept mirror it was meant to replace.
 *
 * The version that *is* buildable inverts it: audit the **consumers**. Every
 * `t(entry.X)` / `translate(entry.X)` call names the property a translator
 * reads, and there are only **10** such names across `src`. Asserting that set
 * is covered by `REGISTRY_TEXT_FIELDS` needs an opt-out of two, both
 * justifiable — `zoneName` (a domain name, user data, never catalogue text)
 * and `default` (a property name shared between `AVAILABILITY_LABELS.default`
 * and CSS class variants, so it needs the `REGISTRY_LABEL_MAPS` treatment
 * rather than the field list). It would have caught all five omissions,
 * because each has a translator call site naming it. Not built here: it
 * belongs beside the scanner's own unit tests, and adding `requires` changes a
 * translation batch that is mid-dispatch.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";

import {
  BASE_LOCALE,
  extractStrings,
  localeNames,
  readLocale,
} from "../scripts/i18n-coverage.mjs";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/**
 * Attributes whose string value is read by a user.
 *
 * Kept to names that are text by definition. A component is free to translate
 * a prop it receives, so this is not airtight on its own — `BuilderFieldLabel`
 * was checked and renders `{label}` raw, which is what puts the builders in
 * the debt table below. A component that *does* translate its own prop would
 * show up here as a hit and belongs in the table with that as its reason.
 */
const TEXT_ATTRIBUTES = new Set([
  "label",
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "description",
  "confirmLabel",
  "cancelLabel",
  "tip",
  "heading",
  "emptyMessage",
  "hint",
]);

/** `toast({ title, description })` renders both verbatim. */
const TOAST_FIELDS = new Set(["title", "description"]);

/**
 * Files that render a catalogued, translated string as a bare literal today,
 * and how many such sites each one has.
 *
 * This is debt, not a waiver, and the numbers are the point — **96 sites across
 * 29 files**, every one of them a place where eleven translations exist and
 * English is shown instead. It is recorded per file rather than per line
 * because line numbers move under any edit, and as a count rather than a list
 * of strings so that the table does not have to be rewritten every time a
 * sentence is reworded.
 *
 * The assertions are `<=`, so **fixing** a file never breaks the build; the
 * failure message reports when a number has become loose so it can be lowered.
 * A file absent from this table *and* from {@link DELIBERATELY_NOT_LOCALISED}
 * must have no such sites at all, which is the half that catches a new
 * `EditKeyDialog`.
 *
 * Everything in here is a real bug and should reach zero. Deliberate opt-outs
 * live in the other table so that this number keeps meaning one thing.
 *
 * `hooks/auth/use-login-form.ts` used to be 62 of these — by far the worst
 * file, a hook that bound its own `t` (`const t = i18next.t.bind(i18next)`) and
 * called it in some handlers and not others, so "Logged in successfully" was
 * English in twelve locales while "Vault secret removed" three handlers away
 * was translated. **It is now absent from this table entirely.** That is what
 * the gate is for, and the number dropping without a red is what `<=` is for.
 *
 * Current clusters: `dns/ZoneTopologyTab.tsx` (15), `dns/AddRecordDialog.tsx`
 * (14), `dns/ImportExportDialog.tsx` (8), and 35 sites across 16 record
 * builders whose `label="…"` props reach `BuilderFieldLabel`
 * (`dns/builders/BuilderField.tsx:61`), which renders `{label}` raw.
 *
 * ## Those 35 builder sites are the tip of something this gate cannot see
 *
 * `src/components/dns/builders/` is **28 files with zero translator calls and
 * zero i18n imports** — verified by AST, because `grep -c 't('` there matches
 * `.split(`, `headline +=` and `redirect=` and reports a thriving translation
 * effort that does not exist. The directory holds **782 distinct bare English
 * strings**, of which only **34** are catalogued and translated elsewhere.
 *
 * So this gate sees 35 sites in an area whose real untranslated surface is 782
 * strings: it undercounts there by a factor of more than twenty. That is not a
 * bug in the detector, it is the evidence condition in the header doing exactly
 * what it says — it proves "a translation exists and is going unused", and a
 * file nobody ever translated has no such translations to find. **Read this
 * table as wasted translations, never as the untranslated surface.** Whole
 * never-translated feature areas need the `uncatalogued` side of
 * `auditCoverage()`, not this.
 */
const BARE_RENDER_DEBT: Readonly<Record<string, number>> = {
  "src/components/audit/AuditLogDialog.tsx": 7,
  "src/components/dns/AddRecordDialog.tsx": 14,
  "src/components/dns/BulkEditBar.tsx": 2,
  // `:11629` is `description: err instanceof Error ? err.message : "Clone
  // failed"` — the `:` branch, beside a `title: t("Error", "Error")` that is
  // wired. Found only after the toast probe learned to follow a conditional.
  "src/components/dns/DNSManager.tsx": 2,
  "src/components/dns/ImportExportDialog.tsx": 8,
  "src/components/dns/ImportPreviewDialog.tsx": 4,
  "src/components/dns/ZoneTopologyTab.tsx": 15,
  "src/components/dns/builders/AnameBuilder.tsx": 1,
  "src/components/dns/builders/AplBuilder.tsx": 1,
  "src/components/dns/builders/CaaBuilder.tsx": 4,
  "src/components/dns/builders/CertBuilder.tsx": 2,
  "src/components/dns/builders/DkimBuilder.tsx": 1,
  "src/components/dns/builders/DnameBuilder.tsx": 1,
  "src/components/dns/builders/DnskeyBuilder.tsx": 2,
  "src/components/dns/builders/DsBuilder.tsx": 1,
  "src/components/dns/builders/LocBuilder.tsx": 3,
  "src/components/dns/builders/NaptrBuilder.tsx": 1,
  "src/components/dns/builders/SoaBuilder.tsx": 3,
  // `:672` renders `{editingIndex !== null ? "Update" : "Add"}` — two of
  // these six, and neither is `JsxText` or an attribute, so it took the
  // jsx-expression detector above to see them at all. Both strings are
  // catalogued and translated eleven ways.
  //
  // Note for anyone fixing it: this file has **no translator**, like every
  // other file in this directory, so wrapping these two in `t()` does not
  // compile. It needs `useI18n()` first, and wiring 2 of its 48 bare strings
  // would reproduce at file scale the defect that `AddRecordDialog.tsx:1384`
  // just had at expression scale.
  "src/components/dns/builders/SpfBuilder.tsx": 6,
  "src/components/dns/builders/SrvBuilder.tsx": 4,
  "src/components/dns/builders/SshfpBuilder.tsx": 1,
  "src/components/dns/builders/SvcbBuilder.tsx": 3,
  "src/components/dns/builders/UriBuilder.tsx": 1,
  "src/components/layout/AuthenticatedAppShell.tsx": 1,
  "src/components/mcp/McpToolPermissions.tsx": 3,
  "src/components/registrar/AddRegistrarDialog.tsx": 3,
  "src/components/registrar/RegistryMonitor.tsx": 1,
  // Both are the `sr-only` "Close" on a primitive. Ordinary defects: these two
  // are not on a crash path, `ToastDiagnosticDialog` being rendered from
  // `ui/toaster.tsx:246`, so neither belongs in the opt-out table below.
  "src/components/ui/ToastDiagnosticDialog.tsx": 1,
  "src/components/ui/dialog.tsx": 1,
};

/**
 * Files that render a catalogued string bare **and should keep doing so**.
 *
 * Separate from {@link BARE_RENDER_DEBT} because a count that mixes "nobody
 * has got to this yet" with "this must not change" stops meaning either. These
 * four sites will never reach zero, and leaving them in the debt total would
 * have made the debt total permanently non-zero and therefore ignorable.
 *
 * Both files are the crash surface, and the reasoning is one the detector
 * cannot derive from the AST:
 *
 *   - `RuntimeCrashRecovery.tsx` (3, window controls) and
 *     `RuntimeDiagnosticDetails.tsx` (1, the "Copied" button) are rendered by
 *     `ErrorBoundary.tsx:153`, `RuntimeCrashRecovery.tsx:186` and `App.tsx:53`
 *     — on screen precisely when something has already failed, which includes
 *     failing *during* start-up.
 *   - `t` resolves asynchronously and returns an empty string until it does,
 *     documented at `LoginSettingsMenu.tsx:74`. On a crash before i18n
 *     settles, a translated label renders as no label at all.
 *   - Calling `useI18n()` there makes the crash screen depend on the context
 *     that may be what broke, turning one failure into a boundary that cannot
 *     render.
 *
 * `"Copied"` is catalogued and translated in eleven locales, so wiring it looks
 * free. The cost falls entirely in the situation the component exists for.
 * `RuntimeDiagnosticDetails.tsx:44` carries the same reasoning as a comment so
 * that nobody "finishes the job"; if these ever are localised, they need the
 * `t(…) || "literal"` floor and a non-hook translator, not `useI18n()`.
 *
 * Counts, not a blanket licence: a *new* bare render in one of these files
 * still fails the ratchet, because the opt-out is for the strings that were
 * reasoned about, not for the file forever.
 *
 * Deliberately a table in checked-in code rather than a `// i18n-ignore`
 * comment directive. A directive would make the gate read prose, and this
 * repo has produced five separate cases of a tool being misled by what a
 * comment contained — including `Password (placeholder)`, whose only
 * appearance in `src` is inside a backtick in a doc comment. An opt-out that
 * requires editing a reviewed table cannot be granted by accident.
 */
const DELIBERATELY_NOT_LOCALISED: Readonly<Record<string, number>> = {
  "src/components/layout/RuntimeCrashRecovery.tsx": 3,
  "src/components/layout/RuntimeDiagnosticDetails.tsx": 1,
};

/**
 * Catalogued keys with no call site `extractStrings()` can find, as a ceiling.
 *
 * A list of the keys themselves was tried and rejected: five agents edit this
 * tree at once, and every key one of them wraps in `t()` or rewords would make
 * the list wrong, which is how a gate gets deleted rather than fixed. A
 * ceiling that can only come down survives that and still fails the thing
 * worth failing — a sentence added to the catalogue that nothing renders.
 *
 * Roughly half of the current number is strings rendered as bare literals —
 * the same defect the table above counts, seen from the catalogue's side — and
 * half is keys whose call site is gone, most of those left behind by a
 * reworded sentence: rewording a `t()` default catalogues the new wording and
 * orphans the old one, in all twelve files, with nothing reporting it.
 *
 * To re-baseline after a deliberate change:
 *
 *   node -e "import('./scripts/i18n-coverage.mjs').then(m=>{const s=m.extractStrings(),b=m.readLocale('en-US');console.log(Object.keys(b).filter(k=>!s.has(k)).length)})"
 */
const ORPHAN_CEILING = 113;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "locales") continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Keys that at least one other locale renders as something other than the key.
 *
 * The condition that makes a hit evidence rather than a guess: a translator
 * wrote another language's version of this string, so it is text someone
 * reads.
 */
function translatedKeys(): Set<string> {
  const base = readLocale(BASE_LOCALE);
  const translated = new Set<string>();
  for (const name of localeNames()) {
    if (name === BASE_LOCALE) continue;
    const data = readLocale(name) as Record<string, string>;
    for (const [key, value] of Object.entries(data)) {
      if (key in base && String(value) !== key) translated.add(key);
    }
  }
  return translated;
}

interface BareSite {
  file: string;
  line: number;
  how: string;
  value: string;
}

/**
 * The string literals an expression can *render*, as opposed to merely mention.
 *
 * `{editingIndex !== null ? "Update" : "Add"}` renders one of two literals and
 * tests a third thing that is not text at all. Collecting every literal under
 * the expression would be wrong in the other direction — `{kind === "zone" ?
 * <A/> : <B/>}` mentions `"zone"` as a comparison operand and renders neither
 * it nor anything else textual — so only value positions are followed:
 *
 *   - a conditional contributes its two branches, never its condition;
 *   - `&&` contributes its right side, and `+` contributes both: if the result
 *     of a concatenation is rendered then so is every literal in it, which is
 *     the `"Failed to …: " + formatError(error)` shape. Every other operator
 *     (`===`, `!==`, `<`, …) contributes nothing, because a comparison operand
 *     is tested rather than shown;
 *   - `||` and `??` contribute both sides **unless the left side already calls
 *     `t()`**, because `{t("Add New Key", "Add New Key") || "Add New Key"}` is
 *     correct code — the right side is a belt-and-braces fallback for `t()`
 *     returning empty, not a bare render. Collecting it reported six false
 *     positives in `LoginSettingsMenu.tsx`, every one of them already
 *     localised;
 *   - a call is never followed, which is what keeps `{t("Update")}` out.
 *
 * Without this, `SpfBuilder.tsx:672` is invisible: it is not `JsxText` and not
 * an attribute, so the two detectors below both miss it, while the string it
 * renders is catalogued and translated in all twelve locales.
 */
/** Does this expression call `t()` anywhere inside it? */
function callsTranslator(expression: ts.Node): boolean {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "t"
  ) {
    return true;
  }
  return ts.forEachChild(expression, callsTranslator) ?? false;
}

function renderedLiterals(
  expression: ts.Expression,
  out: ts.StringLiteral[] = [],
): ts.StringLiteral[] {
  if (ts.isStringLiteral(expression)) {
    out.push(expression);
    return out;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return renderedLiterals(expression.expression, out);
  }
  if (ts.isConditionalExpression(expression)) {
    renderedLiterals(expression.whenTrue, out);
    return renderedLiterals(expression.whenFalse, out);
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      renderedLiterals(expression.left, out);
      // A fallback behind a `t()` call is not a bare render.
      return callsTranslator(expression.left)
        ? out
        : renderedLiterals(expression.right, out);
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return renderedLiterals(expression.right, out);
    }
    if (operator === ts.SyntaxKind.PlusToken) {
      renderedLiterals(expression.left, out);
      return renderedLiterals(expression.right, out);
    }
    return out;
  }
  return out;
}

/** Every place a string in `wanted` is rendered without passing through `t()`. */
function findBareRenders(wanted: ReadonlySet<string>): BareSite[] {
  const sites: BareSite[] = [];
  for (const path of walk(SRC)) {
    const text = readFileSync(path, "utf8");
    const file = relative(ROOT, path).split("\\").join("/");
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const add = (node: ts.Node, value: string, how: string) => {
      if (wanted.has(value))
        sites.push({ file, line: lineOf(node), how, value });
    };

    const visit = (node: ts.Node): void => {
      // Text between tags renders verbatim.
      if (ts.isJsxText(node)) add(node, node.text.trim(), "jsx-text");
      // `{…}` in children position: whatever it evaluates to becomes text.
      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        node.parent &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
      ) {
        for (const literal of renderedLiterals(node.expression)) {
          add(literal, literal.text, "jsx-expression");
        }
      }
      // An attribute whose name is text by definition, either as a bare string
      // or as an expression that can evaluate to one — `label="Algorithm"` and
      // `label={editing ? "Update" : "Add"}` are the same defect.
      if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText())) {
        const { initializer } = node;
        const literals = !initializer
          ? []
          : ts.isStringLiteral(initializer)
            ? [initializer]
            : ts.isJsxExpression(initializer) && initializer.expression
              ? renderedLiterals(initializer.expression)
              : [];
        for (const literal of literals) {
          add(literal, literal.text, `@${node.name.getText()}`);
        }
      }
      // `toast({ title: "…", description: "…" + formatError(e) })`.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "toast"
      ) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            if (!ts.isIdentifier(property.name)) continue;
            if (!TOAST_FIELDS.has(property.name.text)) continue;
            // The same walker the JSX detectors use, rather than a
            // direct-literal test. The first version of this accepted only a
            // bare literal or the left half of a concatenation, so
            // `description: native ? "…" : "…"` made it skip the property and
            // lose **both** branches — two catalogued, translated strings in
            // `use-login-form.ts` that `auth-i18n` found by wiring the file
            // this list pointed them at. It was the `SpfBuilder` hole one
            // layer out: the JSX walker had learned to follow a conditional
            // and the object-property probe had not.
            for (const literal of renderedLiterals(property.initializer)) {
              add(literal, literal.text, `toast.${property.name.text}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/** Sites grouped by file, so the two directions can be checked separately. */
function bareRendersByFile(): Map<string, BareSite[]> {
  const grouped = new Map<string, BareSite[]>();
  for (const site of findBareRenders(translatedKeys())) {
    const found = grouped.get(site.file);
    if (found) found.push(site);
    else grouped.set(site.file, [site]);
  }
  return grouped;
}

function describe(sites: readonly BareSite[], limit = 6): string {
  const shown = sites
    .slice(0, limit)
    .map(
      (site) =>
        `    ${site.file}:${site.line} (${site.how}) ${JSON.stringify(site.value)}`,
    );
  const rest = sites.length - shown.length;
  return [...shown, rest > 0 ? `    …and ${rest} more` : ""]
    .filter(Boolean)
    .join("\n");
}

test("a file with no recorded debt renders no catalogued string as a bare literal", () => {
  // The half that catches a new defect. `EditKeyDialog.tsx` rendered seven
  // strings this way, all seven already translated into eleven languages, and
  // nothing in the project looked — this is what looks.
  const offenders = [...bareRendersByFile()]
    .filter(
      ([file]) =>
        !(file in BARE_RENDER_DEBT) && !(file in DELIBERATELY_NOT_LOCALISED),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  assert.equal(
    offenders.length,
    0,
    `${offenders.length} file(s) render a string that eleven locales already translate, without passing it through t().\n` +
      `Wrap each in t("…", "…"). If the file has no translator at all — every file in dns/builders/ is like this — it needs useI18n() first, and wiring only the catalogued strings would leave the rest English in a file that now looks translated.\n` +
      `If the text genuinely must not be localised, add it to DELIBERATELY_NOT_LOCALISED with the reason, not to BARE_RENDER_DEBT.\n` +
      offenders
        .map(
          ([file, sites]) => `  ${file}: ${sites.length}\n${describe(sites)}`,
        )
        .join("\n"),
  );
});

test("no file renders more bare catalogued strings than its recorded debt", () => {
  // The ratchet on the files that are already bad. Separate from the test
  // above because one mutation must not satisfy both: this one only moves if a
  // *known* file gets worse, that one only if a *clean* file does.
  // Both tables ratchet. An opt-out is for the strings that were reasoned
  // about, so a *new* bare render in a crash-path file still has to be looked
  // at rather than inheriting the exemption.
  const grouped = bareRendersByFile();
  const worse: string[] = [];
  const loose: string[] = [];
  for (const [table, recorded] of [
    ["BARE_RENDER_DEBT", BARE_RENDER_DEBT],
    ["DELIBERATELY_NOT_LOCALISED", DELIBERATELY_NOT_LOCALISED],
  ] as const) {
    for (const [file, allowed] of Object.entries(recorded)) {
      const sites = grouped.get(file) ?? [];
      if (sites.length > allowed) {
        worse.push(
          `  ${file}: ${sites.length} sites, ${allowed} recorded in ${table}\n${describe(sites)}`,
        );
      } else if (sites.length < allowed) {
        loose.push(
          `  ${file}: ${sites.length} sites, ${allowed} recorded in ${table}`,
        );
      }
    }
  }
  assert.equal(
    worse.length,
    0,
    `${worse.length} file(s) gained a bare render of a string eleven locales translate.\n` +
      `${worse.join("\n")}` +
      (loose.length > 0
        ? `\n\nAlso: these have been fixed below their recorded number — lower it in the table named:\n${loose.join("\n")}`
        : ""),
  );
});

test("the catalogue gains no new key without a call site", () => {
  // The other direction, and the one that has to be a ceiling rather than a
  // list: see ORPHAN_CEILING. This is the only test here that uses
  // `extractStrings()`, because "has a call site" is its question; the two
  // tests above are deliberately independent of it.
  const strings = extractStrings();
  const base = readLocale(BASE_LOCALE);
  const orphans = Object.keys(base)
    .filter((key) => !strings.has(key))
    .sort();
  assert.ok(
    orphans.length <= ORPHAN_CEILING,
    `${orphans.length} catalogued keys have no call site, over the recorded ${ORPHAN_CEILING}.\n` +
      `A key added to en-US.json that nothing renders is eleven translations of nothing.\n` +
      `Three things cause this, and only the first is fixed by editing code:\n` +
      `  - a string that reaches t() through a variable: add its registry to REGISTRY_FILES or REGISTRY_LABEL_MAPS in scripts/i18n-coverage.mjs, not to this number;\n` +
      `  - a reworded t() default: the new wording is catalogued and the old one is now stale in all twelve locale files. Clearing it means removing that key from all twelve, which is a coordinated edit, not a local one — re-baseline this number and hand the stale key list on;\n` +
      `  - a deleted call site: same, the key is stale in twelve files.\n` +
      orphans
        .slice(0, 12)
        .map((key) => `    ${JSON.stringify(key)}`)
        .join("\n"),
  );
});
