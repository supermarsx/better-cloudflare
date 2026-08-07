import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHARACTER_STRING_MAX_BYTES,
  characterStringByteLength,
  escapeCharacterString,
  hasUnbalancedQuotes,
  isNormalizedCharacterString,
  isQuotedForm,
  normalizeCharacterString,
  parseCharacterStrings,
  parseCharacterStringTokens,
  quoteCharacterString,
  splitCharacterString,
  unquoteCharacterString,
} from "../src/lib/dns/character-string";

const SPF = "v=spf1 include:_spf.example.com ~all";

test("parses every presentation shape of the same logical value", () => {
  const cases = [
    SPF,
    `"${SPF}"`,
    `  "${SPF}"  `,
    `"${SPF}`,
    `${SPF}"`,
    '"v=spf1 include:_spf.example.com" " ~all"',
  ];

  for (const raw of cases) {
    assert.equal(unquoteCharacterString(raw), SPF, raw);
  }
});

test("splits adjacent quoted strings and concatenates them without a separator", () => {
  assert.deepEqual(parseCharacterStrings('"part one" "part two"'), [
    "part one",
    "part two",
  ]);
  assert.equal(
    unquoteCharacterString('"part one" "part two"'),
    "part onepart two",
  );
  assert.deepEqual(parseCharacterStrings('"a"\t"b"  "c"'), ["a", "b", "c"]);
});

test("bare content is a single character-string and is never split on whitespace", () => {
  assert.deepEqual(parseCharacterStrings(SPF), [SPF]);
  assert.deepEqual(parseCharacterStrings("  hello   world  "), [
    "hello   world",
  ]);
});

test("repairs an unmatched leading quote", () => {
  assert.deepEqual(parseCharacterStrings('"v=DKIM1; k=rsa'), [
    "v=DKIM1; k=rsa",
  ]);
  assert.deepEqual(parseCharacterStrings('"first" "second'), [
    "first",
    "second",
  ]);
  assert.equal(normalizeCharacterString('"v=DKIM1; k=rsa'), '"v=DKIM1; k=rsa"');
});

test("repairs an unmatched trailing quote", () => {
  assert.deepEqual(parseCharacterStrings('v=DKIM1; k=rsa"'), [
    "v=DKIM1; k=rsa",
  ]);
  assert.equal(normalizeCharacterString('v=DKIM1; k=rsa"'), '"v=DKIM1; k=rsa"');
});

test("preserves escaped inner quotes instead of treating them as delimiters", () => {
  assert.deepEqual(parseCharacterStrings(String.raw`"he said \"hi\" once"`), [
    'he said "hi" once',
  ]);
  assert.equal(
    normalizeCharacterString(String.raw`"he said \"hi\" once"`),
    String.raw`"he said \"hi\" once"`,
  );
  // A quoted run that ends in an escaped quote is still balanced.
  assert.equal(hasUnbalancedQuotes(String.raw`"trailing \""`), false);
  assert.deepEqual(parseCharacterStrings(String.raw`"trailing \""`), [
    'trailing "',
  ]);
});

test("decodes and re-encodes backslash and decimal escapes", () => {
  assert.deepEqual(parseCharacterStrings(String.raw`"back\\slash"`), [
    String.raw`back\slash`,
  ]);
  assert.deepEqual(parseCharacterStrings(String.raw`"line\010break"`), [
    "line\nbreak",
  ]);
  assert.equal(
    normalizeCharacterString(String.raw`"back\\slash"`),
    String.raw`"back\\slash"`,
  );
  assert.equal(
    normalizeCharacterString("line\nbreak"),
    String.raw`"line\010break"`,
  );
  // Literal backslash before digits round-trips as an escaped backslash.
  assert.equal(
    unquoteCharacterString(normalizeCharacterString(String.raw`\010`)),
    String.raw`\010`,
  );
});

test("escapes unescaped inner quotes and backslashes on normalization", () => {
  assert.equal(escapeCharacterString(String.raw`a"b\c`), String.raw`a\"b\\c`);
  assert.equal(quoteCharacterString('say "hi"'), String.raw`"say \"hi\""`);
  assert.equal(
    normalizeCharacterString(String.raw`a"b\c`),
    String.raw`"a\"b\\c"`,
  );
});

test("handles empty and whitespace-only content", () => {
  for (const raw of ["", "   ", "\t\n ", undefined]) {
    assert.deepEqual(parseCharacterStrings(raw), []);
    assert.equal(unquoteCharacterString(raw), "");
    assert.equal(normalizeCharacterString(raw), '""');
    assert.equal(isQuotedForm(raw), false);
    assert.equal(isNormalizedCharacterString(raw), false);
  }

  assert.deepEqual(parseCharacterStrings('""'), [""]);
  assert.equal(normalizeCharacterString('""'), '""');
  assert.equal(isNormalizedCharacterString('""'), true);
});

test("preserves significant whitespace inside quotes", () => {
  assert.deepEqual(parseCharacterStrings('"  padded   value  "'), [
    "  padded   value  ",
  ]);
  assert.equal(
    normalizeCharacterString('"  padded   value  "'),
    '"  padded   value  "',
  );
  assert.deepEqual(parseCharacterStrings('"a  b" "  c"'), ["a  b", "  c"]);
});

test("detects quoted form and unbalanced quotes", () => {
  assert.equal(isQuotedForm(`"${SPF}"`), true);
  assert.equal(isQuotedForm(`"${SPF}`), true);
  assert.equal(isQuotedForm(`${SPF}"`), true);
  assert.equal(isQuotedForm(SPF), false);
  // Inner balanced quotes are content, not delimiters.
  assert.equal(isQuotedForm('v=DKIM1; p="abc"'), false);
  assert.deepEqual(parseCharacterStrings('v=DKIM1; p="abc"'), [
    'v=DKIM1; p="abc"',
  ]);

  assert.equal(hasUnbalancedQuotes(`"${SPF}`), true);
  assert.equal(hasUnbalancedQuotes(`${SPF}"`), true);
  assert.equal(hasUnbalancedQuotes(`"${SPF}"`), false);
  assert.equal(hasUnbalancedQuotes(SPF), false);
});

test("measures character-string length in UTF-8 bytes", () => {
  assert.equal(CHARACTER_STRING_MAX_BYTES, 255);
  assert.equal(characterStringByteLength("abc"), 3);
  assert.equal(characterStringByteLength("é"), 2);
  assert.equal(characterStringByteLength("😀"), 4);
  assert.equal(characterStringByteLength(""), 0);
  assert.equal(characterStringByteLength(undefined), 0);
});

test("keeps a 255 byte string whole and splits a 256 byte string", () => {
  const exact = "a".repeat(255);
  assert.equal(characterStringByteLength(exact), 255);
  assert.deepEqual(splitCharacterString(exact), [exact]);
  assert.equal(normalizeCharacterString(exact), `"${exact}"`);

  const oversized = "a".repeat(256);
  const chunks = splitCharacterString(oversized);
  assert.deepEqual(chunks, ["a".repeat(255), "a"]);
  assert.equal(normalizeCharacterString(oversized), `"${"a".repeat(255)}" "a"`);
});

test("splits on byte length without breaking multi-byte code points", () => {
  const twoByte = "é".repeat(128); // 256 bytes
  const chunks = splitCharacterString(twoByte);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "é".repeat(127));
  assert.equal(characterStringByteLength(chunks[0]), 254);
  assert.equal(chunks[1], "é");
  assert.equal(chunks.join(""), twoByte);

  // A 4-byte code point straddling the boundary moves to the next chunk whole.
  const withEmoji = `${"a".repeat(253)}😀`;
  const emojiChunks = splitCharacterString(withEmoji);
  assert.deepEqual(emojiChunks, ["a".repeat(253), "😀"]);
  for (const chunk of emojiChunks) {
    assert.ok(characterStringByteLength(chunk) <= 255);
  }
  assert.equal(emojiChunks.join(""), withEmoji);
  assert.equal(
    unquoteCharacterString(normalizeCharacterString(withEmoji)),
    withEmoji,
  );
});

test("adjacent quoted strings round-trip through normalization", () => {
  const value = `${"x".repeat(300)} tail`;
  const normalized = normalizeCharacterString(value);

  assert.equal(parseCharacterStrings(normalized).length, 2);
  assert.equal(unquoteCharacterString(normalized), value);
  assert.equal(normalizeCharacterString(normalized), normalized);
  assert.equal(isNormalizedCharacterString(normalized), true);

  for (const raw of [
    SPF,
    `"${SPF}"`,
    `"${SPF}`,
    `${SPF}"`,
    '"part one" "part two"',
    String.raw`"he said \"hi\""`,
    '"  spaced  "',
    "a".repeat(600),
    "é".repeat(400),
    "",
  ]) {
    const once = normalizeCharacterString(raw);
    assert.equal(normalizeCharacterString(once), once, raw.slice(0, 24));
    assert.equal(unquoteCharacterString(once), unquoteCharacterString(raw));
    for (const part of parseCharacterStrings(once)) {
      assert.ok(characterStringByteLength(part) <= 255);
    }
  }
});

test("honours a custom maximum chunk size", () => {
  assert.equal(
    normalizeCharacterString("abcdef", { maxBytes: 2 }),
    '"ab" "cd" "ef"',
  );
  assert.equal(
    unquoteCharacterString(normalizeCharacterString("abcdef", { maxBytes: 2 })),
    "abcdef",
  );
});

test("tokenizes whitespace separated character-strings for fixed-field records", () => {
  assert.deepEqual(parseCharacterStringTokens('"Intel i7" "Linux"'), [
    "Intel i7",
    "Linux",
  ]);
  assert.deepEqual(parseCharacterStringTokens("x86_64 Linux"), [
    "x86_64",
    "Linux",
  ]);
  assert.deepEqual(parseCharacterStringTokens('x86_64 "Windows Server"'), [
    "x86_64",
    "Windows Server",
  ]);
  assert.deepEqual(parseCharacterStringTokens('"Intel" "Linux'), [
    "Intel",
    "Linux",
  ]);
  assert.deepEqual(parseCharacterStringTokens(String.raw`"a\"b" c`), [
    'a"b',
    "c",
  ]);
  assert.deepEqual(parseCharacterStringTokens('"" ""'), ["", ""]);
  assert.deepEqual(parseCharacterStringTokens("   "), []);
});
