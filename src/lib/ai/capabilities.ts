/**
 * Which generation parameters the provider in use actually honours.
 *
 * **Why this module exists.** `AgentConfig.topP` shipped stored, validated and
 * persisted while reaching no provider at all: the settings screen offered a
 * dial that was wired to nothing. The fix is not to hide the dial, it is to
 * stop the UI from *claiming* anything the backend has not told it. So every
 * answer here comes from the `ai_protocol_capabilities` map, and the one thing
 * this module will not do is fall back to a hardcoded "OpenAI has no topK"
 * table — such a table would be right until the first protocol adapter gained
 * a parameter, and then it would be a lie with no test to catch it.
 *
 * The rule is deliberately blunt: a parameter is honoured if, and only if, the
 * map lists it for that protocol. Everything else is one of three different
 * things, and they must not render the same way — "this provider ignores it"
 * is a fact, "we could not ask" is an admission, and "no protocol handles this
 * one at all" means the backend applies it itself and there is nothing to
 * report. See {@link AiParameterApplicability}.
 */
import type { AiProtocolCapabilities, ProviderProtocol } from "@/types/ai";

/**
 * The advanced parameters the settings UI offers, in the order it offers them.
 *
 * These are `AgentConfig` field names, spelled exactly as they go over IPC,
 * because that is the spelling `ai_protocol_capabilities` answers in. `topP`
 * is **not** here: it predates the advanced group and is still rendered with
 * the common controls. It is capability-checked all the same — being offered
 * in a different place does not make it any more likely to reach a provider.
 */
export const AI_ADVANCED_PARAMETERS = [
  "topK",
  "stop",
  "seed",
  "frequencyPenalty",
  "presencePenalty",
  "maxContextTokens",
  "systemPromptOverride",
  "requestTimeoutMs",
] as const;

export type AiAdvancedParameter = (typeof AI_ADVANCED_PARAMETERS)[number];

/** Every parameter whose reach depends on the protocol, advanced or not. */
export type AiGenerationParameter = AiAdvancedParameter | "topP";

/**
 * What is known about one parameter reaching one provider.
 *
 * - `honoured` — the backend reports that this protocol sends it.
 * - `unsupported` — the backend was asked and this protocol is not listed.
 * - `notProtocolControl` — the map describes no protocol as honouring this
 *   parameter, which is how a parameter the *backend* applies for itself
 *   presents: the context budget trims history before a request is built, the
 *   prompt override is composed into the system prompt, and the timeout wraps
 *   the HTTP call. None of them is a field in a provider's request body, so
 *   there is nothing for a protocol to accept or refuse.
 * - `unknownProtocol` — no provider resolves, so there is nothing to check a
 *   protocol-level control against. The parameter is still stored; which
 *   provider it will meet is simply not decided yet.
 * - `unknownCapabilities` — `ai_protocol_capabilities` has not answered, so
 *   nothing may be claimed either way.
 */
export type AiParameterApplicability =
  | "honoured"
  | "unsupported"
  | "notProtocolControl"
  | "unknownProtocol"
  | "unknownCapabilities";

/**
 * Resolve one parameter against the capability map.
 *
 * Each "we do not know" has its own answer rather than collapsing into
 * `unsupported`, because locking a control for a reason that is not true is
 * the same class of mistake as leaving one open that does nothing.
 *
 * The `notProtocolControl` rule is read out of the map too, not out of a list
 * here: a parameter that no protocol advertises is one the backend applies
 * itself. Deciding that from the data is what keeps this module honest if the
 * backend later moves a parameter into a protocol's request body — the day
 * `maxContextTokens` appears in one protocol's list and not another's, it
 * starts being marked, with no change here.
 */
export function aiParameterApplicability(
  parameter: AiGenerationParameter,
  protocol: ProviderProtocol | null,
  capabilities: AiProtocolCapabilities | null,
): AiParameterApplicability {
  if (capabilities === null) return "unknownCapabilities";
  const advertised = Object.values(capabilities).some((honoured) =>
    honoured?.includes(parameter),
  );
  if (!advertised) return "notProtocolControl";
  if (protocol === null) return "unknownProtocol";
  const honoured = capabilities[protocol];
  // A protocol the map does not mention is not evidence of support. It is the
  // same "we were not told" the missing map is, so it reads the same way.
  if (honoured === undefined) return "unknownCapabilities";
  return honoured.includes(parameter) ? "honoured" : "unsupported";
}

/** Whether a control for this parameter may be operated at all. */
export function isAiParameterEditable(
  applicability: AiParameterApplicability,
): boolean {
  return (
    applicability === "honoured" ||
    applicability === "notProtocolControl" ||
    applicability === "unknownProtocol"
  );
}

/**
 * Narrow an `ai_protocol_capabilities` payload.
 *
 * The payload crosses IPC, so it is checked rather than asserted. Unknown keys
 * and non-string entries are dropped instead of failing the whole read: one
 * protocol the renderer has never heard of must not cost it the answers for
 * the three it has.
 */
export function normalizeAiProtocolCapabilities(
  value: unknown,
): AiProtocolCapabilities | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, readonly string[]> = {};
  for (const [protocol, fields] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(fields)) continue;
    result[protocol] = fields.filter(
      (field): field is string => typeof field === "string",
    );
  }
  return result as AiProtocolCapabilities;
}
