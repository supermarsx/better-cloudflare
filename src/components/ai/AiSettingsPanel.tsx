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
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import type {
  AgentConfig,
  AiProviderProfile,
  AiProviderProfileInput,
} from "@/types/ai";

import { AiAgentSettings } from "./AiAgentSettings";
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
}: AiSettingsPanelProps) {
  const { t } = useI18n();
  const baseId = useId();
  const navRef = useRef<HTMLDivElement | null>(null);

  const panelId = `${baseId}-section`;
  const tabId = (id: AiSettingsSection) => `${baseId}-${id}`;

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
      return <AiAgentSettings config={config} onSave={onSaveConfig} />;
    }
    if (section === "tools") {
      return (
        <div className="min-w-0 space-y-4">
          {/* The one control the chat view also owns, and the only place it is
              offered in settings — two switches for one piece of state could
              disagree about whether any tool can run. */}
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              {t("Tool use", "Tool use")}
            </h3>
            <div className="flex items-start gap-3">
              <Switch
                id="ai-tools-enabled"
                size="sm"
                checked={config?.toolsEnabled ?? false}
                disabled
                aria-label={t("Tool use", "Tool use")}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Tool use is unavailable in this build. The assistant can read and discuss, but cannot change anything in your account.",
                  "Tool use is unavailable in this build. The assistant can read and discuss, but cannot change anything in your account.",
                )}
              </p>
            </div>
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
