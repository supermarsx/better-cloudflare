/**
 * A reworded English *value* under an unchanged key, and the eleven stale
 * translations it leaves behind.
 *
 * This is the one i18n defect `i18nCoverage.contract.test.ts` cannot see, and
 * the reason is structural rather than an oversight. Every check there is
 * keyed on the key: a locale is "missing" a key, carries an "extra" one, or
 * changed its placeholders. Reword the English value and the key does not
 * move — so nothing is missing, nothing is extra, the placeholder sets still
 * match, and eleven locales go on cheerfully saying the old thing.
 *
 * ## How a candidate is found without consulting git
 *
 * `fill-base` writes `value === key`. So any base entry whose value *differs*
 * from its key was hand-written or hand-reworded, and that is the only place
 * this defect can hide. The credit for that observation belongs to the agent
 * translating ar-SA; it is better than the approach I used first, which diffed
 * en-US against HEAD and therefore could only ever catch a rewording made in
 * the current working tree.
 *
 * ## Two checks, because a candidate is not a defect
 *
 * Most candidates are deliberate: the `SRV port` → `"port"` convention names
 * the record type in the key and shows the bare field name on screen, and the
 * `TTL select` → `"TTL"` convention keeps the control's role out of the label
 * because a screen reader announces the role itself. So the first test pins
 * the *set* of candidates: adding one fails here, which is the prompt to go
 * and update eleven translations.
 *
 * The second test looks for the fingerprint of an actual stale translation. A
 * rewording that adds a Latin token -- "DNS", a product name, an acronym --
 * leaves that token visible in the locales that were updated and absent from
 * the ones that were not. Unanimity proves nothing in either direction; a
 * *split* is the tell. `"Import Records from JSON format"` was found this way:
 * its English had gained "DNS", three locales carried it and eight did not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  BASE_LOCALE,
  localeNames,
  readLocale,
} from "../scripts/i18n-coverage.mjs";

const base = readLocale(BASE_LOCALE) as Record<string, string>;
const translations = localeNames()
  .filter((name: string) => name !== BASE_LOCALE)
  .map((name: string) => ({
    name,
    data: readLocale(name) as Record<string, string>,
  }));

/** Base entries whose value differs from the key `fill-base` would have written. */
function rewordedKeys(): string[] {
  return Object.keys(base)
    .filter((key) => typeof base[key] === "string" && base[key] !== key)
    .sort();
}

/**
 * Every base key whose displayed value deliberately differs from its key.
 *
 * Two conventions and two one-offs. Keep it sorted, and when you add an entry,
 * update all eleven translations in the same change -- that is the entire
 * point of this list existing.
 */
const INTENTIONAL_REWORDS: readonly string[] = [
  // Accessibility labels. The key describes the control; the value is what a
  // screen reader announces, and it omits the role because the reader
  // announces that itself -- "TTL, combo box", not "TTL select, combo box".
  "Content input",
  "Default content input",
  "Name input",
  "SPF input",
  "TTL select",
  // A placeholder, not a label: the key says what it is, the value is the
  // prompt shown inside the empty field.
  "Password (placeholder)",
  // Structured-record field labels. The key names the record type so the key
  // is unique across types; the value is the bare field name, because the
  // surrounding form already says which record is being built.
  "NAPTR flags",
  "NAPTR order",
  "NAPTR preference",
  "NAPTR regexp",
  "NAPTR replacement",
  "NAPTR service",
  "SRV port",
  "SRV priority",
  "SRV target",
  "SRV weight",
  "SSHFP algorithm",
  "SSHFP fingerprint",
  "SSHFP fptype",
  "TLSA data",
  "TLSA matching type",
  "TLSA selector",
  "TLSA usage",
  // Reworded after the fact: the English gained "DNS" to distinguish it from
  // importing other things.
  "Import Records from JSON format",
].toSorted();

test("the set of reworded base values is the one we know about", () => {
  const found = rewordedKeys();
  const added = found.filter((key) => !INTENTIONAL_REWORDS.includes(key));
  const gone = INTENTIONAL_REWORDS.filter((key) => !found.includes(key));

  assert.deepEqual(
    added,
    [],
    `these base values differ from their keys and are not in INTENTIONAL_REWORDS:\n${added
      .map((key) => `  ${JSON.stringify(key)} -> ${JSON.stringify(base[key])}`)
      .join(
        "\n",
      )}\n\nIf you reworded an English value, every locale still carries a translation of the OLD wording and no other test will tell you. Update all eleven, then add the key above.`,
  );
  assert.deepEqual(
    gone,
    [],
    `these keys are listed as reworded but their value now equals their key: ${gone.join(", ")}`,
  );
});

test("no reworded value is carried by some locales and not others", () => {
  // The fingerprint of a stale translation: a Latin token the rewording added,
  // present in the locales that were updated and missing from the ones that
  // were not.
  const split: string[] = [];

  for (const key of rewordedKeys()) {
    const keyWords = new Set(key.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const added = (base[key].match(/[A-Za-z0-9]+/g) ?? []).filter(
      (word) => word.length > 1 && !keyWords.has(word.toLowerCase()),
    );
    // Prefer an acronym: those survive translation verbatim, so their absence
    // is meaningful rather than a translator's choice.
    const probe = added.find((word) => /^[A-Z]{2,}$/.test(word)) ?? added[0];
    if (!probe) continue;

    const carrying = translations.filter(({ data }) =>
      String(data[key] ?? "").includes(probe),
    );
    if (carrying.length === 0 || carrying.length === translations.length) {
      continue;
    }
    split.push(
      `${JSON.stringify(key)} -> ${JSON.stringify(base[key])}\n` +
        `    ${JSON.stringify(probe)} is in ${carrying.map((l) => l.name).join(", ")}\n` +
        `    but not in ${translations
          .filter((l) => !carrying.includes(l))
          .map((l) => l.name)
          .join(", ")}`,
    );
  }

  assert.deepEqual(
    split,
    [],
    `these look like stale translations of a reworded English value:\n  ${split.join("\n  ")}`,
  );
});

/**
 * Two keys whose English *differs* must not share one translated value.
 *
 * This is the check that actually catches a stale translation, and it exists
 * because the token probe below does not. The agent translating pt-PT proved
 * that: it reverted pt-PT's `"Default content input"` to the old
 * `"Conteúdo"` -- the exact state the probe is named for -- and the probe
 * still passed. For that key every word of the reworded value already appears
 * in the key, which is the normal shape of an aria-label key, so the probe
 * finds no added token and skips the key before reading a single locale. It
 * can see 2 of the 24 reworded keys, and one of those is the case it was
 * built from.
 *
 * This check is language-agnostic, which is the other half of the point. The
 * probe needs a Latin token to look for, so it cannot reach ar-SA, hi-IN,
 * ja-JP, ko-KR, ru-RU or zh-CN at all unless the added word happens to be an
 * acronym. A collision is visible in any script.
 *
 * Scoped to groups that touch a reworded key. Across all keys there are ~161
 * collision groups and most are legitimate -- "Cancel" and "Revoke" share a
 * word in several languages, so do "Clear" and "Delete". Narrowing to the
 * keys where an English value was reworded is what makes it zero-noise.
 */
function normalizedEnglish(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

test("a reworded value does not read identically to another key's", () => {
  const reworded = new Set(rewordedKeys());
  const collisions: string[] = [];

  for (const { name, data } of translations) {
    const byTranslation = new Map<
      string,
      { english: Map<string, string>; keys: string[] }
    >();
    for (const key of Object.keys(base)) {
      const translated = data[key];
      if (typeof translated !== "string" || translated.length === 0) continue;
      // Annotated: an unannotated `keys: []` infers `never[]`, and the push
      // below then fails rather than the map being built.
      const group = byTranslation.get(translated) ?? {
        english: new Map<string, string>(),
        keys: [] as string[],
      };
      group.english.set(normalizedEnglish(base[key]), base[key]);
      group.keys.push(key);
      byTranslation.set(translated, group);
    }

    for (const [translated, group] of byTranslation) {
      // Same English rendered the same way is correct, not a collision.
      if (group.english.size < 2) continue;
      if (!group.keys.some((key) => reworded.has(key))) continue;
      collisions.push(
        `${name}: ${JSON.stringify(translated)} is used for ` +
          [...group.english.values()]
            .map((english) => JSON.stringify(english))
            .join(" and "),
      );
    }
  }

  assert.deepEqual(
    collisions,
    [],
    `these locales render two different English strings identically, around a key whose English was reworded -- the sign a translation was not updated with it:\n  ${collisions.join("\n  ")}`,
  );
});

test("the candidate scan would notice a rewording", () => {
  // The two tests above are only as good as `rewordedKeys`, and a scan that
  // silently matched nothing would report "no problems" just as loudly as a
  // clean tree does.
  assert.ok(
    rewordedKeys().length >= 20,
    `expected the known reworded conventions to be found, got ${rewordedKeys().length}`,
  );
  assert.equal(
    base["SRV port"],
    "port",
    "the SRV convention is the anchor this scan is calibrated against",
  );
  // And it must not simply flag everything: the great majority of base entries
  // are `value === key`.
  const total = Object.keys(base).length;
  assert.ok(
    rewordedKeys().length < total / 10,
    `${rewordedKeys().length} of ${total} entries differ from their key, which is too many to be the convention`,
  );
});

test("the locale files this test reads are the ones the app ships", () => {
  // Cheap guard against reading a stale or partial set, which would make both
  // checks above vacuous.
  assert.equal(translations.length, 11);
  assert.ok(
    fileURLToPath(new URL("../src/locales/en-US.json", import.meta.url))
      .length > 0,
  );
  assert.ok(
    Object.keys(base).length > 1000,
    "the base locale should be fully catalogued",
  );
});
