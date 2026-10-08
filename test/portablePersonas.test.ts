/**
 * What a persona may carry on the way out, and what it must satisfy on the way
 * back in.
 *
 * The bounds are asserted in bytes with characters that cost more than one of
 * them, so a check that counted characters fails here rather than in the
 * backend one screen after the user agreed to the import. The
 * control-character cases are split by field, because the rule is not uniform:
 * a line break is prose in a system prompt and corruption in a name.
 *
 * Two assertions carry the security weight. `id` and `builtin` must not
 * survive a parse -- a file that could claim either could shadow a builtin
 * persona -- and a warning must not quote a file's string verbatim, since the
 * strings most likely to be quoted are the ones that were refused for what
 * they contain.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildEnvelope } from "../src/lib/portable/envelope";
import {
  exportPersonas,
  parsePersonasFile,
} from "../src/lib/portable/personas";
import {
  MAX_PORTABLE_PERSONAS,
  PORTABLE_FORMAT,
  PORTABLE_FORMAT_VERSION,
  type PortablePersona,
} from "../src/lib/portable/types";
import type { AiPersona } from "../src/types/ai";

const OPTIONS = { appVersion: "1.2.3", now: new Date("2026-03-04T05:06:07Z") };

const VALID: PortablePersona = {
  name: "Reviewer",
  description: "Reads a diff and says what is wrong with it.",
  systemPrompt: "You review DNS changes.",
};

/**
 * Control characters by code point rather than as literals, so this file stays
 * readable to grep and to a diff -- the reason `@/lib/ai/permissions` scans
 * code points instead of writing a character class.
 *
 * NUL, BEL and ESC are C0; DEL and APC are the ends of the C1 range, which
 * `char::is_control()` covers and a naive `code < 0x20` check does not.
 */
const CONTROL_CHARACTERS = [0x00, 0x07, 0x1b, 0x7f, 0x9f].map((code) =>
  String.fromCodePoint(code),
);
const BELL = CONTROL_CHARACTERS[1];

const PERSONAS_RS = join(
  process.cwd(),
  "src-tauri",
  "crates",
  "bc-ai-agent",
  "src",
  "personas.rs",
);

function personaFile(entries: readonly unknown[]): string {
  return JSON.stringify(buildEnvelope("personas", entries, OPTIONS));
}

function parsed(entries: readonly unknown[]): PortablePersona[] {
  const parse = parsePersonasFile(personaFile(entries));
  assert.equal(parse.ok, true);
  return parse.ok ? parse.value.payload : [];
}

function warningSubjects(
  entries: readonly unknown[],
  reason: string,
): string[] {
  const parse = parsePersonasFile(personaFile(entries));
  assert.equal(parse.ok, true);
  if (!parse.ok) return [];
  return parse.warnings
    .filter((warning) => warning.reason === reason)
    .flatMap((warning) => warning.subjects);
}

test("the bundle ceiling is the store's ceiling, not a number this format picked", () => {
  // `MAX_PORTABLE_PERSONAS` says it matches `MAX_CUSTOM_PERSONAS`. Parsed out
  // of the crate rather than restated, the way `aiPermissions.contract` pins
  // the persona byte bounds: raise the limit in Rust and this fails, instead
  // of an import quietly keeping sixty-four of someone's eighty personas.
  const source = readFileSync(PERSONAS_RS, "utf8");
  const match =
    /pub const MAX_CUSTOM_PERSONAS: usize = (?<value>[0-9_]+);/u.exec(source);
  assert.ok(match?.groups?.value, "MAX_CUSTOM_PERSONAS not found in Rust");
  assert.equal(
    MAX_PORTABLE_PERSONAS,
    Number(match.groups.value.replaceAll("_", "")),
  );
});

test("only custom personas travel, and without the fields the backend owns", () => {
  const personas: AiPersona[] = [
    {
      id: "dns-expert",
      name: "DNS expert",
      description: "A builtin.",
      systemPrompt: "Builtin prompt.",
      builtin: true,
    },
    {
      id: "custom-abc123",
      name: "Reviewer",
      description: "Mine.",
      systemPrompt: "My prompt.",
      builtin: false,
    },
  ];

  const envelope = exportPersonas(personas, OPTIONS);
  assert.equal(envelope.payload.length, 1);
  // Pinned by key: a persona that carried its id would let an import claim one.
  assert.deepEqual(Object.keys(envelope.payload[0]).sort(), [
    "description",
    "name",
    "systemPrompt",
  ]);
  assert.equal(envelope.payload[0].name, "Reviewer");
});

test("a file a build writes is a file it reads back whole", () => {
  const personas: AiPersona[] = Array.from({ length: 3 }, (_, index) => ({
    id: `custom-${index}`,
    name: `Persona ${index}`,
    description: `Number ${index}.`,
    systemPrompt: `Prompt ${index}.`,
    builtin: false,
  }));
  const raw = JSON.stringify(exportPersonas(personas, OPTIONS));
  const parse = parsePersonasFile(raw);
  assert.equal(parse.ok, true);
  if (!parse.ok) return;
  assert.deepEqual(parse.warnings, []);
  assert.deepEqual(
    parse.value.payload.map(({ name }) => name),
    ["Persona 0", "Persona 1", "Persona 2"],
  );
});

test("an id or a builtin flag in the file does not survive the parse", () => {
  const personas = parsed([
    { ...VALID, id: "dns-expert", builtin: true, extra: "smuggled" },
  ]);
  assert.equal(personas.length, 1);
  assert.deepEqual(Object.keys(personas[0]).sort(), [
    "description",
    "name",
    "systemPrompt",
  ]);
  assert.equal("id" in personas[0], false);
  assert.equal("builtin" in personas[0], false);
});

test("one malformed entry is dropped and named; the rest still import", () => {
  const personas = parsed([
    VALID,
    { name: "Nameless", description: "No prompt at all." },
    { ...VALID, name: "Second" },
  ]);
  assert.deepEqual(
    personas.map(({ name }) => name),
    ["Reviewer", "Second"],
  );
  assert.deepEqual(
    warningSubjects(
      [VALID, { name: "Nameless", description: "No prompt." }],
      "invalid-persona",
    ),
    ["Nameless"],
  );
});

test("an entry with no usable name is named by its position", () => {
  assert.deepEqual(warningSubjects([VALID, 42], "invalid-persona"), ["#2"]);
  assert.deepEqual(
    warningSubjects([{ ...VALID, name: "" }], "invalid-persona"),
    ["#1"],
  );
});

test("lengths are bounded in bytes, not in characters", () => {
  // 128 bytes is the ceiling `MAX_PERSONA_NAME_BYTES` sets. Forty-three
  // three-byte characters are 129 bytes and 43 characters: a character count
  // would wave this through and the backend would then refuse it.
  const wide = "漢".repeat(43);
  assert.equal(wide.length, 43);
  assert.deepEqual(parsed([{ ...VALID, name: wide }]), []);
  assert.equal(parsed([{ ...VALID, name: "a".repeat(128) }]).length, 1);
  assert.deepEqual(parsed([{ ...VALID, name: "a".repeat(129) }]), []);

  assert.equal(parsed([{ ...VALID, description: "d".repeat(1024) }]).length, 1);
  assert.deepEqual(parsed([{ ...VALID, description: "d".repeat(1025) }]), []);

  const promptCeiling = 256 * 1024;
  assert.equal(
    parsed([{ ...VALID, systemPrompt: "p".repeat(promptCeiling) }]).length,
    1,
  );
  assert.deepEqual(
    parsed([{ ...VALID, systemPrompt: "p".repeat(promptCeiling + 1) }]),
    [],
  );
});

test("a byte bound is measured before the value is trimmed", () => {
  // `validate_text` in Rust measures `input.name`, not its trimmed form, and
  // only then checks that trimming leaves something. A parser that trimmed
  // first would accept this and watch the create command refuse it.
  assert.deepEqual(
    parsed([{ ...VALID, name: `${"a".repeat(120)}${" ".repeat(20)}` }]),
    [],
  );
});

test("a name or a description refuses every control character", () => {
  for (const control of [...CONTROL_CHARACTERS, "\n", "\r", "\t"]) {
    assert.deepEqual(parsed([{ ...VALID, name: `Rev${control}iewer` }]), []);
    assert.deepEqual(
      parsed([{ ...VALID, description: `Rev${control}iewer` }]),
      [],
    );
  }
});

test("a system prompt keeps its line breaks and tabs and nothing else", () => {
  const prose = "Line one.\r\n\tIndented line two.\n";
  assert.equal(
    parsed([{ ...VALID, systemPrompt: prose }])[0]?.systemPrompt,
    prose,
  );
  for (const control of CONTROL_CHARACTERS) {
    assert.deepEqual(
      parsed([{ ...VALID, systemPrompt: `Prompt${control}` }]),
      [],
    );
  }
});

test("a blank name or prompt is refused the way the backend refuses it", () => {
  assert.deepEqual(parsed([{ ...VALID, name: "   " }]), []);
  assert.deepEqual(parsed([{ ...VALID, systemPrompt: " \t " }]), []);
});

test("a warning never quotes the control characters it is reporting", () => {
  assert.deepEqual(
    warningSubjects([{ ...VALID, name: `Evil${BELL}One` }], "invalid-persona"),
    ["EvilOne"],
  );
});

test("more personas than the ceiling keeps the first N and names the rest", () => {
  const entries = Array.from({ length: MAX_PORTABLE_PERSONAS + 2 }, (_, i) => ({
    ...VALID,
    name: `Persona ${i + 1}`,
  }));
  const personas = parsed(entries);
  assert.equal(personas.length, MAX_PORTABLE_PERSONAS);
  assert.equal(personas[0].name, "Persona 1");
  assert.equal(
    personas[MAX_PORTABLE_PERSONAS - 1].name,
    `Persona ${MAX_PORTABLE_PERSONAS}`,
  );
  assert.deepEqual(warningSubjects(entries, "too-many-personas"), [
    `Persona ${MAX_PORTABLE_PERSONAS + 1}`,
    `Persona ${MAX_PORTABLE_PERSONAS + 2}`,
  ]);
});

test("an export is capped at what an import will accept", () => {
  const personas: AiPersona[] = Array.from(
    { length: MAX_PORTABLE_PERSONAS + 5 },
    (_, index) => ({
      id: `custom-${index}`,
      name: `Persona ${index}`,
      description: "",
      systemPrompt: "Prompt.",
      builtin: false,
    }),
  );
  assert.equal(
    exportPersonas(personas, OPTIONS).payload.length,
    MAX_PORTABLE_PERSONAS,
  );
});

test("a payload that is not a list of personas is refused", () => {
  for (const payload of [{ personas: [] }, "nothing", 7]) {
    const parse = parsePersonasFile(
      JSON.stringify({
        format: PORTABLE_FORMAT,
        version: PORTABLE_FORMAT_VERSION,
        kind: "personas",
        exportedAt: "",
        appVersion: "",
        payload,
      }),
    );
    assert.equal(parse.ok === false && parse.rejection, "malformed-payload");
  }
});
