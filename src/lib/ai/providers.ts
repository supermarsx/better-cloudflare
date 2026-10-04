/**
 * User-defined provider profiles: the protocols they can speak, the bounds a
 * profile has to satisfy, and the draft→input conversion the form uses.
 *
 * **No default base URL is written in this file, or anywhere under `src/`.**
 * `test/aiProviderProxyBoundary.contract.test.ts` forbids the renderer from
 * naming a provider endpoint host, because a host in the renderer is the first
 * half of a direct provider call and the API key is deliberately unreachable
 * from here. So the protocol's default endpoint is resolved on the Rust side:
 * an input with no `baseUrl` is stored with the protocol's own default, and the
 * {@link AiProviderProfile} that comes back carries the resolved URL for the
 * form to show. Default *models* are held here — a model name is not an
 * address, and `model` is a required field on the input, so the form has to
 * supply one.
 *
 * Every bound below mirrors a Rust validator rather than being chosen. The
 * check exists for immediate feedback only: the form still sends the value and
 * still shows the backend's refusal verbatim, because the validator on the
 * other side is the one that decides.
 */
import type {
  AiProviderProfile,
  AiProviderProfileInput,
  ProviderProtocol,
} from "@/types/ai";
import { PROVIDER_PROTOCOLS } from "@/types/ai";

import { AI_AGENT_LIMITS } from "./permissions";

/**
 * Bounds for one profile.
 *
 * `temperature` and `maxTokens` are the same ceilings the agent config uses
 * (`ProviderConfig::validate` and `MAX_COMPLETION_TOKENS`) and are taken from
 * {@link AI_AGENT_LIMITS} rather than restated, so the two screens cannot drift
 * apart. `idBytes` and `labelBytes` are this UI's own ceilings; the id charset
 * is the one the backend accepts.
 */
export const AI_PROVIDER_LIMITS = {
  /** `MAX_PROVIDER_ID_BYTES`. */
  idBytes: 64,
  /** `MAX_PROVIDER_LABEL_BYTES`. */
  labelBytes: 128,
  /** `MAX_MODEL_BYTES`. */
  modelBytes: 256,
  /** `MAX_BASE_URL_BYTES`. */
  baseUrlBytes: 2 * 1024,
  /** `MAX_PROVIDER_PROFILES` — how many profiles one install may hold. */
  profiles: 32,
  temperature: AI_AGENT_LIMITS.temperature,
  maxTokens: AI_AGENT_LIMITS.maxTokensPerTurn,
} as const;

/**
 * The charset a provider id is bounded to. Anchored and applied to the whole
 * string, so a dot, a slash or a space is rejected here rather than becoming a
 * backend refusal the user has to decode.
 */
export const AI_PROVIDER_ID_PATTERN = /^[A-Za-z0-9\-_]+$/;

export interface ProviderProtocolInfo {
  protocol: ProviderProtocol;
  /** Names the wire format, never a single vendor. Passed through `t()`. */
  label: string;
  /** What else speaks it, so "any OpenAI-compatible endpoint" is obvious. */
  description: string;
  /** Prefilled into a new profile's model field. */
  defaultModel: string;
  /** Whether endpoints for this protocol normally need a bearer credential. */
  keyExpected: boolean;
}

/**
 * One entry per protocol. `description` is what tells a user that Groq or a
 * local vLLM is reachable without a new build — the protocol list is closed,
 * the provider list is not.
 */
export const PROVIDER_PROTOCOL_INFO: Readonly<
  Record<ProviderProtocol, ProviderProtocolInfo>
> = {
  openai: {
    protocol: "openai",
    label: "OpenAI-compatible",
    description:
      "OpenAI itself and anything that re-implements its chat completions API — Groq, Together, OpenRouter, Fireworks, vLLM, LM Studio. Point the base URL at the endpoint and it works.",
    defaultModel: "gpt-4o-mini",
    keyExpected: true,
  },
  anthropic: {
    protocol: "anthropic",
    label: "Anthropic",
    description:
      "Anthropic's messages API, or a gateway that re-implements it. Set the base URL to use a proxy in front of it.",
    defaultModel: "claude-sonnet-4-20250514",
    keyExpected: true,
  },
  ollama: {
    protocol: "ollama",
    label: "Ollama",
    description:
      "A local Ollama daemon. No API key is needed; set the base URL if it does not listen on its usual port.",
    defaultModel: "llama3.1",
    keyExpected: false,
  },
};

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return (
    typeof value === "string" &&
    (PROVIDER_PROTOCOLS as readonly string[]).includes(value)
  );
}

/**
 * Whether a string carries any whitespace or C0/DEL control character.
 *
 * Written as a code-point scan rather than a character-class regex on purpose:
 * a regex spelling this needs literal control characters or escapes for them,
 * and a raw NUL in a regex literal makes the whole source file look binary to
 * grep, to diff tooling and to anything that sniffs content type. The `/\s/`
 * test carries the Unicode whitespace the scan would otherwise miss, matching
 * Rust's `char::is_whitespace()`.
 */
function hasWhitespaceOrControl(value: string): boolean {
  if (/\s/.test(value)) return true;
  return hasControlCharacter(value);
}

/**
 * Whether a string carries a C0 or DEL control character.
 *
 * Separate from {@link hasWhitespaceOrControl} because a label may contain
 * spaces — "Groq (fast)" is a perfectly good name — while a control character
 * in one still corrupts whatever line it is rendered into.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** UTF-8 byte length, because Rust's `str::len()` counts bytes, not characters. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Whether a base URL is one the backend will accept.
 *
 * Each clause mirrors one in `bc_ai_provider::profile::validate_base_url`, so
 * that a URL this returns `true` for is not then refused for a reason the user
 * was never told:
 *
 * - **Checked before parsing.** `URL` silently strips tabs, newlines and
 *   surrounding control characters, so `ht\ttps://host` would parse to a
 *   perfectly good `https:` URL and pass a scheme check that reads the parsed
 *   result. The raw string is screened for whitespace and control characters
 *   first, exactly as the Rust side does and for the same reason.
 * - **Absolute, `http:` or `https:`, with a host.** `URL` without a base
 *   rejects a relative path outright, which is the point — `"/v1"` and
 *   `"api/v1"` both throw rather than resolving against the app's own origin.
 *   A scheme like `file:` parses fine and is refused explicitly.
 * - **No embedded credentials.** `https://user:pass@host` is a credential in a
 *   field that is stored and displayed, and the backend refuses it.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  if (value.length === 0) return false;
  if (byteLength(value) > AI_PROVIDER_LIMITS.baseUrlBytes) return false;
  if (hasWhitespaceOrControl(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  return parsed.hostname.length > 0;
}

/** Which input a problem belongs to, so the form can mark the right field. */
export type AiProviderIssueField =
  "id" | "label" | "baseUrl" | "model" | "temperature" | "maxTokens" | "apiKey";

export type AiProviderIssueCode =
  | "required"
  | "idCharset"
  | "idTaken"
  | "tooLong"
  | "controlCharacter"
  | "range"
  | "integerRange"
  | "baseUrl"
  | "atCapacity";

export interface AiProviderIssue {
  field: AiProviderIssueField;
  code: AiProviderIssueCode;
  /** Byte ceiling, for `tooLong`. */
  limit?: number;
  /** Inclusive bounds, for `range` and `integerRange`. */
  min?: number;
  max?: number;
}

/**
 * What the form holds while being edited: strings throughout, because a
 * half-typed number is not a number and coercing one mid-keystroke fights the
 * user.
 */
export interface ProviderDraft {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  temperature: string;
  maxTokens: string;
}

/**
 * What to do with the stored API key on save. Mirrors the three states of
 * {@link AiProviderProfileInput.apiKey}: `keep` omits the field, `clear` sends
 * `null`, `replace` sends the typed string.
 *
 * `keep` is the default for an edit, and it is the reason the form never needs
 * a key to put in a field: not touching the key is expressible without knowing
 * it.
 */
export type ProviderKeyAction = "keep" | "replace" | "clear";

/** A blank draft for the given protocol, with that protocol's default model. */
export function newProviderDraft(
  protocol: ProviderProtocol = "openai",
): ProviderDraft {
  return {
    id: "",
    label: "",
    protocol,
    // Left empty on purpose: the backend fills in the protocol's default
    // endpoint, which is the only place that URL is allowed to live.
    baseUrl: "",
    model: PROVIDER_PROTOCOL_INFO[protocol].defaultModel,
    temperature: "0.7",
    maxTokens: "4096",
  };
}

/**
 * The model a draft should carry after its protocol changes.
 *
 * A model the user typed is theirs and is kept; a model that is still the old
 * protocol's default (or is empty) is replaced, because a model name from one
 * protocol means nothing to another — `gpt-4o-mini` is not an Ollama tag.
 */
export function modelForProtocolChange(
  draft: Pick<ProviderDraft, "protocol" | "model">,
  next: ProviderProtocol,
): string {
  const untouched =
    draft.model.trim().length === 0 ||
    draft.model === PROVIDER_PROTOCOL_INFO[draft.protocol].defaultModel;
  return untouched ? PROVIDER_PROTOCOL_INFO[next].defaultModel : draft.model;
}

/**
 * A draft that edits an existing profile.
 *
 * Every field is seeded from the profile except the key, which has no field to
 * seed — {@link AiProviderProfile} carries no key material at all.
 */
export function providerDraftFromProfile(
  profile: AiProviderProfile,
): ProviderDraft {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    temperature: String(profile.temperature),
    maxTokens: String(profile.maxTokens),
  };
}

/**
 * Turn a label into a usable id: lowercase, anything outside the charset
 * becomes a hyphen, runs collapse, ends are trimmed.
 *
 * Only a suggestion — the user can overwrite it, and the backend is free to
 * assign something else when the input carries no id at all.
 */
export function suggestProviderId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, AI_PROVIDER_LIMITS.idBytes);
  return slug.length > 0 ? slug : "provider";
}

export interface ValidateProviderDraftOptions {
  /** Ids already in use by *other* profiles. An edit excludes its own. */
  takenIds: readonly string[];
  /** Creating requires an id; editing shows the existing one read-only. */
  creating: boolean;
  /** How the key is being handled, so `replace` can require a value. */
  keyAction: ProviderKeyAction;
  /** The typed key. Checked for emptiness only; never inspected further. */
  apiKey: string;
}

/**
 * Client-side validation, in field order so the reported list reads top to
 * bottom like the form.
 *
 * Deliberately *not* exhaustive about what the backend will accept: a draft
 * that passes every check here can still be refused (an unreachable endpoint,
 * a model the provider does not serve, a key it rejects), and the form shows
 * that refusal verbatim instead of second-guessing it.
 */
export function validateProviderDraft(
  draft: ProviderDraft,
  options: ValidateProviderDraftOptions,
): AiProviderIssue[] {
  const issues: AiProviderIssue[] = [];
  const id = draft.id.trim();
  const label = draft.label.trim();
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();

  if (options.creating) {
    if (options.takenIds.length >= AI_PROVIDER_LIMITS.profiles) {
      // The backend caps an install at `MAX_PROVIDER_PROFILES`. Saying so
      // before the round trip is the difference between "delete one first" and
      // an opaque refusal after a health check the user waited for.
      issues.push({
        field: "id",
        code: "atCapacity",
        limit: AI_PROVIDER_LIMITS.profiles,
      });
    }
    if (id.length === 0) {
      issues.push({ field: "id", code: "required" });
    } else if (!AI_PROVIDER_ID_PATTERN.test(id)) {
      issues.push({ field: "id", code: "idCharset" });
    } else if (byteLength(id) > AI_PROVIDER_LIMITS.idBytes) {
      issues.push({
        field: "id",
        code: "tooLong",
        limit: AI_PROVIDER_LIMITS.idBytes,
      });
    } else if (options.takenIds.includes(id)) {
      issues.push({ field: "id", code: "idTaken" });
    }
  }

  if (label.length === 0) {
    issues.push({ field: "label", code: "required" });
  } else if (byteLength(label) > AI_PROVIDER_LIMITS.labelBytes) {
    issues.push({
      field: "label",
      code: "tooLong",
      limit: AI_PROVIDER_LIMITS.labelBytes,
    });
  } else if (hasControlCharacter(label)) {
    // The backend refuses these too: a label is rendered into the chat UI and
    // into a `<title>`-adjacent position, and a stray control character there
    // corrupts the line it lands in.
    issues.push({ field: "label", code: "controlCharacter" });
  }

  // An empty base URL is valid and means "the protocol's default".
  if (baseUrl.length > 0 && !isAbsoluteHttpUrl(baseUrl)) {
    issues.push({ field: "baseUrl", code: "baseUrl" });
  }

  if (model.length === 0) {
    issues.push({ field: "model", code: "required" });
  } else if (byteLength(model) > AI_PROVIDER_LIMITS.modelBytes) {
    issues.push({
      field: "model",
      code: "tooLong",
      limit: AI_PROVIDER_LIMITS.modelBytes,
    });
  }

  const temperature = Number(draft.temperature);
  if (
    draft.temperature.trim().length === 0 ||
    !Number.isFinite(temperature) ||
    temperature < AI_PROVIDER_LIMITS.temperature.min ||
    temperature > AI_PROVIDER_LIMITS.temperature.max
  ) {
    issues.push({
      field: "temperature",
      code: "range",
      min: AI_PROVIDER_LIMITS.temperature.min,
      max: AI_PROVIDER_LIMITS.temperature.max,
    });
  }

  const maxTokens = Number(draft.maxTokens);
  if (
    draft.maxTokens.trim().length === 0 ||
    !Number.isInteger(maxTokens) ||
    maxTokens < AI_PROVIDER_LIMITS.maxTokens.min ||
    maxTokens > AI_PROVIDER_LIMITS.maxTokens.max
  ) {
    issues.push({
      field: "maxTokens",
      code: "integerRange",
      min: AI_PROVIDER_LIMITS.maxTokens.min,
      max: AI_PROVIDER_LIMITS.maxTokens.max,
    });
  }

  if (options.keyAction === "replace" && options.apiKey.trim().length === 0) {
    issues.push({ field: "apiKey", code: "required" });
  }

  return issues;
}

export interface ProviderDraftToInputOptions {
  creating: boolean;
  keyAction: ProviderKeyAction;
  apiKey: string;
}

/**
 * Build the command payload from a validated draft.
 *
 * Two omissions are load-bearing rather than tidy-up:
 *
 * - `baseUrl` is omitted when blank, so the backend applies the protocol
 *   default instead of being handed an empty string to reject.
 * - `apiKey` is omitted for `keep`. Sending `undefined` explicitly would
 *   serialize as `null` through Tauri and *clear* the stored key, turning "I
 *   only renamed it" into "I deleted the credential".
 */
export function providerDraftToInput(
  draft: ProviderDraft,
  options: ProviderDraftToInputOptions,
): AiProviderProfileInput {
  const input: AiProviderProfileInput = {
    label: draft.label.trim(),
    protocol: draft.protocol,
    model: draft.model.trim(),
    temperature: Number(draft.temperature),
    maxTokens: Number(draft.maxTokens),
  };
  const id = draft.id.trim();
  if (id.length > 0) input.id = id;
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl.length > 0) input.baseUrl = baseUrl;
  if (options.keyAction === "replace") input.apiKey = options.apiKey;
  else if (options.keyAction === "clear") input.apiKey = null;
  return input;
}

/**
 * A duplicate of `profile`, with a free id and a label that says what it is.
 *
 * The key is *not* carried over, and cannot be: the renderer never holds one.
 * The copy therefore starts with no credential, which the form states rather
 * than letting the user discover it on the first failed send.
 *
 * `label` is passed in already translated, so this module holds no
 * user-visible prose.
 */
export function duplicateProviderDraft(
  profile: AiProviderProfile,
  takenIds: readonly string[],
  label: string,
): ProviderDraft {
  const draft = providerDraftFromProfile(profile);
  const base = suggestProviderId(`${profile.id}-copy`);
  let candidate = base;
  let suffix = 2;
  while (takenIds.includes(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return { ...draft, id: candidate, label };
}
