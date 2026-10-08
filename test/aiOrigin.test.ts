/**
 * Reading a transcript's attribution.
 *
 * This is the half of per-conversation switching that is a correctness
 * requirement rather than a convenience: once the provider, model and persona
 * can change mid-thread, `Conversation.provider` stops describing the
 * transcript, and crediting an assistant answer to the wrong model is wrong in
 * the same way a wrong DNS record is wrong. Everything here is a pure function
 * over `ChatMessage.origin`, which is why it is tested without rendering
 * anything.
 *
 * Two claims carry the weight:
 *
 * **An id that no longer resolves is shown as itself.** A provider profile or
 * a persona can be deleted while the transcript that used it survives, and
 * substituting another profile's label for it would be a lie about which
 * endpoint saw the conversation. The `*Resolved` flags are what let a renderer
 * say "deleted" rather than print a bare id as though it were a name.
 *
 * **A marker appears only where something changed.** Not at the start, and not
 * on every message: a conversation that never switched must cost the
 * transcript no extra rows at all, because the same renderer serves a 22rem
 * dock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aiOriginChanges,
  aiPersonaLabel,
  aiProviderLabel,
  sameAiOrigin,
  summarizeAiOrigin,
} from "../src/lib/ai/origin";
import type {
  AiPersona,
  AiProviderProfile,
  ChatMessage,
  MessageOrigin,
} from "../src/types/ai";

const CREATED = "2026-08-25T10:00:00Z";

const PROVIDERS: AiProviderProfile[] = [
  {
    id: "openai-main",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.test/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    hasApiKey: true,
  },
];

const PERSONAS: AiPersona[] = [
  {
    id: "dns-expert",
    name: "DNS expert",
    description: "DNS record management specialist",
    systemPrompt: "You are a DNS expert.",
    builtin: true,
  },
];

function origin(overrides: Partial<MessageOrigin> = {}): MessageOrigin {
  return { provider: "openai-main", model: "gpt-4o-mini", ...overrides };
}

function message(id: string, carried?: MessageOrigin): ChatMessage {
  return {
    id,
    message: { role: "assistant", content: { type: "text", text: id } },
    status: "complete",
    createdAt: CREATED,
    pendingToolCalls: [],
    ...(carried ? { origin: carried } : {}),
  };
}

// ── Label resolution ───────────────────────────────────────────────────────

test("an id that no longer resolves is shown as itself, never as another entry", () => {
  assert.equal(aiProviderLabel("openai-main", PROVIDERS), "OpenAI");
  assert.equal(aiProviderLabel("groq-fast", PROVIDERS), "groq-fast");
  assert.equal(aiProviderLabel("openai-main", []), "openai-main");

  assert.equal(aiPersonaLabel("dns-expert", PERSONAS), "DNS expert");
  assert.equal(aiPersonaLabel("custom-gone", PERSONAS), "custom-gone");
});

test("a summary reports whether each id resolved, not just its text", () => {
  const resolved = summarizeAiOrigin(origin({ personaId: "dns-expert" }), {
    providers: PROVIDERS,
    personas: PERSONAS,
  });
  assert.equal(resolved.provider, "OpenAI");
  assert.equal(resolved.providerResolved, true);
  assert.equal(resolved.model, "gpt-4o-mini");
  assert.equal(resolved.persona, "DNS expert");
  assert.equal(resolved.personaResolved, true);
  assert.equal(resolved.missingPersonaId, null);
  assert.equal(resolved.missingProviderId, null);

  // Both deleted since the turn ran. The bare ids survive, flagged as
  // unresolved, so a renderer can mark them rather than pass them off as
  // labels.
  const stale = summarizeAiOrigin(
    origin({ provider: "groq-fast", personaId: "custom-gone" }),
    { providers: PROVIDERS, personas: PERSONAS },
  );
  assert.equal(stale.provider, "groq-fast");
  assert.equal(stale.providerResolved, false);
  assert.equal(stale.persona, "custom-gone");
  assert.equal(stale.personaResolved, false);
});

test("no persona is null rather than an invented name", () => {
  const summary = summarizeAiOrigin(origin(), {
    providers: PROVIDERS,
    personas: PERSONAS,
  });
  assert.equal(
    summary.persona,
    null,
    "a turn that sent no persona prompt must not be credited with one",
  );
  assert.equal(summary.personaResolved, false);
});

test("a substituted choice is reported alongside what actually ran", () => {
  const summary = summarizeAiOrigin(
    origin({
      personaId: "dns-expert",
      missingPersonaId: "custom-gone",
      missingProviderId: "groq-fast",
    }),
    { providers: PROVIDERS, personas: PERSONAS },
  );
  // What ran.
  assert.equal(summary.provider, "OpenAI");
  assert.equal(summary.persona, "DNS expert");
  // What was asked for and could not be honoured.
  assert.equal(summary.missingPersonaId, "custom-gone");
  assert.equal(summary.missingProviderId, "groq-fast");
});

// ── Where a switch happened ────────────────────────────────────────────────

test("every recorded field counts as the attribution", () => {
  const base = origin({ personaId: "dns-expert" });
  assert.ok(sameAiOrigin(base, origin({ personaId: "dns-expert" })));
  assert.ok(!sameAiOrigin(base, origin({ personaId: "security-auditor" })));
  assert.ok(
    !sameAiOrigin(base, origin({ personaId: "dns-expert", model: "gpt-4o" })),
  );
  assert.ok(
    !sameAiOrigin(
      base,
      origin({ personaId: "dns-expert", provider: "groq-fast" }),
    ),
  );
  // A second doomed choice changed something even though the prompt that ran
  // is the same fallback both times, so it counts.
  assert.ok(
    !sameAiOrigin(
      origin({ personaId: "default", missingPersonaId: "custom-a" }),
      origin({ personaId: "default", missingPersonaId: "custom-b" }),
    ),
  );
  assert.ok(
    !sameAiOrigin(
      origin({ missingProviderId: "groq-fast" }),
      origin({ missingProviderId: "groq-slow" }),
    ),
  );
});

test("a conversation that never switched reports no changes at all", () => {
  const carried = origin({ personaId: "dns-expert" });
  const changes = aiOriginChanges([
    message("m1", carried),
    message("m2", carried),
    message("m3", { ...carried }),
  ]);
  assert.equal(
    changes.size,
    0,
    "the transcript must cost no extra rows when nothing changed",
  );
});

test("the first attributed message is not a change", () => {
  const changes = aiOriginChanges([message("m1", origin())]);
  assert.equal(
    changes.size,
    0,
    "there is nothing to have switched from on the first message",
  );
});

test("a change is reported on the message it takes effect on, with what came before", () => {
  const before = origin({ personaId: "dns-expert" });
  const after = origin({ personaId: "security-auditor", model: "gpt-4o" });
  const changes = aiOriginChanges([
    message("m1", before),
    message("m2", before),
    message("m3", after),
    message("m4", after),
  ]);

  assert.deepEqual([...changes.keys()], ["m3"]);
  const change = changes.get("m3");
  assert.ok(change !== undefined, "expected a change on m3");
  assert.deepEqual(change.origin, after);
  assert.deepEqual(
    change.previous,
    before,
    "the marker has to say what the conversation switched away from",
  );
});

test("switching back is a change too, and is reported again", () => {
  const first = origin({ personaId: "dns-expert" });
  const second = origin({ personaId: "security-auditor" });
  const changes = aiOriginChanges([
    message("m1", first),
    message("m2", second),
    message("m3", first),
  ]);
  assert.deepEqual([...changes.keys()], ["m2", "m3"]);
});

test("unattributed messages neither carry nor break a change", () => {
  const before = origin({ personaId: "dns-expert" });
  const after = origin({ personaId: "security-auditor" });
  // A tool result sits between the assistant messages of one turn and has no
  // origin of its own; treating it as a change would make a single tool round
  // look like two switches.
  const changes = aiOriginChanges([
    message("m1", before),
    message("tool-1"),
    message("m2", before),
    message("legacy"),
    message("m3", after),
  ]);
  assert.deepEqual([...changes.keys()], ["m3"]);
  assert.deepEqual(changes.get("m3")?.previous, before);
});

test("a transcript recorded before attribution existed reports nothing", () => {
  const changes = aiOriginChanges([
    message("m1"),
    message("m2"),
    message("m3"),
  ]);
  assert.equal(changes.size, 0);
});
