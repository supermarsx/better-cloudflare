/**
 * `<html dir>` follows the locale.
 *
 * The app ships twelve locales and one of them, `ar-SA`, is right-to-left.
 * `app/layout.tsx` hardcoded `lang="en"` and set no `dir` at all, so every
 * Arabic string rendered inside a left-to-right layout: a trailing Latin run
 * (a filename at the end of a sentence) landed at the visual *start* of the
 * line, and an interior Latin run reordered the Arabic clauses either side of
 * it. The attribute is the fix, so this file pins it from three sides:
 *
 * - the DOM effect, through the component that is actually mounted;
 * - the direction *derivation*, which is CLDR data rather than a list of one,
 *   including that the hand-written fallback agrees with `Intl` -- the fallback
 *   is the only path on an engine without `getTextInfo`, and nothing else
 *   exercises it;
 * - the boot script, which is a second implementation of the same decision and
 *   therefore the thing most likely to drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { DocumentDirection } from "../src/components/i18n/DocumentDirection";
import { LanguageSelector } from "../src/components/layout/LanguageSelector";
import {
  Toast,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "../src/components/ui/toast";
import {
  LOCALE_DIRECTION_BOOT_SCRIPT,
  directionFromSubtags,
  localeDirection,
} from "../src/components/i18n/locale-direction";
import i18n, { availableLanguages } from "../src/i18n";
import { useEnglishLocale, waitForI18nInitialization } from "./i18n-ready";

const originalLang = document.documentElement.lang;
const originalDir = document.documentElement.getAttribute("dir");

/**
 * The root layout as source text.
 *
 * `app/layout.tsx` cannot be imported here -- it imports `src/index.css`, and
 * the test runner has no CSS loader -- but something has to check the wiring.
 * A hook nothing mounts and a boot script nothing injects would leave every
 * assertion in this file green while the app stayed left-to-right. Reading the
 * file is how `test/AppShellCss.contract.test.ts` pins `src/index.css` for the
 * same reason.
 */
const ROOT_LAYOUT = stripComments(
  readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8"),
);

/**
 * `src/components/ui/toast.tsx` and `src/index.css`, comments stripped.
 *
 * Both halves of the toast change describe each other in prose -- the class
 * list names the CSS token, the CSS names the class -- so an assertion that
 * did not strip comments would pass on either half alone. That is the exact
 * failure this file already found once; see {@link stripComments}.
 */
const TOAST_SOURCE = stripComments(
  readFileSync(
    new URL("../src/components/ui/toast.tsx", import.meta.url),
    "utf8",
  ),
);
const APP_CSS = stripComments(
  readFileSync(new URL("../src/index.css", import.meta.url), "utf8"),
);

/**
 * The three menu primitives that share the `.ui-entry` surface, comments out.
 *
 * Stripping matters on this side too: their header comments name `pl-8` as the
 * spelling they moved *away* from, so a scan that read comments would believe
 * `pl-8` is still in use and keep demanding an override for it.
 */
const MENU_PRIMITIVES = ["context-menu.tsx", "DropdownMenu.tsx", "select.tsx"]
  .map((name) =>
    stripComments(
      readFileSync(
        new URL(`../src/components/ui/${name}`, import.meta.url),
        "utf8",
      ),
    ),
  )
  .join("\n");

/**
 * The source with its comments removed.
 *
 * Without this the assertions below match the file's own prose. Deleting
 * `<DocumentDirection />` from the JSX left "mounts the thing that applies the
 * direction" green, because the comment above the `<html>` tag names the
 * component -- a source-text test that matches comments asserts nothing.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(async () => {
  cleanup();
  await waitForI18nInitialization();
  if (i18n.language !== "en-US") await i18n.changeLanguage("en-US");
  document.documentElement.lang = originalLang;
  if (originalDir === null) {
    document.documentElement.removeAttribute("dir");
  } else {
    document.documentElement.setAttribute("dir", originalDir);
  }
});

/**
 * Run {@link LOCALE_DIRECTION_BOOT_SCRIPT} against a stub storage and a stub
 * root element.
 *
 * The script is a string destined for a `<script>` tag, so the only way to
 * test it is to execute it. `new Function` with `localStorage` and `document`
 * as parameters shadows both globals inside the body, which keeps the script
 * away from the real document -- the component tests below assert on that same
 * element and a boot script writing to it would make them lie.
 */
function runBootScript(stored: string | null): {
  lang: string | undefined;
  dir: string | undefined;
  getItemCalls: string[];
} {
  const getItemCalls: string[] = [];
  const documentElement: { lang?: string; dir?: string } = {};
  const localStorage = {
    getItem(key: string) {
      getItemCalls.push(key);
      return stored;
    },
  };
  const run = new Function(
    "localStorage",
    "document",
    LOCALE_DIRECTION_BOOT_SCRIPT,
  ) as (storage: unknown, doc: unknown) => void;
  run(localStorage, { documentElement });
  return {
    lang: documentElement.lang,
    dir: documentElement.dir,
    getItemCalls,
  };
}

/** Switch locale the way the language selector does, flushing React's work. */
async function switchLanguage(tag: string): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(tag);
  });
}

test("the document is laid out right-to-left for Arabic", async () => {
  render(<DocumentDirection />);
  await waitFor(() => {
    assert.equal(document.documentElement.dir, "ltr");
  });

  await switchLanguage("ar-SA");

  await waitFor(() => {
    assert.equal(
      document.documentElement.dir,
      "rtl",
      "Arabic in an LTR layout reorders every sentence with a Latin run in it",
    );
  });
  assert.equal(document.documentElement.lang, "ar-SA");
});

test("the document goes back to left-to-right for English", async () => {
  render(<DocumentDirection />);
  await switchLanguage("ar-SA");
  await waitFor(() => {
    assert.equal(document.documentElement.dir, "rtl");
  });

  await switchLanguage("en-US");

  await waitFor(() => {
    assert.equal(document.documentElement.dir, "ltr");
  });
  assert.equal(document.documentElement.lang, "en-US");
});

test("a locale with no right-to-left subtag is left-to-right", () => {
  // The shapes that must not flip: a plain LTR locale, and an LTR language
  // that merely *neighbours* RTL ones in CLDR -- `ku`, `uz` and `az` are
  // written in Latin by default and only their explicit `-Arab` forms are RTL.
  //
  // Both layers are asserted on purpose. `localeDirection` consults `Intl`
  // first, so on this runtime it never reads the fallback table at all: an
  // over-broad entry in that table is invisible here unless
  // `directionFromSubtags` is called directly. (Found by mutation -- adding
  // `"ku"` to the table left this test green until the second half existed.)
  for (const tag of ["en-US", "de-DE", "ja-JP", "ku", "uz", "az"]) {
    assert.equal(localeDirection(tag), "ltr", `${tag} is not right-to-left`);
    assert.equal(
      directionFromSubtags(tag),
      "ltr",
      `the fallback table claims ${tag} is right-to-left`,
    );
  }
  for (const absent of [undefined, null, "", "   "]) {
    assert.equal(localeDirection(absent), "ltr");
  }
});

test("an unparseable locale does not throw", () => {
  // `new Intl.Locale` raises a RangeError on a structurally invalid tag, and
  // this runs in the root layout: a throw here is a blank app.
  for (const tag of ["not a tag", "en_US_", "--", "x"]) {
    assert.equal(localeDirection(tag), "ltr", `${tag} must fall back to ltr`);
  }
});

test("right-to-left locales this app does not ship yet are still detected", () => {
  // The reason the direction is derived rather than listed as `["ar-SA"]`:
  // adding Hebrew or Farsi must not need a second edit somewhere else.
  for (const tag of [
    "he-IL",
    "fa-IR",
    "ur-PK",
    "ps-AF",
    "ckb-IQ",
    "dv-MV",
    "ku-Arab-IQ",
    "uz-Arab-AF",
  ]) {
    assert.equal(localeDirection(tag), "rtl", `${tag} is right-to-left`);
  }
});

test("the subtag fallback agrees with Intl on every shipped locale", () => {
  // `directionFromSubtags` is the only path on an engine without
  // `Intl.Locale.prototype.getTextInfo` -- Firefox and older WebKit, and Tauri
  // takes whatever webview the host OS ships. If the two disagree, those users
  // get a different layout from everyone else and no other test would notice.
  for (const tag of availableLanguages) {
    assert.equal(
      directionFromSubtags(tag),
      localeDirection(tag),
      `the fallback table disagrees with CLDR about ${tag}`,
    );
  }
});

test("the subtag fallback agrees with Intl beyond the shipped locales", () => {
  for (const tag of [
    "he-IL",
    "fa-IR",
    "ur-PK",
    "ps-AF",
    "ckb-IQ",
    "dv-MV",
    "ug-CN",
    "sd-PK",
    "yi",
    "nqo",
    "ku-Arab-IQ",
    "uz-Arab-AF",
    "ku",
    "uz",
    "az",
    "kk",
    "tr-TR",
    "pt-BR",
  ]) {
    assert.equal(
      directionFromSubtags(tag),
      localeDirection(tag),
      `the fallback table disagrees with CLDR about ${tag}`,
    );
  }
});

test("the boot script sets the same direction the module would", () => {
  // Two implementations of one decision. This is the pair that drifts.
  for (const tag of [...availableLanguages, "he-IL", "ku-Arab-IQ", "ku"]) {
    const applied = runBootScript(tag);
    assert.equal(
      applied.dir,
      localeDirection(tag),
      `the boot script and localeDirection disagree about ${tag}`,
    );
    assert.equal(applied.lang, tag);
  }
});

test("the boot script reads the locale key the app writes", () => {
  // `changeLanguageTransaction` and `readSavedLocale` both use "locale". A
  // boot script reading anything else is a silent no-op on every cold start.
  const applied = runBootScript("ar-SA");
  assert.deepEqual(applied.getItemCalls, ["locale"]);
});

test("the boot script leaves the attributes alone with no stored locale", () => {
  // Nothing stored means the build-time defaults in `app/layout.tsx` are
  // already right, and `lang=""` would be worse than leaving them be.
  const applied = runBootScript(null);
  assert.ok(applied.lang === undefined);
  assert.ok(applied.dir === undefined);
});

test("the root layout mounts the thing that applies the direction", () => {
  assert.match(
    ROOT_LAYOUT,
    /<DocumentDirection>/u,
    "nothing would react to a language change without it mounted",
  );
});

test("the root layout puts the direction provider above the app", () => {
  // It publishes the direction to Radix through a React context, and a context
  // provider that is a *sibling* of the app provides nothing to it. Mounting
  // it beside `{children}` instead of around them would leave every Radix
  // menu laying itself out for LTR with no test to notice.
  const open = ROOT_LAYOUT.indexOf("<DocumentDirection>");
  const children = ROOT_LAYOUT.indexOf("{children}");
  const close = ROOT_LAYOUT.indexOf("</DocumentDirection>");
  assert.ok(open >= 0, "app/layout.tsx must mount <DocumentDirection>");
  assert.ok(children > open, "{children} must be inside the provider");
  assert.ok(close > children, "the provider must close after {children}");
});

test("the root layout runs the boot script before the first paint", () => {
  assert.match(
    ROOT_LAYOUT,
    /dangerouslySetInnerHTML=\{\{\s*__html:\s*LOCALE_DIRECTION_BOOT_SCRIPT\s*\}\}/u,
    "without the inline script an Arabic user watches the app paint LTR and flip",
  );
});

/**
 * Open a real app menu inside the provider and hand back its content element.
 *
 * `LanguageSelector` rather than a menu assembled here out of the primitives:
 * it is the control a user actually reaches for to switch to Arabic, and a
 * synthetic tree built by importing `src/components/ui/DropdownMenu` through a
 * relative path while the app imports it through the `@/` alias threw
 * ``MenuPortal` must be used within `Menu`` -- the two specifiers do not share
 * a module instance here, so Radix's scoped context did not match. Going
 * through a component that imports the alias itself keeps one instance.
 */
async function openMenuUnderProvider(): Promise<HTMLElement> {
  render(
    <DocumentDirection>
      <LanguageSelector />
    </DocumentDirection>,
  );
  // By role alone, with no name: `LanguageSelector` renders exactly one button
  // before the menu opens, and its `aria-label` is translated -- under `ar-SA`
  // it reads "اختر اللغة", so matching the English name fails in the one test
  // that matters most here.
  fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
  return await screen.findByRole("menu");
}

test("Radix menus are told the document direction", async () => {
  // `useDirection()` in @radix-ui/react-direction is
  // `localDir || globalDir || "ltr"` -- a React context that never reads
  // `document.dir`. So `dir="rtl"` on `<html>` does not reach Radix at all,
  // and without the provider a menu anchors `align="end"` against the wrong
  // edge, opens submenus the wrong way and does not swap the arrow keys.
  await switchLanguage("ar-SA");
  const content = await openMenuUnderProvider();
  assert.equal(content.getAttribute("dir"), "rtl");
});

test("Radix menus lay out left-to-right for English", async () => {
  const content = await openMenuUnderProvider();
  assert.equal(content.getAttribute("dir"), "ltr");
});

test("the swipe that dismisses a toast follows the direction", async () => {
  // The viewport is pinned to the trailing edge, so in RTL that is the left
  // one and dismissing is a leftward swipe. Radix defaults to "right", which
  // in RTL asks the user to swipe *into* the screen.
  await switchLanguage("ar-SA");
  render(
    <DocumentDirection>
      <ToastProvider>
        <Toast open data-testid="direction-probe-toast">
          <ToastTitle>Saved</ToastTitle>
        </Toast>
        <ToastViewport />
      </ToastProvider>
    </DocumentDirection>,
  );

  // Not `getByRole("status")`: Radix gives that role to its hidden announce
  // region as well as to the toast, and the announce region carries no swipe
  // attributes, so the obvious query reads `null` off the wrong element.
  const toast = await screen.findByTestId("direction-probe-toast");
  assert.equal(toast.getAttribute("data-swipe-direction"), "left");
});

test("the toast viewport and its close button use logical insets", () => {
  // `end-3` positions the viewport and `pe-9` reserves the room that
  // `ToastClose` occupies at `end-2`. All three have to be logical together:
  // one physical survivor puts the close button on top of the text in RTL.
  assert.match(TOAST_SOURCE, /\bsm:start-auto\b/u);
  assert.match(TOAST_SOURCE, /\bsm:end-3\b/u);
  assert.match(TOAST_SOURCE, /\bpe-9\b/u);
  assert.match(TOAST_SOURCE, /\bend-2\b/u);
  for (const physical of [
    /\bsm:left-auto\b/u,
    /\bsm:right-3\b/u,
    /\bpr-9\b/u,
    /\bright-2\b/u,
  ]) {
    assert.doesNotMatch(
      TOAST_SOURCE,
      physical,
      `${String(physical)} does not flip with the document direction`,
    );
  }
});

test("the toast keyframes travel along the direction token", () => {
  // The other half of the same change. `translateX` has no logical form and a
  // keyframe cannot be selected by direction, so the offset is a token.
  assert.match(APP_CSS, /:root\s*\{[^}]*--ui-toast-enter-x:\s*100%/su);
  assert.match(
    APP_CSS,
    /:root\[dir="rtl"\]\s*\{[^}]*--ui-toast-enter-x:\s*-100%/su,
  );
  const enters = APP_CSS.match(
    /@keyframes uiToast(?:In|Out)\s*\{[^@]*?translateX\(var\(--ui-toast-enter-x\)\)/gsu,
  );
  assert.equal(
    enters?.length,
    2,
    "both uiToastIn and uiToastOut must read the token",
  );
  assert.doesNotMatch(
    APP_CSS,
    /@keyframes uiToast(?:In|Out)\s*\{[^@]*?translateX\(-?100%\)/su,
    "a hardcoded offset in either keyframe sends toasts in from the wrong edge",
  );
});

test("the menu gutter override names the class the menus actually use", () => {
  // `.ui-entry`'s `padding` shorthand is emitted after Tailwind's utilities in
  // the same layer at equal specificity, so it wins and the gutter utility
  // needs a compound `!important` override to land. That makes the class name
  // in `src/index.css` load-bearing, and it had drifted: the primitives moved
  // to `pl-7` and the override stayed on `pl-8`, so the check gutter silently
  // collapsed to 0.5rem and the indicator at `left-1.5` sat on the label.
  //
  // This is also the guard the RTL sweep needs. Converting those call sites to
  // `ps-7` fails here until `src/index.css` grows a matching
  // `.ui-entry.ps-7`, which is exactly the silent breakage that would
  // otherwise ship.
  //
  // Both inline sides are swept, not just the start. `select.tsx` moved its
  // tick to the end of the row on 2026-10-11, so `pe-7` now carries a gutter
  // and is defeated by the shorthand in exactly the same way `pl-7` was. A
  // start-only sweep would have called that file compliant while its labels
  // ran under the tick — the same false pass this test was written for, one
  // axis over.
  const PADDING_PROPERTY: Record<string, string> = {
    ps: "padding-inline-start",
    pl: "padding-left",
    pe: "padding-inline-end",
    pr: "padding-right",
  };
  const used = new Set(
    [...MENU_PRIMITIVES.matchAll(/\b(p[slre])-(\d+)\b/gu)].map(
      ([, prefix, step]) => `${prefix}-${step}`,
    ),
  );
  assert.ok(used.size > 0, "the menu primitives must set a gutter at all");

  for (const utility of used) {
    const [prefix, step] = utility.split("-");
    const property = PADDING_PROPERTY[prefix];
    assert.match(
      APP_CSS,
      new RegExp(
        `\\.ui-entry\\.${prefix}-${step}\\s*\\{[^}]*${property}:[^}]*!important`,
        "su",
      ),
      `${utility} is used on a .ui-entry but src/index.css has no override that reaches it, so the gutter is whatever .ui-entry's shorthand says`,
    );
  }
});

test("the restored gutter is the width the indicator was placed for", () => {
  // 1.75rem is `pl-7` at the default `--spacing: 0.25rem`, i.e. the 28px the
  // three primitives' notes reason about against a 14px indicator. A smaller
  // value puts the glyph back under the text.
  assert.match(
    APP_CSS,
    /\.ui-entry\.pl-7\s*\{[^}]*padding-left:\s*1\.75rem\s*!important/su,
  );
});

test("the root layout declares the no-preference defaults on <html>", () => {
  const openingTag = /<html[^>]*>/u.exec(ROOT_LAYOUT);
  assert.ok(openingTag, "app/layout.tsx must render the <html> element");
  const [tag] = openingTag;

  // `en-US` rather than `en`: that is the bundle `src/i18n.ts` initialises
  // with, so the build-time attribute and the client's first answer agree.
  assert.match(tag, /lang="en-US"/u);
  assert.match(tag, /dir="ltr"/u);
  // Both attributes are corrected by the boot script before React hydrates.
  // Without this, React replaces them with the ones in the JSX and the
  // correction is lost on a cold start in any RTL locale.
  assert.match(
    tag,
    /suppressHydrationWarning/u,
    "React would otherwise overwrite what the boot script set",
  );
});
