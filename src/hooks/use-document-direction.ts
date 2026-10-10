import { useLayoutEffect } from "react";

import i18n from "@/i18n";
import {
  localeDirection,
  type TextDirection,
} from "@/components/i18n/locale-direction";
import { useI18n } from "@/hooks/use-i18n";

/**
 * Put `lang` and `dir` on `<html>` for one locale.
 *
 * `dir` is the whole point: it is what makes the browser lay the app out
 * right-to-left for Arabic, and what Tailwind's logical utilities
 * (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`) read. `lang` goes with it
 * because it is what screen readers pick a voice from and what the font and
 * hyphenation stacks key off; shipping twelve locales under `lang="en"` told
 * every assistive technology the wrong thing.
 *
 * Exported so a test can assert the DOM effect without rendering a tree.
 */
export function applyDocumentDirection(locale: string): TextDirection {
  const direction = localeDirection(locale);
  const root = document.documentElement;
  root.lang = locale;
  root.dir = direction;
  return direction;
}

/**
 * Keep `<html lang>`/`<html dir>` tracking the active i18next language.
 *
 * Mounted once, by `<DocumentDirection />` in the root layout. There are three
 * things going on and all three are load-bearing:
 *
 * 1. **Why not the server?** `app/layout.tsx` is a server component and the
 *    app is an `output: "export"` static build, so the HTML is rendered once,
 *    at build time, for every user. The locale lives in `localStorage` and in
 *    the desktop preference store. The server cannot know it, so interpolating
 *    it into the server-rendered `<html>` is not an option -- the attributes
 *    have to be set on the client.
 *
 * 2. **Why `useLayoutEffect`?** The boot script in the root layout has already
 *    set both attributes before the first paint, so this hook is not what
 *    prevents the flash. What it handles is the *change* -- a user picking a
 *    language from the selector -- and React's Strict Mode remount, which is
 *    on in `next.config.mjs`: on that remount React resets `<html>` to the
 *    attributes it manages from JSX and silently drops the ones the script
 *    set. `useLayoutEffect` runs before paint, so the correction is not
 *    visible. (This is the shape Next's own
 *    `preventing-flash-before-hydration` guide prescribes.)
 *
 * 3. **Why the resolved language?** `i18n.language` is what was *asked* for;
 *    `i18n.resolvedLanguage` is the bundle that will actually render. They
 *    differ when a stored preference names a locale this app does not ship
 *    (the desktop preference path in `src/App.tsx` writes `pref.locale`
 *    through without validating it against the resources). `dir` has to
 *    describe the text that is on screen, which is the resolved one -- marking
 *    an English fallback bundle as `dir="rtl"` would be a new bug, not a fix.
 *
 * The direction is also *returned*, because `<html dir>` is not the only thing
 * that needs it: Radix's primitives read direction from a React context and
 * never look at the document (see `DocumentDirection`). Computing it once here
 * and handing it to both is what stops the attribute and the context
 * disagreeing.
 */
export function useDocumentDirection(): TextDirection {
  const { language } = useI18n();
  // Before `init()` resolves, i18next reports no language at all. `undefined`
  // yields `"ltr"`, which is both the HTML default and what the server-rendered
  // attribute already says, so the first client render agrees with the markup
  // it is hydrating.
  const active = i18n.resolvedLanguage ?? language;
  const direction = localeDirection(active);

  useLayoutEffect(() => {
    // No language yet: leave the attributes alone rather than writing an empty
    // `lang`. Whatever the boot script decided is a better guess.
    if (!active) return;
    applyDocumentDirection(active);
  }, [active]);

  return direction;
}
