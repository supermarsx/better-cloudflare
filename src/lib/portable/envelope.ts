/**
 * The wrapper every exported file carries, and the gate every import passes
 * through before a payload parser sees it.
 *
 * The checks run in a deliberate order -- size, emptiness, JSON, marker,
 * version, kind, payload -- because each one makes the next safe to attempt:
 * the ceiling is checked before `JSON.parse` because parsing is what turns an
 * oversized string into an oversized object graph, and the marker is checked
 * before the kind so that an unrelated JSON file is refused as "not ours"
 * rather than as "the wrong kind of ours".
 *
 * Every parser here and in the sibling modules is a strict projection: it
 * builds a fresh object out of the fields it recognises. Returning the parsed
 * JSON cast to the target type would hand the caller every other field the
 * file carried as well, which is how a hostile file smuggles a value into an
 * object that is later written to storage.
 */
import { utf8ByteLength } from "@/lib/resource-limits";

import {
  MAX_PORTABLE_FILE_BYTES,
  PORTABLE_FORMAT,
  PORTABLE_FORMAT_VERSION,
  type PortableEnvelope,
  type PortableKind,
  type PortableParse,
  type PortableParseWarning,
  type PortableRejection,
} from "./types";

/** How a build identifies itself in a file it writes. */
export interface PortableEnvelopeOptions {
  /** The writing build's version, for a support conversation. */
  appVersion: string;
  /**
   * The moment to stamp. Injectable because `exportedAt` is the only part of
   * an envelope that is not a function of its input, and a test that cannot
   * fix it cannot compare two exports.
   */
  now?: Date;
}

/**
 * Bounds on the strings a warning carries.
 *
 * A warning's subjects come from the file being refused, so they are exactly
 * the strings an attacker chooses: a persona name 200 KB long, or a preference
 * key built out of control characters. They reach the screen through the error
 * path, which is the path least likely to have been looked at, so they are
 * bounded and stripped here rather than wherever they are rendered.
 */
export const MAX_PORTABLE_WARNING_SUBJECTS = 32;
export const MAX_PORTABLE_SUBJECT_CHARACTERS = 160;

/**
 * One file-supplied string, made safe to display.
 *
 * A code-point scan rather than a character-class regex, matching the idiom in
 * `@/lib/ai/permissions`: a regex for this needs either literal control
 * characters -- which make the source file look binary to grep and to diff
 * tooling -- or escapes nobody can read.
 */
export function portableSubject(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // C0 and C1 together are Unicode's `Cc` category, the set Rust's
    // `char::is_control()` covers.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    safe += character;
    // One character past the bound, so that the ellipsis below marks a string
    // that was actually shortened rather than one that merely lost a control
    // character.
    if (safe.length > MAX_PORTABLE_SUBJECT_CHARACTERS) break;
  }
  return safe.length > MAX_PORTABLE_SUBJECT_CHARACTERS
    ? `${safe.slice(0, MAX_PORTABLE_SUBJECT_CHARACTERS - 1)}…`
    : safe;
}

/** The subjects a single warning may name, bounded and deduplicated. */
export function boundedWarningSubjects(values: readonly string[]): string[] {
  const subjects = new Set<string>();
  for (const value of values) {
    subjects.add(portableSubject(value));
    if (subjects.size >= MAX_PORTABLE_WARNING_SUBJECTS) break;
  }
  return [...subjects];
}

/** A warning, or nothing at all when there is nothing to warn about. */
export function portableWarning(
  reason: PortableParseWarning["reason"],
  subjects: readonly string[],
): PortableParseWarning[] {
  if (subjects.length === 0) return [];
  return [{ reason, subjects: boundedWarningSubjects(subjects) }];
}

export function portableReject<T>(
  rejection: PortableRejection,
  detail: string,
): PortableParse<T> {
  return { ok: false, rejection, detail };
}

/** Whether a value can be indexed by string key without surprises. */
export function isPortableRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildEnvelope<TKind extends PortableKind, TPayload>(
  kind: TKind,
  payload: TPayload,
  options: PortableEnvelopeOptions,
): PortableEnvelope<TKind, TPayload> {
  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_FORMAT_VERSION,
    kind,
    exportedAt: (options.now ?? new Date()).toISOString(),
    appVersion: options.appVersion,
    payload,
  };
}

/**
 * Project an untrusted string onto an envelope of the expected kind.
 *
 * The payload is returned as `unknown`: validating it is the job of the module
 * that owns its shape, so there is one place per kind where its fields are
 * named rather than two that can disagree.
 */
export function parseEnvelope<TKind extends PortableKind>(
  raw: string,
  expectedKind: TKind,
): PortableParse<PortableEnvelope<TKind, unknown>> {
  // UTF-8 bytes rather than `raw.length`: the ceiling exists to bound what the
  // parser allocates, and a string of two-byte characters costs twice what its
  // code-unit count suggests. Measuring is a single cheap pass; parsing is not.
  const bytes = utf8ByteLength(raw);
  if (bytes > MAX_PORTABLE_FILE_BYTES) {
    return portableReject(
      "too-large",
      `${bytes} bytes exceeds the ${MAX_PORTABLE_FILE_BYTES} byte ceiling`,
    );
  }
  if (raw.trim().length === 0) {
    return portableReject("empty", "the file contains no data");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A `RangeError` from a pathological document lands here too, which is
    // why the whole call is guarded rather than only `SyntaxError` caught.
    return portableReject(
      "not-json",
      error instanceof Error ? error.message : "the file is not valid JSON",
    );
  }

  if (!isPortableRecord(parsed) || parsed.format !== PORTABLE_FORMAT) {
    return portableReject(
      "not-our-format",
      `expected a ${PORTABLE_FORMAT} document`,
    );
  }

  const { version } = parsed;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    return portableReject("unsupported-version", "the version is not a number");
  }
  // A lower version is read, not refused: the fields this build knows are a
  // superset of what an older one wrote, and the ones it does not know are
  // dropped by projection anyway.
  if (version > PORTABLE_FORMAT_VERSION) {
    return portableReject(
      "unsupported-version",
      `version ${version} was written by a newer build; this one reads up to ${PORTABLE_FORMAT_VERSION}`,
    );
  }

  if (parsed.kind !== expectedKind) {
    return portableReject(
      "wrong-kind",
      `expected ${expectedKind}, found ${typeof parsed.kind === "string" ? portableSubject(parsed.kind) : "no kind"}`,
    );
  }

  if (!("payload" in parsed) || parsed.payload === null) {
    return portableReject("malformed-payload", "the payload is missing");
  }

  return {
    ok: true,
    value: {
      format: PORTABLE_FORMAT,
      version,
      kind: expectedKind,
      // Both of these are shown to a person and are never read by code -- the
      // header of `./types` says `exportedAt` is not even trusted for ordering
      // -- so a file that states them oddly loses them rather than being
      // refused over a field that carries no meaning.
      exportedAt:
        typeof parsed.exportedAt === "string"
          ? portableSubject(parsed.exportedAt)
          : "",
      appVersion:
        typeof parsed.appVersion === "string"
          ? portableSubject(parsed.appVersion)
          : "",
      payload: parsed.payload,
    },
    warnings: [],
  };
}
