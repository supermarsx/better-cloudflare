/**
 * Known LLM endpoints, offered as starting points for a provider profile.
 *
 * # What this is and is not
 *
 * The protocol list is closed and the provider list is open: three wire formats
 * (`openai`, `anthropic`, `ollama`) reach any number of vendors, because almost
 * everyone re-implements OpenAI's chat completions API. That already worked —
 * but only if you knew the vendor's base URL and a model name it serves, which
 * meant a tab to the vendor's docs and two fields of careful typing before the
 * assistant could say anything.
 *
 * A preset fills those fields in. It is **not** a new protocol, not a new
 * backend path, and not a capability claim: nothing here changes what the app
 * can talk to. Every field a preset writes is editable afterwards, and the
 * backend validates the result exactly as it validates a hand-typed one.
 *
 * # Why the three reference vendors carry no base URL
 *
 * `ProviderProtocol::default_base_url` in `bc-ai-provider/src/config.rs` owns
 * the endpoint for each protocol's reference vendor, and `newProviderDraft`'s
 * comment is explicit that this is "the only place that URL is allowed to
 * live". So the OpenAI, Anthropic and Ollama presets leave `baseUrl` empty and
 * inherit it, rather than becoming a second copy that can drift from the first.
 * `test/providerPresets.test.ts` reads that Rust file and fails if any preset
 * hard-codes a URL the Rust side already owns.
 *
 * Everything else here is a third-party endpoint the Rust side has no opinion
 * about, so this is its first and only home.
 *
 * # On the model names
 *
 * A model name is the shortest-lived fact in this file — vendors rename and
 * retire them continuously. Each is a model that vendor served when the entry
 * was written, and the field is a text input the user can change. `docsUrl`
 * points at the vendor's own model list for exactly that reason, and the UI
 * says the model is a starting point rather than a guarantee. A preset whose
 * model has been retired costs one edit; it does not break the profile.
 */

import type { ProviderProtocol } from "@/types/ai";

import { PROVIDER_PROTOCOL_INFO, type ProviderDraft } from "./providers";

/** How a preset is grouped in the picker. */
export type AiProviderPresetCategory =
  /** A vendor serving its own models. */
  | "vendor"
  /** A gateway in front of many vendors' models. */
  | "gateway"
  /** Something the user runs themselves, usually on this machine. */
  | "local";

export interface AiProviderPreset {
  /**
   * Stable key, also the suggested profile id — so it obeys
   * `AI_PROVIDER_ID_PATTERN` (alphanumerics, `-` and `_` only).
   */
  id: string;
  /**
   * The vendor's own name for itself.
   *
   * **Not** passed through `t()`. These are product names, and translating
   * "Together AI" into eleven languages would be inventing names their owners
   * do not use — the same rule the sync providers follow.
   */
  label: string;
  protocol: ProviderProtocol;
  /**
   * The endpoint, or `""` to inherit the protocol's default from the backend.
   *
   * Empty is used only by the three reference vendors; see the note above.
   */
  baseUrl: string;
  /** A model that vendor served when this entry was written. */
  model: string;
  /** The vendor's own documentation, where the current model list lives. */
  docsUrl: string;
  /** False only for endpoints that take no credential at all. */
  keyExpected: boolean;
  category: AiProviderPresetCategory;
  /**
   * Set when `baseUrl` contains something only the user can supply, such as an
   * account id. The UI must not let such a preset be saved unedited, and the
   * placeholder is written in angle brackets so it is obvious on sight.
   */
  baseUrlPlaceholder?: string;
}

/**
 * Every preset, grouped by category and alphabetical within each group — which
 * is also the order the picker offers them in.
 */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  // ── Vendors serving their own models ────────────────────────────────────
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "",
    model: PROVIDER_PROTOCOL_INFO.anthropic.defaultModel,
    docsUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    protocol: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "llama3.1-70b",
    docsUrl: "https://inference-docs.cerebras.ai/introduction",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "cloudflare-workers-ai",
    label: "Cloudflare Workers AI",
    protocol: "openai",
    // The account id is in the path, so this one cannot be saved as given.
    // Included anyway because this is a Cloudflare app: a user who manages
    // their DNS here very likely has an account id to hand.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/<account_id>/ai/v1",
    model: "@cf/meta/llama-3.1-8b-instruct",
    docsUrl: "https://developers.cloudflare.com/workers-ai/models/",
    keyExpected: true,
    category: "vendor",
    baseUrlPlaceholder: "<account_id>",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    docsUrl: "https://api-docs.deepseek.com/",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "google-gemini",
    label: "Google Gemini",
    protocol: "openai",
    // Gemini exposes an OpenAI-compatible surface alongside its own API; this
    // is that surface, which is why the protocol is `openai` and not a fourth
    // entry in the closed protocol list.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    docsUrl: "https://console.groq.com/docs/models",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-large-latest",
    docsUrl: "https://docs.mistral.ai/getting-started/models/models_overview/",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "moonshot",
    label: "Moonshot AI",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "moonshot-v1-8k",
    docsUrl: "https://platform.moonshot.ai/docs",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "",
    model: PROVIDER_PROTOCOL_INFO.openai.defaultModel,
    docsUrl: "https://platform.openai.com/docs/models",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    protocol: "openai",
    // No `/v1`: Perplexity serves chat completions at the host root.
    baseUrl: "https://api.perplexity.ai",
    model: "sonar",
    docsUrl: "https://docs.perplexity.ai/guides/model-cards",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "xai",
    label: "xAI",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-2-latest",
    docsUrl: "https://docs.x.ai/docs/models",
    keyExpected: true,
    category: "vendor",
  },
  {
    id: "zhipu",
    label: "Zhipu AI",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-plus",
    docsUrl: "https://open.bigmodel.cn/dev/api",
    keyExpected: true,
    category: "vendor",
  },

  // ── Gateways in front of many vendors ──────────────────────────────────
  {
    id: "alibaba-dashscope",
    label: "Alibaba Model Studio",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/getting-started/models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    protocol: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    docsUrl: "https://deepinfra.com/models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    docsUrl: "https://fireworks.ai/models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "github-models",
    label: "GitHub Models",
    protocol: "openai",
    baseUrl: "https://models.inference.ai.azure.com",
    model: "gpt-4o-mini",
    docsUrl: "https://docs.github.com/en/github-models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    protocol: "openai",
    baseUrl: "https://api.studio.nebius.ai/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    docsUrl: "https://docs.nebius.com/studio/inference/models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    docsUrl: "https://openrouter.ai/models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "sambanova",
    label: "SambaNova",
    protocol: "openai",
    baseUrl: "https://api.sambanova.ai/v1",
    model: "Meta-Llama-3.3-70B-Instruct",
    docsUrl:
      "https://docs.sambanova.ai/cloud/docs/get-started/supported-models",
    keyExpected: true,
    category: "gateway",
  },
  {
    id: "together",
    label: "Together AI",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    docsUrl: "https://docs.together.ai/docs/serverless-models",
    keyExpected: true,
    category: "gateway",
  },

  // ── Run it yourself ────────────────────────────────────────────────────
  {
    id: "llama-cpp",
    label: "llama.cpp server",
    protocol: "openai",
    baseUrl: "http://localhost:8080/v1",
    model: "local-model",
    docsUrl: "https://github.com/ggml-org/llama.cpp/tree/master/tools/server",
    // `llama-server` serves without a key unless one is configured.
    keyExpected: false,
    category: "local",
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    // LM Studio routes by the identifier shown beside a loaded model, so there
    // is no name that is right for every install.
    model: "local-model",
    docsUrl: "https://lmstudio.ai/docs/app/api/endpoints/openai",
    keyExpected: false,
    category: "local",
  },
  {
    id: "litellm",
    label: "LiteLLM proxy",
    protocol: "openai",
    baseUrl: "http://localhost:4000/v1",
    model: "gpt-4o-mini",
    docsUrl: "https://docs.litellm.ai/docs/simple_proxy",
    // A proxy usually holds the upstream keys and takes its own virtual key,
    // which may or may not be set.
    keyExpected: false,
    category: "local",
  },
  {
    id: "ollama",
    label: "Ollama",
    protocol: "ollama",
    baseUrl: "",
    model: PROVIDER_PROTOCOL_INFO.ollama.defaultModel,
    docsUrl: "https://ollama.com/library",
    keyExpected: false,
    category: "local",
  },
  {
    id: "vllm",
    label: "vLLM",
    protocol: "openai",
    baseUrl: "http://localhost:8000/v1",
    model: "local-model",
    docsUrl:
      "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html",
    keyExpected: false,
    category: "local",
  },
];

/** A preset by id, or `undefined`. */
export function findAiProviderPreset(id: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/**
 * Turn a preset into a draft the provider form can open.
 *
 * The id is suffixed when the preset's own id is taken, so adding a second
 * OpenRouter profile — a different key, or a different default model — does not
 * collide with the first. The label is left alone: two profiles called
 * "OpenRouter" are the user's business and they can rename either.
 *
 * `temperature` and `maxTokens` come from a blank draft rather than from the
 * preset, because they are not properties of an endpoint.
 */
export function providerDraftFromPreset(
  preset: AiProviderPreset,
  takenIds: readonly string[],
  blank: ProviderDraft,
): ProviderDraft {
  let id = preset.id;
  if (takenIds.includes(id)) {
    let suffix = 2;
    while (takenIds.includes(`${preset.id}-${suffix}`)) suffix += 1;
    id = `${preset.id}-${suffix}`;
  }
  return {
    ...blank,
    id,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: preset.model,
  };
}
