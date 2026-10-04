/**
 * Provider management.
 *
 * The load-bearing tests here are the key ones. The renderer is never given key
 * material — `AiProviderProfile` has no `apiKey` field, only `hasApiKey` — and
 * three tests pin the consequences:
 *
 * 1. No input in this screen ever holds a stored key as its value, and nothing
 *    about a stored key is rendered beyond "set" or "not set".
 * 2. An edit that does not touch the key sends no `apiKey` field at all, so the
 *    stored credential survives a rename. Sending `null` would clear it.
 * 3. Clearing is a separate, explicit intent that sends `null`.
 *
 * If this file ever starts failing, read those first. The rest covers CRUD, the
 * default picker, the delete confirmation and the client-side bounds.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AiProviderSettings } from "../src/components/ai/AiProviderSettings";
import { AI_PROVIDER_LIMITS } from "../src/lib/ai/providers";
import {
  PROVIDER_PROTOCOLS,
  type AiProviderProfile,
  type AiProviderProfileInput,
} from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";
import {
  chooseThemedSelectValue,
  enableThemedSelectEnvironment,
  themedSelectValues,
} from "./radix-select";

const OPENAI: AiProviderProfile = {
  id: "openai-main",
  label: "OpenAI",
  protocol: "openai",
  baseUrl: "https://gateway.test/openai/v1",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 4096,
  hasApiKey: true,
};

const OLLAMA: AiProviderProfile = {
  id: "ollama-local",
  label: "Ollama (local)",
  protocol: "ollama",
  baseUrl: "http://host.test:11111",
  model: "llama3.1",
  temperature: 0.7,
  maxTokens: 4096,
  hasApiKey: false,
};

interface Harness {
  saved: AiProviderProfileInput[];
  deleted: string[];
  defaults: Array<string | null>;
  retries: number;
}

function renderProviders(
  overrides: Partial<React.ComponentProps<typeof AiProviderSettings>> = {},
  failures: { save?: unknown; delete?: unknown } = {},
): Harness {
  const harness: Harness = {
    saved: [],
    deleted: [],
    defaults: [],
    retries: 0,
  };
  render(
    <AiProviderSettings
      providers={[OPENAI, OLLAMA]}
      loading={false}
      loadError={null}
      defaultProviderId={OPENAI.id}
      defaultBusy={false}
      onSetDefault={(id) => harness.defaults.push(id)}
      onSave={async (profile) => {
        if (failures.save) throw failures.save;
        harness.saved.push(profile);
        return {
          ...OPENAI,
          ...profile,
          id: profile.id ?? "assigned-id",
          baseUrl: profile.baseUrl ?? "https://resolved.test/v1",
          hasApiKey:
            profile.apiKey === undefined ? true : profile.apiKey !== null,
        };
      }}
      onDelete={async (id) => {
        if (failures.delete) throw failures.delete;
        harness.deleted.push(id);
      }}
      onRetry={() => {
        harness.retries += 1;
      }}
      {...overrides}
    />,
  );
  return harness;
}

/**
 * Assert a query found nothing, without letting `node:assert` inspect the
 * element it did find — same reason as the helper in
 * `AiAssistantPanel.test.tsx`: inspecting a jsdom node inside a `waitFor`
 * retry loop walks the whole document graph on every attempt.
 */
function assertAbsent(node: Element | null, label: string): void {
  assert.ok(node === null, `expected no ${label}`);
}

function providerRow(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-provider="${id}"]`);
  assert.ok(found, `expected a row for ${id}`);
  return found;
}

function lastSaved(harness: Harness): AiProviderProfileInput {
  const found = harness.saved.at(-1);
  assert.ok(found, "expected a save");
  return found;
}

beforeEach(async () => {
  await useEnglishLocale();
  // The protocol picker is a Radix dropdown; opening one needs the two jsdom
  // gaps this installs. See `test/radix-select.ts`.
  enableThemedSelectEnvironment();
});

afterEach(() => {
  cleanup();
});

// ── The key never reaches the renderer, so it never reaches a field ────────

test("a stored key is reported, never rendered, and never put in a field", () => {
  renderProviders();

  // All the screen may say about a credential.
  const row = providerRow(OPENAI.id);
  assert.equal(row.getAttribute("data-has-key"), "true");
  assert.match(row.textContent ?? "", /Key set/);
  assert.equal(providerRow(OLLAMA.id).getAttribute("data-has-key"), "false");
  // Ollama needs none, so "no key" would read as a problem it does not have.
  assert.match(providerRow(OLLAMA.id).textContent ?? "", /No key needed/);

  // The editor for a profile that has a key offers no field with a value in it.
  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  assertAbsent(
    screen.queryByLabelText("API key"),
    "key field before asking to replace the key",
  );
  assert.ok(
    screen.getByText(
      "A key is stored for this provider. It is left unchanged unless you replace or clear it.",
    ),
  );

  // Asking to replace one opens an empty field, not a prefilled one.
  fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
  const key = screen.getByLabelText("API key") as HTMLInputElement;
  assert.equal(key.type, "password");
  assert.equal(key.value, "");
  // The rendered attribute too, not just the live property: an attribute is
  // what a DOM dump, an extension or a screenshot of devtools would show.
  assert.equal(key.getAttribute("value") ?? "", "");

  // No input anywhere in the section holds a value at all beyond the profile's
  // own non-secret fields.
  for (const input of document.querySelectorAll("input")) {
    assert.doesNotMatch(input.value, /^sk-/);
  }
  // And no reveal affordance, unlike the login key field.
  for (const button of screen.getAllByRole("button")) {
    const name = `${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`;
    assert.doesNotMatch(name, /show|reveal/i);
  }
});

test("an edit that does not touch the key sends no apiKey at all", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "OpenAI (prod)" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  const sent = lastSaved(harness);
  assert.equal(sent.id, OPENAI.id);
  assert.equal(sent.label, "OpenAI (prod)");
  // The distinction that matters: absent leaves the key alone, `null` clears
  // it. A rename must not be a credential deletion.
  assert.ok(
    !("apiKey" in sent),
    "renaming a provider must not touch its stored key",
  );
});

test("clearing a key is explicit and sends null", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
  assert.ok(screen.getByText("The stored key will be removed when you save."));
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.equal(lastSaved(harness).apiKey, null);
});

test("replacing a key sends the typed string and drops it afterwards", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-replacement" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.equal(lastSaved(harness).apiKey, "sk-replacement");
  // The editor closes and the key is gone from the page entirely.
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-provider-editor"), "provider editor"),
  );
  assert.doesNotMatch(document.body.textContent ?? "", /sk-replacement/);
});

test("a key is required only when the protocol expects one", async () => {
  const harness = renderProviders({ providers: [], defaultProviderId: null });

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  // An OpenAI-protocol endpoint opens with the key field showing, and refuses
  // an empty one.
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Groq" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
  const issues = await screen.findByTestId("ai-provider-issues");
  assert.match(issues.textContent ?? "", /API key is required\./);
  assert.equal(harness.saved.length, 0);

  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "gsk-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.equal(lastSaved(harness).apiKey, "gsk-test");
});

// ── CRUD ───────────────────────────────────────────────────────────────────

test("adding a provider prefills the protocol's model and derives an id", async () => {
  const harness = renderProviders({ providers: [], defaultProviderId: null });

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  // The model is the protocol's default, so adding a provider is a short form.
  assert.equal(
    (screen.getByLabelText("Model") as HTMLInputElement).value,
    "gpt-4o-mini",
  );
  // The base URL is left empty: the backend resolves the protocol's default,
  // and the renderer is not allowed to name a provider endpoint.
  assert.equal(
    (screen.getByLabelText("Base URL (optional)") as HTMLInputElement).value,
    "",
  );

  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Groq (fast)" },
  });
  // The id follows the name until the user takes it over.
  assert.equal(
    (screen.getByLabelText("Provider ID") as HTMLInputElement).value,
    "groq-fast",
  );
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "gsk-test" },
  });
  fireEvent.change(screen.getByLabelText("Base URL (optional)"), {
    target: { value: "https://gateway.test/openai/v1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.deepEqual(lastSaved(harness), {
    id: "groq-fast",
    label: "Groq (fast)",
    protocol: "openai",
    baseUrl: "https://gateway.test/openai/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 4096,
    apiKey: "gsk-test",
  });
  // The first provider on an empty install becomes the default, because
  // nothing else can be.
  assert.deepEqual(harness.defaults, ["groq-fast"]);
});

test("a typed id is left alone when the name changes afterwards", () => {
  renderProviders({ providers: [], defaultProviderId: null });

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  fireEvent.change(screen.getByLabelText("Provider ID"), {
    target: { value: "my-own-id" },
  });
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Something else entirely" },
  });
  assert.equal(
    (screen.getByLabelText("Provider ID") as HTMLInputElement).value,
    "my-own-id",
  );
});

test("changing the protocol swaps an untouched model but keeps a typed one", async () => {
  renderProviders({ providers: [], defaultProviderId: null });

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  // The protocol picker is the app's themed dropdown, so it is opened and an
  // option is clicked. `fireEvent.change` was for the native `<select>` this
  // replaced; against a Radix trigger — a `<button>` — it does nothing.
  const protocol = () => screen.getByLabelText("Protocol");
  assert.equal(
    (screen.getByLabelText("Model") as HTMLInputElement).value,
    "gpt-4o-mini",
  );
  assert.deepEqual(await themedSelectValues(protocol()), [
    ...PROVIDER_PROTOCOLS,
  ]);

  // An untouched default is replaced: `gpt-4o-mini` is not an Ollama tag.
  await chooseThemedSelectValue(protocol(), "ollama");
  assert.equal(
    (screen.getByLabelText("Model") as HTMLInputElement).value,
    "llama3.1",
  );
  // Ollama needs no credential, so the form stops demanding one.
  assertAbsent(
    screen.queryByLabelText("API key"),
    "a required key field for a protocol that needs none",
  );
  assert.match(
    screen.getByTestId("ai-provider-editor").textContent ?? "",
    /A local Ollama daemon\. No API key is needed/,
  );

  // A model the user typed is theirs, and survives a protocol change.
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "my-finetune-v3" },
  });
  await chooseThemedSelectValue(protocol(), "anthropic");
  assert.equal(
    (screen.getByLabelText("Model") as HTMLInputElement).value,
    "my-finetune-v3",
  );
});

test("changing the protocol drops a base URL the backend would not inherit", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  // The stored endpoint is shown, so the form says where traffic goes.
  assert.equal(
    (screen.getByLabelText("Base URL (optional)") as HTMLInputElement).value,
    OPENAI.baseUrl,
  );

  // `ProviderProfile::apply` does not carry a base URL across a protocol
  // change, so keeping this one on screen would point the Anthropic client at
  // an OpenAI gateway the backend would never have chosen.
  await chooseThemedSelectValue(screen.getByLabelText("Protocol"), "anthropic");
  assert.equal(
    (screen.getByLabelText("Base URL (optional)") as HTMLInputElement).value,
    "",
  );

  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
  await waitFor(() => assert.equal(harness.saved.length, 1));
  const sent = lastSaved(harness);
  assert.equal(sent.protocol, "anthropic");
  assert.ok(
    !("baseUrl" in sent),
    "the new protocol's default endpoint must be the backend's to resolve",
  );
});

test("a base URL with embedded credentials is refused locally", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.change(screen.getByLabelText("Base URL (optional)"), {
    target: { value: "https://user:pass@gateway.test/v1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  const issues = await screen.findByTestId("ai-provider-issues");
  assert.match(
    issues.textContent ?? "",
    /no embedded username or password/,
    "the backend refuses these, so the form must say so first",
  );
  assert.equal(harness.saved.length, 0);
  // The rejected value is not echoed anywhere outside the field the user typed
  // it into: it carries a password.
  assert.doesNotMatch(issues.textContent ?? "", /pass@/);
});

test("an Ollama provider saves with no key at all", async () => {
  const harness = renderProviders({ providers: [], defaultProviderId: null });

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  await chooseThemedSelectValue(screen.getByLabelText("Protocol"), "ollama");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Ollama (local)" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  const sent = lastSaved(harness);
  assert.equal(sent.protocol, "ollama");
  assert.equal(sent.model, "llama3.1");
  assert.ok(
    !("apiKey" in sent),
    "no key is sent for a protocol that needs none",
  );
  assert.ok(
    !("baseUrl" in sent),
    "the protocol default is resolved by the backend",
  );
});

test("duplicating a provider frees the id and carries no credential", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Duplicate OpenAI" }));
  const editor = await screen.findByTestId("ai-provider-editor");
  assert.equal(editor.getAttribute("data-editor-kind"), "create");
  // A free id, and a label that says what it is.
  assert.equal(
    (screen.getByLabelText("Provider ID") as HTMLInputElement).value,
    "openai-main-copy",
  );
  assert.equal(
    (screen.getByLabelText("Name") as HTMLInputElement).value,
    "OpenAI (copy)",
  );
  // The copy starts with no key, because the renderer had none to copy.
  const key = screen.getByLabelText("API key") as HTMLInputElement;
  assert.equal(key.value, "");

  fireEvent.change(key, { target: { value: "sk-copy" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
  await waitFor(() => assert.equal(harness.saved.length, 1));
  assert.equal(lastSaved(harness).id, "openai-main-copy");
  assert.equal(lastSaved(harness).baseUrl, OPENAI.baseUrl);
});

test("deleting confirms first and says what happens to its conversations", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Delete OpenAI" }));
  const confirm = await screen.findByTestId("ai-provider-delete-confirm");
  // The consequence a user cannot guess: the transcript survives, the
  // conversation cannot continue, and the credential is gone.
  assert.match(confirm.textContent ?? "", /Its stored API key is removed/);
  assert.match(
    confirm.textContent ?? "",
    /keep their transcript, but cannot be continued/,
  );
  // It is also the default, which is a second consequence worth saying.
  assert.match(
    confirm.textContent ?? "",
    /new conversations will have no provider/,
  );
  assert.equal(harness.deleted.length, 0);

  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    assertAbsent(
      screen.queryByTestId("ai-provider-delete-confirm"),
      "delete confirmation after cancelling",
    ),
  );
  assert.equal(harness.deleted.length, 0);

  fireEvent.click(screen.getByRole("button", { name: "Delete OpenAI" }));
  fireEvent.click(
    within(await screen.findByTestId("ai-provider-delete-confirm")).getByRole(
      "button",
      { name: "Delete provider" },
    ),
  );
  await waitFor(() => assert.deepEqual(harness.deleted, [OPENAI.id]));
  // Deleting the default leaves no default rather than silently promoting one.
  assert.deepEqual(harness.defaults, [null]);
});

test("the default is a single choice across every provider", () => {
  const harness = renderProviders();

  const radio = screen.getByRole("radio", {
    name: "Make Ollama (local) the default",
  }) as HTMLInputElement;
  assert.equal(radio.checked, false);
  assert.equal(
    (
      screen.getByRole("radio", {
        name: "Make OpenAI the default",
      }) as HTMLInputElement
    ).checked,
    true,
  );
  assert.match(providerRow(OPENAI.id).textContent ?? "", /Default/);

  fireEvent.click(radio);
  assert.deepEqual(harness.defaults, [OLLAMA.id]);
});

test("the default cannot be re-picked while a config write is in flight", () => {
  const harness = renderProviders({ defaultBusy: true });

  const radio = screen.getByRole("radio", {
    name: "Make Ollama (local) the default",
  }) as HTMLInputElement;
  assert.equal(radio.disabled, true);
  // `fireEvent.click` dispatches straight at the node and so reaches a control
  // a real browser would ignore. That makes it the right way to check the
  // second guard: a change handler that fires anyway must not queue a write
  // that races the one already in flight.
  fireEvent.click(radio);
  assert.deepEqual(harness.defaults, []);
});

// ── Empty, loading and failed states ───────────────────────────────────────

test("an install with no providers says what to do instead of showing nothing", () => {
  renderProviders({ providers: [], defaultProviderId: null });

  const empty = screen.getByTestId("ai-providers-empty");
  assert.match(empty.textContent ?? "", /No providers yet/);
  assert.match(empty.textContent ?? "", /cannot answer until one endpoint/);
  assert.ok(screen.getByRole("button", { name: "Add a provider" }));
});

test("a failed listing says so and offers a retry, not an empty list", () => {
  const harness = renderProviders({
    providers: [],
    loadError: {
      code: "AI_UNAVAILABLE",
      message: "The provider store could not be read.",
      source: "provider",
      operation: "ai:list_providers",
      retryable: true,
      details: {},
    },
  });

  assert.ok(screen.getByText("The provider store could not be read."));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.equal(harness.retries, 1);
});

test("a refused save shows the backend's message and keeps the form open", async () => {
  const harness = renderProviders(
    {},
    {
      save: {
        code: "AI_PROVIDER_UNAUTHORIZED",
        message: "The provider rejected the credentials.",
        source: "provider",
        operation: "ai:configure_provider",
        retryable: false,
        details: { status: 401, remediation: "Check the API key." },
      },
    },
  );

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-wrong" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  assert.ok(await screen.findByText("The provider rejected the credentials."));
  assert.ok(screen.getByText("Check the API key."));
  assert.equal(harness.saved.length, 0);
  // The form stays open so the key can be corrected, and the rejected value is
  // not echoed into the page.
  assert.ok(screen.getByTestId("ai-provider-editor"));
  assert.doesNotMatch(document.body.textContent ?? "", /sk-wrong/);
});

// ── Client-side validation, for immediate feedback only ───────────────────

test("an id outside the allowed charset is refused locally", async () => {
  const harness = renderProviders({ providers: [], defaultProviderId: null });

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Gateway" },
  });
  fireEvent.change(screen.getByLabelText("Provider ID"), {
    target: { value: "my provider" },
  });
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  const issues = await screen.findByTestId("ai-provider-issues");
  assert.match(
    issues.textContent ?? "",
    /only letters, digits, hyphens and underscores/,
  );
  assert.equal(harness.saved.length, 0);
});

test("an id already in use is refused locally", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Another" },
  });
  fireEvent.change(screen.getByLabelText("Provider ID"), {
    target: { value: OLLAMA.id },
  });
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  const issues = await screen.findByTestId("ai-provider-issues");
  assert.match(issues.textContent ?? "", /already uses that ID/);
  assert.equal(harness.saved.length, 0);
});

test("a relative or non-http base URL is refused locally", async () => {
  const harness = renderProviders();

  for (const candidate of ["/v1", "gateway.test/v1", "file:///etc/passwd"]) {
    fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
    fireEvent.change(screen.getByLabelText("Base URL (optional)"), {
      target: { value: candidate },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));
    const issues = await screen.findByTestId("ai-provider-issues");
    assert.match(
      issues.textContent ?? "",
      /must be a full http:\/\/ or https:\/\/ address/,
      `${candidate} must be refused`,
    );
    assert.equal(harness.saved.length, 0, `${candidate} must not be sent`);
  }
});

test("an empty base URL is accepted and sent as absent", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.change(screen.getByLabelText("Base URL (optional)"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  await waitFor(() => assert.equal(harness.saved.length, 1));
  // Absent rather than empty: the protocol's default is resolved on the Rust
  // side, so an empty string would be a value for the backend to reject.
  assert.ok(!("baseUrl" in lastSaved(harness)));
});

test("out-of-range numbers are refused against the Rust bounds", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.change(screen.getByLabelText("Temperature"), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByLabelText("Max tokens"), {
    target: { value: String(AI_PROVIDER_LIMITS.maxTokens.max + 1) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  const issues = await screen.findByTestId("ai-provider-issues");
  assert.match(issues.textContent ?? "", /Temperature must be between 0 and 2/);
  assert.match(
    issues.textContent ?? "",
    new RegExp(
      `Max tokens must be a whole number between 1 and ${AI_PROVIDER_LIMITS.maxTokens.max}`,
    ),
  );
  assert.equal(harness.saved.length, 0);
});

test("a name is required", async () => {
  const harness = renderProviders();

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save and verify" }));

  const issues = await screen.findByTestId("ai-provider-issues");
  assert.match(issues.textContent ?? "", /Name is required\./);
  assert.equal(harness.saved.length, 0);
});

test("the editor closes when the profile it was open on disappears", async () => {
  const { rerender } = render(
    <AiProviderSettings
      providers={[OPENAI, OLLAMA]}
      loading={false}
      loadError={null}
      defaultProviderId={OPENAI.id}
      defaultBusy={false}
      onSetDefault={() => {}}
      onSave={async () => null}
      onDelete={async () => {}}
      onRetry={() => {}}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Edit OpenAI" }));
  assert.ok(screen.getByTestId("ai-provider-editor"));

  // Deleted elsewhere. Keeping the form bound to it would send an update that
  // resurrects a profile the user removed.
  rerender(
    <AiProviderSettings
      providers={[OLLAMA]}
      loading={false}
      loadError={null}
      defaultProviderId={null}
      defaultBusy={false}
      onSetDefault={() => {}}
      onSave={async () => null}
      onDelete={async () => {}}
      onRetry={() => {}}
    />,
  );
  await waitFor(() =>
    assertAbsent(
      screen.queryByTestId("ai-provider-editor"),
      "editor for a deleted profile",
    ),
  );
});
