/**
 * The filenames in the sync copy are the filenames on disk, in all twelve
 * locales.
 *
 * One paragraph on the sync screen sends the user to go and look in their own
 * folder. The names in it therefore have to be the names the app writes, and a
 * literal filename is deliberately *not* localised — a translator carries it
 * through unchanged — so a wrong name is wrong identically in every language
 * and reads as authoritative in all of them. An earlier draft of that
 * paragraph invented `vault (1).enc`, a name no sync client could produce, and
 * it shipped in twelve locales before two translators queried it.
 *
 * ## What this adds over the guard that already exists
 *
 * `test/SyncSettings.test.tsx` pins these names, but only for English: it
 * renders the panel under `useEnglishLocale` and asserts on the text that comes
 * out. A locale whose translation drops or mangles a filename passes it, and
 * eleven of the twelve files are never looked at.
 *
 * It also pins against `src/lib/sync/types.ts`, which is a **TypeScript
 * re-declaration** of the names. The files are written by Rust:
 * `SYNC_BLOB_NAME` and `SYNC_MANIFEST_NAME` in `bc-sync/src/payload.rs` are
 * what ends up on disk. So renaming the Rust constant and forgetting the
 * TypeScript copy leaves every test in the project green while the app writes
 * a file its own copy does not mention. This reads the Rust, and checks the
 * TypeScript mirror against it, which closes that drift as well.
 *
 * Reading from Rust also means a rename fails here by name — "the catalogue
 * still describes better-cloudflare-vault.enc" — instead of leaving twelve
 * translations quietly describing files that no longer exist. The constants are
 * effectively frozen, because renaming either orphans every vault anyone has
 * already synced, but that migration would have to rewrite this sentence and
 * this is what makes that a named failure rather than a silent one.
 *
 * ## Why the requirement is derived rather than listed
 *
 * The names are not spelled out here a third time. They come out of the Rust,
 * and which names a given sentence has to carry is read from the English key
 * itself — a key that mentions the manifest must have the manifest in all
 * twelve values. Spelling them out would make this a hand-written list checked
 * against a hand-written list, which is two copies of the same mistake.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  SYNC_BLOB_NAME as TS_BLOB_NAME,
  SYNC_MANIFEST_NAME as TS_MANIFEST_NAME,
} from "../src/lib/sync/types";
import {
  BASE_LOCALE,
  localeNames,
  readLocale,
} from "../scripts/i18n-coverage.mjs";

const ROOT = join(import.meta.dirname, "..");
const PAYLOAD_RS = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-sync",
  "src",
  "payload.rs",
);

/**
 * One `pub const NAME: &str = "…";` out of the Rust that writes the file.
 *
 * Throws rather than returning null when the constant is gone: a rename that
 * this cannot find must fail loudly here, not quietly degrade into checking
 * nothing.
 */
function rustStringConstant(name: string): string {
  const source = readFileSync(PAYLOAD_RS, "utf8");
  const found = new RegExp(
    `pub const ${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"\\s*;`,
    "u",
  ).exec(source);
  assert.ok(
    found,
    `${name} is not a string constant in bc-sync/src/payload.rs any more. If it was renamed or moved, the sync copy in all twelve locales names a file that no longer exists — update the copy, then this test.`,
  );
  return found[1];
}

const SYNC_BLOB_NAME = rustStringConstant("SYNC_BLOB_NAME");
const SYNC_MANIFEST_NAME = rustStringConstant("SYNC_MANIFEST_NAME");

/**
 * The conflict copy a sync client leaves beside the blob.
 *
 * Derived from the blob name rather than written out, because the whole point
 * of the original defect was a stand-in that looked plausible and could not
 * exist. Windows, macOS and the Dropbox/Drive/Nextcloud clients all build this
 * by inserting ` (n)` before the extension.
 */
const CONFLICT_COPY_NAME = SYNC_BLOB_NAME.replace(/\.enc$/u, " (1).enc");

const REQUIRED_NAMES = [
  SYNC_BLOB_NAME,
  SYNC_MANIFEST_NAME,
  CONFLICT_COPY_NAME,
] as const;

test("the TypeScript filename constants match the Rust that writes the files", () => {
  // `src/lib/sync/types.ts` re-declares both names so the frontend can talk
  // about them. Nothing else makes the two copies agree, and the existing
  // English-only guard pins the copy against the *TypeScript* one, so a Rust
  // rename with a forgotten mirror would leave that guard green.
  assert.equal(
    TS_BLOB_NAME,
    SYNC_BLOB_NAME,
    "src/lib/sync/types.ts and bc-sync/src/payload.rs disagree about the blob filename, so the UI names a file the backend does not write",
  );
  assert.equal(
    TS_MANIFEST_NAME,
    SYNC_MANIFEST_NAME,
    "src/lib/sync/types.ts and bc-sync/src/payload.rs disagree about the manifest filename, so the UI names a file the backend does not write",
  );
});

test("the conflict-copy example is derived from the blob name, not invented", () => {
  // Pins the shape of the stand-in itself. `vault (1).enc` passed review once
  // because it looks like a filename; what makes it wrong is that it is not
  // this app's filename with a number added.
  assert.equal(
    CONFLICT_COPY_NAME,
    `${SYNC_BLOB_NAME.replace(/\.enc$/u, "")} (1).enc`,
    "the conflict-copy example is no longer the blob name with a number inserted before the extension",
  );
  assert.ok(
    CONFLICT_COPY_NAME.startsWith(SYNC_BLOB_NAME.replace(/\.enc$/u, "")),
    `the conflict-copy example ${CONFLICT_COPY_NAME} is not a name any sync client would produce from ${SYNC_BLOB_NAME}`,
  );
});

test("every filename the catalogue names is one the app writes", () => {
  // The reverse direction: not "is the real name present" but "is a name
  // present that is not real". This is what would have caught `vault (1).enc`
  // at the moment it was written, because that string is a vault filename by
  // shape and is not one of the three.
  const base = readLocale(BASE_LOCALE) as Record<string, string>;
  // One vault filename token: the name, an optional ` (n)` conflict suffix,
  // and the extension. The lookbehind and the restricted character class keep
  // a match to a single token — a first attempt allowed spaces throughout and
  // greedily swallowed half a sentence, which made this test pass by matching
  // nothing a filename test should look at.
  const filenameShaped =
    /(?<![\w.-])[\w.-]*vault[\w.-]*(?: \(\d+\))?\.(?:enc|json)/giu;
  const wrong: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    for (const text of [key, value]) {
      for (const match of String(text).matchAll(filenameShaped)) {
        const named = match[0];
        if ((REQUIRED_NAMES as readonly string[]).includes(named)) continue;
        // Deliberately no "but it looks close enough" escape here. `vault
        // (1).enc` is a vault filename by shape and is not one of the three,
        // which is the whole defect; a guard that only flagged names already
        // built on this app's stem would have skipped it.
        wrong.push(
          `  ${JSON.stringify(named)} in ${JSON.stringify(key.slice(0, 60))}…`,
        );
      }
    }
  }
  assert.equal(
    wrong.length,
    0,
    `the catalogue names ${wrong.length} vault file(s) this app never writes. A filename is carried through untranslated, so this is wrong identically in all twelve locales:\n${wrong.join("\n")}`,
  );
});

test("all twelve locales carry every filename their English names", () => {
  // The gap this exists for. The English copy is already pinned by
  // `test/SyncSettings.test.tsx`; nothing checks that a translator kept the
  // names, and a filename is the one part of a sentence they must not touch.
  const base = readLocale(BASE_LOCALE) as Record<string, string>;
  const carrying = Object.keys(base).filter((key) =>
    REQUIRED_NAMES.some((name) => key.includes(name)),
  );

  // Each of the three has to be somewhere in the catalogue, or this test is
  // asserting over an empty set and would pass if the copy were deleted.
  for (const name of REQUIRED_NAMES) {
    assert.ok(
      carrying.some((key) => key.includes(name)),
      `no catalogued string names ${name}. Either the sync copy that sends the user to look in their folder is gone, or it no longer names the file — both leave the user hunting for a file by a name nothing told them.`,
    );
  }

  const broken: string[] = [];
  for (const localeName of localeNames()) {
    const data = readLocale(localeName) as Record<string, string>;
    for (const key of carrying) {
      // Which names *this* sentence has to carry, read from the English.
      const required = REQUIRED_NAMES.filter((name) => key.includes(name));
      const value = data[key];
      if (value === undefined) {
        // Absence is `i18nCoverage.contract`'s to report; this test is about a
        // translation that is present and has lost a filename.
        continue;
      }
      const missing = required.filter((name) => !String(value).includes(name));
      if (missing.length > 0) {
        broken.push(
          `  ${localeName}: lost ${missing.map((name) => JSON.stringify(name)).join(", ")} from ${JSON.stringify(key.slice(0, 50))}…`,
        );
      }
    }
  }
  assert.equal(
    broken.length,
    0,
    `${broken.length} translation(s) dropped or altered a filename, so they send the user looking for a file that does not exist:\n${broken.join("\n")}`,
  );
});
