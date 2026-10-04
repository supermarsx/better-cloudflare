/**
 * The provider validation and draft rules, as pure functions.
 *
 * These exist alongside `AiProviderSettings.test.tsx` rather than instead of
 * it: the component test proves the form reaches these rules, and this file
 * pins the rules themselves at the boundaries — where an off-by-one or a
 * missing scheme check is the difference between a clear local message and an
 * opaque backend refusal.
 *
 * Two of the tests are about the renderer's boundaries rather than validation,
 * and are the load-bearing ones:
 *
 * - `providerDraftToInput` must *omit* `apiKey` for a `keep`, because `null`
 *   means "clear the stored key". The difference between an absent field and a
 *   null one is the difference between renaming a provider and deleting its
 *   credential.
 * - No protocol default may name an endpoint host. The renderer is forbidden
 *   from naming one (`aiProviderProxyBoundary.contract.test.ts`), so the
 *   protocol's default base URL is resolved on the Rust side and `baseUrl` is
 *   simply omitted when blank.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_PROVIDER_ID_PATTERN,
  AI_PROVIDER_LIMITS,
  PROVIDER_PROTOCOL_INFO,
  duplicateProviderDraft,
  isAbsoluteHttpUrl,
  isProviderProtocol,
  modelForProtocolChange,
  newProviderDraft,
  providerDraftFromProfile,
  providerDraftToInput,
  suggestProviderId,
  validateProviderDraft,
  type ProviderDraft,
} from "../src/lib/ai/providers";
import { AI_AGENT_LIMITS } from "../src/lib/ai/permissions";
import { PROVIDER_PROTOCOLS, type AiProviderProfile } from "../src/types/ai";

const PROFILE: AiProviderProfile = {
  id: "openai-main",
  label: "OpenAI",
  protocol: "openai",
  baseUrl: "https://gateway.test/openai/v1",
  model: "gpt-4o-mini",
  temperature: 0.4,
  maxTokens: 2048,
  hasApiKey: true,
};

function draft(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    id: "groq-fast",
    label: "Groq (fast)",
    protocol: "openai",
    baseUrl: "",
    model: "llama-3.3-70b",
    temperature: "0.7",
    maxTokens: "4096",
    ...overrides,
  };
}

function codes(
  overrides: Partial<ProviderDraft> = {},
  options: {
    creating?: boolean;
    takenIds?: readonly string[];
    keyAction?: "keep" | "replace" | "clear";
    apiKey?: string;
  } = {},
): string[] {
  return validateProviderDraft(draft(overrides), {
    creating: options.creating ?? true,
    takenIds: options.takenIds ?? [],
    keyAction: options.keyAction ?? "keep",
    apiKey: options.apiKey ?? "",
  }).map((issue) => `${issue.field}:${issue.code}`);
}

// ── The key's three states ─────────────────────────────────────────────────

test("keep omits apiKey, clear sends null, replace sends the string", () => {
  const kept = providerDraftToInput(draft(), {
    creating: false,
    keyAction: "keep",
    apiKey: "",
  });
  // The whole reason the input type exists: absent means "leave it alone".
  assert.ok(
    !("apiKey" in kept),
    "a kept key must not appear in the payload at all",
  );

  const cleared = providerDraftToInput(draft(), {
    creating: false,
    keyAction: "clear",
    apiKey: "",
  });
  assert.ok("apiKey" in cleared);
  assert.equal(cleared.apiKey, null);

  const replaced = providerDraftToInput(draft(), {
    creating: false,
    keyAction: "replace",
    apiKey: "sk-value",
  });
  assert.equal(replaced.apiKey, "sk-value");
});

test("a replace with nothing typed is refused rather than silently kept", () => {
  assert.deepEqual(codes({}, { keyAction: "replace", apiKey: "   " }), [
    "apiKey:required",
  ]);
  assert.deepEqual(codes({}, { keyAction: "replace", apiKey: "sk-x" }), []);
  // A `keep` needs no value, which is how an edit that does not touch the key
  // stays valid with an empty field.
  assert.deepEqual(codes({}, { keyAction: "keep", apiKey: "" }), []);
});

// ── No endpoint host may live in the renderer ─────────────────────────────

test("no protocol default names an endpoint, and a blank base URL is omitted", () => {
  for (const protocol of PROVIDER_PROTOCOLS) {
    const info = PROVIDER_PROTOCOL_INFO[protocol];
    // A model name, never an address. The endpoint is the backend's to supply.
    assert.ok(info.defaultModel.length > 0);
    assert.doesNotMatch(info.defaultModel, /:\/\//);
    assert.equal(newProviderDraft(protocol).baseUrl, "");
  }

  const blank = providerDraftToInput(draft({ baseUrl: "  " }), {
    creating: true,
    keyAction: "keep",
    apiKey: "",
  });
  assert.ok(
    !("baseUrl" in blank),
    "a blank base URL must be omitted so the protocol default applies",
  );

  const given = providerDraftToInput(
    draft({ baseUrl: " https://x.test/v1 " }),
    {
      creating: true,
      keyAction: "keep",
      apiKey: "",
    },
  );
  assert.equal(given.baseUrl, "https://x.test/v1");
});

// ── Base URL ───────────────────────────────────────────────────────────────

test("a base URL must be absolute http or https", () => {
  for (const good of [
    "http://localhost:1234",
    "https://gateway.test",
    "https://gateway.test/openai/v1",
    "http://127.0.0.1:9999/v1",
    "https://gateway.test/v1?region=eu",
  ]) {
    assert.equal(isAbsoluteHttpUrl(good), true, `${good} must be accepted`);
  }
  for (const bad of [
    "",
    "   ",
    "/v1",
    "v1",
    "gateway.test/v1",
    "//gateway.test/v1",
    "file:///etc/passwd",
    "ws://gateway.test",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "http://",
    "https://",
    // Refused by `validate_base_url` on the Rust side, so refusing it here is
    // what keeps the local message and the backend's answer in agreement.
    "https://user:pass@gateway.test/v1",
    "https://user@gateway.test/v1",
  ]) {
    assert.equal(isAbsoluteHttpUrl(bad), false, `${bad} must be refused`);
  }
});

test("a base URL is screened before URL parsing can launder it", () => {
  // `new URL` strips tabs, newlines and surrounding control characters, so
  // every one of these parses into a valid `https:` URL. The Rust validator
  // checks the raw string first for exactly this reason, and so does this one:
  // otherwise a pasted, line-wrapped URL passes here and is refused there.
  const tab = String.fromCharCode(9);
  const newline = String.fromCharCode(10);
  const nul = String.fromCharCode(0);
  for (const bad of [
    `ht${tab}tps://gateway.test/v1`,
    `https://gateway.test/${newline}v1`,
    `https://gateway.test/v1${nul}`,
    "https://gateway.test/ v1",
    "https://gate way.test/v1",
  ]) {
    // Proof the laundering is real, not hypothetical.
    let parsed: URL | null = null;
    try {
      parsed = new URL(bad);
    } catch {
      parsed = null;
    }
    if (parsed !== null) {
      assert.equal(
        isAbsoluteHttpUrl(bad),
        false,
        `${JSON.stringify(bad)} parses to ${parsed.href} and must still be refused`,
      );
    }
  }
});

test("a base URL over the byte ceiling is refused", () => {
  const host = "https://gateway.test/";
  const at = host + "a".repeat(AI_PROVIDER_LIMITS.baseUrlBytes - host.length);
  assert.equal(at.length, AI_PROVIDER_LIMITS.baseUrlBytes);
  assert.equal(isAbsoluteHttpUrl(at), true);
  assert.equal(isAbsoluteHttpUrl(`${at}a`), false);
});

test("only a non-empty, malformed base URL is an issue", () => {
  assert.deepEqual(codes({ baseUrl: "" }), []);
  assert.deepEqual(codes({ baseUrl: "   " }), []);
  assert.deepEqual(codes({ baseUrl: "/v1" }), ["baseUrl:baseUrl"]);
  assert.deepEqual(codes({ baseUrl: "https://gateway.test/v1" }), []);
});

// ── Id ─────────────────────────────────────────────────────────────────────

test("an id is required when creating and ignored when editing", () => {
  assert.deepEqual(codes({ id: "" }, { creating: true }), ["id:required"]);
  // An edit shows the stored id read-only, so there is nothing to validate.
  assert.deepEqual(codes({ id: "" }, { creating: false }), []);
});

test("the id charset is bounded, anchored, and checked whole", () => {
  for (const good of ["a", "A1", "groq-fast", "my_provider", "x-_-9"]) {
    assert.equal(AI_PROVIDER_ID_PATTERN.test(good), true, `${good} is allowed`);
    assert.deepEqual(codes({ id: good }), []);
  }
  for (const bad of [
    "my provider",
    "groq.fast",
    "groq/fast",
    "groq:fast",
    "gröq",
    "groq\nfast",
    "groq#1",
  ]) {
    assert.equal(AI_PROVIDER_ID_PATTERN.test(bad), false, `${bad} is refused`);
    assert.deepEqual(codes({ id: bad }), ["id:idCharset"], `${bad} is refused`);
  }
});

test("an id at the byte ceiling passes and one over it does not", () => {
  const at = "a".repeat(AI_PROVIDER_LIMITS.idBytes);
  assert.deepEqual(codes({ id: at }), []);
  assert.deepEqual(codes({ id: `${at}a` }), [`id:tooLong`]);
});

test("a duplicate id is caught locally, and an edit excludes its own", () => {
  assert.deepEqual(codes({ id: "taken" }, { takenIds: ["taken", "other"] }), [
    "id:idTaken",
  ]);
  assert.deepEqual(codes({ id: "free" }, { takenIds: ["taken"] }), []);
  // `creating: false` skips the id entirely, which is how an edit can keep its
  // own id without colliding with itself.
  assert.deepEqual(
    codes({ id: "taken" }, { creating: false, takenIds: ["taken"] }),
    [],
  );
});

// ── Label, model and numbers ───────────────────────────────────────────────

test("a label is required and bounded in bytes, not characters", () => {
  assert.deepEqual(codes({ label: "" }), ["label:required"]);
  assert.deepEqual(codes({ label: "   " }), ["label:required"]);
  // Spaces and brackets are fine: "Groq (fast)" is a name someone would pick.
  assert.deepEqual(codes({ label: "Groq (fast)" }), []);

  // Rust's `str::len()` counts bytes, so a multi-byte label must be measured
  // the same way or it passes here and fails there.
  const multibyte = "é".repeat(AI_PROVIDER_LIMITS.labelBytes / 2);
  assert.deepEqual(codes({ label: multibyte }), []);
  assert.deepEqual(codes({ label: `${multibyte}é` }), ["label:tooLong"]);
});

test("a label with a control character is refused, as the backend refuses it", () => {
  for (const code of [0, 9, 10, 13, 27, 0x7f]) {
    assert.deepEqual(
      codes({ label: `Groq${String.fromCharCode(code)}fast` }),
      ["label:controlCharacter"],
      `control character ${code} must be refused`,
    );
  }
});

test("a model is required and bounded in bytes", () => {
  assert.deepEqual(codes({ model: "" }), ["model:required"]);
  assert.deepEqual(codes({ model: "  " }), ["model:required"]);

  const at = "m".repeat(AI_PROVIDER_LIMITS.modelBytes);
  assert.deepEqual(codes({ model: at }), []);
  assert.deepEqual(codes({ model: `${at}m` }), ["model:tooLong"]);
});

test("a full install says so before spending a health check on a refusal", () => {
  const full = Array.from(
    { length: AI_PROVIDER_LIMITS.profiles },
    (_unused, index) => `p${index}`,
  );
  assert.deepEqual(codes({ id: "one-more" }, { takenIds: full }), [
    "id:atCapacity",
  ]);
  // One below the cap is fine, and an *edit* is never capped — it replaces a
  // profile rather than adding one.
  assert.deepEqual(codes({ id: "one-more" }, { takenIds: full.slice(1) }), []);
  assert.deepEqual(
    codes({ id: "p0" }, { creating: false, takenIds: full }),
    [],
  );
});

test("temperature and max tokens mirror the agent-config bounds", () => {
  // Taken from the agent limits rather than restated, so the two screens
  // cannot drift apart.
  assert.deepEqual(AI_PROVIDER_LIMITS.temperature, AI_AGENT_LIMITS.temperature);
  assert.deepEqual(
    AI_PROVIDER_LIMITS.maxTokens,
    AI_AGENT_LIMITS.maxTokensPerTurn,
  );

  const { min: tMin, max: tMax } = AI_PROVIDER_LIMITS.temperature;
  assert.deepEqual(codes({ temperature: String(tMin) }), []);
  assert.deepEqual(codes({ temperature: String(tMax) }), []);
  for (const bad of ["", "   ", "-0.1", "2.1", "abc", "NaN", "Infinity"]) {
    assert.deepEqual(
      codes({ temperature: bad }),
      ["temperature:range"],
      `temperature ${bad} must be refused`,
    );
  }

  const { min: mMin, max: mMax } = AI_PROVIDER_LIMITS.maxTokens;
  assert.deepEqual(codes({ maxTokens: String(mMin) }), []);
  assert.deepEqual(codes({ maxTokens: String(mMax) }), []);
  for (const bad of ["", "0", "-1", String(mMax + 1), "1.5", "abc"]) {
    assert.deepEqual(
      codes({ maxTokens: bad }),
      ["maxTokens:integerRange"],
      `max tokens ${bad} must be refused`,
    );
  }
});

test("issues are reported in field order, not one at a time", () => {
  // A form that reports the first problem only makes the user submit five
  // times to learn five things.
  assert.deepEqual(
    codes(
      {
        id: "bad id",
        label: "",
        baseUrl: "/v1",
        model: "",
        temperature: "9",
        maxTokens: "0",
      },
      { keyAction: "replace", apiKey: "" },
    ),
    [
      "id:idCharset",
      "label:required",
      "baseUrl:baseUrl",
      "model:required",
      "temperature:range",
      "maxTokens:integerRange",
      "apiKey:required",
    ],
  );
});

// ── Drafts ─────────────────────────────────────────────────────────────────

test("a new draft carries the protocol's default model and nothing else", () => {
  for (const protocol of PROVIDER_PROTOCOLS) {
    const fresh = newProviderDraft(protocol);
    assert.equal(fresh.protocol, protocol);
    assert.equal(fresh.model, PROVIDER_PROTOCOL_INFO[protocol].defaultModel);
    assert.equal(fresh.id, "");
    assert.equal(fresh.label, "");
    // The defaults must themselves be valid, or a fresh form opens broken.
    assert.deepEqual(codes({ ...fresh, id: "x", label: "X" }), []);
  }
  assert.equal(newProviderDraft().protocol, "openai");
});

test("a draft from a profile copies every field and no credential", () => {
  const seeded = providerDraftFromProfile(PROFILE);
  assert.deepEqual(seeded, {
    id: "openai-main",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://gateway.test/openai/v1",
    model: "gpt-4o-mini",
    temperature: "0.4",
    maxTokens: "2048",
  });
  // There is no key field on a draft, because there is none on a profile.
  assert.ok(!("apiKey" in seeded));
  assert.ok(!("hasApiKey" in seeded));
});

test("a protocol change replaces an untouched model and keeps a typed one", () => {
  assert.equal(
    modelForProtocolChange(
      { protocol: "openai", model: "gpt-4o-mini" },
      "ollama",
    ),
    PROVIDER_PROTOCOL_INFO.ollama.defaultModel,
  );
  assert.equal(
    modelForProtocolChange({ protocol: "openai", model: "" }, "anthropic"),
    PROVIDER_PROTOCOL_INFO.anthropic.defaultModel,
  );
  assert.equal(
    modelForProtocolChange(
      { protocol: "openai", model: "my-finetune-v3" },
      "ollama",
    ),
    "my-finetune-v3",
  );
});

test("a duplicate gets a free id, the source's settings, and no key", () => {
  const first = duplicateProviderDraft(PROFILE, ["openai-main"], "OpenAI copy");
  assert.equal(first.id, "openai-main-copy");
  assert.equal(first.label, "OpenAI copy");
  // The endpoint and model are worth copying; that is the point of duplicating.
  assert.equal(first.baseUrl, PROFILE.baseUrl);
  assert.equal(first.model, PROFILE.model);

  // Duplicating twice must not collide with the first copy.
  const second = duplicateProviderDraft(
    PROFILE,
    ["openai-main", "openai-main-copy"],
    "OpenAI copy",
  );
  assert.equal(second.id, "openai-main-copy-2");
  const third = duplicateProviderDraft(
    PROFILE,
    ["openai-main", "openai-main-copy", "openai-main-copy-2"],
    "OpenAI copy",
  );
  assert.equal(third.id, "openai-main-copy-3");
});

test("a suggested id is always usable, whatever the label was", () => {
  assert.equal(suggestProviderId("Groq (fast)"), "groq-fast");
  assert.equal(suggestProviderId("  OpenAI / prod  "), "openai-prod");
  assert.equal(suggestProviderId("my_provider"), "my_provider");
  // A label with nothing usable in it still has to produce a valid id rather
  // than an empty one the backend would refuse.
  assert.equal(suggestProviderId(""), "provider");
  assert.equal(suggestProviderId("———"), "provider");
  assert.equal(suggestProviderId("日本語"), "provider");

  for (const label of [
    "Groq (fast)",
    "  OpenAI / prod  ",
    "",
    "———",
    "日本語",
    "a".repeat(200),
  ]) {
    const id = suggestProviderId(label);
    assert.equal(
      AI_PROVIDER_ID_PATTERN.test(id),
      true,
      `${label} produced the unusable id ${id}`,
    );
    assert.ok(id.length <= AI_PROVIDER_LIMITS.idBytes);
  }
});

test("the protocol guard accepts exactly the three wire formats", () => {
  for (const protocol of PROVIDER_PROTOCOLS) {
    assert.equal(isProviderProtocol(protocol), true);
  }
  for (const bad of ["openAi", "OpenAI", "groq", "", null, undefined, 1, {}]) {
    assert.equal(isProviderProtocol(bad), false, `${String(bad)} is not one`);
  }
});
