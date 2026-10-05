/**
 * Turning a link the assistant offers into a navigation the app will actually
 * perform — or into nothing at all.
 *
 * **The backend's validation is necessary and not sufficient here.** Rust's
 * `LinkStore::offer` refuses a whole offer containing one bad link, so a
 * `javascript:`, `data:` or `file:` target cannot even be stored, and that is
 * the right place for the check. But a renderer that forwarded `link.target`
 * to a router, an `href` or `window.location` on the strength of that would
 * be one backend change away from a navigation bug — and the thing on the
 * other end of the link is a model. So every target is re-decided here,
 * against the same closed sets, and `resolveAiLink` is the only function that
 * reads `AiLink.target` at all. Nothing downstream of it sees the raw string.
 *
 * The rules are copies of `bc-ai-agent/src/links.rs`, and
 * `test/aiPlan.contract.test.ts` pins them against that file:
 *
 * - `zone` and `record` are opaque ids: letters, digits, `-` and `_`, bounded
 *   by `MAX_LINK_ID_BYTES`. The charset is the whole defence — it cannot
 *   express a traversal, a scheme, a query or an escape, whatever a renderer
 *   later interpolates it into. A `zone` is additionally checked against the
 *   zone ids this account actually has, which the backend cannot do.
 * - `record` is `"<zoneId>/<recordId>"` — two of those ids joined by the one
 *   `/` the charset admits, each half re-checked separately, and the zone half
 *   also checked against this account's own zone list.
 * - `zoneTab` is `"<zoneId>/<tab>"`, parsed identically, except that the tab
 *   half is checked against {@link AI_ZONE_TAB_TARGETS} rather than a
 *   charset: these are fixed view names, not ids, so a name outside the set
 *   is a screen the app does not have.
 * - `domainRegistry` is a hostname by grammar, after the same normalisation
 *   Rust applies (trim, drop the root dot, lower-case).
 * - `workspace` is one of {@link AI_WORKSPACE_TARGETS}, which is Rust's
 *   `WORKSPACE_IDS`.
 * - `external` goes through `normalizeExternalHttpUrl` and is then narrowed to
 *   `https:` only, checked against the raw string so nothing can be
 *   normalised into a pass. The app's own registrar hand-off applies the same
 *   extra rule for the same reason: following a link may mean signing in, and
 *   plaintext is not an acceptable fallback.
 *
 * Navigation itself is the host's. {@link AiLinkNavigation} is wired to the
 * callbacks `DNSManager` already uses for the expiry notice's "Check
 * registration" and the inbox's "Go to record", so there is no second
 * navigation path and no in-app kind reaches `window.location`.
 */
import { normalizeExternalHttpUrl } from "@/lib/external-url";
import type { AiLink } from "@/types/ai";

/**
 * The workspaces a link may open.
 *
 * Rust's `WORKSPACE_IDS`, which is itself the non-`zone` members of
 * `DNSManager`'s `TabKind`. `zone` is absent on both sides for the same
 * reason: a zone workspace needs a zone to open, which is what the `zone`
 * kind is for.
 */
export const AI_WORKSPACE_TARGETS = [
  "settings",
  "audit",
  "tags",
  "registry",
  "notifications",
  "assistant",
] as const;

export type AiWorkspaceTarget = (typeof AI_WORKSPACE_TARGETS)[number];

/**
 * The tabs a `zoneTab` link may open inside a zone.
 *
 * Rust's `ZONE_TAB_IDS`, which is the `ActionTab` union in `DNSManager.tsx`.
 * Disjoint from {@link AI_WORKSPACE_TARGETS} on both sides, and the overlap
 * worth knowing about is a near-miss rather than a collision:
 * `domain-registry` is a *zone* tab and `registry` is a top-level workspace,
 * and they are different screens. `"zone1/settings"` is not a zone tab and
 * `"records"` is not a workspace.
 */
export const AI_ZONE_TAB_TARGETS = [
  "records",
  "import",
  "zone-settings",
  "cache",
  "ssl-tls",
  "domain-audit",
  "domain-registry",
  "topology",
  "analytics",
  "firewall",
  "workers",
  "email-routing",
  "propagation",
  "zone-compare",
  "reference",
] as const;

export type AiZoneTabTarget = (typeof AI_ZONE_TAB_TARGETS)[number];

/**
 * The byte ceilings Rust enforces, mirrored so the renderer refuses what the
 * backend would never have stored.
 *
 * They are not redundant with the charset and grammar checks: a 4 KiB string
 * of legal hex is a legal id by charset and is not an id. Each is the
 * constant of the same name in `links.rs`.
 */
export const AI_LINK_LIMITS = {
  /** `MAX_LINKS_PER_OFFER`: links one offer may carry. */
  maxLinks: 8,
  /** `MAX_LINK_LABEL_BYTES`: one line of UI. */
  labelBytes: 120,
  /**
   * `MAX_LINK_ID_BYTES`: **one id**, not one target. A `record` or `zoneTab`
   * target is two halves joined by a `/`, so the whole string can be 129
   * bytes while each half is still inside this.
   */
  idBytes: 64,
  /** `MAX_LINK_HOSTNAME_BYTES`: the DNS name ceiling. */
  hostnameBytes: 253,
  /** `MAX_LINK_URL_BYTES`: an `external` target. */
  urlBytes: 2048,
} as const;

/**
 * A link that has survived the closed-set check, carrying no free text at
 * all: every field is either a value from a list the app owns, an id whose
 * charset cannot express structure, or a URL the validated opener produced.
 */
export type ResolvedAiLink =
  | { kind: "zone"; zoneId: string }
  | { kind: "record"; zoneId: string; recordId: string }
  | { kind: "zoneTab"; zoneId: string; tab: AiZoneTabTarget }
  | { kind: "domainRegistry"; domain: string }
  | { kind: "workspace"; workspace: AiWorkspaceTarget }
  | { kind: "external"; url: string };

/** The host's navigation, plus the one list a zone link is checked against. */
export interface AiLinkNavigation {
  /**
   * Zone ids the signed-in account has. A `zone` link naming anything else
   * resolves to nothing and renders no control — so an empty list disables the
   * kind, which is the correct behaviour before the zone list has loaded.
   */
  knownZoneIds: readonly string[];
  openZone: (zoneId: string) => void;
  /** Show one record, in a zone this account has. */
  revealRecord: (zoneId: string, recordId: string) => void;
  /** Open a zone on one of its tabs. */
  openZoneTab: (zoneId: string, tab: AiZoneTabTarget) => void;
  openDomainRegistry: (domain: string) => void;
  openWorkspace: (workspace: AiWorkspaceTarget) => void;
}

/**
 * An opaque in-app id: letters, digits, hyphen and underscore only.
 *
 * Rust's `validate_id_target` charset. With no `.`, `\`, `:`, `%`, `?`, `#`,
 * whitespace, control byte or non-ASCII character admitted, the result cannot
 * express a traversal, a scheme, a query or an escape — which is why `..`
 * needs no separate check. `/` is excluded here too: a `record` target carries
 * two of these joined by one, and each half is tested against this on its own.
 */
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * A hostname, by grammar: labels of letters, digits and hyphens separated by
 * single dots, at least two labels, no leading or trailing hyphen.
 *
 * Strict on purpose. It rejects `../`, a bare `.`, an embedded `/`, a scheme,
 * a port, and anything carrying whitespace or a control character, so the
 * value handed to the registry workspace can only be a domain name.
 */
const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** UTF-8 byte length, because every Rust ceiling counts bytes. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isWorkspaceTarget(value: string): value is AiWorkspaceTarget {
  return (AI_WORKSPACE_TARGETS as readonly string[]).includes(value);
}

/**
 * Decide what a link means, or `null` when it means nothing this app will do.
 *
 * `null` is the common, expected answer for a target that does not check out,
 * and the caller's job is to render no control for it — not to fall back to
 * showing the raw target as text, which would still be an invitation to go
 * where the app has refused to take anybody.
 */
export function resolveAiLink(
  link: AiLink,
  navigation: Pick<AiLinkNavigation, "knownZoneIds">,
): ResolvedAiLink | null {
  const target = typeof link.target === "string" ? link.target : "";
  if (target.length === 0) return null;
  // A label is one line of UI and the model wrote it. An over-long one is
  // refused rather than truncated, because the backend would never have
  // stored it and silently shortening it would hide that.
  if (
    typeof link.label !== "string" ||
    utf8ByteLength(link.label) > AI_LINK_LIMITS.labelBytes
  ) {
    return null;
  }

  switch (link.kind) {
    case "zone": {
      if (!isOpaqueId(target)) return null;
      return navigation.knownZoneIds.includes(target)
        ? { kind: "zone", zoneId: target }
        : null;
    }
    case "record": {
      const pair = splitZonePair(target, navigation.knownZoneIds);
      if (pair === null || !isOpaqueId(pair.second)) return null;
      return { kind: "record", zoneId: pair.zoneId, recordId: pair.second };
    }
    case "zoneTab": {
      const pair = splitZonePair(target, navigation.knownZoneIds);
      if (pair === null || !isZoneTabTarget(pair.second)) return null;
      return { kind: "zoneTab", zoneId: pair.zoneId, tab: pair.second };
    }
    case "domainRegistry": {
      if (utf8ByteLength(target) > AI_LINK_LIMITS.hostnameBytes) return null;
      const domain = target.trim().replace(/\.+$/, "").toLowerCase();
      return HOSTNAME_PATTERN.test(domain)
        ? { kind: "domainRegistry", domain }
        : null;
    }
    case "workspace": {
      return isWorkspaceTarget(target)
        ? { kind: "workspace", workspace: target }
        : null;
    }
    case "external": {
      if (utf8ByteLength(target) > AI_LINK_LIMITS.urlBytes) return null;
      const url = normalizeExternalHttpsUrl(target);
      return url === null ? null : { kind: "external", url };
    }
    default:
      // A kind this build does not know. Rendering it as *something* would
      // mean guessing which navigation it wanted.
      return null;
  }
}

function isOpaqueId(target: string): boolean {
  return (
    target.length <= AI_LINK_LIMITS.idBytes && OPAQUE_ID_PATTERN.test(target)
  );
}

function isZoneTabTarget(value: string): value is AiZoneTabTarget {
  return (AI_ZONE_TAB_TARGETS as readonly string[]).includes(value);
}

/**
 * Split a `"<zoneId>/<second>"` target, or `null`.
 *
 * `/` is the one structural byte the id charset admits and only in this one
 * position, so the split must yield **exactly two** non-empty halves:
 * `"zone/.."`, `"../record"`, `"zone//record"`, `"zone/record/extra"`,
 * `"zone/"` and a bare id all fail here rather than having a tail silently
 * dropped. The zone half gets the same closed-set check a `zone` link gets —
 * which the backend cannot make, because it validates the id's shape and not
 * whose zone it is.
 *
 * The `second` half is returned unchecked: `record` and `zoneTab` hold it to
 * different rules, a charset and a closed set respectively.
 */
function splitZonePair(
  target: string,
  knownZoneIds: readonly string[],
): { zoneId: string; second: string } | null {
  const parts = target.split("/");
  if (parts.length !== 2) return null;
  const [zoneId, second] = parts;
  if (!isOpaqueId(zoneId) || second.length === 0) return null;
  if (!knownZoneIds.includes(zoneId)) return null;
  return { zoneId, second };
}

/**
 * The external rule, as its own function so it can be pinned on its own:
 * everything `normalizeExternalHttpUrl` enforces — absolute, a host, no
 * credentials, no whitespace or control characters — and then `https:` only,
 * tested against the raw candidate so no normalisation can produce a pass.
 */
export function normalizeExternalHttpsUrl(candidate: string): string | null {
  if (!candidate.startsWith("https://")) return null;
  const url = normalizeExternalHttpUrl(candidate);
  if (url === null) return null;
  return url.startsWith("https://") ? url : null;
}

/**
 * Perform an in-app navigation.
 *
 * `external` is **not** handled here: it is opened by the control itself
 * through `openExternalUrl`, because the desktop build has to route the URL
 * through the Tauri shell and that opener is the only thing that knows how.
 * Returning `false` for it keeps that explicit rather than implied.
 */
export function followAiLink(
  resolved: ResolvedAiLink,
  navigation: AiLinkNavigation,
): boolean {
  switch (resolved.kind) {
    case "zone":
      navigation.openZone(resolved.zoneId);
      return true;
    case "record":
      navigation.revealRecord(resolved.zoneId, resolved.recordId);
      return true;
    case "zoneTab":
      navigation.openZoneTab(resolved.zoneId, resolved.tab);
      return true;
    case "domainRegistry":
      navigation.openDomainRegistry(resolved.domain);
      return true;
    case "workspace":
      navigation.openWorkspace(resolved.workspace);
      return true;
    case "external":
      return false;
  }
}

/** Display text for a link, falling back to the destination it resolved to. */
export function aiLinkLabel(link: AiLink, resolved: ResolvedAiLink): string {
  const label = typeof link.label === "string" ? link.label.trim() : "";
  if (label.length > 0) return label;
  switch (resolved.kind) {
    case "zone":
      return resolved.zoneId;
    case "record":
      return resolved.recordId;
    case "zoneTab":
      return resolved.tab;
    case "domainRegistry":
      return resolved.domain;
    case "workspace":
      return resolved.workspace;
    case "external":
      return resolved.url;
  }
}
