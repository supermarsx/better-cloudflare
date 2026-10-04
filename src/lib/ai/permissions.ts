/**
 * The assistant's permission model, as a pure function of state.
 *
 * **This module is not the enforcement.** Enforcement lives behind the Tauri
 * boundary: the agent resolves each tool call itself and the renderer never
 * sees the decision until the backend reports it. Everything here exists so the
 * settings UI can explain *why* the backend will answer the way it does, and so
 * a disagreement between what the UI derives and what the backend reports
 * becomes visible instead of being quietly papered over.
 *
 * The resolution order the backend enforces, and the one
 * {@link resolveAiToolPermission} reproduces:
 *
 * 1. Tool use off globally (`AgentConfig.toolsEnabled === false`) — everything
 *    is denied, whatever the mode or the overrides say.
 * 2. An explicit per-tool override wins: `allow` runs, `ask` prompts, `deny`
 *    refuses.
 * 3. Otherwise the mode decides:
 *    - `readOnly` runs read-only tools and **denies** the rest outright. It
 *      does not prompt — a write silently refuses, which is the one consequence
 *      of this mode a user will not guess.
 *    - `ask` runs reads and prompts for writes.
 *    - `autonomous` runs everything.
 *
 * Numeric and length bounds mirror the Rust validators so the user gets
 * immediate feedback, but the backend stays the authority on rejection: a value
 * that passes here can still be refused.
 */
import { utf8ByteLength } from "@/lib/resource-limits";
import type {
  AgentConfig,
  AiPermissionMode,
  AiPermissions,
  AiPermissionsSnapshot,
  AiPersonaInput,
  AiToolClassification,
  AiToolDescriptor,
  AiToolPermission,
} from "@/types/ai";

/** Every mode, in the order the settings UI offers them (least power first). */
export const AI_PERMISSION_MODES: readonly AiPermissionMode[] = [
  "readOnly",
  "ask",
  "autonomous",
] as const;

/** Every per-tool decision, in the order the settings UI offers them. */
export const AI_TOOL_PERMISSIONS: readonly AiToolPermission[] = [
  "allow",
  "ask",
  "deny",
] as const;

/**
 * Agent-loop bounds, taken from the Rust validators rather than guessed.
 *
 * **This table is a hand-maintained duplicate of Rust constants, so it can
 * drift.** That is a build-time problem, not a runtime one: `RUST_BOUNDS` in
 * `test/aiPermissions.contract.test.ts` pairs every pair below with the
 * constant it mirrors and fails naming the field if the two disagree, so CI
 * catches the drift instead of a round trip on every settings open. Edit a
 * number here only to follow a Rust change, and read that table for which
 * constant owns which bound.
 *
 * Nearly all of them live in `bc_ai_provider::limits`, because the provider
 * crate cannot depend on the agent crate and the request validator is the last
 * gate before the wire. Only `maxToolRounds` and `maxContextTokens` are
 * agent-only concepts. `bc_ai_agent::config` re-exports two of the provider
 * bounds as aliases; the contract test deliberately never reads an alias,
 * since an alias is not a literal.
 *
 * `seed` is the one exception, and it is excluded from that contract test on
 * purpose: its range is the **`u32` type**, not a validated bound. Rust types
 * it `Option<u32>` and has no validator arm at all, because every value a
 * `u32` can hold round-trips and anything outside it is unrepresentable rather
 * than rejected. There is therefore no constant to pin it against, and
 * asserting that no validator exists would fire as a false alarm the day
 * someone adds a legitimate one. The pair below is kept so the form can refuse
 * an out-of-range seed with a sentence instead of letting serde refuse it with
 * a parse error.
 */
export const AI_AGENT_LIMITS = {
  maxToolRounds: { min: 1, max: 32 },
  maxTokensPerTurn: { min: 1, max: 131_072 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  topK: { min: 1, max: 1_000_000 },
  seed: { min: 0, max: 4_294_967_295 },
  frequencyPenalty: { min: -2, max: 2 },
  presencePenalty: { min: -2, max: 2 },
  maxContextTokens: { min: 512, max: 2_000_000 },
  requestTimeoutMs: { min: 1_000, max: 600_000 },
} as const;

/**
 * What `AgentConfig::default()` uses for the context budget.
 *
 * Needed because `maxContextTokens` is the one advanced parameter that is not
 * optional: Rust types it a bare `u32` with a serde default, so there is no
 * "unset" to render. A config read from a build that predates the field has no
 * value to seed the form with, and this is the value that build's successor
 * would have given it.
 */
export const AI_DEFAULT_MAX_CONTEXT_TOKENS = 128_000;

/**
 * Stop-sequence bounds, from `bc_ai_provider::limits::validate_stop_sequences`.
 *
 * `maxSequences` is OpenAI's ceiling, which is the lowest of the protocols that
 * take `stop` at all, so it is the most any of them can honour. A sequence must
 * also carry at least one non-whitespace character — an all-space sequence is
 * refused rather than silently dropped.
 */
export const AI_STOP_LIMITS = {
  maxSequences: 4,
  minSequenceBytes: 1,
  maxSequenceBytes: 128,
} as const;

/**
 * Persona bounds, in UTF-8 **bytes** — Rust's `str::len()` counts bytes, so a
 * character count would let a prompt full of non-ASCII past a check the backend
 * then fails. `name` matches `bc_ai_agent::config::MAX_PRESET_BYTES` and
 * `systemPrompt` matches `bc_ai_provider::limits::MAX_SYSTEM_PROMPT_BYTES`.
 * `description` has no Rust analogue to copy; 1 KiB is this UI's own ceiling.
 */
export const AI_PERSONA_LIMITS = {
  nameBytes: 128,
  descriptionBytes: 1024,
  systemPromptBytes: 256 * 1024,
} as const;

/**
 * Advanced parameters that are whole numbers and may be left unset.
 *
 * "Unset" is load-bearing and is **not** zero: Rust types each of these
 * `Option<u32>` and sends nothing at all when it is `None`, so a `topK` of 0
 * would be a request to sample from no tokens rather than a request to leave
 * sampling alone. `maxContextTokens` is absent from this list on purpose — it
 * is a bare `u32` with a default, so it is always set.
 */
export const AI_OPTIONAL_INTEGER_FIELDS = [
  "topK",
  "seed",
  "requestTimeoutMs",
] as const;

/** Advanced parameters that are fractional and may be left unset. */
export const AI_OPTIONAL_DECIMAL_FIELDS = [
  "frequencyPenalty",
  "presencePenalty",
] as const;

export type AiOptionalNumberField =
  | (typeof AI_OPTIONAL_INTEGER_FIELDS)[number]
  | (typeof AI_OPTIONAL_DECIMAL_FIELDS)[number];

/** Which of the three rules produced an effective permission. */
export type AiPermissionReason = "toolsOff" | "override" | "mode";

export interface ResolvedAiToolPermission {
  permission: AiToolPermission;
  reason: AiPermissionReason;
}

export function isAiPermissionMode(value: unknown): value is AiPermissionMode {
  return (
    typeof value === "string" &&
    (AI_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export function isAiToolPermission(value: unknown): value is AiToolPermission {
  return (
    typeof value === "string" &&
    (AI_TOOL_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** What a mode alone does to a tool of this classification. */
export function modePermission(
  mode: AiPermissionMode,
  classification: AiToolClassification,
): AiToolPermission {
  if (mode === "autonomous") return "allow";
  if (classification === "read") return "allow";
  // The asymmetry that needs saying out loud: `readOnly` refuses a write, it
  // does not offer to ask about it.
  return mode === "ask" ? "ask" : "deny";
}

/** Apply the three rules in order. */
export function resolveAiToolPermission(
  tool: Pick<AiToolDescriptor, "name" | "classification">,
  policy: AiPermissions,
  toolsEnabled: boolean,
): ResolvedAiToolPermission {
  if (!toolsEnabled) return { permission: "deny", reason: "toolsOff" };
  const override = policy.tools[tool.name];
  if (isAiToolPermission(override)) {
    return { permission: override, reason: "override" };
  }
  return {
    permission: modePermission(policy.mode, tool.classification),
    reason: "mode",
  };
}

/** One rendered row: what is shown, why, and whether anything disagrees. */
export interface AiToolPermissionRow {
  tool: AiToolDescriptor;
  /**
   * The permission to render. It is the backend's reported value, except when
   * the global tool switch is off — `toolsEnabled` lives in `ai_get_config`,
   * a different command from the one that produced the catalog, so a catalog
   * that has not folded it in would otherwise show a tool as runnable while
   * nothing can run.
   */
  effective: AiToolPermission;
  reason: AiPermissionReason;
  /** The explicit override for this tool, or `null` when the mode decides. */
  override: AiToolPermission | null;
  /** Exactly what the backend reported, before the global switch is applied. */
  reported: AiToolPermission;
  /**
   * The backend's reported permission and the documented rules disagree. Shown
   * rather than hidden: a silent divergence here is the precise failure this
   * UI must not have.
   */
  drifted: boolean;
}

export function buildAiToolPermissionRows(
  snapshot: AiPermissionsSnapshot,
  toolsEnabled: boolean,
): AiToolPermissionRow[] {
  const policy: AiPermissions = { mode: snapshot.mode, tools: snapshot.tools };
  return snapshot.catalog.map((tool) => {
    const derived = resolveAiToolPermission(tool, policy, toolsEnabled);
    const override = isAiToolPermission(policy.tools[tool.name])
      ? policy.tools[tool.name]
      : null;
    return {
      tool,
      effective: toolsEnabled ? tool.permission : "deny",
      reason: derived.reason,
      override,
      reported: tool.permission,
      drifted: toolsEnabled && tool.permission !== derived.permission,
    };
  });
}

/** How many of the rendered rows land on each decision. */
export function summarizeAiToolPermissionRows(
  rows: readonly AiToolPermissionRow[],
): Record<AiToolPermission, number> {
  const totals: Record<AiToolPermission, number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  for (const row of rows) totals[row.effective] += 1;
  return totals;
}

// ─── Client-side validation ────────────────────────────────────────────────

/**
 * A rejected input, as data rather than prose. The settings components map
 * these to `t()` strings; returning a sentence from here would put a
 * user-facing string outside the translation catalogue.
 */
export type AiValidationIssue =
  | {
      field: "temperature" | "topP" | "frequencyPenalty" | "presencePenalty";
      code: "range";
      min: number;
      max: number;
    }
  | {
      field:
        | "maxToolRounds"
        | "maxTokensPerTurn"
        | "topK"
        | "seed"
        | "maxContextTokens"
        | "requestTimeoutMs";
      code: "integerRange";
      min: number;
      max: number;
    }
  /**
   * The stop-sequence rules, each as its own code.
   *
   * They are separate because the fixes are: drop one, shorten one, and put
   * something other than spaces in one. A single "invalid stop sequences"
   * would leave the user to work out which.
   */
  | { field: "stop"; code: "tooManySequences"; limit: number }
  | { field: "stop"; code: "sequenceTooLong"; limit: number }
  | { field: "stop"; code: "sequenceBlank" }
  /**
   * The system-prompt override's own codes, rather than a wider `tooLong`.
   *
   * The persona form and the agent-config form each describe only the codes
   * they can produce, and widening `tooLong` would make every persona issue
   * carry a field the persona form has no control for.
   */
  | { field: "systemPromptOverride"; code: "overrideBlank" }
  | { field: "systemPromptOverride"; code: "overrideTooLong"; limit: number }
  | { field: "systemPromptOverride" | "stop"; code: "controlCharacter" }
  | { field: "name" | "systemPrompt"; code: "required" }
  | {
      field: "name" | "description" | "systemPrompt";
      code: "tooLong";
      limit: number;
    };

type AiRangeField = Extract<AiValidationIssue, { code: "range" }>["field"];
type AiIntegerRangeField = Extract<
  AiValidationIssue,
  { code: "integerRange" }
>["field"];

function rangeIssue(
  field: AiRangeField,
  value: number,
): AiValidationIssue | null {
  const { min, max } = AI_AGENT_LIMITS[field];
  if (!Number.isFinite(value) || value < min || value > max) {
    return { field, code: "range", min, max };
  }
  return null;
}

function integerRangeIssue(
  field: AiIntegerRangeField,
  value: number,
): AiValidationIssue | null {
  const { min, max } = AI_AGENT_LIMITS[field];
  if (!Number.isInteger(value) || value < min || value > max) {
    return { field, code: "integerRange", min, max };
  }
  return null;
}

/**
 * `null` and `undefined` both mean "not set", which is always valid: these
 * parameters exist precisely so that *not* choosing one is expressible. A
 * value that is present is held to the same range the Rust validator holds
 * it to — including NaN, which fails every comparison and so is reported
 * rather than being allowed through as "unset".
 */
function optionalIssue(
  field: AiIntegerRangeField | AiRangeField,
  value: number | null | undefined,
  check: (field: never, value: number) => AiValidationIssue | null,
): AiValidationIssue | null {
  if (value === null || value === undefined) return null;
  return check(field as never, value);
}

/**
 * Whether a string carries a control character other than tab, carriage
 * return or newline.
 *
 * The same rule Rust's `has_forbidden_control` applies, and for the same
 * reason: a control character pasted into a system prompt can forge message
 * structure in the prompt it is joined into. Prose may legitimately carry the
 * other three, which is why they are exempt.
 *
 * A code-point scan rather than a character-class regex, matching the idiom
 * in `@/lib/ai/providers`: a regex for this needs either literal control
 * characters - which make the whole source file look binary to grep and to
 * diff tooling - or escapes nobody can read.
 */
function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    // C0 and C1 together are Unicode's `Cc` category, which is the set
    // Rust's `char::is_control()` covers.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Every stop-sequence rule `validate_stop_sequences` enforces. */
function stopIssues(stop: readonly string[] | undefined): AiValidationIssue[] {
  if (stop === undefined) return [];
  const issues: AiValidationIssue[] = [];
  if (stop.length > AI_STOP_LIMITS.maxSequences) {
    issues.push({
      field: "stop",
      code: "tooManySequences",
      limit: AI_STOP_LIMITS.maxSequences,
    });
  }
  if (
    stop.some(
      (sequence) => utf8ByteLength(sequence) > AI_STOP_LIMITS.maxSequenceBytes,
    )
  ) {
    issues.push({
      field: "stop",
      code: "sequenceTooLong",
      limit: AI_STOP_LIMITS.maxSequenceBytes,
    });
  }
  // A sequence of nothing but whitespace is refused upstream, so it is refused
  // here rather than being sent and bounced.
  if (stop.some((sequence) => sequence.trim().length === 0)) {
    issues.push({ field: "stop", code: "sequenceBlank" });
  }
  if (stop.some(hasForbiddenControl)) {
    issues.push({ field: "stop", code: "controlCharacter" });
  }
  return issues;
}

/**
 * Every bound the agent-config form can break, in field order.
 *
 * Each one mirrors an arm of Rust's `AgentConfig::validate`, with the bounds
 * read from {@link AI_AGENT_LIMITS} and {@link AI_STOP_LIMITS}. A parameter
 * that is absent or `null` is "not set" and is never an issue — except
 * `maxContextTokens`, which Rust types as a bare `u32` with a default, so an
 * absent one means "a build that predates the field" and is left alone rather
 * than failed.
 */
export function validateAgentConfig(
  config: Pick<
    AgentConfig,
    | "maxToolRounds"
    | "maxTokensPerTurn"
    | "temperature"
    | "topP"
    | "topK"
    | "stop"
    | "seed"
    | "frequencyPenalty"
    | "presencePenalty"
    | "maxContextTokens"
    | "requestTimeoutMs"
    | "systemPromptOverride"
  >,
): AiValidationIssue[] {
  const issues: AiValidationIssue[] = [
    integerRangeIssue("maxToolRounds", config.maxToolRounds),
    integerRangeIssue("maxTokensPerTurn", config.maxTokensPerTurn),
    rangeIssue("temperature", config.temperature),
    rangeIssue("topP", config.topP),
    optionalIssue("topK", config.topK, integerRangeIssue),
    optionalIssue("seed", config.seed, integerRangeIssue),
    optionalIssue("frequencyPenalty", config.frequencyPenalty, rangeIssue),
    optionalIssue("presencePenalty", config.presencePenalty, rangeIssue),
    optionalIssue(
      "maxContextTokens",
      config.maxContextTokens,
      integerRangeIssue,
    ),
    optionalIssue(
      "requestTimeoutMs",
      config.requestTimeoutMs,
      integerRangeIssue,
    ),
  ].filter((issue): issue is AiValidationIssue => issue !== null);

  issues.push(...stopIssues(config.stop));

  const override = config.systemPromptOverride;
  if (override !== null && override !== undefined) {
    // Rust refuses a blank-but-present override outright: `null` is how the
    // setting is cleared, and an empty string would otherwise compose a pair
    // of blank lines onto every system prompt.
    if (override.trim().length === 0) {
      issues.push({ field: "systemPromptOverride", code: "overrideBlank" });
    } else if (utf8ByteLength(override) > AI_PERSONA_LIMITS.systemPromptBytes) {
      issues.push({
        field: "systemPromptOverride",
        code: "overrideTooLong",
        limit: AI_PERSONA_LIMITS.systemPromptBytes,
      });
    }
    if (hasForbiddenControl(override)) {
      issues.push({
        field: "systemPromptOverride",
        code: "controlCharacter",
      });
    }
  }

  return issues;
}

/** Every bound the persona form can break, in field order. */
export function validatePersonaInput(
  persona: AiPersonaInput,
): AiValidationIssue[] {
  const issues: AiValidationIssue[] = [];
  const name = persona.name.trim();
  if (name.length === 0) {
    issues.push({ field: "name", code: "required" });
  } else if (utf8ByteLength(name) > AI_PERSONA_LIMITS.nameBytes) {
    issues.push({
      field: "name",
      code: "tooLong",
      limit: AI_PERSONA_LIMITS.nameBytes,
    });
  }

  if (
    utf8ByteLength(persona.description.trim()) >
    AI_PERSONA_LIMITS.descriptionBytes
  ) {
    issues.push({
      field: "description",
      code: "tooLong",
      limit: AI_PERSONA_LIMITS.descriptionBytes,
    });
  }

  const systemPrompt = persona.systemPrompt.trim();
  if (systemPrompt.length === 0) {
    issues.push({ field: "systemPrompt", code: "required" });
  } else if (
    utf8ByteLength(systemPrompt) > AI_PERSONA_LIMITS.systemPromptBytes
  ) {
    issues.push({
      field: "systemPrompt",
      code: "tooLong",
      limit: AI_PERSONA_LIMITS.systemPromptBytes,
    });
  }

  return issues;
}
