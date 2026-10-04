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
 * Agent-loop bounds, taken from the Rust validators rather than guessed:
 * `maxToolRounds` from `bc_ai_agent::config::MAX_TOOL_ROUNDS`,
 * `maxTokensPerTurn` from `bc_ai_provider::limits::MAX_COMPLETION_TOKENS`,
 * `temperature` from `ProviderConfig::validate`. `topP` is a probability, so
 * its ceiling is 1.
 */
export const AI_AGENT_LIMITS = {
  maxToolRounds: { min: 1, max: 32 },
  maxTokensPerTurn: { min: 1, max: 131_072 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
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
      field: "temperature" | "topP";
      code: "range";
      min: number;
      max: number;
    }
  | {
      field: "maxToolRounds" | "maxTokensPerTurn";
      code: "integerRange";
      min: number;
      max: number;
    }
  | { field: "name" | "systemPrompt"; code: "required" }
  | {
      field: "name" | "description" | "systemPrompt";
      code: "tooLong";
      limit: number;
    };

function rangeIssue(
  field: "temperature" | "topP",
  value: number,
): AiValidationIssue | null {
  const { min, max } = AI_AGENT_LIMITS[field];
  if (!Number.isFinite(value) || value < min || value > max) {
    return { field, code: "range", min, max };
  }
  return null;
}

function integerRangeIssue(
  field: "maxToolRounds" | "maxTokensPerTurn",
  value: number,
): AiValidationIssue | null {
  const { min, max } = AI_AGENT_LIMITS[field];
  if (!Number.isInteger(value) || value < min || value > max) {
    return { field, code: "integerRange", min, max };
  }
  return null;
}

/** Every bound the agent-config form can break, in field order. */
export function validateAgentConfig(
  config: Pick<
    AgentConfig,
    "maxToolRounds" | "maxTokensPerTurn" | "temperature" | "topP"
  >,
): AiValidationIssue[] {
  return [
    integerRangeIssue("maxToolRounds", config.maxToolRounds),
    integerRangeIssue("maxTokensPerTurn", config.maxTokensPerTurn),
    rangeIssue("temperature", config.temperature),
    rangeIssue("topP", config.topP),
  ].filter((issue): issue is AiValidationIssue => issue !== null);
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
