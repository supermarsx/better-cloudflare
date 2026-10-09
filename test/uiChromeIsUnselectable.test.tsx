/**
 * Interactive chrome does not highlight; content does.
 *
 * A button's label is a control rather than text, so a double-click should
 * press it twice and not select the word, and a drag across a toolbar should
 * not paint a selection over four buttons. Every native toolkit suppresses
 * this, and a web view that does not is the thing that makes a desktop window
 * feel like a web page.
 *
 * The reason this is a test and not just a class is the other half: it must
 * stay *scoped*. Making the whole app unselectable would take away copying a
 * checksum, a device id, a record value, an upstream error message or a block
 * of export output — all of which this app puts on screen specifically so they
 * can be copied. So the rule is "chrome you click", and the cases below pin
 * both directions: the controls are unselectable, and a sample of the content
 * that must not be is left alone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";

import { Button } from "../src/components/ui/button";
import { Label } from "../src/components/ui/label";

const CSS = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

afterEach(() => {
  cleanup();
});

/**
 * The declaration block of one CSS class, by name.
 *
 * A substring search for `user-select: none` anywhere in the file would pass
 * on a rule belonging to some other selector, which is the failure mode that
 * makes this kind of test worthless.
 */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n  ${selector} {`);
  assert.ok(at >= 0, `${selector} is not declared in src/index.css`);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("\n  }", open);
  assert.ok(close > open, `${selector} has no closing brace`);
  return CSS.slice(open, close);
}

test("a button does not select its own label", () => {
  render(<Button>Push now</Button>);
  const button = screen.getByRole("button", { name: "Push now" });
  assert.match(
    button.className,
    /\bselect-none\b/,
    "a double-click on a button would otherwise highlight its label",
  );
});

test("a label does not select, because clicking it works the control", () => {
  render(
    <>
      <Label htmlFor="cadence">Minutes between pushes</Label>
      <input id="cadence" />
    </>,
  );
  assert.match(
    screen.getByText("Minutes between pushes").className,
    /\bselect-none\b/,
    "a label is part of its control: double-clicking it toggles twice",
  );
});

test("every clickable surface class suppresses selection", () => {
  // `.ui-tab` has carried this from the start; the other two did not, and
  // `.ui-entry`'s consumers were each passing `select-none` by hand instead —
  // which worked until someone added a fourth consumer and forgot.
  for (const selector of [".ui-tab", ".ui-segment", ".ui-entry"]) {
    assert.match(
      ruleBody(selector),
      /user-select:\s*none/,
      `${selector} is a control surface and must not highlight on a drag`,
    );
  }
});

test("content that exists to be copied stays selectable", () => {
  // The guard against over-applying this. `.ui-tag` is a chip carrying a
  // provider name, a tool id or a record type — something to read, and
  // plausibly to paste into a search — rather than something to click. If a
  // future change makes tags interactive, this test should be the thing that
  // asks whether that is still true.
  assert.doesNotMatch(
    ruleBody(".ui-tag"),
    /user-select:\s*none/,
    "a tag is a label to read, not a control to click",
  );

  // And nothing may impose it on the document or the body, which is the
  // shortcut that would silently take copying away everywhere.
  for (const selector of ["html", "body", "*"]) {
    const at = CSS.indexOf(`\n  ${selector} {`);
    if (at < 0) continue;
    assert.doesNotMatch(
      ruleBody(selector),
      /user-select:\s*none/,
      `${selector} must not disable selection app-wide — checksums, record values and error messages are on screen to be copied`,
    );
  }
});
