/**
 * Every native checkbox wears the app's theme.
 *
 * # Why this exists
 *
 * `src/index.css` defines `.checkbox-themed`, which replaces the platform
 * control (`appearance: none`) with the app's glass surface: 16px, a 6px
 * radius, a themed border, a blurred card background and a drawn checkmark.
 * A checkbox that omits it renders as the raw Windows/macOS/GTK control, which
 * is the wrong size, the wrong shape, and does not follow the theme at all —
 * including the `void` theme, whose whole point is that nothing is left light.
 *
 * On 2026-10-11 the user reported it on the record-change field boxes. An
 * audit of all 21 native checkboxes in `src/` found exactly two that opted out,
 * both reaching for `accent-primary` instead:
 *
 *   - `NotificationsSettingsKinds.tsx` — the `RECORD_CHANGE_FIELDS` loop, the
 *     one that was reported.
 *   - `NotificationsSettingsControls.tsx` — the "never" toggle beside a
 *     retention timer. Same family, same screen, not yet noticed.
 *
 * `accent-primary` only tints the platform control's check; it leaves the box
 * itself native. So the two looked *almost* right, which is why they survived
 * nineteen siblings being converted.
 *
 * # Why a source-text gate rather than a render assertion
 *
 * A rendered checkbox carries whatever class it was given, so a render test
 * asserting `checkbox-themed` would have to be written per call site, and a
 * new call site elsewhere adds no test by itself. The defect is *absence* in a
 * population, so the check has to enumerate the population. This walks `src/`,
 * finds every `type="checkbox"`, and requires the themed class on each — so a
 * twenty-second checkbox added tomorrow is covered the moment it exists.
 *
 * Comments are stripped first. Not stripping them would let a file that
 * merely *mentions* `checkbox-themed` in prose pass with an unthemed control,
 * which is the failure mode `test/source-text.ts` documents.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./source-text.ts";

// `URL.pathname` is `/F:/...` on Windows, which `join` turns into `F:\F:\...`.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...tsxFiles(full));
    } else if (entry.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every `<input ...>` opening tag in a source file, as text.
 *
 * A regex of the form `<input\b[^>]*>` is **wrong** here and the first draft of
 * this test used it. JSX attribute values routinely contain `>`:
 *
 *     <input type="checkbox" onChange={(event) => ...} className="..." />
 *
 * so `[^>]*` stops inside the arrow and cuts the tag off before `className`.
 * That produced four false positives — `ImportPreviewDialog` ×3 and
 * `RecordRow`, all four of which do carry the themed class.
 *
 * So the tag is scanned rather than matched: `>` ends it only at brace depth
 * zero and outside a string literal.
 */
function inputTags(source: string): string[] {
  const tags: string[] = [];
  const open = /<input\b/gu;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let index = match.index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote !== null) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      } else if (char === ">" && depth === 0) {
        break;
      }
    }
    tags.push(source.slice(match.index, index + 1));
    open.lastIndex = index + 1;
  }
  return tags;
}

function checkboxTags(source: string): string[] {
  return inputTags(source).filter((tag) => /type="checkbox"/u.test(tag));
}

test("every native checkbox in src/ uses the themed class", () => {
  const offenders: string[] = [];
  let total = 0;

  for (const file of tsxFiles(SRC)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const tag of checkboxTags(source)) {
      total += 1;
      if (!/className="[^"]*\bcheckbox-themed\b/u.test(tag)) {
        offenders.push(
          `${file.slice(SRC.length)}: ${tag.replace(/\s+/gu, " ")}`,
        );
      }
    }
  }

  // Proves the walk found the population rather than silently matching
  // nothing — an empty sweep would otherwise pass this test trivially.
  assert.ok(
    total >= 20,
    `expected the sweep to find the ~21 native checkboxes, found ${total}`,
  );

  assert.deepEqual(
    offenders,
    [],
    `these native checkboxes render the unthemed platform control:\n${offenders.join("\n")}`,
  );
});

test("accent-primary is not used to fake a themed checkbox", () => {
  // The specific wrong turn both offenders took. `accent-*` tints the native
  // control's check and leaves its box alone, so it reads as a near-miss
  // rather than as an obviously unstyled control.
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const tag of checkboxTags(source)) {
      if (/\baccent-primary\b/u.test(tag)) {
        offenders.push(file.slice(SRC.length));
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join(", "));
});
