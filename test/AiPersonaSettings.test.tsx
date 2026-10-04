/**
 * Persona management.
 *
 * The load-bearing test is the builtin one: a built-in persona is immutable on
 * the backend, so this screen must offer no way to edit or delete it. Not a
 * disabled button — nothing. The rest covers create/edit/delete, the delete
 * confirmation, and the client-side bounds.
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

import { AiPersonaSettings } from "../src/components/ai/AiPersonaSettings";
import { AI_PERSONA_LIMITS } from "../src/lib/ai/permissions";
import type { AiPersona, AiPersonaInput } from "../src/types/ai";

import { useEnglishLocale } from "./i18n-ready";

const BUILTIN: AiPersona = {
  id: "dns-expert",
  name: "DNS expert",
  description: "Explains records and spots mistakes",
  systemPrompt: "You are a DNS expert.",
  builtin: true,
};

const CUSTOM: AiPersona = {
  id: "custom-1",
  name: "Zone reviewer",
  description: "Reads a zone and reports on it",
  systemPrompt: "You review DNS zones.",
  builtin: false,
};

interface Harness {
  created: AiPersonaInput[];
  updated: Array<{ id: string; persona: AiPersonaInput }>;
  deleted: string[];
  selected: Array<string | null>;
  retries: number;
}

function renderPersonas(
  overrides: Partial<React.ComponentProps<typeof AiPersonaSettings>> = {},
  failures: { create?: unknown; update?: unknown; delete?: unknown } = {},
): Harness {
  const harness: Harness = {
    created: [],
    updated: [],
    deleted: [],
    selected: [],
    retries: 0,
  };
  render(
    <AiPersonaSettings
      personas={[BUILTIN, CUSTOM]}
      loading={false}
      loadError={null}
      selectedId={null}
      selectionBusy={false}
      onSelect={(id) => harness.selected.push(id)}
      onCreate={async (persona) => {
        if (failures.create) throw failures.create;
        harness.created.push(persona);
        return { ...CUSTOM, id: "custom-new", ...persona };
      }}
      onUpdate={async (id, persona) => {
        if (failures.update) throw failures.update;
        harness.updated.push({ id, persona });
        return { ...CUSTOM, id, ...persona };
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
 * element it did find.
 *
 * Same reason as the helper in `AiAssistantPanel.test.tsx`: under
 * `node:assert/strict` a failed comparison inspects the actual value, and
 * inspecting a jsdom element walks its whole document graph. Inside a
 * `waitFor` retry loop — where the node is still present on the early
 * attempts, which is the normal case for anything that disappears
 * asynchronously — `assert.equal(node, null)` cost this file 184 seconds in
 * one test. Comparing to `null` first keeps the failure message cheap.
 */
function assertAbsent(node: Element | null, label: string): void {
  assert.ok(node === null, `expected no ${label}`);
}

function personaRow(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-persona="${id}"]`);
  assert.ok(found, `expected a row for ${id}`);
  return found;
}

function fillEditor(values: Partial<AiPersonaInput>): void {
  if (values.name !== undefined) {
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: values.name },
    });
  }
  if (values.description !== undefined) {
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: values.description },
    });
  }
  if (values.systemPrompt !== undefined) {
    fireEvent.change(screen.getByLabelText("System prompt"), {
      target: { value: values.systemPrompt },
    });
  }
}

beforeEach(async () => {
  await useEnglishLocale();
});

afterEach(() => {
  cleanup();
});

// ── Builtins are immutable ─────────────────────────────────────────────────

test("a built-in persona offers no edit or delete affordance at all", () => {
  renderPersonas();

  const builtin = personaRow(BUILTIN.id);
  assert.equal(builtin.dataset.builtin, "true");
  assert.match(builtin.textContent ?? "", /Built in · read only/);

  // Not "disabled" — absent. A control whose only outcome is a backend refusal
  // teaches the user that this screen is decorative.
  assertAbsent(
    within(builtin).queryByRole("button", { name: "Edit" }),
    "edit button on a builtin",
  );
  assertAbsent(
    within(builtin).queryByRole("button", { name: "Delete" }),
    "delete button on a builtin",
  );

  // The custom one has both, so the absence above is about `builtin`, not
  // about the screen being read-only everywhere.
  const custom = personaRow(CUSTOM.id);
  assert.ok(within(custom).getByRole("button", { name: "Edit" }));
  assert.ok(within(custom).getByRole("button", { name: "Delete" }));

  // A builtin can still be *selected*: immutable is not unusable.
  assert.ok(within(builtin).getByRole("radio"));
});

test("the prompt a persona will actually use is readable, builtin included", () => {
  renderPersonas();
  assert.match(
    personaRow(BUILTIN.id).textContent ?? "",
    /You are a DNS expert\./,
  );
  assert.match(
    personaRow(CUSTOM.id).textContent ?? "",
    /You review DNS zones\./,
  );
});

// ── Selection ──────────────────────────────────────────────────────────────

test("selection reports the persona id, and null for no persona", () => {
  const harness = renderPersonas({ selectedId: CUSTOM.id });

  assert.equal(
    (within(personaRow(CUSTOM.id)).getByRole("radio") as HTMLInputElement)
      .checked,
    true,
  );

  fireEvent.click(screen.getByRole("radio", { name: /No persona/ }));
  fireEvent.click(within(personaRow(BUILTIN.id)).getByRole("radio"));
  assert.deepEqual(harness.selected, [null, BUILTIN.id]);
});

test("selection is locked while the agent config write is in flight", () => {
  renderPersonas({ selectionBusy: true });
  for (const radio of screen.getAllByRole("radio")) {
    assert.equal((radio as HTMLInputElement).disabled, true);
  }
});

// ── Create ─────────────────────────────────────────────────────────────────

test("a new persona is created from trimmed input", async () => {
  const harness = renderPersonas();

  fireEvent.click(screen.getByRole("button", { name: "New persona" }));
  assert.equal(
    screen.getByTestId("ai-persona-editor").dataset.editorKind,
    "create",
  );

  fillEditor({
    name: "  Auditor  ",
    description: "  Checks a zone  ",
    systemPrompt: "  You audit DNS.  ",
  });
  fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

  await waitFor(() => assert.equal(harness.created.length, 1));
  assert.deepEqual(harness.created[0], {
    name: "Auditor",
    description: "Checks a zone",
    systemPrompt: "You audit DNS.",
  });
  // A successful save closes the editor rather than leaving a stale draft.
  await waitFor(() =>
    assertAbsent(screen.queryByTestId("ai-persona-editor"), "open editor"),
  );
});

test("a refused create keeps the draft and shows the backend's own words", async () => {
  const harness = renderPersonas(
    {},
    {
      create: {
        code: "AI_LIMIT_EXCEEDED",
        message: "At most 16 custom personas are allowed.",
        source: "agent",
        operation: "ai:create_persona",
        retryable: false,
        details: { remediation: "Delete one first." },
      },
    },
  );

  fireEvent.click(screen.getByRole("button", { name: "New persona" }));
  fillEditor({ name: "Auditor", systemPrompt: "You audit DNS." });
  fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

  assert.ok(await screen.findByText("At most 16 custom personas are allowed."));
  assert.ok(screen.getByText("Delete one first."));
  assert.equal(harness.created.length, 0);
  // The editor stays open with the typed values: the user's work survives.
  assert.equal(
    (screen.getByLabelText("Name") as HTMLInputElement).value,
    "Auditor",
  );
});

// ── Edit ───────────────────────────────────────────────────────────────────

test("editing a custom persona preloads it and sends its id", async () => {
  const harness = renderPersonas();

  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Edit" }),
  );
  const editor = screen.getByTestId("ai-persona-editor");
  assert.equal(editor.dataset.editorKind, "edit");
  assert.equal(
    (screen.getByLabelText("Name") as HTMLInputElement).value,
    CUSTOM.name,
  );
  assert.equal(
    (screen.getByLabelText("System prompt") as HTMLTextAreaElement).value,
    CUSTOM.systemPrompt,
  );

  fillEditor({ name: "Zone auditor" });
  fireEvent.click(screen.getByRole("button", { name: "Save persona" }));

  await waitFor(() => assert.equal(harness.updated.length, 1));
  assert.equal(harness.updated[0].id, CUSTOM.id);
  assert.equal(harness.updated[0].persona.name, "Zone auditor");
});

test("cancelling an edit discards the draft without calling the backend", () => {
  const harness = renderPersonas();

  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Edit" }),
  );
  fillEditor({ name: "Discarded" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  assertAbsent(screen.queryByTestId("ai-persona-editor"), "open editor");
  assert.deepEqual(harness.updated, []);

  // Reopening shows the stored values, not the discarded ones.
  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Edit" }),
  );
  assert.equal(
    (screen.getByLabelText("Name") as HTMLInputElement).value,
    CUSTOM.name,
  );
});

// ── Delete ─────────────────────────────────────────────────────────────────

test("delete confirms first and does nothing if the confirmation is cancelled", async () => {
  const harness = renderPersonas();

  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Delete" }),
  );
  const confirm = screen.getByTestId("ai-persona-delete-confirm");
  assert.match(confirm.textContent ?? "", /Delete “Zone reviewer”\?/);
  assert.equal(harness.deleted.length, 0);

  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  assertAbsent(
    screen.queryByTestId("ai-persona-delete-confirm"),
    "delete confirmation",
  );
  assert.deepEqual(harness.deleted, []);

  // Confirming goes through.
  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Delete" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete persona" }));
  await waitFor(() => assert.deepEqual(harness.deleted, [CUSTOM.id]));
});

test("Escape dismisses the delete confirmation", () => {
  const harness = renderPersonas();

  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Delete" }),
  );
  fireEvent.keyDown(screen.getByTestId("ai-persona-delete-confirm"), {
    key: "Escape",
  });

  assertAbsent(
    screen.queryByTestId("ai-persona-delete-confirm"),
    "delete confirmation",
  );
  assert.deepEqual(harness.deleted, []);
});

test("a refused delete surfaces the reason and keeps the persona listed", async () => {
  renderPersonas(
    {},
    {
      delete: {
        code: "AI_IN_USE",
        message: "That persona is selected for an open conversation.",
        source: "agent",
        operation: "ai:delete_persona",
        retryable: false,
        details: {},
      },
    },
  );

  fireEvent.click(
    within(personaRow(CUSTOM.id)).getByRole("button", { name: "Delete" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete persona" }));

  assert.ok(
    await screen.findByText(
      "That persona is selected for an open conversation.",
    ),
  );
  assert.ok(personaRow(CUSTOM.id));
});

// ── Client-side bounds ─────────────────────────────────────────────────────

test("an empty name or prompt is refused locally, with no backend call", () => {
  const harness = renderPersonas();

  fireEvent.click(screen.getByRole("button", { name: "New persona" }));
  fillEditor({ name: "   ", systemPrompt: "  " });
  fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

  const issues = screen.getByTestId("ai-persona-issues");
  assert.match(issues.textContent ?? "", /Enter a name\./);
  assert.match(issues.textContent ?? "", /Enter a system prompt\./);
  assert.deepEqual(harness.created, []);
  // The editor stays open so the issues are next to the fields they concern.
  assert.ok(screen.getByTestId("ai-persona-editor"));
});

test("an over-long prompt is refused locally against the Rust byte limit", () => {
  const harness = renderPersonas();

  fireEvent.click(screen.getByRole("button", { name: "New persona" }));
  fillEditor({
    name: "Auditor",
    systemPrompt: "x".repeat(AI_PERSONA_LIMITS.systemPromptBytes + 1),
  });
  fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

  assert.match(
    screen.getByTestId("ai-persona-issues").textContent ?? "",
    new RegExp(
      `System prompt must be at most ${AI_PERSONA_LIMITS.systemPromptBytes} bytes\\.`,
    ),
  );
  assert.deepEqual(harness.created, []);
});

test("a prompt exactly at the limit is accepted", async () => {
  const harness = renderPersonas();

  fireEvent.click(screen.getByRole("button", { name: "New persona" }));
  fillEditor({
    name: "Auditor",
    systemPrompt: "x".repeat(AI_PERSONA_LIMITS.systemPromptBytes),
  });
  fireEvent.click(screen.getByRole("button", { name: "Create persona" }));

  await waitFor(() => assert.equal(harness.created.length, 1));
  assert.equal(
    harness.created[0].systemPrompt.length,
    AI_PERSONA_LIMITS.systemPromptBytes,
  );
});

// ── Load failure ───────────────────────────────────────────────────────────

test("a failed listing says so and offers a retry", () => {
  const harness = renderPersonas({
    personas: [],
    loadError: {
      code: "AI_UNAVAILABLE",
      message: "The assistant is not running.",
      source: "agent",
      operation: "ai:list_personas",
      retryable: true,
      details: {},
    },
  });

  assert.ok(screen.getByText("The assistant is not running."));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.equal(harness.retries, 1);
});
