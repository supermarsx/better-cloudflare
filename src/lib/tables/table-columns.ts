/**
 * Per-table column visibility model.
 *
 * Every table that offers a "columns" picker registers a {@link TableColumnGroup}
 * here. The registry is the single source of truth for:
 *
 * - which columns exist, in canonical render order;
 * - which columns are locked on (identity columns that would make the table
 *   useless if hidden);
 * - the default visible set used both for fresh installs and for persisted
 *   preferences saved before this feature existed;
 * - the CSS grid template each visible subset resolves to.
 *
 * Persistence is intentionally dumb: a `Record<tableId, columnId[]>` map. Any
 * unknown table id or column id is dropped on read, so the shape stays forward
 * and backward compatible.
 */

/** Column ids rendered by the DNS records table. */
export type DnsRecordColumnId =
  | "select"
  | "type"
  | "name"
  | "content"
  | "comment"
  | "tags"
  | "ttl"
  | "proxied"
  | "actions";

/** A single toggleable column. */
export interface TableColumnDefinition {
  /** Stable persisted id. */
  id: string;
  /** English label; render through `t(label, label)`. */
  label: string;
  /** Short English hint shown under the label in Settings. */
  description?: string;
  /** Locked columns can never be hidden. */
  required?: boolean;
  /** Track size used when building the CSS grid template. */
  width: string;
}

/** A table that exposes a column picker. */
export interface TableColumnGroup {
  /** Stable persisted table id. */
  id: string;
  /** English table label; render through `t(label, label)`. */
  label: string;
  /** English blurb describing where the table lives. */
  description: string;
  /** All columns, in canonical render order. */
  columns: readonly TableColumnDefinition[];
  /** Visible-by-default column ids. */
  defaults: readonly string[];
}

const DNS_RECORDS_COLUMNS: readonly TableColumnDefinition[] = [
  {
    id: "select",
    label: "Selection",
    description: "Bulk-selection checkbox.",
    width: "24px",
  },
  { id: "type", label: "Type", required: true, width: "56px" },
  {
    id: "name",
    label: "Name",
    required: true,
    width: "minmax(140px, 1.4fr)",
  },
  {
    id: "content",
    label: "Content",
    required: true,
    width: "minmax(180px, 2fr)",
  },
  {
    id: "comment",
    label: "Comment",
    description: "The record note stored in Cloudflare.",
    width: "minmax(150px, 1.5fr)",
  },
  {
    id: "tags",
    label: "Tags",
    description: "Local tags applied to the record.",
    width: "minmax(110px, 1fr)",
  },
  { id: "ttl", label: "TTL", width: "92px" },
  { id: "proxied", label: "Proxy", width: "78px" },
  {
    id: "actions",
    label: "Actions",
    description: "Row action menu. Right-click a row for the same actions.",
    width: "92px",
  },
];

const ZONE_COMPARE_COLUMNS: readonly TableColumnDefinition[] = [
  {
    id: "status",
    label: "Status",
    required: true,
    width: "minmax(96px, auto)",
  },
  { id: "type", label: "Type", required: true, width: "64px" },
  {
    id: "name",
    label: "Name",
    required: true,
    width: "minmax(140px, 1.4fr)",
  },
  { id: "content", label: "Content", width: "minmax(160px, 2fr)" },
  { id: "ttl", label: "TTL", width: "minmax(96px, 1fr)" },
  { id: "proxied", label: "Proxy", width: "minmax(80px, 0.8fr)" },
];

const AUDIT_LOG_COLUMNS: readonly TableColumnDefinition[] = [
  { id: "timestamp", label: "Timestamp", required: true, width: "220px" },
  { id: "operation", label: "Operation", required: true, width: "160px" },
  { id: "resource", label: "Resource", width: "minmax(160px, 1fr)" },
  {
    id: "details",
    label: "Details",
    description: "Expander that reveals the raw entry.",
    width: "80px",
  },
];

/** Every table that participates in the Settings → Columns picker. */
export const TABLE_COLUMN_GROUPS: readonly TableColumnGroup[] = [
  {
    id: "dnsRecords",
    label: "DNS records",
    description: "The record list inside each zone workspace.",
    columns: DNS_RECORDS_COLUMNS,
    // Notes replace the action column by default; right-click a row for actions.
    defaults: [
      "select",
      "type",
      "name",
      "content",
      "comment",
      "ttl",
      "proxied",
    ],
  },
  {
    id: "zoneCompare",
    label: "Zone compare",
    description: "The side-by-side zone difference table.",
    columns: ZONE_COMPARE_COLUMNS,
    defaults: ["status", "type", "name", "content", "ttl", "proxied"],
  },
  {
    id: "auditLog",
    label: "Audit log",
    description: "The desktop audit entry table.",
    columns: AUDIT_LOG_COLUMNS,
    defaults: ["timestamp", "operation", "resource", "details"],
  },
];

const GROUPS_BY_ID = new Map(TABLE_COLUMN_GROUPS.map((g) => [g.id, g]));

/** Look up a registered table, or `undefined` when the id is unknown. */
export function getTableColumnGroup(
  tableId: string,
): TableColumnGroup | undefined {
  return GROUPS_BY_ID.get(tableId);
}

/** Column ids that can never be hidden for `tableId`. */
export function getRequiredTableColumns(tableId: string): string[] {
  const group = GROUPS_BY_ID.get(tableId);
  if (!group) return [];
  return group.columns.filter((c) => c.required).map((c) => c.id);
}

/** The default visible column ids for `tableId`. */
export function getDefaultTableColumns(tableId: string): string[] {
  return [...(GROUPS_BY_ID.get(tableId)?.defaults ?? [])];
}

/**
 * Normalize a persisted column list into a renderable one.
 *
 * Guarantees, in order of precedence:
 * 1. an unknown table always resolves to an empty list;
 * 2. `undefined`/`null` (preferences saved before this feature) resolves to the
 *    table defaults — never to an empty table;
 * 3. unknown column ids are dropped;
 * 4. required columns are always present;
 * 5. an otherwise-empty result falls back to the defaults, so the table can
 *    never be hidden into uselessness;
 * 6. the result is deduplicated and ordered by the canonical column order.
 */
export function resolveTableColumns(
  tableId: string,
  stored?: readonly string[] | null,
): string[] {
  const group = GROUPS_BY_ID.get(tableId);
  if (!group) return [];

  const order = group.columns.map((c) => c.id);
  if (!Array.isArray(stored)) return [...group.defaults];

  const known = new Set(order);
  const wanted = new Set(
    stored.filter(
      (value): value is string => typeof value === "string" && known.has(value),
    ),
  );
  // Decide the fallback *before* forcing required columns back in, so a stored
  // list that is empty or entirely unrecognized restores the defaults rather
  // than collapsing the table to its identity columns.
  if (wanted.size === 0) return [...group.defaults];

  for (const required of group.columns) {
    if (required.required) wanted.add(required.id);
  }
  return order.filter((id) => wanted.has(id));
}

/**
 * Normalize a whole persisted `{ tableId: columnIds }` map. Every registered
 * table gets an entry, so callers never have to handle `undefined`.
 */
export function normalizeTableColumnMap(
  stored?: Readonly<Record<string, readonly string[] | undefined>> | null,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const group of TABLE_COLUMN_GROUPS) {
    next[group.id] = resolveTableColumns(group.id, stored?.[group.id]);
  }
  return next;
}

/**
 * Whether `columnId` may be hidden given the currently visible set. Required
 * columns are locked, and the final visible column can never be removed.
 */
export function canHideTableColumn(
  tableId: string,
  visible: readonly string[],
  columnId: string,
): boolean {
  const group = GROUPS_BY_ID.get(tableId);
  if (!group) return false;
  const definition = group.columns.find((c) => c.id === columnId);
  if (!definition || definition.required) return false;
  if (!visible.includes(columnId)) return false;
  return visible.length > 1;
}

/**
 * Toggle a single column, honoring the locked-column and last-column guards.
 * Returns the previous list unchanged when the toggle is not allowed.
 */
export function toggleTableColumn(
  tableId: string,
  visible: readonly string[],
  columnId: string,
  nextVisible: boolean,
): string[] {
  const group = GROUPS_BY_ID.get(tableId);
  if (!group) return [...visible];
  if (!group.columns.some((c) => c.id === columnId)) return [...visible];

  if (nextVisible) {
    if (visible.includes(columnId)) return [...visible];
    return resolveTableColumns(tableId, [...visible, columnId]);
  }
  if (!canHideTableColumn(tableId, visible, columnId)) return [...visible];
  return resolveTableColumns(
    tableId,
    visible.filter((id) => id !== columnId),
  );
}

/** CSS `grid-template-columns` for the given visible subset. */
export function buildGridTemplateColumns(
  tableId: string,
  visible: readonly string[],
): string {
  const group = GROUPS_BY_ID.get(tableId);
  if (!group) return "";
  const byId = new Map(group.columns.map((c) => [c.id, c]));
  return visible
    .map((id) => byId.get(id)?.width)
    .filter((width): width is string => Boolean(width))
    .join(" ");
}
