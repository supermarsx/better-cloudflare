/**
 * Personas on their way out of the app and back in.
 *
 * Only custom personas travel. A builtin is computed by the backend from
 * `crate::presets`, so re-importing one would either duplicate it under a
 * fresh custom id or shadow it, and neither is what "export my personas"
 * means. Dropping `id` and `builtin` is the same decision `AiPersonaInput`
 * makes in `bc-ai-agent/src/personas.rs`, for the same reason: both are the
 * backend's to issue.
 *
 * Validation here is a copy of `validate_input` in that file, because an entry
 * that fails it would be refused by the create command one screen later --
 * after the user had already chosen to import -- and "nine personas imported,
 * one named" is a better answer than a failure half way through a batch.
 */
import { AI_PERSONA_LIMITS } from "@/lib/ai/permissions";
import { utf8ByteLength } from "@/lib/resource-limits";
import type { AiPersona } from "@/types/ai";

import {
  boundedWarningSubjects,
  buildEnvelope,
  isPortableRecord,
  parseEnvelope,
  portableReject,
  portableSubject,
  type PortableEnvelopeOptions,
} from "./envelope";
import {
  MAX_PORTABLE_PERSONAS,
  type PortableParse,
  type PortableParseWarning,
  type PortablePersona,
  type PortablePersonasEnvelope,
} from "./types";

/**
 * Whether a string carries a control character Rust's `validate_text` would
 * refuse.
 *
 * `multiline` is the exemption that applies to `systemPrompt` alone: a prompt
 * is prose and legitimately carries line breaks and tabs, while a name or a
 * description carrying them corrupts the UI. The characters are refused in a
 * prompt too when they are not those three, because a control character pasted
 * into a system prompt can forge message structure in the prompt it is joined
 * into.
 *
 * A code-point scan rather than a character-class regex, matching the idiom in
 * `@/lib/ai/permissions`.
 */
function hasForbiddenControl(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (multiline && (code === 0x09 || code === 0x0a || code === 0x0d))
      continue;
    // C0 and C1 together are Unicode's `Cc` category, which is the set Rust's
    // `char::is_control()` covers.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Every rule `validate_input` applies, in its order.
 *
 * Lengths are measured in UTF-8 **bytes** on the untrimmed value, which is
 * what `str::len()` counts on the string the backend is handed. This is why
 * `validatePersonaInput` in `@/lib/ai/permissions` is not reused: it measures
 * the trimmed value, which is right for a form that trims before sending and
 * wrong for a file whose bytes go to the backend exactly as they arrived. The
 * bounds themselves come from there, where they are already pinned against the
 * Rust constants by `test/aiPermissions.contract.test.ts`.
 */
function isValidPersona(persona: PortablePersona): boolean {
  if (utf8ByteLength(persona.name) > AI_PERSONA_LIMITS.nameBytes) return false;
  if (hasForbiddenControl(persona.name, false)) return false;
  if (persona.name.trim().length === 0) return false;
  if (
    utf8ByteLength(persona.description) > AI_PERSONA_LIMITS.descriptionBytes
  ) {
    return false;
  }
  if (hasForbiddenControl(persona.description, false)) return false;
  if (
    utf8ByteLength(persona.systemPrompt) > AI_PERSONA_LIMITS.systemPromptBytes
  ) {
    return false;
  }
  if (hasForbiddenControl(persona.systemPrompt, true)) return false;
  return persona.systemPrompt.trim().length > 0;
}

/**
 * What to call a dropped entry in a warning.
 *
 * The name is run through {@link portableSubject} because an entry is often
 * dropped *for* its name -- the control characters that made it invalid would
 * otherwise reach the screen through the warning that reports them. An entry
 * with no usable name at all is named by its position, which is the only thing
 * left that distinguishes it.
 */
function personaSubject(entry: unknown, index: number): string {
  const name =
    isPortableRecord(entry) && typeof entry.name === "string"
      ? portableSubject(entry.name).trim()
      : "";
  return name.length > 0 ? name : `#${index + 1}`;
}

/** The custom personas, as they travel. */
export function exportPersonas(
  personas: readonly AiPersona[],
  options: PortableEnvelopeOptions,
): PortablePersonasEnvelope {
  const payload = personas
    .filter((persona) => !persona.builtin)
    // Capped at what an import will accept, so a file this build writes is
    // always a file this build reads back whole.
    .slice(0, MAX_PORTABLE_PERSONAS)
    .map(({ name, description, systemPrompt }) => ({
      name,
      description,
      systemPrompt,
    }));
  return buildEnvelope("personas", payload, options);
}

export function parsePersonasFile(
  raw: string,
): PortableParse<PortablePersonasEnvelope> {
  const envelope = parseEnvelope(raw, "personas");
  if (!envelope.ok) return envelope;
  if (!Array.isArray(envelope.value.payload)) {
    return portableReject("malformed-payload", "the payload is not an array");
  }

  const entries: unknown[] = envelope.value.payload;
  const warnings: PortableParseWarning[] = [];
  // Taken from the front rather than refused outright: a bundle of sixty-five
  // is a bundle of sixty-four plus one, and the store's own ceiling is the
  // same number, so keeping the first N is what the backend would have done.
  const overflow = entries.slice(MAX_PORTABLE_PERSONAS);
  if (overflow.length > 0) {
    warnings.push({
      reason: "too-many-personas",
      subjects: boundedWarningSubjects(
        overflow.map((entry, index) =>
          personaSubject(entry, MAX_PORTABLE_PERSONAS + index),
        ),
      ),
    });
  }

  const personas: PortablePersona[] = [];
  const invalid: string[] = [];
  entries.slice(0, MAX_PORTABLE_PERSONAS).forEach((entry, index) => {
    // All three fields are required, as they are on `AiPersonaInput`, where
    // serde refuses a missing one. Filling an absent field with an empty
    // string would invent content the file never carried.
    if (
      !isPortableRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.description !== "string" ||
      typeof entry.systemPrompt !== "string"
    ) {
      invalid.push(personaSubject(entry, index));
      return;
    }
    // A fresh object holding only the three fields that travel: an `id` or a
    // `builtin` the file carried stops here rather than reaching the create
    // command.
    const persona: PortablePersona = {
      name: entry.name,
      description: entry.description,
      systemPrompt: entry.systemPrompt,
    };
    if (!isValidPersona(persona)) {
      invalid.push(personaSubject(entry, index));
      return;
    }
    personas.push(persona);
  });

  if (invalid.length > 0) {
    warnings.push({
      reason: "invalid-persona",
      subjects: boundedWarningSubjects(invalid),
    });
  }

  return {
    ok: true,
    value: { ...envelope.value, payload: personas },
    warnings,
  };
}
