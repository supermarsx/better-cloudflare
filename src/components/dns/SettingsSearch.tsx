/**
 * "Find a setting" for the Session settings screen.
 *
 * Settings are spread over seven subtabs, so the only way to reach one used to
 * be knowing which subtab held it. This is the box that removes that
 * requirement: it searches {@link SETTINGS_SEARCH_ENTRIES} and hands the chosen
 * entry back, leaving the caller to switch subtab and reveal the row — the
 * search box deliberately knows nothing about either.
 *
 * It is the ARIA combobox pattern rather than a list of buttons: focus stays in
 * the text field, the arrow keys move `aria-activedescendant` through the
 * options, and Enter takes the active one. That is what lets a screen-reader
 * user hear the result count change as they type without losing the caret.
 */
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import {
  searchSettings,
  type SettingsSearchEntry,
} from "@/components/dns/settings-search";

/** How many hits the list shows at once. */
const RESULT_LIMIT = 8;

export interface SettingsSearchProps {
  /** Held by the caller so the query survives a subtab switch. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Desktop build: unlocks the desktop-only half of the index. */
  desktop: boolean;
  /** Called with the chosen setting. The caller does the navigating. */
  onPick: (entry: SettingsSearchEntry) => void;
}

export function SettingsSearch({
  query,
  onQueryChange,
  desktop,
  onPick,
}: SettingsSearchProps) {
  const { t } = useI18n();
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (entryId: string) => `${baseId}-option-${entryId}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [requestedIndex, setRequestedIndex] = useState(0);

  const results = useMemo(
    () => searchSettings(query, { translate: t, desktop, limit: RESULT_LIMIT }),
    [query, t, desktop],
  );
  const hasQuery = query.trim().length > 0;
  const open = hasQuery && results.length > 0;
  /**
   * Clamped here rather than corrected in an effect, so that the render where
   * the list got shorter already points somewhere real: a stale index would
   * leave `aria-activedescendant` naming an option that no longer exists, and
   * a screen reader reads that render.
   */
  const activeIndex =
    results.length === 0 ? 0 : Math.min(requestedIndex, results.length - 1);

  const pick = useCallback(
    (index: number) => {
      const result = results[index];
      if (!result) return;
      onPick(result.entry);
    },
    [onPick, results],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (!hasQuery) return;
      event.preventDefault();
      onQueryChange("");
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      pick(activeIndex);
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setRequestedIndex((activeIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setRequestedIndex((activeIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setRequestedIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setRequestedIndex(results.length - 1);
    }
  };

  /**
   * What the live region says. An empty search says nothing at all — a count
   * announced before the user has typed is noise, not feedback.
   */
  const announcement = !hasQuery
    ? ""
    : results.length === 0
      ? t("No settings match your search.", "No settings match your search.")
      : t("{{count}} settings match.", {
          count: results.length,
          defaultValue: `${results.length} settings match.`,
        });

  return (
    <div className="relative" data-testid="settings-search">
      <Label htmlFor={inputId} className="sr-only">
        {t("Find a setting", "Find a setting")}
      </Label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={inputId}
        ref={inputRef}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          open ? optionId(results[activeIndex]?.entry.id ?? "") : undefined
        }
        placeholder={t("Find a setting by name", "Find a setting by name")}
        value={query}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setRequestedIndex(0);
        }}
        onKeyDown={onKeyDown}
        className="h-9 pl-9 pr-9 text-sm"
      />
      {hasQuery ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
          aria-label={t("Clear settings search", "Clear settings search")}
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {hasQuery && results.length === 0 ? (
        <p
          className="mt-2 rounded-lg border border-border/60 bg-card/80 px-3 py-2 text-xs text-muted-foreground"
          data-testid="settings-search-empty"
        >
          {t(
            "No settings match your search.",
            "No settings match your search.",
          )}
        </p>
      ) : null}
      {/* Always rendered, so `aria-controls` always resolves to a real node. */}
      <ul
        id={listboxId}
        role="listbox"
        aria-label={t("Matching settings", "Matching settings")}
        data-testid="settings-search-results"
        hidden={!open}
        className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 scrollbar-themed overflow-auto rounded-xl border border-border/60 bg-popover/95 p-1 shadow-lg"
      >
        {results.map((result, index) => (
          <li
            key={result.entry.id}
            id={optionId(result.entry.id)}
            role="option"
            aria-selected={index === activeIndex}
            data-setting-result={result.entry.id}
            data-active={index === activeIndex}
            className="cursor-pointer rounded-lg px-3 py-2 text-left text-xs data-[active=true]:bg-accent/60"
            // `mousedown` would blur the input before the click lands, which
            // closes the list out from under the pointer.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setRequestedIndex(index)}
            onClick={() => pick(index)}
          >
            <span className="block text-[10px] uppercase tracking-widest text-muted-foreground">
              {result.breadcrumb}
            </span>
            <span className="block font-medium text-foreground">
              {result.label}
            </span>
            {result.description ? (
              <span className="mt-0.5 block text-muted-foreground">
                {result.description}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
