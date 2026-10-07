/**
 * The searchable index of Session settings.
 *
 * Settings live in ten subtabs of one 13,000-line component, and a user who
 * wants one has to know which subtab holds it. This module is the index a
 * search box reads: one entry per setting, with the subtab that owns it and
 * enough text to find it by.
 *
 * ## Why a hand-written list is safe here
 *
 * A registry that merely *claims* to list every setting rots the first time
 * somebody adds a row and forgets it — search then silently cannot find the new
 * setting. So the claim is checked rather than trusted:
 * `test/settingsSearch.registry.test.ts` parses `DNSManager.tsx` with the
 * TypeScript compiler, finds every settings row in it, and fails unless the
 * rows and the `anchor.kind === "row"` entries here are the same set, with the
 * same labels, in the same subtabs, with the same platform and precondition
 * gates. Nothing below is taken on faith except the `keywords`.
 *
 * The subtabs whose contents are not rows of this shape are handled by
 * construction instead: the Columns entries are generated from
 * {@link TABLE_COLUMN_GROUPS}, and the Assistant and Notifications entries are
 * checked against `AI_SETTINGS_SECTIONS` and
 * `NOTIFICATION_SETTINGS_SECTIONS` by the same test. Both of those subtabs
 * re-host a panel whose rows live in their own files, so a *section* is the
 * finest thing the index can name and the finest thing a jump can land on;
 * checking the sections against the panel's own list is what stops a renamed
 * section leaving search matching a word nobody can see.
 *
 * About and Diagnostics index their settings rows, and only those. Their
 * informational content — build facts, dependency lists, a collected report —
 * lives in child components and is not a setting, so it is not indexed.
 *
 * ## Labels are stored in English, and matched in both languages
 *
 * `label` is the English string the component passes to `t(label, label)` —
 * that string *is* the i18n key, which is what lets the test compare the two
 * character for character. Search then matches against both the translated
 * label (what the user is looking at) and the English one (what the key says),
 * so a French UI finds "Auto refresh" by either "actualisation" or "refresh".
 * Storing the translation instead would be impossible — it is not known until
 * runtime — and storing only the English would make search useless in every
 * other locale.
 */
import {
  TABLE_COLUMN_GROUPS,
  type TableColumnGroup,
} from "@/lib/tables/table-columns";

/** The Session settings subtabs, in nav order. */
export type SettingsSubtab =
  | "general"
  | "columns"
  | "topology"
  | "audit"
  | "notifications"
  | "mcp"
  | "assistant"
  | "profiles"
  | "about"
  | "diagnostics";

/** One subtab of the Session settings screen. */
export interface SettingsSubtabDescriptor {
  id: SettingsSubtab;
  /** English label; render through `t(label, label)`. */
  label: string;
  /** The nav button, and every setting under it, exist only on desktop. */
  desktopOnly?: true;
}

/**
 * The subtab nav, as data.
 *
 * The settings nav renders from this and so does the search breadcrumb, so the
 * two cannot drift into calling the same subtab different things.
 */
export const SETTINGS_SUBTABS: readonly SettingsSubtabDescriptor[] = [
  { id: "general", label: "General" },
  { id: "columns", label: "Columns" },
  { id: "topology", label: "Topology" },
  { id: "audit", label: "Audit" },
  // Desktop only, like the Notifications tab itself: the settings are read and
  // written by `notifications_get_settings` / `notifications_update_settings`,
  // and the web build has no host to ask.
  { id: "notifications", label: "Notifications", desktopOnly: true },
  { id: "mcp", label: "MCP" },
  { id: "assistant", label: "Assistant", desktopOnly: true },
  { id: "profiles", label: "Profiles" },
  // Last two, and in this order: both answer "what am I running" rather than
  // "how should it behave", and a diagnostics report is the more niche of the
  // two.
  { id: "about", label: "About" },
  { id: "diagnostics", label: "Diagnostics" },
];

const SUBTAB_LABELS = new Map(SETTINGS_SUBTABS.map((s) => [s.id, s.label]));

/** English label for a subtab; render through `t(label, label)`. */
export function settingsSubtabLabel(subtab: SettingsSubtab): string {
  return SUBTAB_LABELS.get(subtab) ?? subtab;
}

/**
 * How to find an entry's control in the DOM once its subtab is open.
 *
 * `row` is the common case and the only kind the source-derived test can
 * police, because it is the only kind backed by a `data-setting-id` on a
 * settings row.
 */
export type SettingsAnchor =
  | { readonly kind: "row" }
  | {
      readonly kind: "columnToggle";
      readonly table: string;
      readonly column: string;
    }
  | { readonly kind: "assistantSection"; readonly section: string }
  | { readonly kind: "notificationsSection"; readonly section: string }
  | { readonly kind: "subtab" };

/** One searchable setting. */
export interface SettingsSearchEntry {
  /**
   * Stable id. For `anchor.kind === "row"` this is also the row's
   * `data-setting-id` attribute, which is how a jump finds it.
   */
  id: string;
  subtab: SettingsSubtab;
  /** English label, verbatim from the row's own `t(label, label)` call. */
  label: string;
  /** A breadcrumb level between the subtab and the label, when one exists. */
  group?: string;
  /**
   * English hint. Where a row shows one, this is that same string, so the
   * search result reads like the row it leads to — and so `t()` finds the same
   * translation the row does.
   */
  description?: string;
  /** Words a user may plausibly type that the label and hint do not contain. */
  keywords?: readonly string[];
  /** Desktop builds only; hidden from search everywhere else. */
  desktopOnly?: true;
  /**
   * Why the row can be absent even with its subtab open, in English. Shown
   * when a jump lands on a subtab whose row is not currently rendered.
   */
  requires?: string;
  anchor: SettingsAnchor;
}

/** Settings rendered as rows of the shared settings-row shape. */
const ROW_ENTRIES: readonly SettingsSearchEntry[] = [
  // --- General ---------------------------------------------------------
  {
    id: "rewrite-copied-record-domains",
    subtab: "general",
    label: "Rewrite copied record domains",
    description:
      "Replace source-zone domain suffixes with the destination zone when pasting records.",
    keywords: ["paste", "clipboard", "suffix", "copy"],
    anchor: { kind: "row" },
  },
  {
    id: "preview-pasted-records",
    subtab: "general",
    label: "Preview pasted records",
    description:
      "Confirm rewritten names and content before a paste that changed a record, or that creates more than two.",
    keywords: ["paste", "clipboard", "confirm"],
    anchor: { kind: "row" },
  },
  {
    id: "auto-refresh",
    subtab: "general",
    label: "Auto refresh",
    description: "Pauses while editing records or dialogs are open.",
    keywords: ["reload", "poll", "interval"],
    anchor: { kind: "row" },
  },
  {
    id: "default-per-page",
    subtab: "general",
    label: "Default per-page",
    description: "New zone tabs inherit this value unless overridden.",
    keywords: ["pagination", "page size", "rows"],
    anchor: { kind: "row" },
  },
  {
    id: "loader-timeout",
    subtab: "general",
    label: "Loader timeout",
    description: "Max 60s. Loading overlay auto-hides after timeout.",
    keywords: ["spinner", "overlay", "loading"],
    anchor: { kind: "row" },
  },
  {
    id: "unsupported-record-types",
    subtab: "general",
    label: "Unsupported record types",
    description: "Controls the Type dropdown default. Zones can override this.",
    keywords: ["add record", "type", "rfc"],
    anchor: { kind: "row" },
  },
  {
    id: "reopen-last-tabs",
    subtab: "general",
    label: "Reopen last tabs",
    description: "Restore tabs from the last session on launch.",
    keywords: ["restore", "startup", "launch", "session"],
    anchor: { kind: "row" },
  },
  {
    id: "middle-click-closes-tabs",
    subtab: "general",
    label: "Middle-click closes tabs",
    description:
      "Controls whether pressing the mouse wheel on a tab closes it.",
    keywords: ["mouse", "wheel", "tab"],
    anchor: { kind: "row" },
  },
  {
    id: "assistant-placement",
    subtab: "general",
    label: "Assistant placement",
    keywords: ["ai", "chat", "panel", "sidebar", "tab"],
    anchor: { kind: "row" },
  },
  {
    id: "confirm-logout",
    subtab: "general",
    label: "Confirm logout",
    description: "Show a confirmation dialog when logging out.",
    keywords: ["sign out", "dialog"],
    anchor: { kind: "row" },
  },
  {
    id: "confirm-window-close",
    subtab: "general",
    label: "Confirm window close",
    description: "Show a confirmation dialog when closing the app window.",
    keywords: ["quit", "exit", "dialog"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "auto-logout-idle",
    subtab: "general",
    label: "Auto logout (idle)",
    description: "Logs out automatically after inactivity.",
    keywords: ["sign out", "inactivity", "timeout", "lock"],
    anchor: { kind: "row" },
  },

  // --- General › Recycle bin -------------------------------------------
  //
  // Desktop only, and not because the preferences are: the retained records
  // live in the OS keyring, written by `bc_storage::retention` through Tauri
  // commands, so on the web these four would configure a bin that does not
  // exist.
  {
    id: "recycle-bin-enabled",
    subtab: "general",
    group: "Recycle bin",
    label: "Recycle bin",
    description:
      "Deleting a record keeps a restorable copy. Off makes a deletion immediate and final.",
    keywords: ["trash", "undo", "restore", "deleted", "retention", "bin"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "recycle-bin-retention-days",
    subtab: "general",
    group: "Recycle bin",
    label: "Keep deletions for",
    description:
      "Applies to deletions made from now on. Entries already in the bin keep the expiry date they were given.",
    keywords: ["trash", "days", "expiry", "retention", "bin", "restore"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "recycle-bin-max-entries",
    subtab: "general",
    group: "Recycle bin",
    label: "Bin size",
    description:
      "Entries the bin holds before it gives up its oldest to make room.",
    keywords: ["trash", "limit", "entries", "bin", "eviction", "oldest"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "recycle-bin-auto-purge",
    subtab: "general",
    group: "Recycle bin",
    label: "Sweep expired entries",
    description:
      "Off does not keep an expired entry restorable — a restore past the expiry is refused either way. It only stops the sweep happening unasked.",
    keywords: ["trash", "purge", "expired", "bin", "clean"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  // The only row in the group that is not a rule: it opens what retention has
  // already kept. Worth indexing under the words for the things a user comes
  // looking for — "restore", "undelete", "disabled record" — because this is
  // the one screen where a record that exists nowhere else can be put back.
  {
    id: "recycle-bin-contents",
    subtab: "general",
    group: "Recycle bin",
    label: "Recycle bin contents",
    description:
      "Restore a deleted record, re-enable a disabled one, or forget an entry for good. Nothing listed there exists anywhere else.",
    keywords: [
      "trash",
      "restore",
      "undelete",
      "undo",
      "recover",
      "disabled",
      "re-enable",
      "enable",
      "forget",
      "empty",
      "bin",
    ],
    desktopOnly: true,
    anchor: { kind: "row" },
  },

  // --- Topology --------------------------------------------------------
  {
    id: "topology-resolution-hops",
    subtab: "topology",
    label: "Topology resolution hops",
    description: "Max recursive hostname resolution depth for topology (1-15).",
    keywords: ["cname", "chain", "depth", "recursion"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-request-mode",
    subtab: "topology",
    label: "Topology request mode",
    description: "Choose whether topology resolves via normal DNS or DoH.",
    keywords: ["doh", "https", "udp", "tcp", "resolver"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-dns-server",
    subtab: "topology",
    label: "DNS server",
    description: "Common resolvers list. Default is 1.1.1.1.",
    keywords: ["resolver", "nameserver", "cloudflare", "google", "quad9"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-custom-dns-server",
    subtab: "topology",
    label: "Custom DNS server",
    description: "IP address used when DNS server is set to Custom.",
    keywords: ["resolver", "ip"],
    requires: "DNS server is set to Custom",
    anchor: { kind: "row" },
  },
  {
    id: "topology-custom-doh-endpoint",
    subtab: "topology",
    label: "Custom DoH endpoint",
    description: "Optional override for DoH mode.",
    keywords: ["doh", "https", "url", "resolver"],
    requires: "Topology request mode is set to DNS-over-HTTPS (DoH)",
    anchor: { kind: "row" },
  },
  {
    id: "topology-lookup-timeout",
    subtab: "topology",
    label: "Lookup timeout",
    description: "Per DNS/DoH lookup timeout for topology chain resolution.",
    keywords: ["timeout", "latency", "slow"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-disable-ptr-lookups",
    subtab: "topology",
    label: "Disable end-node PTR lookups",
    description: "Skip reverse DNS lookups to speed up topology loading.",
    keywords: ["reverse", "ptr", "rdns", "speed"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-skip-resolution-chain",
    subtab: "topology",
    label: "Don't scan resolution chain",
    description: "Faster lookups, but omits intermediate chain hops.",
    keywords: ["cname", "chain", "hops", "speed"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-disable-geo",
    subtab: "topology",
    label: "Disable GEO detection",
    description: "Turns off country enrichment for resolved IP nodes.",
    keywords: ["geoip", "country", "location", "privacy"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-geo-provider",
    subtab: "topology",
    label: "GEO lookup service",
    description:
      "Chooses GEO source; Auto tries multiple services and falls back.",
    keywords: ["geoip", "provider", "ipwhois", "ipapi", "country"],
    requires: "GEO detection is enabled",
    anchor: { kind: "row" },
  },
  {
    id: "topology-disable-service-discovery",
    subtab: "topology",
    label: "Disable service discovery",
    description: "Disables manual service probing in topology tab.",
    keywords: ["probe", "port", "scan"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-tcp-services",
    subtab: "topology",
    label: "TCP services to probe",
    description: "Multi-select common TCP services for simple discovery.",
    keywords: ["port", "probe", "scan", "http", "ssh"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-disable-annotations",
    subtab: "topology",
    label: "Disable annotations",
    description: "Hides annotation tools in topology view.",
    keywords: ["notes", "markup", "draw"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-disable-full-window",
    subtab: "topology",
    label: "Disable full window",
    description: "Hides full-window graph action in topology controls.",
    keywords: ["fullscreen", "maximise", "maximize", "graph"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-export-confirm-path",
    subtab: "topology",
    label: "Confirm path to export",
    description: "Applies to topology code/SVG/PNG export actions.",
    keywords: ["save", "destination", "folder", "dialog"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "topology-export-path",
    subtab: "topology",
    label: "Topology export path",
    description: "Default export location for topology assets.",
    keywords: ["save", "folder", "downloads", "documents"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "topology-export-custom-path",
    subtab: "topology",
    label: "Custom export path",
    keywords: ["save", "folder", "directory"],
    desktopOnly: true,
    requires: "Topology export path is set to Custom path",
    anchor: { kind: "row" },
  },
  {
    id: "topology-copy-actions",
    subtab: "topology",
    label: "Copy actions",
    description: "Controls which actions appear in topology Copy menu.",
    keywords: ["clipboard", "mermaid", "svg", "png", "menu"],
    anchor: { kind: "row" },
  },
  {
    id: "topology-export-actions",
    subtab: "topology",
    label: "Export actions",
    description: "Controls which actions appear in topology Export menu.",
    keywords: ["mermaid", "svg", "png", "pdf", "menu"],
    anchor: { kind: "row" },
  },

  // --- Audit -----------------------------------------------------------
  {
    id: "audit-categories",
    subtab: "audit",
    label: "Audit categories",
    keywords: ["email", "security", "hygiene", "checks", "domain audit"],
    anchor: { kind: "row" },
  },
  {
    id: "audit-export-folder-preset",
    subtab: "audit",
    label: "Export folder preset",
    description: "Choose the default start folder for audit exports.",
    keywords: ["save", "folder", "downloads", "documents", "csv"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "audit-export-skip-destination-confirm",
    subtab: "audit",
    label: "Don't confirm destination",
    description: "Enabled by default.",
    keywords: ["save", "dialog", "destination", "export"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "audit-export-custom-path",
    subtab: "audit",
    label: "Custom export path",
    keywords: ["save", "folder", "directory"],
    desktopOnly: true,
    requires: "Export folder preset is set to Custom path",
    anchor: { kind: "row" },
  },
  {
    id: "audit-confirm-clear-logs",
    subtab: "audit",
    label: "Confirm clear audit logs",
    description: "Ask before deleting all audit entries.",
    keywords: ["delete", "purge", "dialog"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },

  // --- MCP -------------------------------------------------------------
  {
    id: "mcp-server-status",
    subtab: "mcp",
    label: "Server status",
    keywords: ["mcp", "running", "stopped", "url", "refresh"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "mcp-server-enabled",
    subtab: "mcp",
    label: "Enable MCP server",
    description:
      "Server is off by default. Enable to accept local MCP clients.",
    keywords: ["mcp", "start", "stop", "model context protocol"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "mcp-bind-host",
    subtab: "mcp",
    label: "Bind host",
    keywords: ["mcp", "port", "127.0.0.1", "listen", "address"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "mcp-tool-access",
    subtab: "mcp",
    label: "Tool access",
    keywords: ["mcp", "permissions", "tools", "allow"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },

  // --- About › Update checking -----------------------------------------
  //
  // These sit with About rather than in General because the question they
  // answer is "is the build I am running the current one", and the build this
  // is running is the thing About names. Desktop only: the check is an
  // `update_check` command, so a browser build has nothing to ask.
  {
    id: "update-check-status",
    subtab: "about",
    group: "Updates",
    label: "Update status",
    keywords: [
      "update",
      "upgrade",
      "release",
      "version",
      "github",
      "check now",
      "newer",
    ],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "update-check-enabled",
    subtab: "about",
    group: "Updates",
    label: "Check for updates",
    description:
      "Asks GitHub's public releases list whether a newer release exists. Nothing is downloaded and nothing is replaced.",
    keywords: ["update", "upgrade", "release", "github", "notify", "offline"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "update-check-interval",
    subtab: "about",
    group: "Updates",
    label: "Hours between checks",
    description: "From 1 hour to 168 (one week).",
    keywords: ["update", "interval", "frequency", "hours", "how often"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },
  {
    id: "update-check-prereleases",
    subtab: "about",
    group: "Updates",
    label: "Include pre-releases",
    description:
      "Off by default: stable releases only. On, a pre-release counts as newer.",
    keywords: ["update", "beta", "prerelease", "pre-release", "rc", "unstable"],
    desktopOnly: true,
    anchor: { kind: "row" },
  },

  // --- Diagnostics -----------------------------------------------------
  {
    id: "diagnostics-include-zone-names",
    subtab: "diagnostics",
    label: "Include zone names",
    description:
      "Off, the report counts your zones. On, it names them — and a report exists to be pasted somewhere public.",
    keywords: [
      "diagnostics",
      "privacy",
      "zone names",
      "domains",
      "user data",
      "redact",
    ],
    anchor: { kind: "row" },
  },
  {
    id: "diagnostics-report",
    subtab: "diagnostics",
    label: "Diagnostics report",
    description:
      "Build, platform, services and counts, for pasting into a bug report. No credentials, and no record names or contents at any setting.",
    keywords: [
      "diagnostics",
      "bug report",
      "issue",
      "support",
      "copy",
      "markdown",
      "json",
      "troubleshoot",
    ],
    anchor: { kind: "row" },
  },
];

/**
 * The Columns picker, generated from the table registry.
 *
 * Column toggles are not settings rows — they are checkboxes inside a fieldset
 * per table — so the row test cannot police them. Generating them from
 * {@link TABLE_COLUMN_GROUPS}, the same array the picker itself renders from,
 * removes the need: a new column appears in search the moment it exists.
 */
function columnEntries(
  groups: readonly TableColumnGroup[],
): SettingsSearchEntry[] {
  return groups.flatMap((group) =>
    group.columns.map((column) => ({
      id: `column-${group.id}-${column.id}`,
      subtab: "columns" as const,
      label: column.label,
      group: group.label,
      description: column.description ?? group.description,
      keywords: ["column", "table", "show", "hide"],
      anchor: {
        kind: "columnToggle" as const,
        table: group.id,
        column: column.id,
      },
    })),
  );
}

/**
 * Settings that are not rows of their own: the Assistant and Notifications
 * panels' sections, and the Profiles controls. All are checked by the registry
 * test against the strings their subtab actually renders — the two panels
 * against their own exported section lists — which catches a rename, but,
 * unlike the rows, not an addition.
 */
const ANCHORLESS_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    id: "assistant-providers",
    subtab: "assistant",
    label: "Providers",
    keywords: ["ai", "api key", "model", "anthropic", "openai", "endpoint"],
    desktopOnly: true,
    anchor: { kind: "assistantSection", section: "providers" },
  },
  {
    id: "assistant-behaviour",
    subtab: "assistant",
    label: "Behaviour",
    keywords: ["ai", "behavior", "temperature", "prompt", "mode"],
    desktopOnly: true,
    anchor: { kind: "assistantSection", section: "behaviour" },
  },
  {
    id: "assistant-tools",
    subtab: "assistant",
    label: "Tools & permissions",
    keywords: ["ai", "allow", "approval", "tool"],
    desktopOnly: true,
    anchor: { kind: "assistantSection", section: "tools" },
  },
  {
    id: "assistant-personas",
    subtab: "assistant",
    label: "Personas",
    keywords: ["ai", "persona", "system prompt", "role"],
    desktopOnly: true,
    anchor: { kind: "assistantSection", section: "personas" },
  },
  // The notification settings panel's six sections. Their rows live in the
  // `NotificationsSettings*.tsx` files, so the row test cannot police them;
  // the registry test checks these against
  // `NOTIFICATION_SETTINGS_SECTIONS` instead, which is how a renamed section
  // fails rather than leaving search matching a word nobody can see.
  {
    id: "notifications-service",
    subtab: "notifications",
    label: "Service",
    keywords: [
      "notifications",
      "monitoring",
      "poll",
      "interval",
      "pause",
      "resume",
      "check now",
      "backoff",
      "rdap cache",
    ],
    desktopOnly: true,
    anchor: { kind: "notificationsSection", section: "service" },
  },
  {
    id: "notifications-kinds",
    subtab: "notifications",
    label: "Kinds",
    keywords: [
      "notifications",
      "domain expiry",
      "record change",
      "audit finding",
      "severity",
      "os notify",
      "desktop notification",
    ],
    desktopOnly: true,
    anchor: { kind: "notificationsSection", section: "kinds" },
  },
  {
    id: "notifications-expiry",
    subtab: "notifications",
    label: "Expiry",
    keywords: [
      "notifications",
      "milestones",
      "days left",
      "renewal",
      "rdap",
      "registrar",
      "countdown",
      "stale",
      "warning",
      "critical",
    ],
    desktopOnly: true,
    anchor: { kind: "notificationsSection", section: "expiry" },
  },
  {
    id: "notifications-zones",
    subtab: "notifications",
    label: "Zones",
    keywords: [
      "notifications",
      "mute",
      "allowlist",
      "monitored",
      "per zone",
      "override",
    ],
    desktopOnly: true,
    anchor: { kind: "notificationsSection", section: "zones" },
  },
  {
    id: "notifications-delivery",
    subtab: "notifications",
    label: "Delivery",
    keywords: [
      "notifications",
      "quiet hours",
      "toast",
      "badge",
      "in app",
      "os",
      "sound",
      "silence",
    ],
    desktopOnly: true,
    anchor: { kind: "notificationsSection", section: "delivery" },
  },
  {
    id: "notifications-retention",
    subtab: "notifications",
    label: "Retention",
    keywords: [
      "notifications",
      "purge",
      "archive",
      "keep",
      "history",
      "inbox size",
    ],
    desktopOnly: true,
    anchor: { kind: "notificationsSection", section: "retention" },
  },
  {
    id: "profiles-export",
    subtab: "profiles",
    label: "Export settings",
    keywords: ["backup", "json", "download", "save"],
    anchor: { kind: "subtab" },
  },
  {
    id: "profiles-import",
    subtab: "profiles",
    label: "Import settings",
    keywords: ["restore", "json", "upload", "load"],
    anchor: { kind: "subtab" },
  },
  {
    id: "profiles-clone",
    subtab: "profiles",
    label: "Clone from session",
    keywords: ["copy", "session", "profile", "duplicate"],
    anchor: { kind: "subtab" },
  },
];

/** Every searchable setting, in subtab order. */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = (() => {
  const all = [
    ...ROW_ENTRIES,
    ...columnEntries(TABLE_COLUMN_GROUPS),
    ...ANCHORLESS_ENTRIES,
  ];
  const order = new Map(SETTINGS_SUBTABS.map((s, index) => [s.id, index]));
  return all.sort(
    (a, b) => (order.get(a.subtab) ?? 0) - (order.get(b.subtab) ?? 0),
  );
})();

const ENTRIES_BY_ID = new Map(SETTINGS_SEARCH_ENTRIES.map((e) => [e.id, e]));

/** Look up one entry, or `undefined` when the id is unknown. */
export function findSettingsEntry(id: string): SettingsSearchEntry | undefined {
  return ENTRIES_BY_ID.get(id);
}

/**
 * The CSS selector that finds an entry's control, or `null` for an entry whose
 * subtab is the whole target.
 */
export function settingsAnchorSelector(
  entry: SettingsSearchEntry,
): string | null {
  switch (entry.anchor.kind) {
    case "row":
      return `[data-setting-id="${entry.id}"]`;
    case "columnToggle":
      return `[data-testid="column-group-${entry.anchor.table}"] [data-column-id="${entry.anchor.column}"]`;
    case "assistantSection":
      return `[data-testid="assistant-settings-host"]`;
    case "notificationsSection":
      return `[data-testid="notifications-settings-host"]`;
    case "subtab":
      return null;
  }
}

/** `t(key, defaultValue)`, as `useI18n` hands it out. */
export type SettingsTranslate = (key: string, defaultValue: string) => string;

const IDENTITY_TRANSLATE: SettingsTranslate = (_key, defaultValue) =>
  defaultValue;

export interface SettingsSearchOptions {
  /** The component's own `t`. Defaults to returning the English default. */
  translate?: SettingsTranslate;
  /** Whether this is a desktop build. Desktop-only entries need it. */
  desktop?: boolean;
  /** Cap on returned results. Defaults to all of them. */
  limit?: number;
}

/** One hit, with the strings a result row should show. */
export interface SettingsSearchResult {
  entry: SettingsSearchEntry;
  /** The label as the user currently sees it. */
  label: string;
  /** "Topology", or "Columns › DNS records" where there is a group. */
  breadcrumb: string;
  /** The hint as the user currently sees it, when the entry has one. */
  description?: string;
  score: number;
}

/**
 * Fold a string into the form matching compares: lower case, unaccented, and
 * with every run of punctuation flattened to a single space.
 *
 * The flattening is what lets "per page" find "Default per-page" and "1.1.1.1"
 * find the resolver list, without the caller having to guess the separator the
 * label happens to use.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The query, folded and split into the tokens that must all match. */
export function settingsSearchTokens(query: string): string[] {
  const folded = fold(query);
  return folded.length === 0 ? [] : folded.split(" ");
}

/** A weighted piece of text an entry can be found by. */
interface Field {
  text: string;
  weight: number;
}

function entryFields(
  entry: SettingsSearchEntry,
  translate: SettingsTranslate,
): { fields: Field[]; label: string; breadcrumb: string; hint?: string } {
  const label = translate(entry.label, entry.label) || entry.label;
  const subtabLabel = settingsSubtabLabel(entry.subtab);
  const translatedSubtab = translate(subtabLabel, subtabLabel) || subtabLabel;
  const group = entry.group
    ? translate(entry.group, entry.group) || entry.group
    : undefined;
  const hint = entry.description
    ? translate(entry.description, entry.description) || entry.description
    : undefined;

  const fields: Field[] = [
    // Both languages: the label the user is reading, and the English key, so a
    // translated UI still answers to the English name of a setting.
    { text: label, weight: 8 },
    { text: entry.label, weight: 8 },
    { text: group ?? "", weight: 4 },
    { text: entry.group ?? "", weight: 4 },
    { text: translatedSubtab, weight: 3 },
    { text: subtabLabel, weight: 3 },
    { text: hint ?? "", weight: 2 },
    { text: entry.description ?? "", weight: 2 },
    { text: (entry.keywords ?? []).join(" "), weight: 2 },
  ];

  return {
    fields: fields.filter((field) => field.text.length > 0),
    label,
    breadcrumb: group ? `${translatedSubtab} › ${group}` : translatedSubtab,
    hint,
  };
}

/**
 * Settings matching `query`, best first.
 *
 * Every token must match something, so extra words narrow rather than widen.
 * An empty query matches nothing: the result list is a response to typing, not
 * a second copy of the settings screen.
 */
export function searchSettings(
  query: string,
  options: SettingsSearchOptions = {},
): SettingsSearchResult[] {
  const tokens = settingsSearchTokens(query);
  if (tokens.length === 0) return [];

  const translate = options.translate ?? IDENTITY_TRANSLATE;
  const desktop = options.desktop ?? false;
  const subtabOrder = new Map(SETTINGS_SUBTABS.map((s, i) => [s.id, i]));
  const results: SettingsSearchResult[] = [];

  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    if (entry.desktopOnly && !desktop) continue;

    const { fields, label, breadcrumb, hint } = entryFields(entry, translate);
    const folded = fields.map((field) => ({
      text: fold(field.text),
      weight: field.weight,
    }));

    let score = 0;
    let matchedEveryToken = true;
    for (const token of tokens) {
      let best = 0;
      for (const field of folded) {
        if (!field.text.includes(token)) continue;
        // A label the query starts off is a stronger hit than one it merely
        // appears inside, so "auto" ranks "Auto refresh" above "Disable
        // annotations"'s hint.
        const bonus = field.text.startsWith(token) ? 1 : 0;
        best = Math.max(best, field.weight + bonus);
      }
      if (best === 0) {
        matchedEveryToken = false;
        break;
      }
      score += best;
    }
    if (!matchedEveryToken) continue;

    results.push({
      entry,
      label,
      breadcrumb,
      ...(hint === undefined ? {} : { description: hint }),
      score,
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const order =
      (subtabOrder.get(a.entry.subtab) ?? 0) -
      (subtabOrder.get(b.entry.subtab) ?? 0);
    if (order !== 0) return order;
    return a.label.localeCompare(b.label);
  });

  return options.limit === undefined
    ? results
    : results.slice(0, options.limit);
}
