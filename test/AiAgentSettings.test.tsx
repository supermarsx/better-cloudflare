/**
 * The generation settings form.
 *
 * Two properties carry this file, and everything else here is scaffolding for
 * them:
 *
 * 1. **No field is a bare number.** Each one states what it does and what a
 *    high or low value costs, and prints its accepted range from the shared
 *    bounds rather than from a literal, so the number on screen cannot drift
 *    away from the number that refuses the save.
 * 2. **Nothing claims to reach a provider that will not take it.** `topP` once
 *    shipped stored, validated and sent nowhere. The advanced parameters could
 *    repeat that six times over, so a control whose parameter the capability
 *    map does not list for the provider in use is locked and says why — and
 *    when the map could not be read at all, none of them is operable, because
 *    "we could not ask" is not permission to imply "yes".
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AiAgentSettings } from "../src/components/ai/AiAgentSettings";
import {
  AI_ADVANCED_PARAMETERS,
  type AiAdvancedParameter,
} from "../src/lib/ai/capabilities";
import {
  AI_AGENT_LIMITS,
  AI_DEFAULT_MAX_CONTEXT_TOKENS,
  AI_PERSONA_LIMITS,
  AI_STOP_LIMITS,
  validateAgentConfig,
} from "../src/lib/ai/permissions";
import type { AgentConfig, AiProtocolCapabilities } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const CONFIG: AgentConfig = {
  maxToolRounds: 8,
  maxTokensPerTurn: 4096,
  toolsEnabled: true,
  stream: true,
  temperature: 0.7,
  topP: 1,
  personaId: "default",
  defaultProviderId: "openai-main",
};

/**
 * The map `ai_protocol_capabilities` actually returns, copied from the
 * per-protocol tables in `bc-ai-provider/src/sampling.rs`: OpenAI takes the
 * penalties and a seed but no `topK`, Anthropic takes `topK` and neither
 * penalty nor seed. The asymmetry is the whole point — a fixture where every
 * protocol took everything would pin nothing.
 *
 * Note what is *absent*: `maxContextTokens`, `systemPromptOverride` and
 * `requestTimeoutMs` appear under no protocol, because the backend applies
 * them itself rather than putting them in a request body. The UI has to read
 * that out of the map rather than hold a list of its own.
 */
const CAPABILITIES: AiProtocolCapabilities = {
  openai: ["topP", "stop", "seed", "frequencyPenalty", "presencePenalty"],
  anthropic: ["topP", "topK", "stop"],
  ollama: ["topP", "topK", "stop", "seed"],
};

/** The parameters no protocol advertises, so none of them is ever marked. */
const BACKEND_APPLIED = [
  "maxContextTokens",
  "systemPromptOverride",
  "requestTimeoutMs",
] as const;

interface Harness {
  saved: AgentConfig[];
  retries: number;
}

function renderSettings(
  overrides: Partial<React.ComponentProps<typeof AiAgentSettings>> = {},
): Harness {
  const harness: Harness = { saved: [], retries: 0 };
  render(
    <AiAgentSettings
      config={CONFIG}
      protocol="openai"
      providerLabel="OpenAI"
      capabilities={CAPABILITIES}
      capabilitiesLoading={false}
      capabilitiesError={null}
      onRetryCapabilities={() => {
        harness.retries += 1;
      }}
      onSave={async (next) => {
        harness.saved.push(next);
      }}
      {...overrides}
    />,
  );
  return harness;
}

/** One field's wrapper, which carries what the capability map decided. */
function field(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-field="${name}"]`);
  assert.ok(found, `expected a field for ${name}`);
  return found;
}

function advanced(): HTMLDetailsElement {
  const found = screen.getByTestId("ai-agent-advanced");
  assert.ok(found instanceof window.HTMLDetailsElement);
  return found;
}

/** Every field on the form, in render order, by parameter name. */
function fieldNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="ai-agent-field"]'),
  ).map((node) => node.dataset.field ?? "");
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

// ── Every field explains itself ────────────────────────────────────────────

test("every setting states what it does, not just its name", () => {
  renderSettings();

  for (const name of [
    "temperature",
    "topP",
    "maxToolRounds",
    "maxTokensPerTurn",
    "stream",
    ...AI_ADVANCED_PARAMETERS,
  ]) {
    const explanation = field(name).textContent ?? "";
    // Long enough to be a sentence about consequences rather than a restated
    // label. The shortest real explanation on the form is ~190 characters.
    assert.ok(
      explanation.length > 120,
      `${name} must carry an explanation, got ${JSON.stringify(explanation)}`,
    );
  }
});

test("no explanation merely restates its own label", () => {
  renderSettings();

  // "Temperature: the temperature" is the failure mode. Every explanation has
  // to say something the label does not, so none of them may be the label
  // again with punctuation around it.
  for (const node of document.querySelectorAll<HTMLElement>(
    '[data-testid="ai-agent-field"]',
  )) {
    const label = node.querySelector("label")?.textContent?.trim() ?? "";
    const help = node.querySelector<HTMLElement>(
      '[data-testid="ai-agent-range"]',
    )?.nextElementSibling;
    const explanation = help?.textContent?.trim() ?? "";
    assert.ok(explanation.length > 0, `${label} has no explanation`);
    assert.notEqual(explanation.replace(/[.:]/g, ""), label);
  }
});

test("each field prints the range the shared bounds carry, not a literal", () => {
  renderSettings();

  // The point of reading these from `AI_AGENT_LIMITS` is that the backend's
  // validator is the source: a change there has to move the text on screen.
  assert.match(
    field("temperature").textContent ?? "",
    new RegExp(
      `Between ${AI_AGENT_LIMITS.temperature.min} and ${AI_AGENT_LIMITS.temperature.max}\\.`,
    ),
  );
  assert.match(
    field("topP").textContent ?? "",
    new RegExp(
      `Between ${AI_AGENT_LIMITS.topP.min} and ${AI_AGENT_LIMITS.topP.max}\\.`,
    ),
  );
  assert.match(
    field("maxToolRounds").textContent ?? "",
    new RegExp(
      `A whole number between ${AI_AGENT_LIMITS.maxToolRounds.min} and ${AI_AGENT_LIMITS.maxToolRounds.max}\\.`,
    ),
  );
  assert.match(
    field("maxTokensPerTurn").textContent ?? "",
    new RegExp(
      `A whole number between ${AI_AGENT_LIMITS.maxTokensPerTurn.min} and ${AI_AGENT_LIMITS.maxTokensPerTurn.max}\\.`,
    ),
  );
  // The override's ceiling is the provider's own system-prompt limit, which is
  // the same bound a persona prompt is held to.
  assert.match(
    field("systemPromptOverride").textContent ?? "",
    new RegExp(`Up to ${AI_PERSONA_LIMITS.systemPromptBytes} bytes`),
  );
  // Every field has a range line, including the checkbox.
  assert.equal(
    document.querySelectorAll('[data-testid="ai-agent-range"]').length,
    fieldNames().length,
  );
});

test("the input bounds are the bounds the text promises", () => {
  renderSettings();

  const bounded = (label: string) =>
    screen.getByLabelText(label) as HTMLInputElement;
  assert.equal(
    bounded("Temperature").max,
    String(AI_AGENT_LIMITS.temperature.max),
  );
  assert.equal(bounded("Top-p").max, String(AI_AGENT_LIMITS.topP.max));
  assert.equal(
    bounded("Tool rounds per turn").max,
    String(AI_AGENT_LIMITS.maxToolRounds.max),
  );
  assert.equal(
    bounded("Tokens per turn").max,
    String(AI_AGENT_LIMITS.maxTokensPerTurn.max),
  );
});

// ── The advanced group ─────────────────────────────────────────────────────

test("the advanced parameters are collapsed, and all of them are there", () => {
  renderSettings();

  assert.equal(
    advanced().open,
    false,
    "the common controls must not be buried under eight more",
  );
  assert.ok(within(advanced()).getByText(/^Advanced/));
  // Each advanced parameter has a control, and `AI_ADVANCED_PARAMETERS` is the
  // list, so adding one to the contract without rendering it fails here.
  for (const parameter of AI_ADVANCED_PARAMETERS) {
    assert.ok(
      advanced().contains(field(parameter)),
      `${parameter} must live in the advanced group`,
    );
  }
});

test("an advanced control the provider does not accept is marked and locked", () => {
  renderSettings({ protocol: "openai", providerLabel: "OpenAI" });

  // OpenAI has no `topK`; the map says so, and that is the only reason this
  // UI says so.
  const topK = field("topK");
  assert.equal(topK.dataset.applicability, "unsupported");
  assert.equal(
    (screen.getByLabelText("Top-k") as HTMLInputElement).disabled,
    true,
  );
  assert.match(
    within(topK).getByTestId("ai-agent-marking").textContent ?? "",
    /Not sent to OpenAI: the openai protocol does not accept this parameter\./,
  );
  // And it says the value survives, because it does: the config is sent back
  // unchanged rather than blanked.
  assert.match(
    within(topK).getByTestId("ai-agent-marking").textContent ?? "",
    /The value is kept, and applies to a provider that does\./,
  );

  // A parameter the same provider does accept is left alone entirely.
  const seed = field("seed");
  assert.equal(seed.dataset.applicability, "honoured");
  assert.equal(
    (screen.getByLabelText("Seed") as HTMLInputElement).disabled,
    false,
  );
  assert.equal(within(seed).queryByTestId("ai-agent-marking"), null);
});

test("the marking follows the provider rather than a list in the frontend", () => {
  renderSettings({ protocol: "anthropic", providerLabel: "Claude via proxy" });

  // Anthropic is the mirror image of OpenAI: `topK` yes, penalties and seed
  // no. Nothing in the component knows that — the map does.
  assert.equal(field("topK").dataset.applicability, "honoured");
  for (const parameter of [
    "seed",
    "frequencyPenalty",
    "presencePenalty",
  ] as const) {
    assert.equal(
      field(parameter).dataset.applicability,
      "unsupported",
      `${parameter} must be marked for anthropic`,
    );
    assert.match(
      within(field(parameter)).getByTestId("ai-agent-marking").textContent ??
        "",
      /Not sent to Claude via proxy: the anthropic protocol does not accept/,
    );
  }
  // The summary on the closed disclosure says how many, so the marking is
  // discoverable without opening it.
  assert.ok(screen.getByText("Advanced (3 not accepted by this provider)"));
});

test("a parameter no protocol advertises is never marked against one", () => {
  renderSettings({ protocol: "anthropic", providerLabel: "Claude via proxy" });

  // The context budget trims history before a request is built, the prompt
  // override is composed into the system prompt, and the timeout wraps the
  // HTTP call: none of them is a field in a provider's body, which is why
  // `ai_protocol_capabilities` lists them under no protocol. Marking them
  // "not accepted by anthropic" would be a confident falsehood — and the rule
  // that avoids it is read out of the map, not out of a list here.
  for (const parameter of BACKEND_APPLIED) {
    assert.equal(
      field(parameter).dataset.applicability,
      "notProtocolControl",
      parameter,
    );
    assert.equal(
      within(field(parameter)).queryByTestId("ai-agent-marking"),
      null,
    );
  }
  assert.equal(
    (screen.getByLabelText("Context token ceiling") as HTMLInputElement)
      .disabled,
    false,
  );
  assert.equal(
    (screen.getByLabelText("System prompt override") as HTMLTextAreaElement)
      .disabled,
    false,
  );
  assert.equal(
    (screen.getByLabelText("Request timeout") as HTMLInputElement).disabled,
    false,
  );
  // The three Anthropic genuinely refuses are still the only ones counted.
  assert.ok(screen.getByText("Advanced (3 not accepted by this provider)"));
});

test("topP is capability-checked even though it sits with the common controls", () => {
  // The setting that lied. It is rendered above the disclosure for history's
  // sake, which must not exempt it from the check that exists because of it.
  renderSettings({
    protocol: "openai",
    providerLabel: "OpenAI",
    capabilities: { ...CAPABILITIES, openai: ["stop", "seed"] },
  });

  assert.equal(field("topP").dataset.applicability, "unsupported");
  assert.equal(
    (screen.getByLabelText("Top-p") as HTMLInputElement).disabled,
    true,
  );
  assert.match(
    within(field("topP")).getByTestId("ai-agent-marking").textContent ?? "",
    /does not accept this parameter/,
  );
  // Temperature is not in the map at all, because it is not provider-dependent
  // — it reaches every protocol — so it is neither marked nor locked.
  assert.equal(
    field("temperature").dataset.applicability,
    "notProviderDependent",
  );
  assert.equal(
    (screen.getByLabelText("Temperature") as HTMLInputElement).disabled,
    false,
  );
});

test("an unread capability map locks the advanced group instead of guessing", () => {
  const harness = renderSettings({
    capabilities: null,
    capabilitiesError: {
      code: "AI_UNAVAILABLE",
      message: "The assistant is not running.",
      source: "agent",
      operation: "ai:protocol_capabilities",
      retryable: true,
      details: {},
    },
  });

  for (const parameter of AI_ADVANCED_PARAMETERS) {
    assert.equal(
      field(parameter).dataset.applicability,
      "unknownCapabilities",
      `${parameter} must not be claimed either way`,
    );
  }
  assert.equal(
    (screen.getByLabelText("Top-k") as HTMLInputElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByLabelText("Seed") as HTMLInputElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByLabelText("System prompt override") as HTMLTextAreaElement)
      .disabled,
    true,
  );
  assert.match(
    screen.getByTestId("ai-agent-advanced-notice").textContent ?? "",
    /The assistant is not running\..*locked until it can/,
  );
  // No parameter is *marked* unsupported: that would be a claim, and the only
  // honest statement is the group-level one.
  assert.equal(
    document.querySelectorAll('[data-testid="ai-agent-marking"]').length,
    0,
  );

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.equal(harness.retries, 1);
});

test("a map that is still being read says so rather than reporting a failure", () => {
  renderSettings({ capabilities: null, capabilitiesLoading: true });

  assert.match(
    screen.getByTestId("ai-agent-advanced-notice").textContent ?? "",
    /Checking which of these parameters your provider accepts…/,
  );
  // Nothing to retry while the read is in flight.
  assert.equal(screen.queryByRole("button", { name: "Try again" }), null);
});

test("with no default provider nothing is marked unsupported", () => {
  renderSettings({ protocol: null, providerLabel: null });

  for (const parameter of AI_ADVANCED_PARAMETERS) {
    assert.equal(
      field(parameter).dataset.applicability,
      (BACKEND_APPLIED as readonly string[]).includes(parameter)
        ? "notProtocolControl"
        : "unknownProtocol",
      parameter,
    );
  }
  // Editable, because there is no provider to refuse them yet — and the notice
  // says exactly that instead of implying they do nothing.
  assert.equal(
    (screen.getByLabelText("Top-k") as HTMLInputElement).disabled,
    false,
  );
  assert.match(
    screen.getByTestId("ai-agent-advanced-notice").textContent ?? "",
    /No default provider is set, so there is nothing to check these against yet\./,
  );
  assert.equal(
    document.querySelectorAll('[data-testid="ai-agent-marking"]').length,
    0,
  );
});

test("the notice names the provider the parameters were checked against", () => {
  renderSettings({ protocol: "ollama", providerLabel: "Ollama (local)" });

  assert.match(
    screen.getByTestId("ai-agent-advanced-notice").textContent ?? "",
    /Checked against Ollama \(local\), the default provider, which speaks ollama\./,
  );
  // The honest caveat: this is one provider, and a conversation can use any.
  assert.match(
    screen.getByTestId("ai-agent-advanced-notice").textContent ?? "",
    /A conversation started with a different provider accepts a different set\./,
  );
});

// ── What gets stored ───────────────────────────────────────────────────────

test("the advanced values are stored, and an empty field means not set", async () => {
  const harness = renderSettings();

  fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "42" } });
  fireEvent.change(screen.getByLabelText("Frequency penalty"), {
    target: { value: "0.4" },
  });
  fireEvent.change(screen.getByLabelText("Stop sequences"), {
    target: { value: "\nUser:\n  Assistant:\n" },
  });
  fireEvent.change(screen.getByLabelText("System prompt override"), {
    target: { value: "Answer in British English." },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  });

  await waitFor(() => assert.equal(harness.saved.length, 1));
  const sent = harness.saved[0];
  assert.equal(sent.seed, 42);
  assert.equal(sent.frequencyPenalty, 0.4);
  // Blank lines are dropped; leading spaces are not, because a stop sequence
  // may legitimately begin with one.
  assert.deepEqual(sent.stop, ["User:", "  Assistant:"]);
  assert.equal(sent.systemPromptOverride, "Answer in British English.");
  // Untouched optional fields are sent as an explicit null: "not set" has to
  // be expressible, and 0 is a value somebody may have chosen.
  assert.equal(sent.topK, null);
  assert.equal(sent.presencePenalty, null);
  assert.equal(sent.requestTimeoutMs, null);
  // The context budget is the exception. Rust types it a bare `u32` with a
  // default, so there is no "unset" to send and the form carries the value it
  // was seeded with.
  assert.equal(sent.maxContextTokens, AI_DEFAULT_MAX_CONTEXT_TOKENS);
  // The settings that were already there are carried through untouched.
  assert.equal(sent.toolsEnabled, true);
  assert.equal(sent.personaId, "default");
});

test("a value this provider ignores is still stored rather than dropped", async () => {
  // `topK` reaches nothing on OpenAI, and the control for it is locked — but a
  // value stored while an Anthropic profile was the default must survive a
  // save made now, or switching the default back would silently have cleared
  // a setting nobody touched.
  const harness = renderSettings({ config: { ...CONFIG, topK: 40 } });

  assert.equal(
    (screen.getByLabelText("Top-k") as HTMLInputElement).value,
    "40",
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  });

  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.equal(harness.saved[0].topK, 40);
});

test("a set parameter is held to the same bounds the backend enforces", () => {
  // `<input type="number">` normalises unparseable text to an empty value, so
  // this is checked at the validator: the rule has to hold for a value that
  // arrived from anywhere other than this form, NaN included, which used to
  // serialize to null and take the user’s value with it.
  assert.deepEqual(validateAgentConfig({ ...CONFIG, seed: Number.NaN }), [
    {
      field: "seed",
      code: "integerRange",
      min: AI_AGENT_LIMITS.seed.min,
      max: AI_AGENT_LIMITS.seed.max,
    },
  ]);
  for (const [field, value] of [
    ["topK", 0],
    ["requestTimeoutMs", 1],
    ["maxContextTokens", 1],
    ["seed", -1],
  ] as const) {
    assert.deepEqual(
      validateAgentConfig({ ...CONFIG, [field]: value }),
      [
        {
          field,
          code: "integerRange",
          min: AI_AGENT_LIMITS[field].min,
          max: AI_AGENT_LIMITS[field].max,
        },
      ],
      `${field} ${value} is outside the Rust validator's range`,
    );
  }
  for (const field of ["frequencyPenalty", "presencePenalty"] as const) {
    assert.deepEqual(validateAgentConfig({ ...CONFIG, [field]: 2.5 }), [
      {
        field,
        code: "range",
        min: AI_AGENT_LIMITS[field].min,
        max: AI_AGENT_LIMITS[field].max,
      },
    ]);
  }
  // "Not set" is never an error: these parameters exist so that leaving one to
  // the provider is expressible. An absent `maxContextTokens` is left alone
  // too - that is a read from a build without the field, not a value.
  assert.deepEqual(
    validateAgentConfig({ ...CONFIG, seed: null, topK: undefined }),
    [],
  );
});

test("the stop-sequence rules are the provider crate's rules", () => {
  assert.deepEqual(
    validateAgentConfig({
      ...CONFIG,
      stop: Array.from(
        { length: AI_STOP_LIMITS.maxSequences + 1 },
        (_, index) => `s${index}`,
      ),
    }),
    [
      {
        field: "stop",
        code: "tooManySequences",
        limit: AI_STOP_LIMITS.maxSequences,
      },
    ],
  );
  assert.deepEqual(
    validateAgentConfig({
      ...CONFIG,
      stop: ["x".repeat(AI_STOP_LIMITS.maxSequenceBytes + 1)],
    }),
    [
      {
        field: "stop",
        code: "sequenceTooLong",
        limit: AI_STOP_LIMITS.maxSequenceBytes,
      },
    ],
  );
  // A sequence of nothing but spaces is refused upstream, so it is refused
  // here rather than sent and bounced.
  assert.deepEqual(validateAgentConfig({ ...CONFIG, stop: ["   "] }), [
    { field: "stop", code: "sequenceBlank" },
  ]);
  // Leading spaces are legitimate: a sequence may begin with one.
  assert.deepEqual(
    validateAgentConfig({ ...CONFIG, stop: ["  Assistant:", "User:"] }),
    [],
  );
});

test("a blank override is refused rather than composed onto every prompt", async () => {
  // Rust refuses a present-but-blank override: `null` is how it is cleared,
  // and an empty one would append two blank lines to every system prompt.
  assert.deepEqual(
    validateAgentConfig({ ...CONFIG, systemPromptOverride: "   " }),
    [{ field: "systemPromptOverride", code: "overrideBlank" }],
  );

  // The form cannot produce one: clearing the field sends `null`.
  const harness = renderSettings({
    config: { ...CONFIG, systemPromptOverride: "Prefer UK English." },
  });
  fireEvent.change(screen.getByLabelText("System prompt override"), {
    target: { value: "  " },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  });
  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.equal(harness.saved[0].systemPromptOverride, null);
});

test("the override says it adds to the persona rather than replacing it", () => {
  renderSettings();

  // `compose_system_prompt` appends; it does not substitute. Copy that said
  // "in place of the persona's" would be describing a different backend.
  const explanation = field("systemPromptOverride").textContent ?? "";
  assert.match(explanation, /added to the end of whichever system prompt/);
  assert.match(explanation, /It adds, it does not replace/);
  assert.doesNotMatch(explanation, /in place of|stops being sent/);
});

test("an override past the provider's prompt ceiling is refused", async () => {
  const harness = renderSettings();

  fireEvent.change(screen.getByLabelText("System prompt override"), {
    target: { value: "x".repeat(AI_PERSONA_LIMITS.systemPromptBytes + 1) },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  });

  assert.deepEqual(harness.saved, []);
  assert.match(
    screen.getByTestId("ai-agent-issues").textContent ?? "",
    new RegExp(
      `System prompt override must be at most ${AI_PERSONA_LIMITS.systemPromptBytes} bytes\\.`,
    ),
  );
});

test("a fraction in a whole-number parameter is refused twice over", () => {
  renderSettings({ protocol: null, providerLabel: null });

  // First at the control, which is where a user meets it: `step` makes the
  // browser refuse a fractional count before the form is ever submitted.
  for (const label of [
    "Top-k",
    "Seed",
    "Context token ceiling",
    "Request timeout",
  ]) {
    assert.equal(
      (screen.getByLabelText(label) as HTMLInputElement).step,
      "1",
      `${label} is a count, not a measurement`,
    );
  }
  // And again at the validator, which is the half that still applies to a
  // value that arrived from anywhere other than this form.
  assert.deepEqual(validateAgentConfig({ ...CONFIG, topK: 4.5 }), [
    {
      field: "topK",
      code: "integerRange",
      min: AI_AGENT_LIMITS.topK.min,
      max: AI_AGENT_LIMITS.topK.max,
    },
  ]);
  assert.deepEqual(validateAgentConfig({ ...CONFIG, maxContextTokens: 1.5 }), [
    {
      field: "maxContextTokens",
      code: "integerRange",
      min: AI_AGENT_LIMITS.maxContextTokens.min,
      max: AI_AGENT_LIMITS.maxContextTokens.max,
    },
  ]);
  // The penalties are measurements, so a fraction is the normal case there.
  assert.deepEqual(
    validateAgentConfig({ ...CONFIG, frequencyPenalty: 0.4 }),
    [],
  );
});

test("a refused save shows the backend's own message", async () => {
  render(
    <AiAgentSettings
      config={CONFIG}
      protocol="openai"
      providerLabel="OpenAI"
      capabilities={CAPABILITIES}
      capabilitiesLoading={false}
      capabilitiesError={null}
      onRetryCapabilities={() => {}}
      onSave={async () => {
        throw {
          code: "AI_INVALID_CONFIG",
          message: "seed is not supported by this build.",
          source: "agent",
          operation: "ai:set_config",
          retryable: false,
          details: { remediation: "Clear the seed and save again." },
        };
      }}
    />,
  );

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  });

  assert.ok(screen.getByText("seed is not supported by this build."));
  assert.ok(screen.getByText("Clear the seed and save again."));
});

test("the form waits for the config instead of rendering invented defaults", () => {
  renderSettings({ config: null });

  assert.match(
    screen.getByTestId("ai-agent-settings").textContent ?? "",
    /Reading the assistant's settings…/,
  );
  assert.equal(screen.queryByLabelText("Temperature"), null);
});

test("every control carries its explanation as its accessible description", () => {
  renderSettings();

  // The explanation is not decoration: a screen reader has to reach it from
  // the control, which is what `aria-describedby` is for.
  for (const [label, parameter] of [
    ["Temperature", "temperature"],
    ["Top-p", "topP"],
    ["Tool rounds per turn", "maxToolRounds"],
    ["Tokens per turn", "maxTokensPerTurn"],
    ["Top-k", "topK"],
    ["Stop sequences", "stop"],
    ["Seed", "seed"],
    ["Frequency penalty", "frequencyPenalty"],
    ["Presence penalty", "presencePenalty"],
    ["Context token ceiling", "maxContextTokens"],
    ["Request timeout", "requestTimeoutMs"],
    ["System prompt override", "systemPromptOverride"],
  ] as [string, AiAdvancedParameter | string][]) {
    const control = screen.getByLabelText(label);
    const describedBy = control.getAttribute("aria-describedby");
    assert.ok(describedBy, `${label} must point at its explanation`);
    const help = document.getElementById(describedBy);
    assert.ok(help, `${label}'s description must exist`);
    assert.ok(
      field(parameter).contains(help),
      `${label}'s description must be its own field's`,
    );
  }
});
