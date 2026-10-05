/**
 * The places the assistant is pointing at, as real controls.
 *
 * Two rules, both of which the app already follows elsewhere and neither of
 * which is reinvented here.
 *
 * **In-app links use the navigation the app already has.** Every in-app kind
 * goes through `followAiLink`, which calls the same callbacks `DNSManager`
 * wires to the expiry notice's "Check registration" and the inbox's "Go to
 * record". There is no second navigation path, and nothing here touches
 * `window.location`, a router or an `href`.
 *
 * **External links are buttons, not anchors.** The desktop build has to route
 * the URL through the Tauri shell, which an anchor cannot do, so this matches
 * `RegistrarSiteLink` and `RecordRow` exactly: a `<button>` whose click hands
 * the URL to `openExternalUrl`, which validates scheme, credentials and
 * control characters and then picks the shell or `window.open(…,
 * "noopener,noreferrer")` per build.
 *
 * And the rule specific to this surface: the destination came from a **model**.
 * `resolveAiLink` re-checks every target against the app's own closed sets
 * before any of this renders, and a target that does not check out produces
 * **no control at all** — not a disabled one, and not the raw target as
 * copyable text, because either would still be an invitation to follow a
 * destination the app has refused. What was dropped is counted on screen, so
 * a vanished link is visible rather than silent.
 */
import {
  ArrowRight,
  ExternalLink,
  Globe,
  LayoutGrid,
  Table2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import {
  AI_LINK_LIMITS,
  aiLinkLabel,
  followAiLink,
  resolveAiLink,
  type AiLinkNavigation,
  type ResolvedAiLink,
} from "@/lib/ai/links";
import { openExternalUrl } from "@/lib/external-url";
import type { AiLink } from "@/types/ai";

export interface AiLinkListProps {
  links: readonly AiLink[];
  /**
   * The host's navigation. Absent when the host does not own the workspace —
   * in which case the in-app kinds offer no control, for the same reason the
   * placement picker is absent from a host that does not own the preference:
   * an inert control is worse than none. `external` still works, because it
   * needs nothing from the host.
   */
  navigation?: AiLinkNavigation;
  /** A heading, when this list is a section of its own rather than a row. */
  heading?: string;
  /** Distinguishes several lists in one surface, for tests and labels. */
  context?: string;
}

/** No navigation: the in-app kinds cannot be followed, external still can. */
const NO_NAVIGATION: AiLinkNavigation = {
  knownZoneIds: [],
  openZone: () => {},
  revealRecord: () => {},
  openZoneTab: () => {},
  openDomainRegistry: () => {},
  openWorkspace: () => {},
};

function iconFor(resolved: ResolvedAiLink) {
  switch (resolved.kind) {
    case "zone":
    case "record":
      return Table2;
    case "domainRegistry":
      return Globe;
    case "zoneTab":
    case "workspace":
      return LayoutGrid;
    case "external":
      return ExternalLink;
  }
}

export function AiLinkList({
  links,
  navigation,
  heading,
  context,
}: AiLinkListProps) {
  const { t } = useI18n();
  const resolver = navigation ?? NO_NAVIGATION;

  // The offer ceiling is enforced again here. The backend refuses an offer
  // over it, so going past it would mean the payload did not come from the
  // offer path at all — and a model filling the panel with controls is the
  // thing that bound exists to stop.
  const offered = links.slice(0, AI_LINK_LIMITS.maxLinks);
  const resolved = offered.map((link) => ({
    link,
    target: resolveAiLink(link, resolver),
  }));
  // An in-app link with no host wiring is dropped for the same reason an
  // unresolvable one is: there is nothing it can do.
  const usable = resolved.filter(
    (entry): entry is { link: AiLink; target: ResolvedAiLink } =>
      entry.target !== null &&
      (entry.target.kind === "external" || navigation !== undefined),
  );
  const droppedCount = links.length - usable.length;

  if (links.length === 0) return null;

  return (
    <div
      className="min-w-0 space-y-1"
      data-testid="ai-link-list"
      data-context={context ?? ""}
      data-usable={usable.length}
      data-dropped={droppedCount}
    >
      {heading ? <h4 className="text-xs font-semibold">{heading}</h4> : null}
      {usable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {usable.map(({ link, target }, index) => {
            const Icon = iconFor(target);
            const label = aiLinkLabel(link, target);
            const name = accessibleName(target, label, t);
            return (
              <Button
                key={`${target.kind}-${index}-${label}`}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 max-w-full gap-1 px-2 text-xs"
                data-testid="ai-link"
                data-kind={target.kind}
                // The resolved destination, never `link.target`: what is
                // pinned here has been through the closed-set check.
                data-destination={describeDestination(target)}
                aria-label={name}
                title={name}
                onClick={() => {
                  if (target.kind === "external") {
                    // The only external path. `openExternalUrl` validates and
                    // then picks the shell or a `noopener,noreferrer` window.
                    void openExternalUrl(target.url);
                    return;
                  }
                  followAiLink(target, resolver);
                }}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{label}</span>
                {target.kind === "external" ? null : (
                  <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" />
                )}
              </Button>
            );
          })}
        </div>
      ) : null}
      {droppedCount > 0 ? (
        <p
          role="note"
          data-testid="ai-link-dropped"
          className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"
        >
          {droppedCount === 1
            ? t(
                "One link was left out: it pointed somewhere this app does not open.",
                "One link was left out: it pointed somewhere this app does not open.",
              )
            : t(
                "{{count}} links were left out: they pointed somewhere this app does not open.",
                {
                  count: droppedCount,
                  defaultValue: `${droppedCount} links were left out: they pointed somewhere this app does not open.`,
                },
              )}
        </p>
      ) : null}
    </div>
  );
}

/** A stable description of where a control leads, for tests and for `title`. */
function describeDestination(target: ResolvedAiLink): string {
  switch (target.kind) {
    case "zone":
      return target.zoneId;
    case "record":
      return `${target.zoneId}/${target.recordId}`;
    case "zoneTab":
      return `${target.zoneId}/${target.tab}`;
    case "domainRegistry":
      return target.domain;
    case "workspace":
      return target.workspace;
    case "external":
      return target.url;
  }
}

/**
 * The accessible name says where the control goes, not just what it is called.
 *
 * A model-written label is free text and several of them can read the same;
 * the destination is what tells them apart. For an external link it names the
 * host, which is the part that must never be a surprise — the same rule
 * `RegistrarSiteLink` applies.
 */
function accessibleName(
  target: ResolvedAiLink,
  label: string,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (target.kind) {
    case "zone":
      return t("Open the zone {{label}}", {
        label,
        defaultValue: `Open the zone ${label}`,
      });
    case "record":
      return t("Show the record {{label}} in this app", {
        label,
        defaultValue: `Show the record ${label} in this app`,
      });
    case "zoneTab":
      return t("Open {{label}} on the {{tab}} view", {
        label,
        tab: target.tab,
        defaultValue: `Open ${label} on the ${target.tab} view`,
      });
    case "domainRegistry":
      return t("Check {{domain}} in the registry", {
        domain: target.domain,
        defaultValue: `Check ${target.domain} in the registry`,
      });
    case "workspace":
      return t("Open {{label}} in this app", {
        label,
        defaultValue: `Open ${label} in this app`,
      });
    case "external": {
      const host = hostOf(target.url);
      return t("Open {{label}} in your browser ({{host}})", {
        label,
        host,
        defaultValue: `Open ${label} in your browser (${host})`,
      });
    }
  }
}

/** The host of an already-validated URL; never throws, because it parsed once. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
