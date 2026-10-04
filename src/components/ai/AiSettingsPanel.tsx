/**
 * The assistant's settings, as a sectioned panel with a section nav.
 *
 * This is deliberately the *same* pattern as the app's own settings rather than
 * a design of its own: a `role="toolbar"` strip of `.ui-segment` buttons over a
 * single visible section, exactly as the workspace's Session settings tab
 * (`DNSManager`) and the Notifications settings view
 * (`NotificationsSettings`) do, down to the class names. Someone who has used
 * one has used all three.
 *
 * Two things are added on top of that shared idiom, both because this surface
 * is reached by keyboard far more often than the workspace tab is:
 *
 * 1. **The strip is a real toolbar.** ARIA says a toolbar is one tab stop with
 *    arrow-key movement inside it, which the app's own strips do not implement
 *    — four sections meant four Tab presses to cross. Here the selected
 *    segment is the only tab stop (roving `tabindex`), Left/Right and Up/Down
 *    move between sections, and Home/End jump to the ends. Clicking still
 *    works identically.
 * 2. **The section is announced.** The body is a labelled group whose label is
 *    the active segment, and `aria-controls` ties the two together, so moving
 *    through the strip says which section each stop opens.
 *
 * **On a narrow surface the nav does not change shape.** The dock is 22rem and
 * the bubble 26rem, and `.ui-segment-group` is already a single
 * `overflow-x: auto` row with `white-space: nowrap`, so the strip scrolls
 * sideways rather than wrapping — the same thing the workspace's own settings
 * strip and the global tab bar do when the window is narrow. That is a
 * deliberate choice twice over: a wrapped strip would steal a second and third
 * row of transcript height from the bubble, and collapsing the nav into a
 * dropdown would hide the existence of the other sections on the very surface
 * where they are hardest to find. Arrow-key movement reaches an off-screen
 * segment and `focus()` scrolls it into view, so nothing is unreachable.
 *
 * The sections themselves need no second layout: every form in them already
 * puts its label above its control and wraps its number pairs, which is why
 * they fit a 22rem dock unchanged. `compact` therefore only trims the padding
 * around them — it is not a layout switch, and claiming one would be a lie
 * about what the dock does differently.
 */
import {
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_ASSISTANT_PRESENTATION_OPTIONS,
  isAiAssistantPresentation,
  type AiAssistantPresentation,
} from "@/lib/ai/presentation";
import { cn } from "@/lib/utils";
import type {
  AgentConfig,
  AiProviderProfile,
  AiProviderProfileInput,
} from "@/types/ai";

import { ConnectedAiAgentSettings } from "./AiAgentSettings";
import { AI_SELECT_CONTENT_CLASS, AI_SELECT_TRIGGER_CLASS } from "./ai-select";
import { describeAiError } from "./ai-error";
import { ConnectedAiPermissionSettings } from "./AiPermissionSettings";
import { ConnectedAiPersonaSettings } from "./AiPersonaSettings";
import { AiProviderSettings } from "./AiProviderSettings";

/**
 * Settings sections, in nav order.
 *
 * `providers` is first and is the default: it is the only section that can be
 * *required* before the assistant works at all, and landing anywhere else would
 * make an unconfigured install look broken.
 */
export type AiSettingsSection =
  "providers" | "behaviour" | "tools" | "personas";

export const AI_SETTINGS_SECTIONS: readonly {
  id: AiSettingsSection;
  label: string;
}[] = [
  { id: "providers", label: "Providers" },
  { id: "behaviour", label: "Behaviour" },
  { id: "tools", label: "Tools & permissions" },
  { id: "personas", label: "Personas" },
] as const;

/**
 * The placement picker's value guard, as a function rather than an inline
 * `if`, so that the rule can be pinned by a test on its own.
 *
 * A dropdown's change handler takes a bare `string`: the themed `Select` is
 * typed `(value: string) => void`, and the value it reports comes from
 * whichever item was rendered at the time, which can be a set that has since
 * changed. The stored preference it is seeded from can hold anything at all.
 * So the string is narrowed here and a value that is not a presentation
 * becomes `null` — never state, and never a call to the owner.
 */
export function placementFromPickerValue(
  value: string,
): AiAssistantPresentation | null {
  return isAiAssistantPresentation(value) ? value : null;
}

export interface AiSettingsPanelProps {
  section: AiSettingsSection;
  onSectionChange: (section: AiSettingsSection) => void;
  /** Stack rows instead of pairing them, for the dock and the bubble. */
  compact: boolean;
  providers: AiProviderProfile[];
  providersLoading: boolean;
  providersError: unknown;
  onRefreshProviders: () => void;
  onSaveProvider: (
    profile: AiProviderProfileInput,
  ) => Promise<AiProviderProfile | null>;
  onDeleteProvider: (id: string) => Promise<void>;
  /** `null` until `ai_get_config` has answered. */
  config: AgentConfig | null;
  /** An `ai_set_config` write is in flight. */
  configBusy: boolean;
  onSaveConfig: (config: AgentConfig) => Promise<void>;
  onSelectPersona: (id: string | null) => void;
  onSetDefaultProvider: (id: string | null) => void;
  /** Which chrome the assistant is currently wearing. */
  presentation: AiAssistantPresentation;
  /**
   * Changes that chrome. Absent when the host does not own the preference, in
   * which case no placement control is offered — an inert one would be worse
   * than none, and this is the only section that could show it.
   */
  onPresentationChange?: (next: AiAssistantPresentation) => void;
}

export function AiSettingsPanel({
  section,
  onSectionChange,
  compact,
  providers,
  providersLoading,
  providersError,
  onRefreshProviders,
  onSaveProvider,
  onDeleteProvider,
  config,
  configBusy,
  onSaveConfig,
  onSelectPersona,
  onSetDefaultProvider,
  presentation,
  onPresentationChange,
}: AiSettingsPanelProps) {
  const { t } = useI18n();
  const baseId = useId();
  const navRef = useRef<HTMLDivElement | null>(null);

  const panelId = `${baseId}-section`;
  const tabId = (id: AiSettingsSection) => `${baseId}-${id}`;
  const placementId = `${baseId}-placement`;
  const defaultProvider =
    providers.find((profile) => profile.id === config?.defaultProviderId) ??
    null;

  /**
   * The `toolsEnabled` write in flight, or `null` when none is.
   *
   * It is a tri-state rather than a boolean `busy` flag because the switch has
   * to show the value being written while the round trip runs: `config` still
   * holds the old one, and rendering that would make every flip look like it
   * bounced back.
   */
  const [toolsPending, setToolsPending] = useState<boolean | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsRemediation, setToolsRemediation] = useState<string | null>(null);
  const shownToolsEnabled = toolsPending ?? config?.toolsEnabled ?? false;

  /**
   * Flip tool use, carrying the whole config.
   *
   * A partial write would reset whatever the Behaviour form and the provider
   * list last stored, which is the same reason `handlePersonaSelect` in
   * `AiAssistantPanel` sends `{ ...current }`. A second flip while the first
   * is in flight is dropped rather than queued: two `ai_set_config` writes
   * have no guaranteed order, so the loser would silently win.
   */
  const setToolsEnabled = async (next: boolean) => {
    if (config === null || toolsPending !== null) return;
    setToolsPending(next);
    setToolsError(null);
    setToolsRemediation(null);
    try {
      await onSaveConfig({ ...config, toolsEnabled: next });
    } catch (error) {
      const described = describeAiError(
        error,
        t("Tool use could not be changed.", "Tool use could not be changed."),
      );
      setToolsError(described.message);
      setToolsRemediation(described.remediation ?? null);
    } finally {
      // Back to reporting `config`. On success the host has already replaced
      // it; on a refusal it never changed, so the switch returns to the state
      // the backend is actually in.
      setToolsPending(null);
    }
  };
  const placementHint =
    AI_ASSISTANT_PRESENTATION_OPTIONS.find(
      (option) => option.id === presentation,
    )?.hint ?? null;

  /**
   * Nothing is configured yet, so the Providers section is marked in the nav.
   * Only once the config has actually been read: a nav that cries for attention
   * while a round trip is in flight is noise, not a signal.
   */
  const needsProvider = !providersLoading && providers.length === 0;

  /** Move the selection and the roving tab stop together. */
  const selectSection = (next: AiSettingsSection, moveFocus: boolean) => {
    onSectionChange(next);
    if (!moveFocus) return;
    navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-section="${next}"]`)
      ?.focus();
  };

  const handleNavKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = AI_SETTINGS_SECTIONS.findIndex(
      (entry) => entry.id === section,
    );
    if (index < 0) return;
    const last = AI_SETTINGS_SECTIONS.length - 1;
    let target: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = index === 0 ? last : index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectSection(AI_SETTINGS_SECTIONS[target].id, true);
  };

  /**
   * Exactly one section is built, so only the open one mounts. The permission
   * catalog and the persona list are separate commands, and reading them
   * because a provider form is open would be a round trip nobody asked for.
   */
  const renderSection = (): ReactNode => {
    if (section === "providers") {
      return (
        <AiProviderSettings
          providers={providers}
          loading={providersLoading}
          loadError={providersError}
          defaultProviderId={config?.defaultProviderId ?? null}
          defaultBusy={configBusy || config === null}
          onSetDefault={onSetDefaultProvider}
          onSave={onSaveProvider}
          onDelete={onDeleteProvider}
          onRetry={onRefreshProviders}
        />
      );
    }
    if (section === "behaviour") {
      return (
        <div className="min-w-0 space-y-4">
          {/* Where the assistant appears. It lives here rather than inside
              `AiAgentSettings` because that form is agent config behind a Save
              button, and this is a local UI preference that applies the moment
              it changes.

              A dropdown rather than the radio list the workspace's own Session
              settings uses: this section has to fit a 22rem dock and a 26rem
              bubble, where three labels each with their own paragraph would
              cost more transcript height than the choice is worth. The
              selected option's consequence is stated under it, which is the
              part a label cannot carry — the full set is still spelled out in
              Session settings, under General. */}
          {onPresentationChange ? (
            <section
              className="min-w-0 space-y-2"
              data-testid="ai-placement"
              data-presentation={presentation}
            >
              <h3 className="text-sm font-semibold">
                {t(
                  "Where the assistant appears",
                  "Where the assistant appears",
                )}
              </h3>
              <label
                htmlFor={placementId}
                className="block text-xs font-medium"
              >
                {t("Placement", "Placement")}
              </label>
              <Select
                value={presentation}
                onValueChange={(value) => {
                  // The guard the native `<select>` carried, unchanged: a junk
                  // value must not become state. See `placementFromPickerValue`.
                  const next = placementFromPickerValue(value);
                  if (next !== null) onPresentationChange(next);
                }}
              >
                <SelectTrigger
                  id={placementId}
                  className={AI_SELECT_TRIGGER_CLASS}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={AI_SELECT_CONTENT_CLASS}>
                  {AI_ASSISTANT_PRESENTATION_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.id}
                      value={option.id}
                      // Radix consumes `value`, so the chosen id never reaches
                      // the DOM. Mirrored here because which *value* an option
                      // carries is the thing worth pinning — a label can be
                      // translated, an id cannot.
                      data-value={option.id}
                    >
                      {t(option.label, option.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p
                role="note"
                data-testid="ai-placement-hint"
                className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]"
              >
                {placementHint ? t(placementHint, placementHint) : null}
              </p>
            </section>
          ) : null}
          {/* The default provider decides which advanced parameters apply:
              new conversations start with it, so it is the one the settings
              can honestly be checked against. An id that resolves to nothing
              — deleted profile, or none chosen yet — is passed through as
              `null` rather than guessed at. */}
          <ConnectedAiAgentSettings
            config={config}
            onSave={onSaveConfig}
            protocol={defaultProvider?.protocol ?? null}
            providerLabel={defaultProvider?.label ?? null}
          />
        </div>
      );
    }
    if (section === "tools") {
      return (
        <div className="min-w-0 space-y-4">
          {/* The master switch, and the only control for it anywhere in the
              app: the chat view's old "Disable tool use" button went with the
              gate it belonged to, which left `toolsEnabled` on by default and
              unreachable. It writes the whole config through `onSaveConfig`,
              so a flip here cannot reset what the other sections stored.

              While the write is in flight the switch shows the value being
              written, not the one still in `config` — a switch that springs
              back for the length of a round trip reads as a failure. A refusal
              is what actually springs it back, next to the backend's own
              message. */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              {t("Tool use", "Tool use")}
            </h3>
            <div className="flex items-start gap-3">
              <Switch
                id="ai-tools-enabled"
                size="sm"
                checked={shownToolsEnabled}
                disabled={config === null || toolsPending !== null}
                aria-label={t("Tool use", "Tool use")}
                onCheckedChange={(next) => void setToolsEnabled(next)}
              />
              <p className="text-xs text-muted-foreground">
                {shownToolsEnabled
                  ? t(
                      "Tool use is on for the assistant. Which tools it can actually run is still decided by the rules below and by the app's own MCP tool grants, so turning it on does not by itself allow anything.",
                      "Tool use is on for the assistant. Which tools it can actually run is still decided by the rules below and by the app's own MCP tool grants, so turning it on does not by itself allow anything.",
                    )
                  : t(
                      "Tool use is off for the assistant, so no tool runs whatever the rules below say. The assistant can still chat; it just cannot look anything up.",
                      "Tool use is off for the assistant, so no tool runs whatever the rules below say. The assistant can still chat; it just cannot look anything up.",
                    )}
              </p>
            </div>
            {toolsError ? (
              <p
                role="alert"
                data-testid="ai-tools-error"
                className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <span className="block">{toolsError}</span>
                {toolsRemediation ? (
                  <span className="block">{toolsRemediation}</span>
                ) : null}
              </p>
            ) : null}
          </section>
          <ConnectedAiPermissionSettings
            toolsEnabled={config?.toolsEnabled ?? false}
          />
        </div>
      );
    }
    return (
      <ConnectedAiPersonaSettings
        selectedId={config?.personaId ?? null}
        selectionBusy={configBusy}
        onSelect={onSelectPersona}
      />
    );
  };

  return (
    <div
      className="min-w-0 space-y-4"
      data-testid="ai-settings"
      data-section={section}
      data-compact={compact}
    >
      <div
        ref={navRef}
        role="toolbar"
        aria-label={t(
          "Assistant settings sections",
          "Assistant settings sections",
        )}
        aria-orientation="horizontal"
        className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
        onKeyDown={handleNavKeyDown}
      >
        {AI_SETTINGS_SECTIONS.map((entry) => {
          const active = section === entry.id;
          return (
            <button
              key={entry.id}
              id={tabId(entry.id)}
              type="button"
              className="ui-segment ui-focus"
              data-section={entry.id}
              data-active={active}
              aria-pressed={active}
              aria-controls={panelId}
              // One tab stop for the whole strip; the arrows move inside it.
              tabIndex={active ? 0 : -1}
              onClick={() => selectSection(entry.id, false)}
            >
              {t(entry.label, entry.label)}
              {entry.id === "providers" && needsProvider ? (
                <>
                  <span
                    aria-hidden="true"
                    data-testid="ai-settings-attention"
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                  />
                  {/* Folded into the button's accessible name, so the dot is
                      not the only way to learn that setup is outstanding. The
                      explicit space is load-bearing: without it the computed
                      name runs the two together as "Providers(needs setup)". */}{" "}
                  <span className="sr-only">
                    {t("(needs setup)", "(needs setup)")}
                  </span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        id={panelId}
        role="group"
        aria-labelledby={tabId(section)}
        className={cn(
          "min-w-0 rounded-xl border border-border/60 bg-card/60 text-sm",
          // Padding is the one thing the dock and the bubble need less of, and
          // it is keyed off the surface rather than a `sm:`/`md:` breakpoint: a
          // docked panel can be 22rem wide on a 2560px display, so the viewport
          // says nothing useful about how much room this panel has.
          compact ? "p-2" : "p-3 sm:p-4",
        )}
      >
        {renderSection()}
      </div>
    </div>
  );
}
