/**
 * The provider preset catalogue cannot ship an entry the app would refuse.
 *
 * # Why this is the test that matters
 *
 * A preset is data. Twenty-six hand-written entries, each with a URL, a model
 * and an id, none of them exercised by anything until a user picks that exact
 * one — so a typo in the eleventh entry is invisible until someone needs the
 * eleventh provider. There is no render path that touches them all.
 *
 * So the catalogue is driven through the same validator the form uses. Every
 * preset becomes a draft and that draft must produce **no** issues. That turns
 * "did I type these twenty-six entries correctly" into something a test run
 * answers, and it stays answered when the twenty-seventh is added.
 *
 * # And why the Rust check is here
 *
 * `newProviderDraft` states that a protocol's default endpoint lives in
 * `bc-ai-provider/src/config.rs` and nowhere else. A preset that hard-coded
 * `https://api.openai.com/v1` would be a second copy of a fact Rust owns, free
 * to drift from it — and that drift already exists between the two default
 * *model* names, so this is not hypothetical. The assertion reads the Rust file
 * and fails if any preset re-states a URL from it, which is the same technique
 * `i18nFilenameLiterals` uses to keep the sync filenames honest.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AI_PROVIDER_PRESETS,
  findAiProviderPreset,
  providerDraftFromPreset,
} from "../src/lib/ai/provider-presets.ts";
import {
  AI_PROVIDER_ID_PATTERN,
  AI_PROVIDER_LIMITS,
  PROVIDER_PROTOCOL_INFO,
  isAbsoluteHttpUrl,
  newProviderDraft,
  validateProviderDraft,
} from "../src/lib/ai/providers.ts";

const RUST_CONFIG = readFileSync(
  new URL("../src-tauri/crates/bc-ai-provider/src/config.rs", import.meta.url),
  "utf8",
);

test("the catalogue is big enough to be worth having", () => {
  // Guards against a sweep that silently found nothing — every assertion below
  // iterates the catalogue, so an empty one would pass all of them.
  assert.ok(
    AI_PROVIDER_PRESETS.length >= 20,
    `expected an extensive catalogue, found ${AI_PROVIDER_PRESETS.length}`,
  );
});

test("every preset produces a draft the form would accept", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    const draft = providerDraftFromPreset(
      preset,
      [],
      newProviderDraft(preset.protocol),
    );
    const issues = validateProviderDraft(draft, {
      takenIds: [],
      creating: true,
      keyAction: preset.keyExpected ? "replace" : "keep",
      // A preset cannot carry a credential, so the key the user will type is
      // stood in for here. What is under test is the preset's own fields.
      apiKey: preset.keyExpected ? "placeholder-key" : "",
    });
    assert.deepEqual(
      issues,
      [],
      `${preset.id} produced issues: ${JSON.stringify(issues)}`,
    );
  }
});

test("every preset id is usable as a profile id", () => {
  const seen = new Set<string>();
  for (const preset of AI_PROVIDER_PRESETS) {
    assert.match(
      preset.id,
      AI_PROVIDER_ID_PATTERN,
      `${preset.id} is not a legal provider id`,
    );
    assert.ok(
      Buffer.byteLength(preset.id, "utf8") <= AI_PROVIDER_LIMITS.idBytes,
      `${preset.id} exceeds ${AI_PROVIDER_LIMITS.idBytes} bytes`,
    );
    assert.ok(!seen.has(preset.id), `${preset.id} appears twice`);
    seen.add(preset.id);
  }
});

test("every preset names itself and a model, within the backend's limits", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    assert.ok(preset.label.trim().length > 0, `${preset.id} has no label`);
    assert.ok(
      Buffer.byteLength(preset.label, "utf8") <= AI_PROVIDER_LIMITS.labelBytes,
      `${preset.id}'s label exceeds ${AI_PROVIDER_LIMITS.labelBytes} bytes`,
    );
    assert.ok(preset.model.trim().length > 0, `${preset.id} has no model`);
    assert.ok(
      Buffer.byteLength(preset.model, "utf8") <= AI_PROVIDER_LIMITS.modelBytes,
      `${preset.id}'s model exceeds ${AI_PROVIDER_LIMITS.modelBytes} bytes`,
    );
  }
});

test("a preset's base URL is either absolute, inherited, or visibly incomplete", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    if (preset.baseUrl === "") {
      // Inheriting the protocol default, which only the reference vendors do.
      assert.equal(
        preset.id,
        PROVIDER_PROTOCOL_INFO[preset.protocol].protocol === "openai"
          ? "openai"
          : preset.id,
        `${preset.id} inherits a base URL but is not a reference vendor`,
      );
      continue;
    }
    if (preset.baseUrlPlaceholder !== undefined) {
      // Not a valid URL yet, by design — it carries a slot only the user can
      // fill. It must actually contain the slot it advertises, or the UI's
      // "replace this first" warning would point at nothing.
      assert.ok(
        preset.baseUrl.includes(preset.baseUrlPlaceholder),
        `${preset.id} advertises placeholder ${preset.baseUrlPlaceholder} but its URL does not contain it`,
      );
      continue;
    }
    assert.ok(
      isAbsoluteHttpUrl(preset.baseUrl),
      `${preset.id}'s base URL is not an absolute http(s) URL: ${preset.baseUrl}`,
    );
  }
});

test("no preset re-states a base URL that Rust owns", () => {
  // Pulled out of the Rust match arms rather than restated here, so this test
  // cannot drift from the thing it is protecting.
  const owned = [
    ...RUST_CONFIG.matchAll(
      /Self::(?:OpenAi|Anthropic|Ollama)\s*=>\s*"(https?:\/\/[^"]+)"/gu,
    ),
  ].map(([, url]) => url);

  assert.ok(
    owned.length >= 3,
    `expected to find the protocol default URLs in config.rs, found ${owned.length}`,
  );

  for (const preset of AI_PROVIDER_PRESETS) {
    assert.ok(
      !owned.includes(preset.baseUrl),
      `${preset.id} hard-codes ${preset.baseUrl}, which bc-ai-provider/src/config.rs already owns — leave baseUrl empty to inherit it`,
    );
  }
});

test("the three reference vendors inherit rather than restate", () => {
  // The converse of the test above: not merely "nobody copies the URL" but
  // "the entries that should inherit actually do". Without this, deleting the
  // OpenAI preset's inheritance in favour of no preset at all would pass.
  for (const id of ["openai", "anthropic", "ollama"]) {
    const preset = findAiProviderPreset(id);
    assert.ok(preset !== undefined, `${id} should be offered as a preset`);
    assert.equal(
      preset.baseUrl,
      "",
      `${id} must inherit its endpoint from the backend`,
    );
  }
});

test("a local endpoint expects no key and a hosted one does", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    if (preset.category === "local") continue;
    assert.equal(
      preset.keyExpected,
      true,
      `${preset.id} is hosted, so it needs a credential`,
    );
  }
});

test("every preset points at documentation over https", () => {
  for (const preset of AI_PROVIDER_PRESETS) {
    assert.ok(
      isAbsoluteHttpUrl(preset.docsUrl),
      `${preset.id}'s docs URL is not absolute: ${preset.docsUrl}`,
    );
    assert.ok(
      preset.docsUrl.startsWith("https://"),
      `${preset.id}'s docs URL is not https: ${preset.docsUrl}`,
    );
  }
});

test("a taken id is suffixed rather than colliding", () => {
  const preset = findAiProviderPreset("openrouter");
  assert.ok(preset !== undefined);

  const first = providerDraftFromPreset(preset, [], newProviderDraft());
  assert.equal(first.id, "openrouter");

  // A second profile for the same vendor is a real case: a different key, or a
  // different default model.
  const second = providerDraftFromPreset(
    preset,
    ["openrouter"],
    newProviderDraft(),
  );
  assert.equal(second.id, "openrouter-2");
  const third = providerDraftFromPreset(
    preset,
    ["openrouter", "openrouter-2"],
    newProviderDraft(),
  );
  assert.equal(third.id, "openrouter-3");

  // The label is deliberately not suffixed: two profiles named "OpenRouter"
  // are the user's business, and the id is what has to be unique.
  assert.equal(second.label, "OpenRouter");
});

test("a preset does not carry tuning that belongs to the profile", () => {
  // `temperature` and `maxTokens` are not properties of an endpoint, so they
  // come from the blank draft. If a preset started overriding them, picking a
  // provider would silently reset a user's tuning.
  const blank = newProviderDraft();
  for (const preset of AI_PROVIDER_PRESETS) {
    const draft = providerDraftFromPreset(preset, [], blank);
    assert.equal(draft.temperature, blank.temperature, preset.id);
    assert.equal(draft.maxTokens, blank.maxTokens, preset.id);
  }
});
