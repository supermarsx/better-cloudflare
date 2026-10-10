/**
 * Which way a locale's text runs, and the boot script that applies it before
 * the first paint.
 *
 * `<html dir>` is the switch that decides whether the whole app is laid out
 * left-to-right or right-to-left. It was never set, so `ar-SA` -- one of the
 * twelve locales this app ships -- rendered Arabic inside an LTR layout:
 * trailing Latin runs (a filename at the end of a sentence) jumped to the
 * visual start of the line, and interior Latin runs reordered the Arabic
 * clauses either side of them.
 *
 * The direction is *derived*, not listed. A hardcoded `["ar-SA"]` would be
 * wrong the first time Hebrew or Farsi is added and nothing would catch it, so
 * the primary source is `Intl.Locale`'s text info, which is CLDR data. The
 * subtag table below is only the fallback for engines that do not expose it
 * (`getTextInfo()` is Chrome 130+ / Safari 17+; the pre-standard `textInfo`
 * getter covers Chrome 99-129; Firefox was later still). Tauri's webview is
 * whatever the host OS ships, so "the browser supports it" is not something
 * this code gets to assume.
 *
 * `test/documentDirection.test.tsx` asserts the two paths agree, both across
 * every locale in `availableLanguages` and across the RTL languages that are
 * not shipped yet -- so the fallback cannot drift from CLDR unnoticed.
 */

export type TextDirection = "ltr" | "rtl";

/**
 * Primary language subtags whose default script is right-to-left, lowercased
 * because that is how they arrive after `toLowerCase()`.
 *
 * Checked against `Intl.Locale(...).getTextInfo().direction` by the test, so
 * this is CLDR's answer rather than a guess. It is deliberately not
 * exhaustive: the dead scripts (Avestan, Phoenician, Old Hungarian) are left
 * to {@link RTL_SCRIPT_SUBTAGS}, which catches anything written in an RTL
 * script whatever its language. `ku`, `uz` and `az` are absent on purpose --
 * their default script is Latin, and only the explicit `-Arab` forms are RTL.
 */
const RTL_LANGUAGE_SUBTAGS = [
  "ar",
  "arc",
  "azb",
  "bal",
  "bcc",
  "bgn",
  "bqi",
  "ckb",
  "dv",
  "fa",
  "glk",
  "he",
  "iw",
  "ji",
  "khw",
  "ks",
  "lki",
  "lrc",
  "mde",
  "mzn",
  "nqo",
  "pnb",
  "prs",
  "ps",
  "sd",
  "sdh",
  "skr",
  "syr",
  "ug",
  "ur",
  "yi",
] as const;

/**
 * Script subtags that are right-to-left regardless of language, lowercased for
 * the same reason. This is what makes `ku-Arab` or `uz-Arab` come out RTL
 * while bare `ku` and `uz` stay LTR.
 */
const RTL_SCRIPT_SUBTAGS = [
  "adlm",
  "arab",
  "aran",
  "hebr",
  "mand",
  "mend",
  "nkoo",
  "rohg",
  "samr",
  "syrc",
  "thaa",
  "yezi",
] as const;

/**
 * Direction from the tag's own subtags, with no `Intl` involved.
 *
 * The fallback half of {@link localeDirection}, exported so the test can
 * exercise it directly instead of having to take `Intl.Locale` away from the
 * runtime to reach it.
 */
export function directionFromSubtags(locale: string): TextDirection {
  const subtags = locale.toLowerCase().split(/[-_]/);
  const [language] = subtags;
  if (RTL_LANGUAGE_SUBTAGS.some((subtag) => subtag === language)) return "rtl";
  if (subtags.some((part) => RTL_SCRIPT_SUBTAGS.some((s) => s === part))) {
    return "rtl";
  }
  return "ltr";
}

type LegacyTextInfoLocale = Intl.Locale & {
  /** Pre-standard getter, shipped before `getTextInfo()` existed. */
  textInfo?: Intl.TextInfo;
};

/** Direction from CLDR via `Intl`, or `undefined` if this engine cannot say. */
function directionFromIntl(locale: string): TextDirection | undefined {
  try {
    const resolved = new Intl.Locale(locale) as LegacyTextInfoLocale;
    // TypeScript's `lib.esnext.intl` declares `getTextInfo` unconditionally;
    // the runtime does not necessarily have it, hence the `typeof` guard.
    const info =
      typeof resolved.getTextInfo === "function"
        ? resolved.getTextInfo()
        : resolved.textInfo;
    const direction = info?.direction;
    return direction === "rtl" || direction === "ltr" ? direction : undefined;
  } catch {
    // `new Intl.Locale` throws a RangeError on a structurally invalid tag.
    return undefined;
  }
}

/**
 * The direction to lay a locale's text out in.
 *
 * Anything unparseable or missing is `"ltr"`, which is both the HTML default
 * and the direction of the `en-US` fallback bundle i18next serves when it
 * cannot resolve a language.
 */
export function localeDirection(
  locale: string | null | undefined,
): TextDirection {
  if (typeof locale !== "string" || locale.trim() === "") return "ltr";
  const tag = locale.trim();
  return directionFromIntl(tag) ?? directionFromSubtags(tag);
}

/** The `localStorage` key `src/i18n.ts` reads the saved locale from. */
export const LOCALE_STORAGE_KEY = "locale";

/**
 * A synchronous script for `<head>`, which sets `lang` and `dir` while the
 * browser is still parsing the HTML.
 *
 * Without it the attributes can only be corrected after hydration, and an
 * Arabic user watches the app paint left-to-right and then flip. The app is a
 * static export, so the server has no idea which locale this user picked --
 * the stored preference is the only thing that knows, and only the client can
 * read it. Next's own guidance for exactly this case is an inline script; see
 * `node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`.
 *
 * It is generated from the tables above rather than hand-written so the two
 * copies of the fallback cannot drift apart, and it reads the same storage key
 * as `readSavedLocale` in `src/i18n.ts` so the two cannot disagree about where
 * the preference lives. `test/documentDirection.test.tsx` evaluates this
 * string and compares its answers against {@link localeDirection}.
 *
 * Everything is wrapped in `try`/`catch`: `localStorage` throws outright in a
 * locked-down webview, and a boot script that can throw is a blank app.
 */
export const LOCALE_DIRECTION_BOOT_SCRIPT = [
  "(function(){try{",
  `var tag=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)});`,
  "if(!tag)return;",
  "var dir;",
  "try{",
  "var loc=new Intl.Locale(tag);",
  'var info=typeof loc.getTextInfo==="function"?loc.getTextInfo():loc.textInfo;',
  "dir=info&&info.direction;",
  "}catch(e){}",
  'if(dir!=="rtl"&&dir!=="ltr"){',
  "var parts=String(tag).toLowerCase().split(/[-_]/);",
  `var langs=${JSON.stringify(RTL_LANGUAGE_SUBTAGS)};`,
  `var scripts=${JSON.stringify(RTL_SCRIPT_SUBTAGS)};`,
  "dir=langs.indexOf(parts[0])>=0||parts.some(function(p){",
  "return scripts.indexOf(p)>=0;",
  '})?"rtl":"ltr";',
  "}",
  "var root=document.documentElement;",
  "root.lang=tag;",
  "root.dir=dir;",
  "}catch(e){}})()",
].join("");
