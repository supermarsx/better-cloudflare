/**
 * Providers: add, edit, duplicate and delete named endpoints, and pick which
 * one new conversations use.
 *
 * Provider identity is a user-defined id, not a fixed kind, so "OpenAI" and
 * "Groq" are two profiles that happen to share the `openai` protocol. The
 * protocol list is closed (it is the wire format); the provider list is not.
 *
 * **The key-handling rule, which is the reason this file is shaped the way it
 * is.** The renderer never receives key material: `AiProviderProfile` has no
 * `apiKey` field, only `hasApiKey`. So:
 *
 * - No stored key is ever put into a field value. The key input is a
 *   `type="password"` bound to local state that starts empty, is shown only
 *   when the user has asked to set or replace a key, and is cleared the moment
 *   a save succeeds. A password box pre-filled with a real credential — even
 *   masked — is readable from the DOM, and is exactly the leak the `hasApiKey`
 *   shape exists to prevent.
 * - Not touching a key is expressible without knowing it: an edit that leaves
 *   the key alone omits `apiKey` entirely, `null` clears it, and a string
 *   replaces it. See {@link ProviderKeyAction}.
 * - What the UI shows about a credential is therefore "key set" or "no key",
 *   never a value, never a prefix, never a length.
 *
 * Saving is also the connection test: `ai_configure_provider` health-checks
 * against the endpoint before storing, so a rejection means the provider does
 * not work rather than merely that the form was malformed. The backend is the
 * authority on that; the client-side checks here exist for immediate feedback
 * and nothing more.
 *
 * Deletion confirms inline rather than in a modal, for the same reason
 * `AiPersonaSettings` does: the list is the context the user needs in order to
 * answer, so hiding it behind an overlay makes the decision harder.
 */
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_PROVIDER_LIMITS,
  PROVIDER_PROTOCOL_INFO,
  duplicateProviderDraft,
  isProviderProtocol,
  modelForProtocolChange,
  newProviderDraft,
  providerDraftFromProfile,
  providerDraftToInput,
  suggestProviderId,
  validateProviderDraft,
  type AiProviderIssue,
  type ProviderDraft,
  type ProviderKeyAction,
} from "@/lib/ai/providers";
import { cn } from "@/lib/utils";
import {
  PROVIDER_PROTOCOLS,
  type AiProviderProfile,
  type AiProviderProfileInput,
} from "@/types/ai";

import { describeAiError } from "./ai-error";
import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";

/** Which form is open, and whether it creates or updates. */
type Editor =
  { kind: "create" } | { kind: "edit"; id: string; hasApiKey: boolean };

export interface AiProviderSettingsProps {
  providers: AiProviderProfile[];
  loading: boolean;
  loadError: unknown;
  /** From `AgentConfig.defaultProviderId`. May name a deleted profile. */
  defaultProviderId: string | null;
  /** An agent-config write is in flight, so the default must not be re-picked. */
  defaultBusy: boolean;
  onSetDefault: (id: string | null) => void;
  /** Resolves with the stored profile, which may differ from what was sent. */
  onSave: (
    profile: AiProviderProfileInput,
  ) => Promise<AiProviderProfile | null>;
  onDelete: (id: string) => Promise<void>;
  onRetry: () => void;
}

export function AiProviderSettings({
  providers,
  loading,
  loadError,
  defaultProviderId,
  defaultBusy,
  onSetDefault,
  onSave,
  onDelete,
  onRetry,
}: AiProviderSettingsProps) {
  const { t } = useI18n();
  const headingId = useId();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(() => newProviderDraft());
  const [keyAction, setKeyAction] = useState<ProviderKeyAction>("keep");
  // Local, transient, and never seeded from a profile: the renderer has no
  // stored key to seed it with.
  const [apiKey, setApiKey] = useState("");
  /** Once the user edits the id, stop deriving it from the label. */
  const [idTouched, setIdTouched] = useState(false);
  const [issues, setIssues] = useState<AiProviderIssue[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // A profile the editor was open on can disappear — deleted from another
  // surface, or gone after a refresh. Keeping a form bound to it would send an
  // update that resurrects a profile the user removed.
  useEffect(() => {
    if (editor?.kind !== "edit") return;
    if (providers.some((profile) => profile.id === editor.id)) return;
    setEditor(null);
  }, [editor, providers]);

  const takenIds = providers.map((profile) => profile.id);
  const protocolInfo = PROVIDER_PROTOCOL_INFO[draft.protocol];
  const creating = editor?.kind === "create";
  const storedKey = editor?.kind === "edit" && editor.hasApiKey;

  const resetForm = () => {
    setIssues([]);
    setFormError(null);
    setRemediation(null);
    setSaved(null);
    setApiKey("");
    setIdTouched(false);
  };

  const openCreate = () => {
    const fresh = newProviderDraft();
    setDraft(fresh);
    // A protocol that expects a credential opens with the field showing; one
    // that does not (Ollama) starts with no key and offers to add one.
    setKeyAction(
      PROVIDER_PROTOCOL_INFO[fresh.protocol].keyExpected ? "replace" : "keep",
    );
    resetForm();
    setEditor({ kind: "create" });
  };

  const openEdit = (profile: AiProviderProfile) => {
    setDraft(providerDraftFromProfile(profile));
    setKeyAction("keep");
    resetForm();
    setIdTouched(true);
    setEditor({ kind: "edit", id: profile.id, hasApiKey: profile.hasApiKey });
  };

  const openDuplicate = (profile: AiProviderProfile) => {
    setDraft(
      duplicateProviderDraft(
        profile,
        takenIds,
        t("{{label}} (copy)", {
          label: profile.label,
          defaultValue: `${profile.label} (copy)`,
        }),
      ),
    );
    // The copy carries no credential, because there is none to carry.
    setKeyAction(
      PROVIDER_PROTOCOL_INFO[profile.protocol].keyExpected ? "replace" : "keep",
    );
    resetForm();
    setIdTouched(true);
    setEditor({ kind: "create" });
  };

  const closeEditor = () => {
    setEditor(null);
    resetForm();
    setKeyAction("keep");
  };

  const changeProtocol = (value: string) => {
    if (!isProviderProtocol(value)) return;
    setDraft((prev) => {
      if (prev.protocol === value) return prev;
      return {
        ...prev,
        protocol: value,
        model: modelForProtocolChange(prev, value),
        // The base URL goes with the protocol. `ProviderProfile::apply` does
        // not inherit a stored base URL across a protocol change — an OpenAI
        // endpoint is meaningless to the Anthropic client — so carrying this
        // profile's old URL over would hand the new client an address the
        // backend would never have chosen for it. Cleared, the protocol's own
        // default is resolved, which is what the empty field's placeholder
        // already promises.
        baseUrl: "",
      };
    });
    // A protocol that needs no credential must not keep demanding one.
    if (!PROVIDER_PROTOCOL_INFO[value].keyExpected && !storedKey) {
      setKeyAction("keep");
      setApiKey("");
    }
  };

  const changeLabel = (value: string) => {
    setDraft((prev) => ({
      ...prev,
      label: value,
      id: creating && !idTouched ? suggestProviderId(value) : prev.id,
    }));
  };

  const describeIssue = (issue: AiProviderIssue): string => {
    const fieldLabels: Record<AiProviderIssue["field"], string> = {
      id: t("Provider ID", "Provider ID"),
      label: t("Name", "Name"),
      baseUrl: t("Base URL", "Base URL"),
      model: t("Model", "Model"),
      temperature: t("Temperature", "Temperature"),
      maxTokens: t("Max tokens", "Max tokens"),
      apiKey: t("API key", "API key"),
    };
    const field = fieldLabels[issue.field];
    switch (issue.code) {
      case "required":
        return t("{{field}} is required.", {
          field,
          defaultValue: `${field} is required.`,
        });
      case "idCharset":
        return t(
          "Provider ID may use only letters, digits, hyphens and underscores.",
          "Provider ID may use only letters, digits, hyphens and underscores.",
        );
      case "idTaken":
        return t(
          "Another provider already uses that ID.",
          "Another provider already uses that ID.",
        );
      case "tooLong":
        return t("{{field}} must be at most {{limit}} bytes.", {
          field,
          limit: issue.limit ?? 0,
          defaultValue: `${field} must be at most ${issue.limit ?? 0} bytes.`,
        });
      case "controlCharacter":
        return t("{{field}} must not contain control characters.", {
          field,
          defaultValue: `${field} must not contain control characters.`,
        });
      case "atCapacity":
        return t(
          "You already have the maximum of {{limit}} providers. Delete one before adding another.",
          {
            limit: issue.limit ?? 0,
            defaultValue: `You already have the maximum of ${issue.limit ?? 0} providers. Delete one before adding another.`,
          },
        );
      case "baseUrl":
        return t(
          "Base URL must be a full http:// or https:// address with no spaces and no embedded username or password, or empty to use the protocol default.",
          "Base URL must be a full http:// or https:// address with no spaces and no embedded username or password, or empty to use the protocol default.",
        );
      case "integerRange":
        return t(
          "{{field}} must be a whole number between {{min}} and {{max}}.",
          {
            field,
            min: issue.min ?? 0,
            max: issue.max ?? 0,
            defaultValue: `${field} must be a whole number between ${issue.min ?? 0} and ${issue.max ?? 0}.`,
          },
        );
      case "range":
        return t("{{field}} must be between {{min}} and {{max}}.", {
          field,
          min: issue.min ?? 0,
          max: issue.max ?? 0,
          defaultValue: `${field} must be between ${issue.min ?? 0} and ${issue.max ?? 0}.`,
        });
    }
  };

  const handleSubmit = async () => {
    if (editor === null) return;
    const found = validateProviderDraft(draft, {
      takenIds: takenIds.filter(
        (id) => editor.kind === "create" || id !== editor.id,
      ),
      creating: editor.kind === "create",
      keyAction,
      apiKey,
    });
    setIssues(found);
    setFormError(null);
    setRemediation(null);
    setSaved(null);
    if (found.length > 0) return;

    setBusy(true);
    try {
      const stored = await onSave(
        providerDraftToInput(draft, {
          creating: editor.kind === "create",
          keyAction,
          apiKey,
        }),
      );
      // Nothing reads the key back, so holding it after a successful save would
      // only widen its exposure.
      setApiKey("");
      setKeyAction("keep");
      setSaved(
        t(
          "Provider verified and saved for this session.",
          "Provider verified and saved for this session.",
        ),
      );
      setEditor(null);
      if (stored !== null && defaultProviderId === null) {
        // First provider on a fresh install: nothing else can be the default,
        // and leaving it unset would make a configured assistant look broken.
        onSetDefault(stored.id);
      }
    } catch (error) {
      // Only the backend's sanitized message is surfaced, and the failure is
      // never handed to runtime reporting — the submitted value is a secret.
      const described = describeAiError(
        error,
        t(
          "The provider could not be verified.",
          "The provider could not be verified.",
        ),
      );
      setFormError(described.message);
      setRemediation(described.remediation ?? null);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setFormError(null);
    setRemediation(null);
    try {
      await onDelete(id);
      setPendingDeleteId(null);
      if (defaultProviderId === id) onSetDefault(null);
    } catch (error) {
      const described = describeAiError(
        error,
        t(
          "The provider could not be deleted.",
          "The provider could not be deleted.",
        ),
      );
      setFormError(described.message);
      setRemediation(described.remediation ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby={headingId}
      data-testid="ai-providers"
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("Providers", "Providers")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "A provider is one named endpoint with its own model and credential. Any service that speaks one of the protocols below works, so you can keep several at once — OpenAI and Groq, or a hosted model and a local one.",
            "A provider is one named endpoint with its own model and credential. Any service that speaks one of the protocols below works, so you can keep several at once — OpenAI and Groq, or a hosted model and a local one.",
          )}
        </p>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>
            {
              describeAiError(
                loadError,
                t(
                  "The providers could not be listed.",
                  "The providers could not be listed.",
                ),
              ).message
            }
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t("Try again", "Try again")}
          </Button>
        </div>
      ) : null}

      {formError ? (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>{formError}</p>
          {remediation ? <p>{remediation}</p> : null}
        </div>
      ) : null}

      {saved ? (
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {saved}
        </p>
      ) : null}

      {loading && providers.length === 0 ? (
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {t("Loading providers…", "Loading providers…")}
        </p>
      ) : null}

      {!loading && providers.length === 0 ? (
        <div
          data-testid="ai-providers-empty"
          className="space-y-2 rounded-lg border border-dashed border-border/60 bg-card/30 px-3 py-4 text-xs"
        >
          <p className="font-medium">
            {t("No providers yet", "No providers yet")}
          </p>
          <p className="text-muted-foreground">
            {t(
              "The assistant cannot answer until one endpoint is configured. Adding one is a short form: pick the protocol, paste a key, and the default model and endpoint are filled in for you.",
              "The assistant cannot answer until one endpoint is configured. Adding one is a short form: pick the protocol, paste a key, and the default model and endpoint are filled in for you.",
            )}
          </p>
        </div>
      ) : null}

      {providers.length > 0 ? (
        <fieldset
          className="min-w-0 space-y-2 rounded-lg border border-border/60 bg-card/30 p-3"
          disabled={defaultBusy || busy}
        >
          <legend className="px-1 text-xs font-medium">
            {t("Default provider", "Default provider")}
          </legend>
          <p className="px-1 text-xs text-muted-foreground">
            {t(
              "New conversations start with the default. Existing conversations keep the provider they were created with.",
              "New conversations start with the default. Existing conversations keep the provider they were created with.",
            )}
          </p>

          {providers.map((profile) => {
            const info = PROVIDER_PROTOCOL_INFO[profile.protocol];
            return (
              <div
                key={profile.id}
                data-testid="ai-provider-row"
                data-provider={profile.id}
                data-protocol={profile.protocol}
                data-default={defaultProviderId === profile.id}
                data-has-key={profile.hasApiKey}
                className="min-w-0 space-y-2 rounded-md border border-border/50 bg-card/50 px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <label className="flex min-w-0 flex-1 items-start gap-3">
                    <input
                      type="radio"
                      name="ai-default-provider"
                      className="checkbox-themed mt-1 shrink-0"
                      checked={defaultProviderId === profile.id}
                      disabled={defaultBusy || busy}
                      aria-label={t("Make {{label}} the default", {
                        label: profile.label,
                        defaultValue: `Make ${profile.label} the default`,
                      })}
                      onChange={() => {
                        // The `disabled` attribute is what stops a pointer, but
                        // it is not the only way in: a second pick while the
                        // first `ai_set_config` is still in flight would queue
                        // a competing write whose order is not guaranteed.
                        if (defaultBusy || busy) return;
                        onSetDefault(profile.id);
                      }}
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-xs font-medium break-words [overflow-wrap:anywhere]">
                          {profile.label}
                        </span>
                        <Tag>{t(info.label, info.label)}</Tag>
                        {/* `hasApiKey` is the entire credential story the
                            renderer is told, and all it may show. */}
                        <Tag
                          variant={profile.hasApiKey ? "primary" : undefined}
                          data-testid="ai-provider-key-state"
                        >
                          {profile.hasApiKey
                            ? t("Key set", "Key set")
                            : info.keyExpected
                              ? t("No key", "No key")
                              : t("No key needed", "No key needed")}
                        </Tag>
                        {defaultProviderId === profile.id ? (
                          <Tag variant="primary">{t("Default", "Default")}</Tag>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                        {profile.model} · {profile.baseUrl}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t("ID {{id}}", {
                          id: profile.id,
                          defaultValue: `ID ${profile.id}`,
                        })}
                      </span>
                    </span>
                  </label>

                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={t("Edit {{label}}", {
                        label: profile.label,
                        defaultValue: `Edit ${profile.label}`,
                      })}
                      onClick={() => openEdit(profile)}
                    >
                      {t("Edit", "Edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={t("Duplicate {{label}}", {
                        label: profile.label,
                        defaultValue: `Duplicate ${profile.label}`,
                      })}
                      onClick={() => openDuplicate(profile)}
                    >
                      {t("Duplicate", "Duplicate")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={t("Delete {{label}}", {
                        label: profile.label,
                        defaultValue: `Delete ${profile.label}`,
                      })}
                      onClick={() => {
                        setFormError(null);
                        setPendingDeleteId(profile.id);
                      }}
                    >
                      {t("Delete", "Delete")}
                    </Button>
                  </div>
                </div>

                {pendingDeleteId === profile.id ? (
                  <div
                    role="alertdialog"
                    aria-label={t("Confirm deletion", "Confirm deletion")}
                    data-testid="ai-provider-delete-confirm"
                    className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs"
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      setPendingDeleteId(null);
                    }}
                  >
                    <p className="break-words [overflow-wrap:anywhere]">
                      {t(
                        "Delete “{{label}}”? Its stored API key is removed. Conversations created with it keep their transcript, but cannot be continued until you pick another provider for them.",
                        {
                          label: profile.label,
                          defaultValue: `Delete “${profile.label}”? Its stored API key is removed. Conversations created with it keep their transcript, but cannot be continued until you pick another provider for them.`,
                        },
                      )}
                    </p>
                    {defaultProviderId === profile.id ? (
                      <p className="break-words [overflow-wrap:anywhere]">
                        {t(
                          "It is also the default, so new conversations will have no provider until you choose one.",
                          "It is also the default, so new conversations will have no provider until you choose one.",
                        )}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setPendingDeleteId(null)}
                      >
                        {t("Cancel", "Cancel")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleDelete(profile.id)}
                      >
                        {t("Delete provider", "Delete provider")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {editor === null ? (
        <Button type="button" size="sm" disabled={busy} onClick={openCreate}>
          {t("Add a provider", "Add a provider")}
        </Button>
      ) : (
        <form
          className="min-w-0 space-y-3 rounded-lg border border-border/60 bg-card/30 p-3"
          data-testid="ai-provider-editor"
          data-editor-kind={editor.kind}
          // `noValidate` is deliberate. The `type="url"` and `type="number"`
          // fields below carry `min`/`max` so the right keyboard and spinners
          // appear, but leaving native constraint validation on meant the
          // browser aborted the submit before `validateProviderDraft` ever ran:
          // a bad base URL or an out-of-range token count produced a transient
          // native bubble on one field instead of this form's own list of every
          // problem, and nothing was reported to the user in the same place as
          // a backend refusal. The checks are kept in one place instead.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <h4 className="text-xs font-semibold">
            {creating
              ? t("Add a provider", "Add a provider")
              : t("Edit provider", "Edit provider")}
          </h4>

          <div className="space-y-1">
            <Label htmlFor="ai-provider-protocol">
              {t("Protocol", "Protocol")}
            </Label>
            {/* The app's themed dropdown, like the per-tool picker in
                `AiPermissionSettings` — one idiom for every choice in the
                assistant. `changeProtocol` narrows the reported value before
                it reaches the draft, so a string that is not a protocol
                cannot become one. */}
            <Select value={draft.protocol} onValueChange={changeProtocol}>
              <SelectTrigger
                id="ai-provider-protocol"
                className={cn(AI_SELECT_TRIGGER_CLASS, "h-9")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={AI_SELECT_CONTENT_CLASS}>
                {PROVIDER_PROTOCOLS.map((candidate) => (
                  // Radix consumes `value`; `data-value` keeps the wire
                  // spelling of the protocol visible on the DOM.
                  <SelectItem
                    key={candidate}
                    value={candidate}
                    data-value={candidate}
                  >
                    {t(
                      PROVIDER_PROTOCOL_INFO[candidate].label,
                      PROVIDER_PROTOCOL_INFO[candidate].label,
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(protocolInfo.description, protocolInfo.description)}
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="ai-provider-label">{t("Name", "Name")}</Label>
            <Input
              id="ai-provider-label"
              value={draft.label}
              placeholder={t("e.g. Groq (fast)", "e.g. Groq (fast)")}
              onChange={(event) => changeLabel(event.target.value)}
            />
          </div>

          {creating ? (
            <div className="space-y-1">
              <Label htmlFor="ai-provider-id">
                {t("Provider ID", "Provider ID")}
              </Label>
              <Input
                id="ai-provider-id"
                value={draft.id}
                maxLength={AI_PROVIDER_LIMITS.idBytes}
                onChange={(event) => {
                  setIdTouched(true);
                  setDraft((prev) => ({ ...prev, id: event.target.value }));
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Letters, digits, hyphens and underscores. Conversations are stored against it, so it cannot be changed later.",
                  "Letters, digits, hyphens and underscores. Conversations are stored against it, so it cannot be changed later.",
                )}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("ID {{id}} · cannot be changed", {
                id: draft.id,
                defaultValue: `ID ${draft.id} · cannot be changed`,
              })}
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="ai-provider-model">{t("Model", "Model")}</Label>
            <Input
              id="ai-provider-model"
              value={draft.model}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, model: event.target.value }))
              }
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ai-provider-base-url">
              {t("Base URL (optional)", "Base URL (optional)")}
            </Label>
            <Input
              id="ai-provider-base-url"
              type="url"
              value={draft.baseUrl}
              placeholder={t(
                "Leave empty for this protocol's default endpoint",
                "Leave empty for this protocol's default endpoint",
              )}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "A full http:// or https:// address. This is the field that points the protocol at a different service.",
                "A full http:// or https:// address. This is the field that points the protocol at a different service.",
              )}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label htmlFor="ai-provider-temperature">
                {t("Temperature", "Temperature")}
              </Label>
              <Input
                id="ai-provider-temperature"
                type="number"
                min={AI_PROVIDER_LIMITS.temperature.min}
                max={AI_PROVIDER_LIMITS.temperature.max}
                step={0.1}
                value={draft.temperature}
                className="w-28"
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    temperature: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-provider-max-tokens">
                {t("Max tokens", "Max tokens")}
              </Label>
              <Input
                id="ai-provider-max-tokens"
                type="number"
                min={AI_PROVIDER_LIMITS.maxTokens.min}
                max={AI_PROVIDER_LIMITS.maxTokens.max}
                step={1}
                value={draft.maxTokens}
                className="w-32"
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    maxTokens: event.target.value,
                  }))
                }
              />
            </div>
          </div>

          <div className="space-y-2" data-testid="ai-provider-key-field">
            {/* Three mutually exclusive intents, and the field exists only for
                the one that needs a value. The stored key is never a value
                here, because the renderer was never given it. */}
            {storedKey ? (
              <p className="text-xs" data-testid="ai-provider-key-status">
                {keyAction === "clear"
                  ? t(
                      "The stored key will be removed when you save.",
                      "The stored key will be removed when you save.",
                    )
                  : keyAction === "replace"
                    ? t(
                        "The key you enter below replaces the stored one.",
                        "The key you enter below replaces the stored one.",
                      )
                    : t(
                        "A key is stored for this provider. It is left unchanged unless you replace or clear it.",
                        "A key is stored for this provider. It is left unchanged unless you replace or clear it.",
                      )}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {storedKey && keyAction !== "keep" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setKeyAction("keep");
                    setApiKey("");
                  }}
                >
                  {t("Keep the stored key", "Keep the stored key")}
                </Button>
              ) : null}
              {keyAction !== "replace" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setKeyAction("replace");
                    setApiKey("");
                  }}
                >
                  {storedKey
                    ? t("Replace key", "Replace key")
                    : t("Set a key", "Set a key")}
                </Button>
              ) : null}
              {storedKey && keyAction !== "clear" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setKeyAction("clear");
                    setApiKey("");
                  }}
                >
                  {t("Clear key", "Clear key")}
                </Button>
              ) : null}
            </div>

            {keyAction === "replace" ? (
              <div className="space-y-1">
                <Label htmlFor="ai-provider-key">
                  {protocolInfo.keyExpected
                    ? t("API key", "API key")
                    : t("API key (not required)", "API key (not required)")}
                </Label>
                <Input
                  id="ai-provider-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder={t("Provider API key", "Provider API key")}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p role="note" className="text-xs text-muted-foreground">
                  {t(
                    "Stored in memory for this session only. You will need to re-enter it after restarting the app.",
                    "Stored in memory for this session only. You will need to re-enter it after restarting the app.",
                  )}
                </p>
              </div>
            ) : null}
          </div>

          {issues.length > 0 ? (
            <ul
              role="alert"
              data-testid="ai-provider-issues"
              className="list-disc space-y-1 rounded-md border border-destructive/40 bg-destructive/10 py-2 pl-7 pr-3 text-xs text-destructive"
            >
              {issues.map((issue) => (
                <li key={`${issue.field}-${issue.code}`}>
                  {describeIssue(issue)}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy
                ? t("Verifying…", "Verifying…")
                : t("Save and verify", "Save and verify")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={closeEditor}
            >
              {t("Cancel", "Cancel")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
