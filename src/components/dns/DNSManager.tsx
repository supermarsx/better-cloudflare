/**
 * Top-level DNS Manager UI which composes the zone selector, the record
 * list and dialogs for creating/importing records.
 */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Tag } from "@/components/ui/tag";
import { useCloudflareAPI } from "@/hooks/dns/use-cloudflare-api";
import type { DNSRecord, Zone, ZoneSetting, RecordType } from "@/types/dns";
import { RECORD_TYPES } from "@/types/dns";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import {
  storageManager,
  type SessionSettingsProfile,
} from "@/lib/storage/storage";
import {
  ArrowUpDown,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileDown,
  FileUp,
  Filter,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { isDesktop } from "@/lib/environment";
import {
  createPreferenceFailureReporter,
  TauriClient,
  type BulkDnsDeleteFailure,
  type EmailRoutingRuleResponse,
  type EmailRoutingSettingsResponse,
  type McpServerStatus,
  type UnlistenFn,
  type WorkerRouteResponse,
} from "@/lib/api/tauri-client";
import { AddRecordDialog } from "./AddRecordDialog";
import { ImportExportDialog } from "./ImportExportDialog";
import { RecordRow } from "./RecordRow";
import { SpecialIpAuditFindings } from "./SpecialIpAuditFindings";
import { NotificationsPanel } from "./NotificationsPanel";
import { AiAssistantPanel } from "@/components/ai/AiAssistantPanel";
import { toastAllowed } from "@/lib/notifications/notification-settings";
import { parseCSVRecords, parseBINDZone } from "@/lib/dns/dns-parsers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { RegistryMonitor } from "@/components/registrar/RegistryMonitor";
import { TOPOLOGY_MODEL_NODE_LIMIT, ZoneTopologyTab } from "./ZoneTopologyTab";
import { RecordTypeReference } from "@/components/docs/RecordTypeReference";
import { useRegistrarMonitor } from "@/hooks/registrar/use-registrar-monitor";
import {
  findSpecialIpRecords,
  runDomainAudit,
  type DomainAuditCategory,
  type DomainAuditItem,
} from "@/lib/audit/domain-audit";
import type { DomainHealthCheck, DomainInfo } from "@/types/registrar";
import { AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";
import { FirewallPanel } from "@/components/firewall/FirewallPanel";
import { WorkersPanel } from "@/components/workers/WorkersPanel";
import { EmailRoutingPanel } from "@/components/email/EmailRoutingPanel";
import { PropagationChecker } from "./PropagationChecker";
import { BulkEditBar } from "./BulkEditBar";
import { ZoneCompare } from "./ZoneCompare";
import { HotkeyHelpDialog } from "@/components/layout/HotkeyHelpDialog";
import { useUndoRedo, type UndoRedoEntry } from "@/hooks/dns/use-undo-redo";
import {
  cacheZoneRecords,
  getCachedZoneRecords,
} from "@/lib/storage/offline-cache";
import {
  prepareCopiedDnsRecord,
  type PreparedCopiedDnsRecord,
} from "@/lib/dns/record-copy";
import { normalizeRecordCharacterStrings } from "@/lib/dns/record-normalize";
import { ImportPreviewDialog } from "./ImportPreviewDialog";
import {
  TABLE_COLUMN_GROUPS,
  buildGridTemplateColumns,
  canHideTableColumn,
  getDefaultTableColumns,
  normalizeTableColumnMap,
  resolveTableColumns,
  toggleTableColumn,
  type DnsRecordColumnId,
} from "@/lib/tables/table-columns";
import { reconcileTabOrder } from "@/lib/tabs/tab-order";
import {
  reportRuntimeError,
  sanitizeRuntimeText,
  type RuntimeDiagnostic,
} from "@/lib/errors/runtime-reporting";
import {
  formatRequestError,
  normalizeRequestError,
  RequestError,
} from "@/lib/api/request-error";
import { AuthenticatedAppShell } from "@/components/layout/AuthenticatedAppShell";
import { DnsAppCommandBar } from "./DnsAppCommandBar";
import { DnsConnectionBar } from "./DnsConnectionBar";
import {
  McpToolPermissions,
  type McpToolPermissionsApplication,
  type McpToolPermissionsFailure,
} from "@/components/mcp/McpToolPermissions";
import {
  DnsWorkspaceTabs,
  getDnsWorkspacePanelId,
  getDnsWorkspaceTabId,
  getNextActiveTabIdAfterClose,
} from "./DnsWorkspaceTabs";

function reportDnsManagerFailure(error: unknown, label: string) {
  return reportRuntimeError(error, { source: "runtime", label }).diagnostic;
}

type DnsRecordLoadFailure = {
  diagnostic: RuntimeDiagnostic;
  message: string;
  kind: string;
  operation: string;
  transport: string;
  targetLabel?: "Native command" | "Endpoint";
  target?: string;
  status?: number;
  statusText?: string;
  requestId?: string;
  remediation?: string;
  retryable: boolean;
};

type DnsRecordLoadState =
  | { status: "ready"; loadedAt: number }
  | {
      status: "stale";
      source: "cache" | "last-good";
      snapshotAt?: number;
      failure: DnsRecordLoadFailure;
    }
  | { status: "error"; failure: DnsRecordLoadFailure };

function createDnsRecordLoadFailure(
  error: unknown,
  zoneId: string,
  zoneName: string,
): DnsRecordLoadFailure {
  const desktop = isDesktop();
  const normalized = normalizeRequestError(error, {
    operation: "List DNS records",
    ...(desktop
      ? { source: "tauri", command: "get_dns_records" }
      : {
          source: "browser",
          endpoint: `/zones/${zoneId}/dns_records`,
        }),
  });
  const publicError = new RequestError(normalized.kind, normalized.message, {
    source: normalized.source,
    endpoint: normalized.endpoint,
    operation: normalized.operation,
    command: normalized.command,
    status: normalized.status,
    statusText: normalized.statusText,
    code: normalized.code,
    requestId: normalized.requestId,
    retryAfter: normalized.retryAfter,
    retryable: normalized.retryable,
    remediation: normalized.remediation,
    diagnosticId: normalized.diagnosticId,
  });
  const diagnostic = reportDnsManagerFailure(
    {
      name: publicError.name,
      message: formatRequestError(publicError),
      ...(publicError.code ? { code: publicError.code } : {}),
    },
    `Load DNS records for ${sanitizeRuntimeText(zoneName, 120)}`,
  );
  const targetLabel = publicError.command
    ? "Native command"
    : publicError.endpoint
      ? "Endpoint"
      : undefined;
  return {
    diagnostic,
    message: publicError.message,
    kind: publicError.kind,
    operation: publicError.operation ?? "List DNS records",
    transport:
      publicError.command || publicError.source === "tauri"
        ? "Desktop native bridge"
        : "Web backend",
    ...(targetLabel ? { targetLabel } : {}),
    ...(publicError.command || publicError.endpoint
      ? { target: publicError.command ?? publicError.endpoint }
      : {}),
    ...(publicError.status !== undefined ? { status: publicError.status } : {}),
    ...(publicError.statusText ? { statusText: publicError.statusText } : {}),
    ...(publicError.requestId || publicError.diagnosticId
      ? { requestId: publicError.requestId ?? publicError.diagnosticId }
      : {}),
    ...(publicError.remediation
      ? { remediation: publicError.remediation }
      : {}),
    retryable: publicError.retryable,
  };
}

function DnsRecordLoadNotice({
  state,
  onRetry,
}: {
  state: Extract<DnsRecordLoadState, { status: "error" | "stale" }>;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const failure = state.failure;
  const stale = state.status === "stale";
  const title = stale
    ? state.source === "cache"
      ? t(
          "Live DNS records unavailable; showing cached records",
          "Live DNS records unavailable; showing cached records",
        )
      : t(
          "DNS refresh failed; showing last loaded records",
          "DNS refresh failed; showing last loaded records",
        )
    : t("DNS records could not be loaded", "DNS records could not be loaded");

  return (
    <div
      role={stale ? "status" : "alert"}
      aria-live={stale ? "polite" : "assertive"}
      data-testid={`dns-record-load-${state.status}`}
      className={cn(
        "mb-3 rounded-lg border px-3 py-3 text-sm",
        stale
          ? "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100"
          : "border-destructive/50 bg-destructive/10 text-destructive",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <p className="mt-1 break-words text-xs">{failure.message}</p>
          {stale && state.snapshotAt ? (
            <p className="mt-1 text-xs">
              {t("Snapshot time: {{time}}", {
                time: new Date(state.snapshotAt).toLocaleString(),
                defaultValue: `Snapshot time: ${new Date(state.snapshotAt).toLocaleString()}`,
              })}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t("Retry DNS records", "Retry DNS records")}
          onClick={onRetry}
        >
          {t("Retry", "Retry")}
        </Button>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-medium">{t("Operation", "Operation")}</dt>
          <dd className="break-words opacity-90">{failure.operation}</dd>
        </div>
        <div>
          <dt className="font-medium">{t("Transport", "Transport")}</dt>
          <dd className="break-words opacity-90">{failure.transport}</dd>
        </div>
        {failure.targetLabel && failure.target ? (
          <div>
            <dt className="font-medium">{failure.targetLabel}</dt>
            <dd className="break-all opacity-90">{failure.target}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">{t("Failure kind", "Failure kind")}</dt>
          <dd className="break-words opacity-90">{failure.kind}</dd>
        </div>
        {failure.status !== undefined ? (
          <div>
            <dt className="font-medium">{t("Status", "Status")}</dt>
            <dd className="break-words opacity-90">
              {failure.status}
              {failure.statusText ? ` ${failure.statusText}` : ""}
            </dd>
          </div>
        ) : null}
        {failure.requestId ? (
          <div>
            <dt className="font-medium">{t("Request ID", "Request ID")}</dt>
            <dd className="break-all opacity-90">{failure.requestId}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">{t("Diagnostic ID", "Diagnostic ID")}</dt>
          <dd className="break-all opacity-90">{failure.diagnostic.id}</dd>
        </div>
        <div>
          <dt className="font-medium">{t("Retryable", "Retryable")}</dt>
          <dd className="opacity-90">
            {failure.retryable ? t("Yes", "Yes") : t("No", "No")}
          </dd>
        </div>
      </dl>
      {failure.remediation ? (
        <p className="mt-2 text-xs">
          <span className="font-medium">{t("Next step", "Next step")}:</span>{" "}
          {failure.remediation}
        </p>
      ) : null}
    </div>
  );
}

const reportPreferenceFailure = createPreferenceFailureReporter((error) => {
  reportDnsManagerFailure(error, "Persist desktop DNS preferences");
});

function persistDnsPreferenceFields(fields: Record<string, unknown>) {
  void TauriClient.updatePreferenceFields(fields).catch(
    reportPreferenceFailure,
  );
}

function normalizeMcpToolIds(values: readonly unknown[]): string[] {
  return Array.from(
    new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  );
}

function sameMcpToolIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((toolId) => right.includes(toolId))
  );
}

type ActionTab =
  | "records"
  | "import"
  | "zone-settings"
  | "cache"
  | "ssl-tls"
  | "domain-audit"
  | "domain-registry"
  | "topology"
  | "analytics"
  | "firewall"
  | "workers"
  | "email-routing"
  | "propagation"
  | "zone-compare"
  | "reference";
type TabKind =
  | "zone"
  | "settings"
  | "audit"
  | "tags"
  | "registry"
  | "notifications"
  | "assistant";
type SortKey = "type" | "name" | "content" | "ttl" | "proxied";
type SortDir = "asc" | "desc" | null;
type SettingsSubtab =
  "general" | "columns" | "topology" | "audit" | "mcp" | "profiles";
type ExportFolderPreset =
  "system" | "documents" | "downloads" | "desktop" | "custom";
type TopologyResolverMode = "dns" | "doh";
type TopologyDohProvider = "google" | "cloudflare" | "quad9" | "custom";
type TopologyGeoProvider =
  "auto" | "ipwhois" | "ipapi_co" | "ip_api" | "internal";
type TopologyCopyAction = "mermaid" | "svg" | "png";
type TopologyExportAction = "mermaid" | "svg" | "png" | "pdf";
type AuditFilterField = "operation" | "resource" | "timestamp" | "details";
type AuditFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "matches"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

type AuditFilterRule = {
  id: string;
  field: AuditFilterField;
  operator: AuditFilterOperator;
  value: string;
};

const TOPOLOGY_TCP_SERVICE_OPTIONS: Array<{ port: number; label: string }> = [
  { port: 21, label: "FTP (21)" },
  { port: 22, label: "SSH (22)" },
  { port: 23, label: "Telnet (23)" },
  { port: 25, label: "SMTP (25)" },
  { port: 53, label: "DNS (53)" },
  { port: 80, label: "HTTP (80)" },
  { port: 110, label: "POP3 (110)" },
  { port: 143, label: "IMAP (143)" },
  { port: 443, label: "HTTPS (443)" },
  { port: 465, label: "SMTPS (465)" },
  { port: 587, label: "Submission (587)" },
  { port: 993, label: "IMAPS (993)" },
  { port: 995, label: "POP3S (995)" },
  { port: 3306, label: "MySQL (3306)" },
  { port: 5432, label: "PostgreSQL (5432)" },
];
const TOPOLOGY_COPY_ACTION_OPTIONS: Array<{
  value: TopologyCopyAction;
  label: string;
}> = [
  { value: "mermaid", label: "Mermaid code" },
  { value: "svg", label: "SVG" },
  { value: "png", label: "PNG" },
];
const TOPOLOGY_EXPORT_ACTION_OPTIONS: Array<{
  value: TopologyExportAction;
  label: string;
}> = [
  { value: "mermaid", label: "Mermaid code" },
  { value: "svg", label: "SVG" },
  { value: "png", label: "PNG" },
  { value: "pdf", label: "PDF" },
];
const TOPOLOGY_DNS_SERVER_LABELS: Record<string, string> = {
  "1.1.1.1": "1.1.1.1 (Cloudflare default)",
  "1.0.0.1": "1.0.0.1 (Cloudflare)",
  "8.8.8.8": "8.8.8.8 (Google)",
  "8.8.4.4": "8.8.4.4 (Google)",
  "9.9.9.9": "9.9.9.9 (Quad9)",
  "149.112.112.112": "149.112.112.112 (Quad9)",
  "208.67.222.222": "208.67.222.222 (OpenDNS)",
  "208.67.220.220": "208.67.220.220 (OpenDNS)",
  "94.140.14.14": "94.140.14.14 (AdGuard)",
  "76.76.2.0": "76.76.2.0 (Control D)",
  custom: "Custom",
};
const TOPOLOGY_GEO_PROVIDER_LABELS: Record<TopologyGeoProvider, string> = {
  auto: "Auto (multi-provider fallback)",
  ipwhois: "ipwho.is",
  ipapi_co: "ipapi.co",
  ip_api: "ip-api.com",
  internal: "Internal only (private/reserved IPs)",
};

type ZoneTab = {
  recordLoadState?: DnsRecordLoadState;
  kind: TabKind;
  id: string;
  zoneId: string;
  zoneName: string;
  status?: string;
  records: DNSRecord[];
  recordsLimited: boolean;
  sourceRecordCount: number;
  isLoading: boolean;
  editingRecord: string | null;
  searchTerm: string;
  typeFilter: RecordType | "";
  page: number;
  perPage: number;
  sortKey: SortKey | null;
  sortDir: SortDir;
  selectedIds: string[];
  showAddRecord: boolean;
  showImport: boolean;
  newRecord: Partial<DNSRecord>;
  importData: string;
  importFormat: "json" | "csv" | "bind";
};

/**
 * A paste that has been rewritten, normalized and deduplicated, waiting for
 * the user to confirm it in the preview dialog.
 */
type PastePreviewState = {
  tabId: string;
  zoneId: string;
  zoneName: string;
  sourceZoneName: string;
  /** Records that survived validation and dedupe, ready to create. */
  items: PreparedCopiedDnsRecord[];
  /** Records dropped before the preview (invalid or already present). */
  skipped: number;
  /** Size of the copy buffer the preview was built from. */
  sourceCount: number;
};

/**
 * Paste sizes above this show the preview even when the rewrite was a no-op:
 * a one-or-two record paste stays a single click, a bulk paste gets a look.
 */
const PASTE_PREVIEW_RECORD_THRESHOLD = 2;

/**
 * Props for the `DNSManager` top-level component.
 */
interface DNSManagerProps {
  /** API key to be used for server requests (token or key) */
  apiKey: string;
  /** Optional email used when authenticating with a key+email pair */
  email?: string;
  /** Callback invoked when the user logs out */
  onLogout: () => void;
}

const ACTION_TABS: { id: ActionTab; label: string; hint: string }[] = [
  {
    id: "records",
    label: "Records",
    hint: "Edit, filter, and manage records in-place",
  },
  {
    id: "import",
    label: "Import/Export",
    hint: "Move records across zones and formats",
  },
  {
    id: "zone-settings",
    label: "Zone Settings",
    hint: "Override defaults for this zone",
  },
  {
    id: "cache",
    label: "Cache",
    hint: "Purge cache and tune Cloudflare caching",
  },
  {
    id: "ssl-tls",
    label: "SSL/TLS",
    hint: "Manage encryption and HTTPS behavior",
  },
  {
    id: "domain-audit",
    label: "Audits",
    hint: "Check DNS compliance and best practices",
  },
  {
    id: "domain-registry",
    label: "Registry",
    hint: "RDAP/WHOIS and registrar checks for this domain",
  },
  {
    id: "topology",
    label: "Topology",
    hint: "Visualize DNS relationships, CNAME chains, and shared services",
  },
  {
    id: "analytics",
    label: "Analytics",
    hint: "Traffic, bandwidth, and threat statistics",
  },
  {
    id: "firewall",
    label: "Firewall",
    hint: "Firewall rules, IP access rules, and WAF rulesets",
  },
  {
    id: "workers",
    label: "Workers",
    hint: "Manage Cloudflare Worker routes for this zone",
  },
  {
    id: "email-routing",
    label: "Email",
    hint: "Configure email routing rules and forwarding",
  },
  {
    id: "propagation",
    label: "Propagation",
    hint: "Check DNS propagation across global resolvers",
  },
  {
    id: "zone-compare",
    label: "Compare",
    hint: "Compare DNS records between zones",
  },
  {
    id: "reference",
    label: "Reference",
    hint: "What each record type is for, with formats, examples and RFCs",
  },
];
const ZONE_ACTION_PANEL_ID = "dns-zone-action-panel";

function getZoneActionTabId(id: ActionTab): string {
  return `dns-zone-action-tab-${id}`;
}

const ACTION_TAB_LABELS: Record<TabKind, string> = {
  zone: "Zone",
  settings: "Settings",
  audit: "Audit",
  tags: "Tags",
  registry: "Registry",
  notifications: "Notifications",
  assistant: "Assistant",
};

/**
 * A history entry stores the operation it performed (`forward`) and the one
 * that reverses it (`reverse`); both are *executed* verbatim, so a single
 * applier serves undo and redo. Bulk operations (paste, import, bulk delete,
 * bulk edit) push one entry covering every record instead of one per record.
 */
type DNSOp =
  | { kind: "create"; zoneId: string; record: DNSRecord }
  | { kind: "update"; zoneId: string; record: DNSRecord }
  | { kind: "delete"; zoneId: string; recordId: string; record: DNSRecord }
  | { kind: "bulk-create"; zoneId: string; records: DNSRecord[] }
  | { kind: "bulk-update"; zoneId: string; records: DNSRecord[] }
  | { kind: "bulk-delete"; zoneId: string; records: DNSRecord[] };

/** How many individual failures a bulk toast names before it summarises. */
const BULK_FAILURE_DETAIL_LIMIT = 3;

function describeRecordForFailure(record?: DNSRecord, fallback = ""): string {
  return record ? `${record.type} ${record.name}` : fallback;
}

function joinBulkFailures(details: string[], total: number): string {
  if (total > details.length) {
    details.push(`and ${total - details.length} more`);
  }
  return details.join("; ");
}

/** Name the records a bulk delete refused, so the toast is actionable. */
function describeBulkDeleteFailures(
  failed: readonly BulkDnsDeleteFailure[],
  records: readonly DNSRecord[],
): string {
  const byId = new Map(records.map((record) => [record.id, record]));
  return joinBulkFailures(
    failed
      .slice(0, BULK_FAILURE_DETAIL_LIMIT)
      .map(
        (failure) =>
          `${describeRecordForFailure(byId.get(failure.id), failure.id)}: ${failure.error}`,
      ),
    failed.length,
  );
}

/** Name the records a bulk field edit could not change. */
function describeBulkUpdateFailures(
  failures: ReadonlyArray<{ record: DNSRecord; error: string }>,
): string {
  return joinBulkFailures(
    failures
      .slice(0, BULK_FAILURE_DETAIL_LIMIT)
      .map(
        (failure) =>
          `${describeRecordForFailure(failure.record, failure.record.id)}: ${failure.error}`,
      ),
    failures.length,
  );
}

/**
 * Rebuild the op paired with a create so it names the records that were just
 * created rather than the ones the create was modelled on.
 *
 * Recreating a record does not restore its Cloudflare id — the API mints a new
 * one — so the delete that reverses a create goes stale the moment the create
 * is replayed. Returns `null` when nothing needs re-pointing.
 */
function repointPairedDnsOp(
  paired: DNSOp,
  created: readonly DNSRecord[],
): DNSOp | null {
  const withIds = created.filter((record) => record?.id);
  if (!withIds.length) return null;
  if (paired.kind === "delete") {
    const record = withIds[0];
    if (record.id === paired.recordId) return null;
    return {
      kind: "delete",
      zoneId: paired.zoneId,
      recordId: record.id,
      record,
    };
  }
  if (paired.kind === "bulk-delete") {
    const unchanged =
      withIds.length === paired.records.length &&
      withIds.every((record, index) => record.id === paired.records[index]?.id);
    if (unchanged) return null;
    return {
      kind: "bulk-delete",
      zoneId: paired.zoneId,
      records: [...withIds],
    };
  }
  return null;
}

const CACHE_LEVEL_DETAILS: Record<string, string> = {
  basic:
    "Standard caching behavior. Query strings are respected for cache variation.",
  aggressive:
    "Caches more aggressively by reducing query-string variation. Better hit rate, but ensure query params do not change content.",
  simplified:
    "Minimal query-string variation for maximum cache reuse. Use when URLs are already canonical and deterministic.",
};

const createEmptyRecord = (): Partial<DNSRecord> => ({
  type: "A",
  name: "",
  content: "",
  ttl: 300,
  proxied: false,
});

function normalizeSuggestedRecordName(name: string, zoneName: string): string {
  const trimmedName = name.trim().replace(/\.$/, "");
  const trimmedZone = zoneName.trim().replace(/\.$/, "");
  if (!trimmedZone) return trimmedName;
  if (!trimmedName || trimmedName === "@") return trimmedZone;

  const normalizedName = trimmedName.toLowerCase();
  const normalizedZone = trimmedZone.toLowerCase();
  if (
    normalizedName === normalizedZone ||
    normalizedName.endsWith(`.${normalizedZone}`)
  ) {
    return trimmedName;
  }
  return `${trimmedName}.${trimmedZone}`;
}

const DNS_RECORD_MEMORY_LIMIT = 5_000;
const DNS_RECORD_RENDER_LIMIT = 200;
const DNS_API_PAGE_SIZE_LIMIT = 500;
const DNS_TOPOLOGY_RECORD_LIMIT = TOPOLOGY_MODEL_NODE_LIMIT;
const DNS_TOPOLOGY_SCAN_PAGE_LIMIT = 200;
const DNS_EXPORT_PAGE_SIZE = DNS_API_PAGE_SIZE_LIMIT;
const DNS_EXPORT_PAGE_LIMIT = 10_000;
const DNS_EXPORT_RECORD_LIMIT = 50_000;
const DNS_EXPORT_ESTIMATED_BYTE_LIMIT = 32 * 1024 * 1024;
const DNS_OPEN_ZONE_TAB_LIMIT = 8;
const DNS_INACTIVE_RECORD_EVICTION_THRESHOLD = 1_000;
const DNS_AUTO_REFRESH_MIN_MS = 60_000;
const DNS_AUTO_REFRESH_MAX_MS = 30 * 60_000;
const DNS_MIN_PAGE_SIZE = 25;
const DNS_DEFAULT_PAGE_SIZE = 50;

function clampAutoRefreshInterval(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(
    DNS_AUTO_REFRESH_MAX_MS,
    Math.max(DNS_AUTO_REFRESH_MIN_MS, Math.round(numeric)),
  );
}

function limitRestoredTabIds(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let zoneCount = 0;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || id.length > 256 || seen.has(id)) continue;
    if (!id.startsWith("__")) {
      if (zoneCount >= DNS_OPEN_ZONE_TAB_LIMIT) continue;
      zoneCount += 1;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function appendBoundedZoneTab(
  tabs: ZoneTab[],
  nextTab: ZoneTab,
  activeTabId: string | null,
): { tabs: ZoneTab[]; evictedTabId?: string; opened: boolean } {
  if (tabs.some((tab) => tab.zoneId === nextTab.zoneId)) {
    return { tabs, opened: true };
  }
  const openZoneTabs = tabs.filter((tab) => tab.kind === "zone");
  if (openZoneTabs.length < DNS_OPEN_ZONE_TAB_LIMIT) {
    return { tabs: [...tabs, nextTab], opened: true };
  }
  const evicted = tabs.find(
    (tab) =>
      tab.kind === "zone" &&
      tab.id !== activeTabId &&
      !tab.editingRecord &&
      !tab.showAddRecord &&
      !tab.showImport &&
      !tab.importData.trim() &&
      !String(tab.newRecord.name ?? "").trim() &&
      !String(tab.newRecord.content ?? "").trim(),
  );
  if (!evicted) return { tabs, opened: false };
  return {
    tabs: [...tabs.filter((tab) => tab.id !== evicted.id), nextTab],
    evictedTabId: evicted.id,
    opened: true,
  };
}

function evictInactiveTabRecords(
  tabs: ZoneTab[],
  activeTabId: string | null,
): ZoneTab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (
      tab.kind !== "zone" ||
      tab.id === activeTabId ||
      tab.records.length < DNS_INACTIVE_RECORD_EVICTION_THRESHOLD ||
      tab.editingRecord ||
      tab.showAddRecord ||
      tab.showImport
    ) {
      return tab;
    }
    changed = true;
    return {
      ...tab,
      records: [],
      selectedIds: [],
    };
  });
  return changed ? next : tabs;
}

function createCompletionScheduledPoller(
  task: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void = () => {},
): () => void {
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (disposed) return;
    timeout = setTimeout(() => {
      timeout = undefined;
      if (disposed) return;
      void task()
        .catch((error) => {
          if (!disposed) onError(error);
        })
        .finally(() => {
          if (!disposed) schedule();
        });
    }, intervalMs);
  };

  schedule();
  return () => {
    disposed = true;
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
}

function createRequestGenerationTracker() {
  let nextGeneration = 0;
  const currentByKey = new Map<string, number>();
  return {
    begin(key: string): number {
      const generation = ++nextGeneration;
      currentByKey.set(key, generation);
      return generation;
    },
    isCurrent(key: string, generation: number): boolean {
      return currentByKey.get(key) === generation;
    },
    invalidate(key: string): void {
      currentByKey.delete(key);
    },
    clear(): void {
      currentByKey.clear();
      nextGeneration += 1;
    },
  };
}

function clampDnsPageSize(
  value: unknown,
  fallback = DNS_DEFAULT_PAGE_SIZE,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (numeric === 0) return 0;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(
    DNS_API_PAGE_SIZE_LIMIT,
    Math.max(DNS_MIN_PAGE_SIZE, Math.round(numeric)),
  );
}

function clampZonePerPageMap(
  value: Record<string, number> | null | undefined,
): Record<string, number> {
  if (!value) return {};
  const next: Record<string, number> = {};
  for (const [zoneId, pageSize] of Object.entries(value)) {
    if (!zoneId) continue;
    next[zoneId] = clampDnsPageSize(pageSize);
  }
  return next;
}

function retainDnsRecordsForUi(records: DNSRecord[]): {
  records: DNSRecord[];
  limited: boolean;
  sourceRecordCount: number;
} {
  if (records.length <= DNS_RECORD_MEMORY_LIMIT) {
    return {
      records,
      limited: false,
      sourceRecordCount: records.length,
    };
  }
  return {
    records: records.slice(0, DNS_RECORD_MEMORY_LIMIT),
    limited: true,
    sourceRecordCount: records.length,
  };
}

type DnsRecordPageLoader = (
  zoneId: string,
  page: number,
  perPage: number,
  signal?: AbortSignal,
) => Promise<DNSRecord[]>;

type DnsTopologyFilter = {
  searchTerm: string;
  typeFilter: RecordType | "";
  getRecordTags?: (record: DNSRecord) => readonly string[];
};

type DnsTopologyLoadResult =
  | {
      status: "ready";
      records: DNSRecord[];
      scannedRecordCount: number;
      pageCount: number;
    }
  | {
      status: "too-large";
      records: [];
      scannedRecordCount: number;
      pageCount: number;
      matchingRecordCountLowerBound: number;
    }
  | {
      status: "scan-limited";
      records: [];
      scannedRecordCount: number;
      pageCount: number;
      matchingRecordCountLowerBound: number;
    };

type DnsTopologyRecordState = {
  status: "idle" | "loading" | "ready" | "too-large" | "scan-limited" | "error";
  queryKey: string;
  records: DNSRecord[];
  scannedRecordCount: number;
  pageCount: number;
  matchingRecordCountLowerBound: number;
  error: string | null;
};

const EMPTY_DNS_TOPOLOGY_RECORD_STATE: DnsTopologyRecordState = {
  status: "idle",
  queryKey: "",
  records: [],
  scannedRecordCount: 0,
  pageCount: 0,
  matchingRecordCountLowerBound: 0,
  error: null,
};

function throwIfDnsOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("DNS operation aborted", "AbortError");
}

type DnsExportFormat = "json" | "csv" | "bind";

function estimateJsonValueBytes(
  value: unknown,
  remainingBytes = DNS_EXPORT_ESTIMATED_BYTE_LIMIT,
  depth = 0,
  ancestors = new Set<object>(),
): number {
  if (remainingBytes <= 0 || depth > 8) return remainingBytes + 1;
  if (value === null || value === undefined) return 4;
  if (typeof value === "string") return value.length * 6 + 2;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return 32;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return remainingBytes + 1;
  }

  ancestors.add(value);
  let bytes = 2;
  let entries = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      entries += 1;
      if (entries > 2_048) return remainingBytes + 1;
      bytes += key.length * 6 + 4;
      const childBytes = estimateJsonValueBytes(
        (value as Record<string, unknown>)[key],
        remainingBytes - bytes,
        depth + 1,
        ancestors,
      );
      bytes += childBytes + 1;
      if (bytes > remainingBytes) return bytes;
    }
    return bytes;
  } finally {
    ancestors.delete(value);
  }
}

function estimateDnsExportRecordBytes(
  record: DNSRecord,
  format: DnsExportFormat,
): number {
  const textUpperBound = (value: unknown) => String(value ?? "").length * 6 + 8;
  if (format === "csv") {
    return (
      16 +
      textUpperBound(record.type) +
      textUpperBound(record.name) +
      textUpperBound(record.content) +
      textUpperBound(record.ttl) +
      textUpperBound(record.priority) +
      textUpperBound(record.proxied)
    );
  }
  if (format === "bind") {
    return (
      32 +
      textUpperBound(record.name) +
      textUpperBound(record.ttl) +
      textUpperBound(record.type) +
      textUpperBound(record.priority) +
      textUpperBound(record.content)
    );
  }
  return estimateJsonValueBytes(record);
}

function matchesDnsTopologyFilter(
  record: DNSRecord,
  filter: DnsTopologyFilter,
): boolean {
  if (filter.typeFilter && record.type !== filter.typeFilter) return false;
  const query = filter.searchTerm.trim().toLowerCase();
  if (!query) return true;
  if (
    String(record.name ?? "")
      .toLowerCase()
      .includes(query) ||
    String(record.type ?? "")
      .toLowerCase()
      .includes(query) ||
    String(record.content ?? "")
      .toLowerCase()
      .includes(query)
  ) {
    return true;
  }
  return Boolean(
    filter
      .getRecordTags?.(record)
      .some((tag) => tag.toLowerCase().includes(query)),
  );
}

/**
 * Topology loading is independent from table pagination. It retains no more
 * than the graph's exact model limit and scans a deterministic number of
 * fixed-size API pages. A full final page is never treated as proof that the
 * source is complete.
 */
async function loadAuthoritativeDnsRecordsForTopology(
  loadPage: DnsRecordPageLoader,
  zoneId: string,
  filter: DnsTopologyFilter,
  signal?: AbortSignal,
): Promise<DnsTopologyLoadResult> {
  const records: DNSRecord[] = [];
  let scannedRecordCount = 0;

  for (let page = 1; page <= DNS_TOPOLOGY_SCAN_PAGE_LIMIT; page += 1) {
    throwIfDnsOperationAborted(signal);
    const batch = await loadPage(zoneId, page, DNS_API_PAGE_SIZE_LIMIT, signal);
    throwIfDnsOperationAborted(signal);
    scannedRecordCount += batch.length;

    for (const record of batch) {
      if (!matchesDnsTopologyFilter(record, filter)) continue;
      if (records.length === DNS_TOPOLOGY_RECORD_LIMIT) {
        return {
          status: "too-large",
          records: [],
          scannedRecordCount,
          pageCount: page,
          matchingRecordCountLowerBound: DNS_TOPOLOGY_RECORD_LIMIT + 1,
        };
      }
      records.push(record);
    }

    if (batch.length < DNS_API_PAGE_SIZE_LIMIT) {
      return {
        status: "ready",
        records,
        scannedRecordCount,
        pageCount: page,
      };
    }
  }

  return {
    status: "scan-limited",
    records: [],
    scannedRecordCount,
    pageCount: DNS_TOPOLOGY_SCAN_PAGE_LIMIT,
    matchingRecordCountLowerBound: records.length,
  };
}

/**
 * Export is intentionally separate from bounded UI retention. It walks every
 * authoritative API page until the explicit aggregate ceilings are reached.
 * It either returns the complete record set or throws, and never turns a
 * partial UI view into a silent partial export.
 */
async function loadCompleteDnsRecordsForExport(
  loadPage: DnsRecordPageLoader,
  zoneId: string,
  signal?: AbortSignal,
  format: DnsExportFormat = "json",
): Promise<DNSRecord[]> {
  const records: DNSRecord[] = [];
  let estimatedBytes = 2;
  for (let page = 1; page <= DNS_EXPORT_PAGE_LIMIT; page += 1) {
    throwIfDnsOperationAborted(signal);
    const batch = await loadPage(zoneId, page, DNS_EXPORT_PAGE_SIZE, signal);
    throwIfDnsOperationAborted(signal);
    if (records.length + batch.length > DNS_EXPORT_RECORD_LIMIT) {
      throw new Error(
        `DNS export exceeds the ${DNS_EXPORT_RECORD_LIMIT.toLocaleString()}-record safety limit; no partial file was created.`,
      );
    }
    for (const record of batch) {
      const recordBytes = estimateDnsExportRecordBytes(record, format);
      if (estimatedBytes + recordBytes > DNS_EXPORT_ESTIMATED_BYTE_LIMIT) {
        throw new Error(
          `DNS export exceeds the ${DNS_EXPORT_ESTIMATED_BYTE_LIMIT / (1024 * 1024)} MiB estimated output safety limit; no partial file was created.`,
        );
      }
      estimatedBytes += recordBytes;
      records.push(record);
    }
    if (batch.length < DNS_EXPORT_PAGE_SIZE) return records;
  }
  throw new Error(
    `DNS export exceeded the ${DNS_EXPORT_PAGE_LIMIT}-page safety limit; no partial file was created.`,
  );
}

const createZoneTab = (zone: Zone, perPage: number): ZoneTab => ({
  kind: "zone",
  id: zone.id,
  zoneId: zone.id,
  zoneName: zone.name,
  status: zone.status,
  records: [],
  recordsLimited: false,
  sourceRecordCount: 0,
  isLoading: false,
  editingRecord: null,
  searchTerm: "",
  typeFilter: "",
  page: 1,
  perPage: clampDnsPageSize(perPage),
  sortKey: null,
  sortDir: null,
  selectedIds: [],
  showAddRecord: false,
  showImport: false,
  newRecord: createEmptyRecord(),
  importData: "",
  importFormat: "json",
});
const createActionTab = (kind: Exclude<TabKind, "zone">): ZoneTab => ({
  kind,
  id: `__${kind}`,
  zoneId: "",
  zoneName: ACTION_TAB_LABELS[kind],
  status: undefined,
  records: [],
  recordsLimited: false,
  sourceRecordCount: 0,
  isLoading: false,
  editingRecord: null,
  searchTerm: "",
  typeFilter: "",
  page: 1,
  perPage: DNS_DEFAULT_PAGE_SIZE,
  sortKey: null,
  sortDir: null,
  selectedIds: [],
  showAddRecord: false,
  showImport: false,
  newRecord: createEmptyRecord(),
  importData: "",
  importFormat: "json",
});

function parseAuditTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

function formatRelativeTime(timestampMs: number): string {
  const deltaSeconds = Math.round((timestampMs - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return rtf.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return rtf.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaSeconds / 3600);
  if (Math.abs(deltaHours) < 24) return rtf.format(deltaHours, "hour");
  const deltaDays = Math.round(deltaSeconds / 86400);
  return rtf.format(deltaDays, "day");
}

function formatAuditTimestampShort(value: unknown): string {
  const parsed = parseAuditTimestamp(value);
  if (parsed === null) return "Unknown";
  const date = new Date(parsed);
  const short = date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${short} (${formatRelativeTime(parsed)})`;
}

function formatAuditTimestampFull(value: unknown): string {
  const parsed = parseAuditTimestamp(value);
  if (parsed === null) return "Unknown";
  const date = new Date(parsed);
  return `${date.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  })} | ${date.toISOString()}`;
}

function formatHumanizedDateTime(value: unknown): {
  short: string;
  full: string;
} {
  const parsed = parseAuditTimestamp(value);
  if (parsed === null) return { short: "—", full: "—" };
  const date = new Date(parsed);
  return {
    short: `${date.toLocaleDateString()} (${formatRelativeTime(parsed)})`,
    full: `${date.toLocaleString()} | ${date.toISOString()}`,
  };
}

function useLoadingOverlay(
  loading: boolean,
  timeoutMs: number,
): { visible: boolean } {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const id = window.setTimeout(
      () => {
        setVisible(false);
      },
      Math.max(1000, Math.min(60000, timeoutMs)),
    );
    return () => window.clearTimeout(id);
  }, [loading, timeoutMs]);

  return { visible };
}

function SectionLoadingOverlay({ label }: { label: string }) {
  const theme =
    typeof document !== "undefined"
      ? (document.documentElement.dataset.theme ?? "sunset")
      : "sunset";
  const isDarkOverlayTheme =
    theme === "sunset" || theme === "oled" || theme === "void";
  const spinnerGradient =
    "conic-gradient(from 0deg, hsl(var(--primary)) 0deg, hsl(var(--primary) / 0.2) 90deg, hsl(var(--primary)) 220deg, hsl(var(--primary)) 360deg)";
  const spinnerGlowGradient =
    "conic-gradient(from 0deg, hsl(var(--primary)) 0deg, hsl(var(--primary) / 0.26) 110deg, hsl(var(--primary) / 0.95) 250deg, hsl(var(--primary)) 360deg)";
  const ringMask =
    "radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px))";

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex items-center justify-center rounded-xl backdrop-blur-2xl backdrop-saturate-150",
        isDarkOverlayTheme
          ? "bg-gradient-to-br from-black/88 via-black/82 to-primary/44"
          : "bg-gradient-to-br from-white/95 via-white/90 to-primary/12",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-primary/35 px-3 py-2 text-xs text-foreground shadow-[0_0_34px_hsl(var(--primary)/0.28)]",
          isDarkOverlayTheme ? "bg-card/85" : "bg-card/96",
        )}
      >
        <div className="relative h-5 w-5">
          <div
            className="absolute inset-0 rounded-full opacity-85 blur-[1px]"
            style={{ background: spinnerGlowGradient }}
          />
          <div
            className="absolute inset-0 animate-spin rounded-full"
            style={{
              background: spinnerGradient,
              WebkitMask: ringMask,
              mask: ringMask,
            }}
          />
          <div
            className={cn(
              "absolute inset-[5px] rounded-full",
              isDarkOverlayTheme ? "bg-card/85" : "bg-card/96",
            )}
          />
        </div>
        {label}
      </div>
    </div>
  );
}

function sanitizeDomainAuditCategories(
  value: Partial<Record<DomainAuditCategory, boolean>> | null | undefined,
): Record<DomainAuditCategory, boolean> {
  return {
    email: value?.email !== false,
    security: value?.security !== false,
    hygiene: value?.hygiene !== false,
  };
}

/**
 * DNS Manager component responsible for listing zones and DNS records and
 * providing UI for add/import/export/update/delete operations.
 *
 * @param apiKey - API key used to authenticate server requests
 * @param email - optional email when using key+email authentication
 * @param onLogout - callback invoked when the user logs out
 */
export function DNSManager({ apiKey, email, onLogout }: DNSManagerProps) {
  const { t } = useI18n();
  const initialZoneSelectionHandledRef = useRef(false);
  const settingsImportInputRef = useRef<HTMLInputElement | null>(null);
  const sessionProfileHydratedRef = useRef(false);
  const exportRequestRef = useRef<AbortController | null>(null);
  const recordRequestGenerationsRef = useRef(createRequestGenerationTracker());
  const topologyRequestRef = useRef<{
    id: number;
    queryKey: string;
    controller: AbortController;
  } | null>(null);
  const nextTopologyRequestIdRef = useRef(0);
  // Email Routing + Worker routes for the topology Email/Services graphs.
  // Loaded lazily once per zone while the Topology tab is active; failures are
  // swallowed (the DNS graph never waits on them) and surface as `undefined`.
  const [topologyIntegrations, setTopologyIntegrations] = useState<{
    zoneId: string;
    emailRouting?: {
      settings: EmailRoutingSettingsResponse;
      rules: EmailRoutingRuleResponse[];
    };
    workerRoutes?: WorkerRouteResponse[];
    emailRoutingUnavailable: boolean;
  } | null>(null);
  const topologyIntegrationsRequestRef = useRef<{
    zoneId: string;
    controller: AbortController;
  } | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState("");
  const [tabs, setTabs] = useState<ZoneTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [actionTab, setActionTab] = useState<ActionTab>("records");
  // Record a "Go to record" control just navigated to; flashes its row.
  const [revealedRecordId, setRevealedRecordId] = useState<string | null>(null);
  const actionTabRefs = useRef(new Map<ActionTab, HTMLButtonElement>());
  const [topologyRecordState, setTopologyRecordState] =
    useState<DnsTopologyRecordState>(EMPTY_DNS_TOPOLOGY_RECORD_STATE);
  const [globalPerPage, setGlobalPerPage] = useState(DNS_DEFAULT_PAGE_SIZE);
  const [zonePerPage, setZonePerPage] = useState<Record<string, number>>({});
  const [showUnsupportedRecordTypes, setShowUnsupportedRecordTypes] = useState(
    storageManager.getShowUnsupportedRecordTypes(),
  );
  const [zoneShowUnsupportedRecordTypes, setZoneShowUnsupportedRecordTypes] =
    useState<Record<string, boolean>>(
      storageManager.getZoneShowUnsupportedRecordTypesMap(),
    );
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number | null>(
    clampAutoRefreshInterval(storageManager.getAutoRefreshInterval()),
  );
  const [rewriteCopiedRecordDomains, setRewriteCopiedRecordDomains] = useState(
    storageManager.getRewriteCopiedRecordDomains(),
  );
  const [tableColumns, setTableColumns] = useState<Record<string, string[]>>(
    () => normalizeTableColumnMap(storageManager.getTableColumns()),
  );
  const registrarMonitor = useRegistrarMonitor(apiKey, email);
  const [auditEntries, setAuditEntries] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditFilters, setAuditFilters] = useState<AuditFilterRule[]>([]);
  const [auditSort, setAuditSort] = useState<{
    field: "timestamp" | "operation" | "resource";
    dir: "asc" | "desc";
  }>({ field: "timestamp", dir: "desc" });
  const [auditLimit, setAuditLimit] = useState("100");
  const [showClearAuditConfirm, setShowClearAuditConfirm] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [reopenLastTabs, setReopenLastTabs] = useState(false);
  const [reopenZoneTabs, setReopenZoneTabs] = useState<Record<string, boolean>>(
    {},
  );
  const [lastOpenTabs, setLastOpenTabs] = useState<string[]>([]);
  const [restoredTabs, setRestoredTabs] = useState(false);
  const [prefsReady, setPrefsReady] = useState(false);
  const [mcpSessionPreferencesRevision, setMcpSessionPreferencesRevision] =
    useState(0);
  const [pendingLastActiveTab, setPendingLastActiveTab] = useState("");
  const [auditExportDefaultDocuments, setAuditExportDefaultDocuments] =
    useState(storageManager.getAuditExportDefaultDocuments());
  const [confirmClearAuditLogs, setConfirmClearAuditLogs] = useState(
    storageManager.getConfirmClearAuditLogs(),
  );
  const [auditExportFolderPreset, setAuditExportFolderPreset] =
    useState<ExportFolderPreset>(
      storageManager.getAuditExportFolderPreset() as ExportFolderPreset,
    );
  const [auditExportCustomPath, setAuditExportCustomPath] = useState(
    storageManager.getAuditExportCustomPath(),
  );
  const [
    auditExportSkipDestinationConfirm,
    setAuditExportSkipDestinationConfirm,
  ] = useState(storageManager.getAuditExportSkipDestinationConfirm());
  const [settingsSubtab, setSettingsSubtab] =
    useState<SettingsSubtab>("general");
  const [sessionSettingsProfiles, setSessionSettingsProfiles] = useState<
    Record<string, SessionSettingsProfile>
  >(storageManager.getSessionSettingsProfiles());
  const [cloneSourceSessionId, setCloneSourceSessionId] = useState("");
  const [copyBuffer, setCopyBuffer] = useState<{
    records: DNSRecord[];
    sourceZoneId: string;
    sourceZoneName: string;
  } | null>(null);
  const [showCopyBuffer, setShowCopyBuffer] = useState(false);
  const [confirmPastePreview, setConfirmPastePreview] = useState(() =>
    storageManager.getConfirmPastePreview(),
  );
  const [pastePreview, setPastePreview] = useState<PastePreviewState | null>(
    null,
  );

  const { toast } = useToast();
  const notifySaved = useCallback(
    (description: string) => {
      toast({ title: t("Saved", "Saved"), description });
    },
    [t, toast],
  );
  const dnsRecordColumns = useMemo(
    () =>
      resolveTableColumns(
        "dnsRecords",
        tableColumns.dnsRecords,
      ) as DnsRecordColumnId[],
    [tableColumns.dnsRecords],
  );
  const dnsRecordGridTemplate = useMemo(
    () => buildGridTemplateColumns("dnsRecords", dnsRecordColumns),
    [dnsRecordColumns],
  );
  const auditLogColumns = useMemo(
    () => resolveTableColumns("auditLog", tableColumns.auditLog),
    [tableColumns.auditLog],
  );
  const auditLogGridTemplate = useMemo(
    () => buildGridTemplateColumns("auditLog", auditLogColumns),
    [auditLogColumns],
  );
  const zoneCompareColumns = useMemo(
    () => resolveTableColumns("zoneCompare", tableColumns.zoneCompare),
    [tableColumns.zoneCompare],
  );
  const setTableColumnVisible = useCallback(
    (tableId: string, columnId: string, visible: boolean) => {
      setTableColumns((previous) => {
        const current = resolveTableColumns(tableId, previous[tableId]);
        const next = toggleTableColumn(tableId, current, columnId, visible);
        if (
          next.length === current.length &&
          next.every((id, index) => id === current[index])
        ) {
          return previous;
        }
        return { ...previous, [tableId]: next };
      });
    },
    [],
  );
  const resetTableColumns = useCallback((tableId: string) => {
    setTableColumns((previous) => ({
      ...previous,
      [tableId]: getDefaultTableColumns(tableId),
    }));
  }, []);
  const [tagsZoneId, setTagsZoneId] = useState<string>("");
  const [newTag, setNewTag] = useState("");
  const [renameTagFrom, setRenameTagFrom] = useState<string | null>(null);
  const [renameTagTo, setRenameTagTo] = useState("");
  const [tagsVersion, setTagsVersion] = useState(0);
  const [tagManagerRecords, setTagManagerRecords] = useState<DNSRecord[]>([]);
  const [tagManagerRecordsLoading, setTagManagerRecordsLoading] =
    useState(false);
  const [tagManagerRecordsLimited, setTagManagerRecordsLimited] =
    useState(false);
  const [tagManagerRecordsError, setTagManagerRecordsError] = useState<
    string | null
  >(null);
  const [tagAssociationSearch, setTagAssociationSearch] = useState("");
  const [tagAssociationDrafts, setTagAssociationDrafts] = useState<
    Record<string, string>
  >({});
  const [confirmLogout, setConfirmLogout] = useState(true);
  const [idleLogoutMs, setIdleLogoutMs] = useState<number | null>(null);
  const [confirmWindowClose, setConfirmWindowClose] = useState(true);
  const [closeTabOnMiddleClick, setCloseTabOnMiddleClick] = useState(
    storageManager.getCloseTabOnMiddleClick(),
  );
  const [mcpServerEnabled, setMcpServerEnabled] = useState(
    storageManager.getMcpServerEnabled(),
  );
  const [mcpServerHost, setMcpServerHost] = useState(
    storageManager.getMcpServerHost(),
  );
  const [mcpServerPort, setMcpServerPort] = useState(
    storageManager.getMcpServerPort(),
  );
  const [initialMcpPermissionSnapshot] = useState(() =>
    storageManager.getMcpEnabledToolsSnapshot(),
  );
  const [mcpEnabledTools, setMcpEnabledTools] = useState<string[]>(
    initialMcpPermissionSnapshot.enabledTools,
  );
  const [mcpRequestedTools, setMcpRequestedTools] = useState<string[]>(() =>
    Array.from(
      new Set([
        ...initialMcpPermissionSnapshot.enabledTools,
        ...initialMcpPermissionSnapshot.pendingHighRiskToolIds,
      ]),
    ),
  );
  const [mcpPermissionsReady, setMcpPermissionsReady] = useState(false);
  const [mcpConfirmedPermissionRevision, setMcpConfirmedPermissionRevision] =
    useState(0);
  const [mcpStartupDrainRevision, setMcpStartupDrainRevision] = useState(0);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpActionError, setMcpActionError] = useState<string | null>(null);
  const mcpEnabledToolsRef = useRef(mcpEnabledTools);
  const mcpRequestedToolsRef = useRef(mcpRequestedTools);
  const mcpServerEnabledRef = useRef(mcpServerEnabled);
  const mcpServerHostRef = useRef(mcpServerHost);
  const mcpServerPortRef = useRef(mcpServerPort);
  const mcpPermissionsReadyRef = useRef(mcpPermissionsReady);
  const mcpStartupSynchronizationKey = useMemo(() => {
    if (
      mcpSessionPreferencesRevision === 0 ||
      mcpConfirmedPermissionRevision === 0
    ) {
      return null;
    }
    return JSON.stringify({
      preferencesRevision: mcpSessionPreferencesRevision,
      permissionRevision: mcpConfirmedPermissionRevision,
    });
  }, [mcpConfirmedPermissionRevision, mcpSessionPreferencesRevision]);
  const mcpStartupSynchronizationKeyRef = useRef<string | null>(
    mcpStartupSynchronizationKey,
  );
  const mcpStartupCompletedKeyRef = useRef<string | null>(null);
  const mcpStartupInFlightKeyRef = useRef<string | null>(null);
  const mcpStartupMountedRef = useRef(false);
  mcpServerEnabledRef.current = mcpServerEnabled;
  mcpServerHostRef.current = mcpServerHost;
  mcpServerPortRef.current = mcpServerPort;
  mcpPermissionsReadyRef.current = mcpPermissionsReady;
  mcpStartupSynchronizationKeyRef.current = mcpStartupSynchronizationKey;
  const mcpPermissionsParkingRef = useRef<HTMLDivElement | null>(null);
  const mcpPermissionsViewRef = useRef<HTMLDivElement | null>(null);
  const [mcpPermissionsPortalHost, setMcpPermissionsPortalHost] =
    useState<HTMLDivElement | null>(null);
  const [loadingOverlayTimeoutMs, setLoadingOverlayTimeoutMs] = useState(
    storageManager.getLoadingOverlayTimeoutMs(),
  );
  const [topologyResolutionMaxHops, setTopologyResolutionMaxHops] = useState(
    storageManager.getTopologyResolutionMaxHops(),
  );
  const [topologyResolverMode, setTopologyResolverMode] =
    useState<TopologyResolverMode>(storageManager.getTopologyResolverMode());
  const [topologyDnsServer, setTopologyDnsServer] = useState(
    storageManager.getTopologyDnsServer(),
  );
  const [topologyCustomDnsServer, setTopologyCustomDnsServer] = useState(
    storageManager.getTopologyCustomDnsServer(),
  );
  const [topologyDohProvider, setTopologyDohProvider] =
    useState<TopologyDohProvider>(storageManager.getTopologyDohProvider());
  const [topologyDohCustomUrl, setTopologyDohCustomUrl] = useState(
    storageManager.getTopologyDohCustomUrl(),
  );
  const [topologyExportConfirmPath, setTopologyExportConfirmPath] = useState(
    storageManager.getTopologyExportConfirmPath(),
  );
  const [topologyExportFolderPreset, setTopologyExportFolderPreset] =
    useState<ExportFolderPreset>(
      storageManager.getTopologyExportFolderPreset() as ExportFolderPreset,
    );
  const [topologyExportCustomPath, setTopologyExportCustomPath] = useState(
    storageManager.getTopologyExportCustomPath(),
  );
  const [topologyCopyActions, setTopologyCopyActions] = useState<
    TopologyCopyAction[]
  >(storageManager.getTopologyCopyActions() as TopologyCopyAction[]);
  const [topologyExportActions, setTopologyExportActions] = useState<
    TopologyExportAction[]
  >(storageManager.getTopologyExportActions() as TopologyExportAction[]);
  const [topologyDisableAnnotations, setTopologyDisableAnnotations] = useState(
    storageManager.getTopologyDisableAnnotations(),
  );
  const [topologyDisableFullWindow, setTopologyDisableFullWindow] = useState(
    storageManager.getTopologyDisableFullWindow(),
  );
  const [topologyLookupTimeoutMs, setTopologyLookupTimeoutMs] = useState(
    storageManager.getTopologyLookupTimeoutMs(),
  );
  const [topologyDisablePtrLookups, setTopologyDisablePtrLookups] = useState(
    storageManager.getTopologyDisablePtrLookups(),
  );
  const [topologyDisableGeoLookups, setTopologyDisableGeoLookups] = useState(
    storageManager.getTopologyDisableGeoLookups(),
  );
  const [topologyGeoProvider, setTopologyGeoProvider] =
    useState<TopologyGeoProvider>(storageManager.getTopologyGeoProvider());
  const [topologyScanResolutionChain, setTopologyScanResolutionChain] =
    useState(storageManager.getTopologyScanResolutionChain());
  const [topologyDisableServiceDiscovery, setTopologyDisableServiceDiscovery] =
    useState(storageManager.getTopologyDisableServiceDiscovery());
  const [topologyTcpServices, setTopologyTcpServices] = useState<string[]>(
    storageManager.getTopologyTcpServices(),
  );
  const [cacheSettingsLoading, setCacheSettingsLoading] = useState(false);
  const [cacheSettingsError, setCacheSettingsError] = useState<string | null>(
    null,
  );
  const [zoneDevMode, setZoneDevMode] = useState<ZoneSetting<string> | null>(
    null,
  );
  const [zoneCacheLevel, setZoneCacheLevel] =
    useState<ZoneSetting<string> | null>(null);
  const [purgeUrlsInput, setPurgeUrlsInput] = useState("");
  const [showPurgeEverythingConfirm, setShowPurgeEverythingConfirm] =
    useState(false);
  const [showPurgeUrlsConfirm, setShowPurgeUrlsConfirm] = useState(false);
  const [pendingPurgeUrls, setPendingPurgeUrls] = useState<string[]>([]);
  const [pendingPurgeIssues, setPendingPurgeIssues] = useState<string[]>([]);
  const [sslSettingsLoading, setSslSettingsLoading] = useState(false);
  const [sslSettingsError, setSslSettingsError] = useState<string | null>(null);
  const [zoneSslMode, setZoneSslMode] = useState<ZoneSetting<string> | null>(
    null,
  );
  const [zoneMinTlsVersion, setZoneMinTlsVersion] =
    useState<ZoneSetting<string> | null>(null);
  const [zoneTls13, setZoneTls13] = useState<ZoneSetting<string> | null>(null);
  const [zoneAlwaysUseHttps, setZoneAlwaysUseHttps] =
    useState<ZoneSetting<string> | null>(null);
  const [zoneAutoHttpsRewrites, setZoneAutoHttpsRewrites] =
    useState<ZoneSetting<string> | null>(null);
  const [zoneOpportunisticEncryption, setZoneOpportunisticEncryption] =
    useState<ZoneSetting<string> | null>(null);
  const [domainAuditShowPassed, setDomainAuditShowPassed] = useState(false);
  const [domainAuditCategories, setDomainAuditCategories] = useState<
    Record<DomainAuditCategory, boolean>
  >(sanitizeDomainAuditCategories(storageManager.getDomainAuditCategories()));
  const [auditOverridesByZone, setAuditOverridesByZone] = useState<
    Record<string, Set<string>>
  >({});
  const [registryLookupDomain, setRegistryLookupDomain] = useState("");
  const [registryChecksLoading, setRegistryChecksLoading] = useState(false);
  const [registryChecksError, setRegistryChecksError] = useState<string | null>(
    null,
  );
  const [rdapResult, setRdapResult] = useState<Record<string, unknown> | null>(
    null,
  );
  const [showRawRdap, setShowRawRdap] = useState(false);
  const [registrarDomainResult, setRegistrarDomainResult] =
    useState<DomainInfo | null>(null);
  const [registrarHealthResult, setRegistrarHealthResult] =
    useState<DomainHealthCheck | null>(null);
  const {
    getZones,
    getDNSRecords,
    createDNSRecord,
    updateDNSRecord,
    bulkCreateDNSRecords,
    deleteDNSRecord,
    purgeCache,
    getZoneSetting,
    updateZoneSetting,
    registrarListAllDomains,
    registrarHealthCheckAll,
    simulateSPF,
    getSPFGraph,
    // New API methods
    getZoneAnalytics,
    getFirewallRules,
    createFirewallRule,
    updateFirewallRule,
    deleteFirewallRule,
    getIpAccessRules,
    createIpAccessRule,
    deleteIpAccessRule,
    getWafRulesets,
    getWorkerRoutes,
    createWorkerRoute,
    deleteWorkerRoute,
    getEmailRoutingSettings,
    getEmailRoutingRules,
    createEmailRoutingRule,
    deleteEmailRoutingRule,
    deleteBulkDnsRecords,
    checkDnsPropagation,
  } = useCloudflareAPI(apiKey, email);

  /* Helper: update any tab whose zoneId matches */
  const updateTabByZone = useCallback(
    (zoneId: string, fn: (prev: ZoneTab) => ZoneTab) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.zoneId === zoneId ? fn(tab) : tab)),
      );
    },
    [],
  );

  /* ── Undo / Redo ────────────────────────────────────── */
  const applyDnsOp = useCallback(
    async (op: DNSOp, onCreated?: (record: DNSRecord) => void) => {
      switch (op.kind) {
        case "create": {
          const created = await createDNSRecord(op.zoneId, op.record);
          onCreated?.(created);
          updateTabByZone(op.zoneId, (prev) => ({
            ...prev,
            records: [created, ...prev.records],
          }));
          break;
        }
        case "delete": {
          await deleteDNSRecord(op.zoneId, op.recordId);
          updateTabByZone(op.zoneId, (prev) => ({
            ...prev,
            records: prev.records.filter((r) => r.id !== op.recordId),
          }));
          break;
        }
        case "update": {
          const updated = await updateDNSRecord(
            op.zoneId,
            op.record.id,
            op.record,
          );
          updateTabByZone(op.zoneId, (prev) => ({
            ...prev,
            records: prev.records.map((r) =>
              r.id === op.record.id ? updated : r,
            ),
          }));
          break;
        }
        case "bulk-update": {
          const updated: DNSRecord[] = [];
          try {
            for (const record of op.records) {
              updated.push(await updateDNSRecord(op.zoneId, record.id, record));
            }
          } finally {
            // Whatever landed before a rejection is already live at
            // Cloudflare, so the table has to show it either way.
            if (updated.length) {
              const byId = new Map(updated.map((r) => [r.id, r]));
              updateTabByZone(op.zoneId, (prev) => ({
                ...prev,
                records: prev.records.map((r) => byId.get(r.id) ?? r),
              }));
            }
          }
          break;
        }
        case "bulk-create": {
          const created: DNSRecord[] = [];
          try {
            for (const record of op.records) {
              const next = await createDNSRecord(op.zoneId, record);
              created.push(next);
              onCreated?.(next);
            }
          } finally {
            if (created.length) {
              updateTabByZone(op.zoneId, (prev) => ({
                ...prev,
                records: [...created, ...prev.records],
              }));
            }
          }
          break;
        }
        case "bulk-delete": {
          const removed = new Set<string>();
          try {
            for (const record of op.records) {
              await deleteDNSRecord(op.zoneId, record.id);
              removed.add(record.id);
            }
          } finally {
            if (removed.size) {
              updateTabByZone(op.zoneId, (prev) => ({
                ...prev,
                records: prev.records.filter((r) => !removed.has(r.id)),
                selectedIds: prev.selectedIds.filter((id) => !removed.has(id)),
              }));
            }
          }
          break;
        }
      }
    },
    [createDNSRecord, deleteDNSRecord, updateDNSRecord, updateTabByZone],
  );

  /**
   * Run one half of a history entry and re-point the other half at whatever
   * was actually created. Recreating a record mints a new Cloudflare id, so
   * without this the entry that moves to the opposite stack still names the
   * dead id and every later undo/redo of it 404s.
   */
  const runHistoryOp = useCallback(
    async (
      op: DNSOp,
      pairedKey: "forward" | "reverse",
      entry: UndoRedoEntry<DNSOp>,
    ) => {
      const created: DNSRecord[] = [];
      try {
        await applyDnsOp(op, (record) => created.push(record));
      } finally {
        const repointed = repointPairedDnsOp(entry[pairedKey], created);
        // The hook moves this exact entry object between stacks, so patching
        // it here is what the next undo/redo will read.
        if (repointed) entry[pairedKey] = repointed;
      }
    },
    [applyDnsOp],
  );

  const {
    push: pushUndo,
    undo,
    redo,
  } = useUndoRedo<DNSOp>({
    onUndo: (reverse, entry) => runHistoryOp(reverse, "forward", entry),
    onRedo: (forward, entry) => runHistoryOp(forward, "reverse", entry),
  });

  /**
   * Record a bulk creation (paste or import) as one undoable step, so a single
   * Ctrl/⌘+Z removes every record the batch added.
   */
  const pushBulkCreateUndo = useCallback(
    (
      zoneId: string,
      records: readonly DNSRecord[],
      description: string,
    ): void => {
      const withIds = records.filter((record) => record?.id);
      if (!withIds.length) return;
      pushUndo({
        description,
        forward: { kind: "bulk-create", zoneId, records: [...withIds] },
        reverse: { kind: "bulk-delete", zoneId, records: [...withIds] },
      });
    },
    [pushUndo],
  );

  /* Global keyboard shortcuts: Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z redo */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  const availableZones = useMemo(
    () => zones.filter((zone) => zone.id),
    [zones],
  );

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const topologySearchTerm =
    activeTab?.kind === "zone" ? activeTab.searchTerm : "";
  const topologyTypeFilter =
    activeTab?.kind === "zone" ? activeTab.typeFilter : "";
  const topologyQueryKey = useMemo(
    () =>
      activeTab?.kind === "zone"
        ? JSON.stringify([
            activeTab.zoneId,
            topologySearchTerm.trim().toLowerCase(),
            topologyTypeFilter,
            topologySearchTerm.trim() ? tagsVersion : 0,
          ])
        : "",
    [
      activeTab?.kind,
      activeTab?.zoneId,
      tagsVersion,
      topologySearchTerm,
      topologyTypeFilter,
    ],
  );
  const currentSessionId = useMemo(
    () => storageManager.getCurrentSession() ?? "__default",
    [],
  );
  const sessionProfileIds = useMemo(
    () =>
      Object.keys(sessionSettingsProfiles).sort((a, b) => a.localeCompare(b)),
    [sessionSettingsProfiles],
  );

  const buildSessionSettingsProfile =
    useCallback((): SessionSettingsProfile => {
      return {
        autoRefreshInterval,
        rewriteCopiedRecordDomains,
        defaultPerPage: globalPerPage,
        zonePerPage,
        showUnsupportedRecordTypes,
        zoneShowUnsupportedRecordTypes,
        reopenLastTabs,
        reopenZoneTabs,
        confirmLogout,
        idleLogoutMs,
        confirmWindowClose,
        closeTabOnMiddleClick,
        mcpServerEnabled,
        mcpServerHost,
        mcpServerPort,
        mcpEnabledTools,
        loadingOverlayTimeoutMs,
        topologyResolutionMaxHops,
        topologyResolverMode,
        topologyDnsServer,
        topologyCustomDnsServer,
        topologyDohProvider,
        topologyDohCustomUrl,
        topologyExportConfirmPath,
        topologyExportFolderPreset,
        topologyExportCustomPath,
        topologyCopyActions,
        topologyExportActions,
        topologyDisableAnnotations,
        topologyDisableFullWindow,
        topologyLookupTimeoutMs,
        topologyDisablePtrLookups,
        topologyDisableGeoLookups,
        topologyGeoProvider,
        topologyScanResolutionChain,
        topologyDisableServiceDiscovery,
        topologyTcpServices,
        auditExportDefaultDocuments,
        confirmClearAuditLogs,
        auditExportFolderPreset,
        auditExportCustomPath,
        auditExportSkipDestinationConfirm,
        domainAuditCategories,
      };
    }, [
      autoRefreshInterval,
      rewriteCopiedRecordDomains,
      globalPerPage,
      zonePerPage,
      showUnsupportedRecordTypes,
      zoneShowUnsupportedRecordTypes,
      reopenLastTabs,
      reopenZoneTabs,
      confirmLogout,
      idleLogoutMs,
      confirmWindowClose,
      closeTabOnMiddleClick,
      mcpServerEnabled,
      mcpServerHost,
      mcpServerPort,
      mcpEnabledTools,
      loadingOverlayTimeoutMs,
      topologyResolutionMaxHops,
      topologyResolverMode,
      topologyDnsServer,
      topologyCustomDnsServer,
      topologyDohProvider,
      topologyDohCustomUrl,
      topologyExportConfirmPath,
      topologyExportFolderPreset,
      topologyExportCustomPath,
      topologyCopyActions,
      topologyExportActions,
      topologyDisableAnnotations,
      topologyDisableFullWindow,
      topologyLookupTimeoutMs,
      topologyDisablePtrLookups,
      topologyDisableGeoLookups,
      topologyGeoProvider,
      topologyScanResolutionChain,
      topologyDisableServiceDiscovery,
      topologyTcpServices,
      auditExportDefaultDocuments,
      confirmClearAuditLogs,
      auditExportFolderPreset,
      auditExportCustomPath,
      auditExportSkipDestinationConfirm,
      domainAuditCategories,
    ]);

  const applySessionSettingsProfile = useCallback(
    (profile: SessionSettingsProfile) => {
      if (
        typeof profile.autoRefreshInterval === "number" ||
        profile.autoRefreshInterval === null
      ) {
        setAutoRefreshInterval(
          clampAutoRefreshInterval(profile.autoRefreshInterval),
        );
      }
      if (typeof profile.rewriteCopiedRecordDomains === "boolean") {
        setRewriteCopiedRecordDomains(profile.rewriteCopiedRecordDomains);
      }
      if (typeof profile.defaultPerPage === "number") {
        setGlobalPerPage(clampDnsPageSize(profile.defaultPerPage));
      }
      if (profile.zonePerPage && typeof profile.zonePerPage === "object") {
        setZonePerPage(clampZonePerPageMap(profile.zonePerPage));
      }
      if (typeof profile.showUnsupportedRecordTypes === "boolean") {
        setShowUnsupportedRecordTypes(profile.showUnsupportedRecordTypes);
      }
      if (
        profile.zoneShowUnsupportedRecordTypes &&
        typeof profile.zoneShowUnsupportedRecordTypes === "object"
      ) {
        setZoneShowUnsupportedRecordTypes(
          profile.zoneShowUnsupportedRecordTypes,
        );
      }
      if (typeof profile.reopenLastTabs === "boolean") {
        setReopenLastTabs(profile.reopenLastTabs);
      }
      if (
        profile.reopenZoneTabs &&
        typeof profile.reopenZoneTabs === "object"
      ) {
        setReopenZoneTabs(profile.reopenZoneTabs);
      }
      if (typeof profile.confirmLogout === "boolean") {
        setConfirmLogout(profile.confirmLogout);
      }
      if (
        typeof profile.idleLogoutMs === "number" ||
        profile.idleLogoutMs === null
      ) {
        setIdleLogoutMs(profile.idleLogoutMs ?? null);
      }
      if (typeof profile.confirmWindowClose === "boolean") {
        setConfirmWindowClose(profile.confirmWindowClose);
      }
      if (typeof profile.closeTabOnMiddleClick === "boolean") {
        setCloseTabOnMiddleClick(profile.closeTabOnMiddleClick);
      }
      if (typeof profile.mcpServerEnabled === "boolean") {
        setMcpServerEnabled(profile.mcpServerEnabled);
      }
      if (typeof profile.mcpServerHost === "string") {
        setMcpServerHost(profile.mcpServerHost || "127.0.0.1");
      }
      if (typeof profile.mcpServerPort === "number") {
        setMcpServerPort(
          Math.max(1, Math.min(65535, Math.round(profile.mcpServerPort))),
        );
      }
      if (Array.isArray(profile.mcpEnabledTools)) {
        const requestedTools = normalizeMcpToolIds(profile.mcpEnabledTools);
        if (!sameMcpToolIds(requestedTools, mcpEnabledToolsRef.current)) {
          mcpPermissionsReadyRef.current = false;
          setMcpPermissionsReady(false);
        }
        mcpRequestedToolsRef.current = requestedTools;
        setMcpRequestedTools(requestedTools);
      }
      if (typeof profile.loadingOverlayTimeoutMs === "number") {
        setLoadingOverlayTimeoutMs(
          Math.max(1000, Math.min(60000, profile.loadingOverlayTimeoutMs)),
        );
      }
      if (typeof profile.topologyResolutionMaxHops === "number") {
        setTopologyResolutionMaxHops(
          Math.max(
            1,
            Math.min(15, Math.round(profile.topologyResolutionMaxHops)),
          ),
        );
      }
      if (
        profile.topologyResolverMode === "dns" ||
        profile.topologyResolverMode === "doh"
      ) {
        setTopologyResolverMode(profile.topologyResolverMode);
      }
      if (typeof profile.topologyDnsServer === "string") {
        setTopologyDnsServer(profile.topologyDnsServer || "1.1.1.1");
      }
      if (typeof profile.topologyCustomDnsServer === "string") {
        setTopologyCustomDnsServer(profile.topologyCustomDnsServer);
      }
      if (
        profile.topologyDohProvider === "google" ||
        profile.topologyDohProvider === "cloudflare" ||
        profile.topologyDohProvider === "quad9" ||
        profile.topologyDohProvider === "custom"
      ) {
        setTopologyDohProvider(profile.topologyDohProvider);
      }
      if (typeof profile.topologyDohCustomUrl === "string") {
        setTopologyDohCustomUrl(profile.topologyDohCustomUrl);
      }
      if (typeof profile.topologyExportConfirmPath === "boolean") {
        setTopologyExportConfirmPath(profile.topologyExportConfirmPath);
      }
      if (typeof profile.topologyExportFolderPreset === "string") {
        setTopologyExportFolderPreset(
          profile.topologyExportFolderPreset as ExportFolderPreset,
        );
      }
      if (typeof profile.topologyExportCustomPath === "string") {
        setTopologyExportCustomPath(profile.topologyExportCustomPath);
      }
      if (Array.isArray(profile.topologyCopyActions)) {
        setTopologyCopyActions(
          Array.from(
            new Set(
              profile.topologyCopyActions
                .map((v) => String(v).trim())
                .filter(
                  (v): v is TopologyCopyAction =>
                    v === "mermaid" || v === "svg" || v === "png",
                ),
            ),
          ),
        );
      }
      if (Array.isArray(profile.topologyExportActions)) {
        setTopologyExportActions(
          Array.from(
            new Set(
              profile.topologyExportActions
                .map((v) => String(v).trim())
                .filter(
                  (v): v is TopologyExportAction =>
                    v === "mermaid" ||
                    v === "svg" ||
                    v === "png" ||
                    v === "pdf",
                ),
            ),
          ),
        );
      }
      if (typeof profile.topologyDisableAnnotations === "boolean") {
        setTopologyDisableAnnotations(profile.topologyDisableAnnotations);
      }
      if (typeof profile.topologyDisableFullWindow === "boolean") {
        setTopologyDisableFullWindow(profile.topologyDisableFullWindow);
      }
      if (typeof profile.topologyLookupTimeoutMs === "number") {
        setTopologyLookupTimeoutMs(
          Math.max(
            250,
            Math.min(10000, Math.round(profile.topologyLookupTimeoutMs)),
          ),
        );
      }
      if (typeof profile.topologyDisablePtrLookups === "boolean") {
        setTopologyDisablePtrLookups(profile.topologyDisablePtrLookups);
      }
      if (typeof profile.topologyDisableGeoLookups === "boolean") {
        setTopologyDisableGeoLookups(profile.topologyDisableGeoLookups);
      }
      if (
        profile.topologyGeoProvider === "auto" ||
        profile.topologyGeoProvider === "ipwhois" ||
        profile.topologyGeoProvider === "ipapi_co" ||
        profile.topologyGeoProvider === "ip_api" ||
        profile.topologyGeoProvider === "internal"
      ) {
        setTopologyGeoProvider(profile.topologyGeoProvider);
      }
      if (typeof profile.topologyScanResolutionChain === "boolean") {
        setTopologyScanResolutionChain(profile.topologyScanResolutionChain);
      }
      if (typeof profile.topologyDisableServiceDiscovery === "boolean") {
        setTopologyDisableServiceDiscovery(
          profile.topologyDisableServiceDiscovery,
        );
      }
      if (Array.isArray(profile.topologyTcpServices)) {
        setTopologyTcpServices(
          Array.from(
            new Set(
              profile.topologyTcpServices
                .map((v) => String(v).trim())
                .filter(Boolean),
            ),
          ),
        );
      }
      if (typeof profile.auditExportDefaultDocuments === "boolean") {
        setAuditExportDefaultDocuments(profile.auditExportDefaultDocuments);
      }
      if (typeof profile.confirmClearAuditLogs === "boolean") {
        setConfirmClearAuditLogs(profile.confirmClearAuditLogs);
      }
      if (typeof profile.auditExportFolderPreset === "string") {
        setAuditExportFolderPreset(
          profile.auditExportFolderPreset as ExportFolderPreset,
        );
      }
      if (typeof profile.auditExportCustomPath === "string") {
        setAuditExportCustomPath(profile.auditExportCustomPath);
      }
      if (typeof profile.auditExportSkipDestinationConfirm === "boolean") {
        setAuditExportSkipDestinationConfirm(
          profile.auditExportSkipDestinationConfirm,
        );
      }
      if (profile.domainAuditCategories) {
        setDomainAuditCategories(
          sanitizeDomainAuditCategories(profile.domainAuditCategories),
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!prefsReady) return;
    if (sessionProfileHydratedRef.current) return;
    const profile = sessionSettingsProfiles[currentSessionId];
    if (profile) {
      applySessionSettingsProfile(profile);
    }
    sessionProfileHydratedRef.current = true;
    setMcpSessionPreferencesRevision((revision) => revision + 1);
  }, [
    applySessionSettingsProfile,
    currentSessionId,
    prefsReady,
    sessionSettingsProfiles,
  ]);

  const resolvedShowUnsupportedRecordTypes = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone")
      return showUnsupportedRecordTypes;
    const zoneId = activeTab.zoneId;
    if (
      Object.prototype.hasOwnProperty.call(
        zoneShowUnsupportedRecordTypes,
        zoneId,
      )
    )
      return zoneShowUnsupportedRecordTypes[zoneId] === true;
    return showUnsupportedRecordTypes;
  }, [activeTab, showUnsupportedRecordTypes, zoneShowUnsupportedRecordTypes]);

  const [domainAuditItems, setDomainAuditItems] = useState<DomainAuditItem[]>(
    [],
  );

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") {
      setDomainAuditItems([]);
      return;
    }
    let active = true;
    const zone = activeTab.zoneName.trim().toLowerCase();
    const registrarExpiry =
      registrarDomainResult &&
      registrarDomainResult.domain.trim().toLowerCase() === zone
        ? registrarDomainResult.expires_at
        : null;
    const rdapEventsRaw = Array.isArray(
      (rdapResult as Record<string, unknown> | null)?.events,
    )
      ? ((rdapResult as Record<string, unknown>).events as Array<
          Record<string, unknown>
        >)
      : [];
    const rdapExpiryEvent =
      rdapEventsRaw
        .find((event) =>
          String(event.eventAction ?? "")
            .toLowerCase()
            .includes("expiration"),
        )
        ?.eventDate?.toString() ?? null;
    const opts = {
      includeCategories: domainAuditCategories,
      domainExpiresAt: registrarExpiry ?? rdapExpiryEvent,
    };
    if (isDesktop()) {
      const records =
        activeTab.records as unknown as import("@/lib/api/tauri-client").TauriDNSRecord[];
      TauriClient.runDomainAudit(activeTab.zoneName, records, opts)
        .then((items) => {
          if (active) setDomainAuditItems(items);
        })
        .catch((error) => {
          reportDnsManagerFailure(error, "Run desktop DNS audit");
          if (!active) return;
          // Fallback to frontend implementation on error
          setDomainAuditItems(
            runDomainAudit(activeTab.zoneName, activeTab.records, opts),
          );
        });
    } else {
      setDomainAuditItems(
        runDomainAudit(activeTab.zoneName, activeTab.records, opts),
      );
    }
    return () => {
      active = false;
    };
  }, [activeTab, domainAuditCategories, rdapResult, registrarDomainResult]);

  const domainAuditItemsWithOverrides = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return domainAuditItems;
    const overrides = auditOverridesByZone[activeTab.zoneId] ?? new Set();
    return domainAuditItems.map((item) => {
      if (overrides.has(item.id) && item.severity !== "pass") {
        return {
          ...item,
          severity: "pass" as const,
          title: `${item.title} (overridden)`,
          details: `Original severity: ${item.severity}\n\n${item.details}`,
        };
      }
      return item;
    });
  }, [activeTab, auditOverridesByZone, domainAuditItems]);

  const domainAuditVisibleItems = useMemo(() => {
    if (domainAuditShowPassed) return domainAuditItemsWithOverrides;
    return domainAuditItemsWithOverrides.filter((i) => i.severity !== "pass");
  }, [domainAuditItemsWithOverrides, domainAuditShowPassed]);

  const parseLastActiveTab = useCallback(
    (value: string): { tabId: string; action?: ActionTab } | null => {
      const raw = value.trim();
      if (!raw) return null;
      if (raw.startsWith("__")) return { tabId: raw };
      if (
        raw === "records" ||
        raw === "import" ||
        raw === "zone-settings" ||
        raw === "cache" ||
        raw === "ssl-tls" ||
        raw === "domain-audit" ||
        raw === "domain-registry" ||
        raw === "topology" ||
        raw === "reference"
      ) {
        // Legacy malformed value (action without zone id): ignore.
        return null;
      }
      const [zoneId, actionRaw] = raw.split("|", 2);
      if (!zoneId) return null;
      if (
        actionRaw === "records" ||
        actionRaw === "import" ||
        actionRaw === "zone-settings" ||
        actionRaw === "cache" ||
        actionRaw === "ssl-tls" ||
        actionRaw === "domain-audit" ||
        actionRaw === "domain-registry" ||
        actionRaw === "topology" ||
        actionRaw === "reference"
      ) {
        return { tabId: zoneId, action: actionRaw };
      }
      return { tabId: zoneId };
    },
    [],
  );

  const updateTab = useCallback(
    (tabId: string, updater: (tab: ZoneTab) => ZoneTab) => {
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== tabId) return tab;
          const updated = updater(tab);
          const bounded = retainDnsRecordsForUi(updated.records);
          if (!bounded.limited) return updated;
          return {
            ...updated,
            records: bounded.records,
            recordsLimited: true,
            sourceRecordCount: Math.max(
              updated.sourceRecordCount,
              bounded.sourceRecordCount,
            ),
          };
        }),
      );
    },
    [],
  );

  const openZoneTab = useCallback(
    (zoneId: string) => {
      const zone = availableZones.find((item) => item.id === zoneId);
      if (!zone) return;
      if (tabs.some((tab) => tab.zoneId === zoneId)) {
        setActiveTabId(zoneId);
        return;
      }
      const perPage = clampDnsPageSize(zonePerPage[zoneId] ?? globalPerPage);
      const bounded = appendBoundedZoneTab(
        tabs,
        createZoneTab(zone, perPage),
        activeTabId,
      );
      if (!bounded.opened) {
        toast({
          title: t("Tab limit reached", "Tab limit reached"),
          description: t(
            "Close or finish an inactive DNS draft before opening another zone.",
            "Close or finish an inactive DNS draft before opening another zone.",
          ),
          variant: "destructive",
        });
        return;
      }
      if (bounded.evictedTabId) {
        recordRequestGenerationsRef.current.invalidate(bounded.evictedTabId);
      }
      // Restoring a session calls this once per persisted tab in a single tick.
      // A non-functional update would compute every append from the same stale
      // `tabs` snapshot, so all but the last tab would be dropped and the
      // persisted order lost. Recompute against the queued state instead.
      setTabs((prev) => {
        if (prev === tabs) return bounded.tabs;
        if (prev.some((tab) => tab.zoneId === zoneId)) return prev;
        const next = appendBoundedZoneTab(
          prev,
          createZoneTab(zone, perPage),
          activeTabId,
        );
        if (next.evictedTabId) {
          recordRequestGenerationsRef.current.invalidate(next.evictedTabId);
        }
        return next.opened ? next.tabs : prev;
      });
      setActiveTabId(zoneId);
    },
    [activeTabId, availableZones, globalPerPage, tabs, t, toast, zonePerPage],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      const nextTab = tabs.find((tab) => tab.id === tabId);
      setActiveTabId(tabId);
      if (nextTab?.kind === "zone") {
        setSelectedZoneId(tabId);
        setActionTab("records");
      } else {
        setSelectedZoneId("");
      }
    },
    [tabs],
  );

  const closeTab = useCallback((tabId: string) => {
    recordRequestGenerationsRef.current.invalidate(tabId);
    setTabs((prev) => {
      if (!prev.some((tab) => tab.id === tabId)) return prev;

      const nextTabs = prev.filter((tab) => tab.id !== tabId);
      setActiveTabId((currentActiveId) => {
        const nextActiveId = getNextActiveTabIdAfterClose(
          prev,
          currentActiveId,
          tabId,
        );
        if (nextActiveId === currentActiveId) return currentActiveId;

        const nextActive = nextTabs.find((tab) => tab.id === nextActiveId);
        if (nextActive?.kind === "zone") {
          setSelectedZoneId(nextActive.zoneId);
          setActionTab("records");
        } else {
          setSelectedZoneId("");
        }
        return nextActiveId;
      });
      return nextTabs;
    });
  }, []);

  useEffect(() => {
    setTabs((previous) => evictInactiveTabRecords(previous, activeTabId));
  }, [activeTabId]);

  // The shell keeps one persistent scroll node, so switching to a shorter view
  // would otherwise drop the viewer halfway down a page they never scrolled.
  // The node carries `scroll-smooth`, hence scrollTo with an explicit "auto".
  useEffect(() => {
    if (typeof document === "undefined") return;
    const region = document.querySelector<HTMLElement>(
      '[data-app-shell-scroll-region="body"]',
    );
    if (typeof region?.scrollTo !== "function") return;
    region.scrollTo({ top: 0, behavior: "auto" });
  }, [activeTabId, actionTab]);

  /**
   * Bring one record into view in the records list: narrow the list to it,
   * switch to the records panel, then scroll to and flash its row.
   */
  const revealRecord = useCallback(
    (record: DNSRecord) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      const isKnownType = (type: string): type is RecordType =>
        (RECORD_TYPES as readonly string[]).includes(type);
      const typeFilter: RecordType | "" = isKnownType(record.type)
        ? record.type
        : "";
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        searchTerm: record.name,
        typeFilter,
        editingRecord: null,
      }));
      setActionTab("records");
      setRevealedRecordId(record.id);
    },
    [activeTab, updateTab],
  );

  useEffect(() => {
    if (!revealedRecordId || actionTab !== "records") return;
    if (typeof document === "undefined") return;
    // Cloudflare ids are hex, but `CSS.escape` is missing in some test DOMs.
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(revealedRecordId)
        : revealedRecordId.replace(/["\\]/g, "\\$&");
    const row = document.querySelector<HTMLElement>(
      `[data-record-row="${escaped}"]`,
    );
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    row?.focus?.({ preventScroll: true });
    const timer = window.setTimeout(() => setRevealedRecordId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [revealedRecordId, actionTab]);

  const focusActionTab = useCallback((index: number) => {
    const tab = ACTION_TABS[(index + ACTION_TABS.length) % ACTION_TABS.length];
    if (!tab) return;
    setActionTab(tab.id);
    actionTabRefs.current.get(tab.id)?.focus();
  }, []);

  const handleActionTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusActionTab(index + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusActionTab(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusActionTab(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusActionTab(ACTION_TABS.length - 1);
      }
    },
    [focusActionTab],
  );

  const openActionTab = useCallback((kind: Exclude<TabKind, "zone">) => {
    const id = `__${kind}`;
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === id)) return prev;
      return [...prev, createActionTab(kind)];
    });
    setActiveTabId(id);
    setSelectedZoneId("");
  }, []);

  // ── Notifications (t9) ─────────────────────────────────────────────────
  // Start the desktop background monitor with the unlocked token, keep the
  // bell badge in sync with `notifications://changed`, toast new items that
  // pass `inApp.toastMinSeverity`, and stop the service when this component
  // unmounts (every logout path — explicit, confirmed and idle — unmounts it).
  const [notificationsUnread, setNotificationsUnread] = useState(0);
  const [notificationsBadge, setNotificationsBadge] = useState(true);
  const pendingNotificationRevealRef = useRef<{
    zoneId: string;
    recordId: string;
  } | null>(null);
  // `isDesktop()` is true whenever `__TAURI__` is present (jsdom tests set
  // it), but IPC needs the internals bridge; skip the service without it.
  const notificationsAvailable =
    isDesktop() &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!notificationsAvailable) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    let lastSeenAt = new Date().toISOString();

    const announceNew = async () => {
      const [settings, fresh] = await Promise.all([
        TauriClient.notificationsGetSettings(),
        TauriClient.notificationsList({ scope: "unread", limit: 20 }),
      ]);
      if (cancelled) return;
      setNotificationsBadge(settings.inApp.badge);
      const newest = fresh
        .filter((item) => item.createdAt > lastSeenAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (newest.length === 0) return;
      lastSeenAt = newest[0].createdAt;
      for (const item of newest.slice(0, 3)) {
        if (!toastAllowed(settings, item.severity)) continue;
        toast({
          title: item.title,
          description: item.body,
          variant: item.severity === "critical" ? "destructive" : undefined,
        });
      }
    };

    const bootstrap = async () => {
      try {
        const status = await TauriClient.notificationsStart(apiKey, email);
        if (cancelled) return;
        setNotificationsUnread(status.unread);
        const settings = await TauriClient.notificationsGetSettings();
        if (cancelled) return;
        setNotificationsBadge(settings.inApp.badge);
        unlisten = await TauriClient.onNotificationsChanged(({ unread }) => {
          if (cancelled) return;
          setNotificationsUnread(unread);
          void announceNew().catch((error) =>
            reportDnsManagerFailure(error, "Announce new notifications"),
          );
        });
        if (cancelled) {
          unlisten();
          unlisten = null;
        }
      } catch (error) {
        if (!cancelled)
          reportDnsManagerFailure(error, "Start notification monitoring");
      }
    };
    void bootstrap();

    return () => {
      cancelled = true;
      unlisten?.();
      void TauriClient.notificationsStop().catch((error) =>
        reportDnsManagerFailure(error, "Stop notification monitoring"),
      );
    };
  }, [apiKey, email, notificationsAvailable, toast]);

  /** "Go to record" from the inbox: open the zone, reveal once its records load. */
  const revealNotificationRecord = useCallback(
    (zoneId: string, recordId: string) => {
      if (!availableZones.some((zone) => zone.id === zoneId)) {
        toast({
          title: t("Zone not available", "Zone not available"),
          description: t(
            "The zone this notification refers to is not in the current account.",
            "The zone this notification refers to is not in the current account.",
          ),
          variant: "destructive",
        });
        return;
      }
      pendingNotificationRevealRef.current = { zoneId, recordId };
      openZoneTab(zoneId);
    },
    [availableZones, openZoneTab, t, toast],
  );

  useEffect(() => {
    const pending = pendingNotificationRevealRef.current;
    if (!pending || !activeTab || activeTab.kind !== "zone") return;
    if (activeTab.zoneId !== pending.zoneId || activeTab.isLoading) return;
    const record = activeTab.records.find(
      (candidate) => candidate.id === pending.recordId,
    );
    if (record) {
      pendingNotificationRevealRef.current = null;
      revealRecord(record);
      return;
    }
    // Records finished loading (or failed) and the id is gone.
    if (activeTab.recordLoadState) {
      pendingNotificationRevealRef.current = null;
      toast({
        title: t("Record not found", "Record not found"),
        description: t(
          "The record may have been removed since the notification was created.",
          "The record may have been removed since the notification was created.",
        ),
      });
    }
  }, [activeTab, revealRecord, t, toast]);

  const loadZones = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const zonesData = await getZones(signal);
        setZones(zonesData);
      } catch (error) {
        if (
          signal?.aborted ||
          (error as Error).name === "AbortError" ||
          (error as { kind?: string }).kind === "aborted"
        ) {
          return;
        }
        toast({
          title: t("Error", "Error"),
          description: t("Failed to load zones: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to load zones: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      }
    },
    [getZones, t, toast],
  );

  /**
   * Apply a tab order produced by the tab strip. The persisted `last_open_tabs`
   * list is driven off `tabs`, so reordering here is what makes the new order
   * survive a reload.
   */
  const applyTabOrder = useCallback((orderedIds: string[]) => {
    setTabs((prev) => {
      const next = reconcileTabOrder(prev, orderedIds);
      const unchanged =
        next.length === prev.length &&
        next.every((tab, index) => tab.id === prev[index]?.id);
      return unchanged ? prev : next;
    });
  }, []);

  const loadAuditEntries = useCallback(async () => {
    if (!isDesktop()) {
      setAuditError(
        t(
          "Audit log is only available in the desktop app.",
          "Audit log is only available in the desktop app.",
        ),
      );
      return;
    }
    setAuditLoading(true);
    setAuditError(null);
    try {
      const list = await TauriClient.getAuditEntries();
      const items = Array.isArray(list)
        ? (list as Array<Record<string, unknown>>)
        : [];
      setAuditEntries(items);
    } catch (err) {
      setAuditError((err as Error).message);
    } finally {
      setAuditLoading(false);
    }
  }, [t]);

  const loadRecords = useCallback(
    async (tab: ZoneTab, signal?: AbortSignal) => {
      if (!tab.zoneId) return;
      const generation = recordRequestGenerationsRef.current.begin(tab.id);
      const ownsGeneration = () =>
        recordRequestGenerationsRef.current.isCurrent(tab.id, generation);
      const isCurrentRequest = () => !signal?.aborted && ownsGeneration();

      updateTab(tab.id, (prev) => ({ ...prev, isLoading: true }));
      try {
        let combined: DNSRecord[];
        let recordsLimited = false;
        let sourceRecordCount = 0;
        if (tab.perPage === 0) {
          const pageSize = DNS_API_PAGE_SIZE_LIMIT;
          let currentPage = 1;
          let lastBatchWasFull = false;
          combined = [];
          while (combined.length < DNS_RECORD_MEMORY_LIMIT) {
            const batch = await getDNSRecords(
              tab.zoneId,
              currentPage,
              pageSize,
              signal,
            );
            if (!isCurrentRequest()) return;
            sourceRecordCount += batch.length;
            const available = DNS_RECORD_MEMORY_LIMIT - combined.length;
            if (batch.length > available) {
              combined.push(...batch.slice(0, available));
              recordsLimited = true;
              break;
            }
            combined.push(...batch);
            lastBatchWasFull = batch.length === pageSize;
            if (!lastBatchWasFull) break;
            currentPage += 1;
          }
          if (
            !recordsLimited &&
            lastBatchWasFull &&
            combined.length === DNS_RECORD_MEMORY_LIMIT
          ) {
            const overflowBatch = await getDNSRecords(
              tab.zoneId,
              currentPage,
              pageSize,
              signal,
            );
            if (!isCurrentRequest()) return;
            sourceRecordCount += overflowBatch.length;
            recordsLimited = overflowBatch.length > 0;
          }
        } else {
          const requestedPageSize = clampDnsPageSize(tab.perPage);
          const result = await getDNSRecords(
            tab.zoneId,
            Math.max(1, Math.round(tab.page)),
            requestedPageSize,
            signal,
          );
          if (!isCurrentRequest()) return;
          const bounded = retainDnsRecordsForUi(result);
          combined = bounded.records;
          recordsLimited = bounded.limited;
          sourceRecordCount = bounded.sourceRecordCount;
        }
        if (!isCurrentRequest()) return;
        updateTab(tab.id, (prev) => ({
          ...prev,
          records: combined,
          recordsLimited,
          sourceRecordCount,
          recordLoadState: { status: "ready", loadedAt: Date.now() },
        }));
        // Persist to offline cache on success
        if (isCurrentRequest()) {
          cacheZoneRecords(tab.zoneId, tab.zoneName, combined);
        }
      } catch (error) {
        if (
          !isCurrentRequest() ||
          signal?.aborted ||
          (error as Error).name === "AbortError"
        ) {
          return;
        }
        const failure = createDnsRecordLoadFailure(
          error,
          tab.zoneId,
          tab.zoneName,
        );
        // Try offline cache fallback
        const cached = getCachedZoneRecords(tab.zoneId);
        if (!isCurrentRequest()) return;
        if (cached) {
          const bounded = retainDnsRecordsForUi(cached.records as DNSRecord[]);
          const cacheReachedUiCap =
            cached.records.length >= DNS_RECORD_MEMORY_LIMIT;
          if (!isCurrentRequest()) return;
          updateTab(tab.id, (prev) => ({
            ...prev,
            records: bounded.records,
            recordsLimited: bounded.limited || cacheReachedUiCap,
            sourceRecordCount: bounded.sourceRecordCount,
            recordLoadState: {
              status: "stale",
              source: "cache",
              snapshotAt: cached.cachedAt,
              failure,
            },
          }));
          if (!isCurrentRequest()) return;
          toast({
            title: t("Offline", "Offline"),
            description: t("Showing cached records from {{time}}", {
              time: new Date(cached.cachedAt).toLocaleString(),
              defaultValue: `Showing cached records from ${new Date(cached.cachedAt).toLocaleString()}`,
            }),
            diagnostic: failure.diagnostic,
          });
        } else {
          if (!isCurrentRequest()) return;
          updateTab(tab.id, (prev) => {
            const snapshotAt =
              prev.recordLoadState?.status === "ready"
                ? prev.recordLoadState.loadedAt
                : prev.recordLoadState?.status === "stale"
                  ? prev.recordLoadState.snapshotAt
                  : undefined;
            return {
              ...prev,
              recordLoadState:
                prev.records.length > 0
                  ? {
                      status: "stale",
                      source: "last-good",
                      snapshotAt,
                      failure,
                    }
                  : { status: "error", failure },
            };
          });
          toast({
            title: t("Error", "Error"),
            description: t("Failed to load DNS records: {{error}}", {
              error: failure.message,
              defaultValue: `Failed to load DNS records: ${failure.message}`,
            }),
            variant: "destructive",
            diagnostic: failure.diagnostic,
          });
        }
      } finally {
        if (ownsGeneration()) {
          updateTab(tab.id, (prev) => ({ ...prev, isLoading: false }));
        }
      }
    },
    [getDNSRecords, t, toast, updateTab],
  );

  const loadTopologyRecords = useCallback(
    async (
      zoneId: string,
      queryKey: string,
      searchTerm: string,
      typeFilter: RecordType | "",
    ) => {
      topologyRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestId = ++nextTopologyRequestIdRef.current;
      topologyRequestRef.current = {
        id: requestId,
        queryKey,
        controller,
      };
      setTopologyRecordState({
        status: "loading",
        queryKey,
        records: [],
        scannedRecordCount: 0,
        pageCount: 0,
        matchingRecordCountLowerBound: 0,
        error: null,
      });

      const isCurrentRequest = () =>
        !controller.signal.aborted &&
        topologyRequestRef.current?.id === requestId;

      try {
        const result = await loadAuthoritativeDnsRecordsForTopology(
          getDNSRecords,
          zoneId,
          {
            searchTerm,
            typeFilter,
            getRecordTags: searchTerm.trim()
              ? (record) => storageManager.getRecordTags(zoneId, record.id)
              : undefined,
          },
          controller.signal,
        );
        if (!isCurrentRequest()) return;
        setTopologyRecordState({
          status: result.status,
          queryKey,
          records: result.records,
          scannedRecordCount: result.scannedRecordCount,
          pageCount: result.pageCount,
          matchingRecordCountLowerBound:
            result.status === "ready"
              ? result.records.length
              : result.matchingRecordCountLowerBound,
          error: null,
        });
      } catch (error) {
        if (
          !isCurrentRequest() ||
          controller.signal.aborted ||
          (error as Error).name === "AbortError"
        ) {
          return;
        }
        const diagnostic = reportDnsManagerFailure(
          error,
          "Load authoritative DNS topology records",
        );
        setTopologyRecordState({
          status: "error",
          queryKey,
          records: [],
          scannedRecordCount: 0,
          pageCount: 0,
          matchingRecordCountLowerBound: 0,
          error: diagnostic.message,
        });
      } finally {
        if (topologyRequestRef.current?.id === requestId) {
          topologyRequestRef.current = null;
        }
      }
    },
    [getDNSRecords],
  );

  const loadTagManagerRecords = useCallback(
    async (zoneId: string, signal?: AbortSignal) => {
      if (!zoneId) {
        setTagManagerRecords([]);
        setTagManagerRecordsLimited(false);
        setTagManagerRecordsError(null);
        return;
      }
      setTagManagerRecordsLoading(true);
      setTagManagerRecordsLimited(false);
      setTagManagerRecordsError(null);
      try {
        const pageSize = DNS_API_PAGE_SIZE_LIMIT;
        let currentPage = 1;
        const combined: DNSRecord[] = [];
        let limited = false;
        while (combined.length < DNS_RECORD_MEMORY_LIMIT) {
          const batch = await getDNSRecords(
            zoneId,
            currentPage,
            pageSize,
            signal,
          );
          const available = DNS_RECORD_MEMORY_LIMIT - combined.length;
          if (batch.length > available) {
            combined.push(...batch.slice(0, available));
            limited = true;
            break;
          }
          combined.push(...batch);
          if (batch.length < pageSize) break;
          if (combined.length >= DNS_RECORD_MEMORY_LIMIT) {
            limited = true;
            break;
          }
          currentPage += 1;
        }
        setTagManagerRecords(combined);
        setTagManagerRecordsLimited(limited);
      } catch (error) {
        if (
          signal?.aborted ||
          (error as Error).name === "AbortError" ||
          (error as { kind?: string }).kind === "aborted"
        ) {
          return;
        }
        setTagManagerRecordsError((error as Error).message);
      } finally {
        setTagManagerRecordsLoading(false);
      }
    },
    [getDNSRecords],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadZones(controller.signal);
    return () => controller.abort();
  }, [loadZones]);

  useEffect(
    () => () => {
      exportRequestRef.current?.abort();
      exportRequestRef.current = null;
      topologyRequestRef.current?.controller.abort();
      topologyRequestRef.current = null;
      nextTopologyRequestIdRef.current += 1;
      recordRequestGenerationsRef.current.clear();
    },
    [],
  );

  const refreshMcpStatus = useCallback(async () => {
    if (!isDesktop()) return;
    setMcpActionError(null);
    try {
      const status = await TauriClient.getMcpServerStatus();
      setMcpStatus(status);
    } catch (error) {
      const diagnostic = reportDnsManagerFailure(
        error,
        "Refresh MCP server status",
      );
      setMcpActionError(diagnostic.message);
    }
  }, []);

  const handleMcpPermissionsApplied = useCallback(
    (
      enabledTools: string[],
      status: McpServerStatus,
      application: McpToolPermissionsApplication,
    ) => {
      const confirmedTools = normalizeMcpToolIds(enabledTools);
      const initialAuthoritativeReadiness = !mcpPermissionsReadyRef.current;
      const confirmedSelectionChanged = !sameMcpToolIds(
        confirmedTools,
        mcpEnabledToolsRef.current,
      );
      mcpEnabledToolsRef.current = confirmedTools;
      setMcpEnabledTools(confirmedTools);
      if (application.synchronization === "final") {
        mcpRequestedToolsRef.current = confirmedTools;
        setMcpRequestedTools(confirmedTools);
      }
      setMcpStatus(status);
      setMcpActionError(null);
      mcpPermissionsReadyRef.current = true;
      setMcpPermissionsReady(true);
      if (initialAuthoritativeReadiness || confirmedSelectionChanged) {
        setMcpConfirmedPermissionRevision((revision) => revision + 1);
      }
    },
    [],
  );

  const handleMcpPermissionsError = useCallback(
    (error: unknown, failure: McpToolPermissionsFailure) => {
      if (failure.operation === "bootstrap") {
        mcpPermissionsReadyRef.current = false;
        setMcpPermissionsReady(false);
      }
      const label =
        failure.operation === "bootstrap"
          ? "Synchronize MCP server preferences"
          : "Update MCP tool access";
      const report = reportRuntimeError(error, {
        source: "runtime",
        label,
        ...(failure.operation === "update"
          ? { deduplicate: false, notifyListeners: false }
          : {}),
      });
      const diagnostic = report.diagnostic;
      if (failure.operation === "update" || !report.duplicate) {
        toast({
          title: label,
          description: diagnostic.message,
          diagnostic,
          variant: "destructive",
        });
      }
    },
    [toast],
  );

  const setMcpServerRunning = useCallback(
    async (enabled: boolean, host?: string, port?: number) => {
      if (
        !isDesktop() ||
        !mcpPermissionsReadyRef.current ||
        mcpStartupInFlightKeyRef.current !== null
      ) {
        return;
      }
      const previousEnabled = mcpServerEnabled;
      const previousStatus = mcpStatus;
      const synchronizationKey = mcpStartupSynchronizationKeyRef.current;
      setMcpBusy(true);
      setMcpActionError(null);
      try {
        const nextHost = (host ?? mcpServerHost).trim() || "127.0.0.1";
        const nextPort = Math.max(
          1,
          Math.min(65535, Math.round(port ?? mcpServerPort)),
        );
        const status = enabled
          ? await TauriClient.startMcpServer(
              nextHost,
              nextPort,
              mcpEnabledTools,
            )
          : await TauriClient.stopMcpServer();
        if (
          synchronizationKey !== null &&
          mcpStartupSynchronizationKeyRef.current === synchronizationKey
        ) {
          mcpStartupCompletedKeyRef.current = synchronizationKey;
        }
        setMcpStatus(status);
        mcpServerEnabledRef.current = enabled;
        setMcpServerEnabled(enabled);
      } catch (error) {
        setMcpServerEnabled(previousEnabled);
        setMcpStatus(previousStatus);
        const diagnostic = reportDnsManagerFailure(
          error,
          enabled ? "Start MCP server" : "Stop MCP server",
        );
        setMcpActionError(diagnostic.message);
      } finally {
        setMcpBusy(false);
      }
    },
    [
      mcpEnabledTools,
      mcpServerEnabled,
      mcpServerHost,
      mcpServerPort,
      mcpStatus,
    ],
  );

  useEffect(() => {
    if (!prefsReady) return;
    if (!selectedZoneId) return;

    if (!initialZoneSelectionHandledRef.current) {
      initialZoneSelectionHandledRef.current = true;
      if (reopenLastTabs) return;
    }

    openZoneTab(selectedZoneId);
  }, [selectedZoneId, openZoneTab, prefsReady, reopenLastTabs]);

  useEffect(() => {
    if (activeTab?.kind === "zone") {
      const controller = new AbortController();
      loadRecords(activeTab, controller.signal);
      return () => controller.abort();
    }
    // Only the identity fields below may retrigger a fetch. `loadRecords`
    // writes `records`/`isLoading` back onto the same tab, so depending on the
    // whole `activeTab` object would make every fetch invalidate its own
    // effect and refetch forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab?.zoneId,
    activeTab?.page,
    activeTab?.perPage,
    activeTab?.kind,
    loadRecords,
  ]);

  useEffect(() => {
    if (
      actionTab !== "topology" ||
      activeTab?.kind !== "zone" ||
      !activeTab.zoneId
    ) {
      topologyRequestRef.current?.controller.abort();
      topologyRequestRef.current = null;
      setTopologyRecordState((previous) =>
        previous.status === "idle" && previous.queryKey === ""
          ? previous
          : EMPTY_DNS_TOPOLOGY_RECORD_STATE,
      );
      return;
    }

    void loadTopologyRecords(
      activeTab.zoneId,
      topologyQueryKey,
      topologySearchTerm,
      topologyTypeFilter,
    );

    return () => {
      const request = topologyRequestRef.current;
      if (request?.queryKey === topologyQueryKey) {
        request.controller.abort();
      }
    };
  }, [
    actionTab,
    activeTab?.kind,
    activeTab?.zoneId,
    loadTopologyRecords,
    topologyQueryKey,
    topologySearchTerm,
    topologyTypeFilter,
  ]);

  useEffect(() => {
    if (
      actionTab !== "topology" ||
      activeTab?.kind !== "zone" ||
      !activeTab.zoneId
    ) {
      return;
    }
    const zoneId = activeTab.zoneId;
    if (topologyIntegrations?.zoneId === zoneId) return;
    if (topologyIntegrationsRequestRef.current?.zoneId === zoneId) return;
    topologyIntegrationsRequestRef.current?.controller.abort();
    const controller = new AbortController();
    topologyIntegrationsRequestRef.current = { zoneId, controller };
    void (async () => {
      const [settings, rules, routes] = await Promise.allSettled([
        getEmailRoutingSettings(zoneId, controller.signal),
        getEmailRoutingRules(zoneId, controller.signal),
        getWorkerRoutes(zoneId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (topologyIntegrationsRequestRef.current?.controller === controller) {
        topologyIntegrationsRequestRef.current = null;
      }
      const settingsValue =
        settings.status === "fulfilled" &&
        settings.value &&
        typeof settings.value === "object"
          ? (settings.value as EmailRoutingSettingsResponse)
          : null;
      const emailRouting =
        settingsValue &&
        rules.status === "fulfilled" &&
        Array.isArray(rules.value)
          ? {
              settings: settingsValue,
              rules: rules.value as EmailRoutingRuleResponse[],
            }
          : undefined;
      setTopologyIntegrations({
        zoneId,
        emailRouting,
        workerRoutes:
          routes.status === "fulfilled" && Array.isArray(routes.value)
            ? (routes.value as WorkerRouteResponse[])
            : undefined,
        emailRoutingUnavailable: !emailRouting,
      });
    })();
    return () => {
      if (topologyIntegrationsRequestRef.current?.controller === controller) {
        controller.abort();
        topologyIntegrationsRequestRef.current = null;
      }
    };
  }, [
    actionTab,
    activeTab?.kind,
    activeTab?.zoneId,
    getEmailRoutingRules,
    getEmailRoutingSettings,
    getWorkerRoutes,
    topologyIntegrations?.zoneId,
  ]);

  useEffect(() => {
    if (activeTab?.kind === "audit") {
      loadAuditEntries();
    }
  }, [activeTab?.kind, loadAuditEntries]);

  const refreshCacheSettings = useCallback(
    async (zoneId: string) => {
      setCacheSettingsLoading(true);
      setCacheSettingsError(null);
      setZoneDevMode(null);
      setZoneCacheLevel(null);
      try {
        const results = await Promise.allSettled([
          getZoneSetting<string>(zoneId, "development_mode"),
          getZoneSetting<string>(zoneId, "cache_level"),
        ]);
        const [dev, level] = results;
        if (dev.status === "fulfilled") setZoneDevMode(dev.value);
        if (level.status === "fulfilled") setZoneCacheLevel(level.value);
        const errors = results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason)
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .filter(Boolean);
        if (errors.length) setCacheSettingsError(errors.join(" | "));
      } catch (e) {
        setCacheSettingsError(e instanceof Error ? e.message : String(e));
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [getZoneSetting],
  );

  const refreshSslSettings = useCallback(
    async (zoneId: string) => {
      setSslSettingsLoading(true);
      setSslSettingsError(null);
      setZoneSslMode(null);
      setZoneMinTlsVersion(null);
      setZoneTls13(null);
      setZoneAlwaysUseHttps(null);
      setZoneAutoHttpsRewrites(null);
      setZoneOpportunisticEncryption(null);
      try {
        const results = await Promise.allSettled([
          getZoneSetting<string>(zoneId, "ssl"),
          getZoneSetting<string>(zoneId, "min_tls_version"),
          getZoneSetting<string>(zoneId, "tls_1_3"),
          getZoneSetting<string>(zoneId, "always_use_https"),
          getZoneSetting<string>(zoneId, "automatic_https_rewrites"),
          getZoneSetting<string>(zoneId, "opportunistic_encryption"),
        ]);
        const [ssl, minTls, tls13, alwaysHttps, rewrites, oppEnc] = results;
        if (ssl.status === "fulfilled") setZoneSslMode(ssl.value);
        if (minTls.status === "fulfilled") setZoneMinTlsVersion(minTls.value);
        if (tls13.status === "fulfilled") setZoneTls13(tls13.value);
        if (alwaysHttps.status === "fulfilled")
          setZoneAlwaysUseHttps(alwaysHttps.value);
        if (rewrites.status === "fulfilled")
          setZoneAutoHttpsRewrites(rewrites.value);
        if (oppEnc.status === "fulfilled")
          setZoneOpportunisticEncryption(oppEnc.value);
        const errors = results
          .filter((r) => r.status === "rejected")
          .map((r) => (r as PromiseRejectedResult).reason)
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .filter(Boolean);
        if (errors.length) setSslSettingsError(errors.join(" | "));
      } catch (e) {
        setSslSettingsError(e instanceof Error ? e.message : String(e));
      } finally {
        setSslSettingsLoading(false);
      }
    },
    [getZoneSetting],
  );

  useEffect(() => {
    if (activeTab?.kind !== "zone") return;
    if (actionTab !== "cache") return;
    void refreshCacheSettings(activeTab.zoneId);
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, refreshCacheSettings]);

  useEffect(() => {
    if (activeTab?.kind !== "zone") return;
    if (actionTab !== "ssl-tls") return;
    void refreshSslSettings(activeTab.zoneId);
  }, [actionTab, activeTab?.kind, activeTab?.zoneId, refreshSslSettings]);

  useEffect(() => {
    if (!isDesktop()) return;
    if (settingsSubtab !== "mcp") return;
    void refreshMcpStatus();
  }, [refreshMcpStatus, settingsSubtab]);

  useEffect(() => {
    let active = true;
    if (isDesktop()) {
      TauriClient.getPreferences()
        .then((prefs) => {
          if (!active) return;
          const prefObj = prefs as {
            last_zone?: string;
            last_active_tab?: string;
            auto_refresh_interval?: number;
            rewrite_copied_record_domains?: boolean;
            default_per_page?: number;
            zone_per_page?: Record<string, number>;
            show_unsupported_record_types?: boolean;
            zone_show_unsupported_record_types?: Record<string, boolean>;
            reopen_last_tabs?: boolean;
            reopen_zone_tabs?: Record<string, boolean>;
            last_open_tabs?: string[];
            dns_table_columns?: string[];
            confirm_logout?: boolean;
            idle_logout_ms?: number | null;
            confirm_window_close?: boolean;
            close_tab_on_middle_click?: boolean;
            mcp_server_enabled?: boolean;
            mcp_server_host?: string;
            mcp_server_port?: number;
            mcp_enabled_tools?: string[];
            loading_overlay_timeout_ms?: number;
            topology_resolution_max_hops?: number;
            topology_resolver_mode?: TopologyResolverMode;
            topology_dns_server?: string;
            topology_custom_dns_server?: string;
            topology_doh_provider?: TopologyDohProvider;
            topology_doh_custom_url?: string;
            topology_export_confirm_path?: boolean;
            topology_export_folder_preset?: string;
            topology_export_custom_path?: string;
            topology_copy_actions?: string[];
            topology_export_actions?: string[];
            topology_disable_annotations?: boolean;
            topology_disable_full_window?: boolean;
            topology_lookup_timeout_ms?: number;
            topology_disable_ptr_lookups?: boolean;
            topology_disable_geo_lookups?: boolean;
            topology_geo_provider?: TopologyGeoProvider;
            topology_scan_resolution_chain?: boolean;
            topology_disable_service_discovery?: boolean;
            topology_tcp_services?: string[];
            propagation_resolvers?: string[];
            propagation_custom_resolvers?: string[];
            propagation_timeout_ms?: number;
            propagation_attempts?: number;
            propagation_consensus_percent?: number;
            propagation_watch_interval_s?: number;
            audit_export_default_documents?: boolean;
            confirm_clear_audit_logs?: boolean;
            audit_export_folder_preset?: string;
            audit_export_custom_path?: string;
            audit_export_skip_destination_confirm?: boolean;
            domain_audit_categories?: Record<DomainAuditCategory, boolean>;
            session_settings_profiles?: Record<string, SessionSettingsProfile>;
          };
          if (prefObj.last_zone) setSelectedZoneId(prefObj.last_zone);
          if (typeof prefObj.last_active_tab === "string") {
            setPendingLastActiveTab(prefObj.last_active_tab);
          }
          if (typeof prefObj.auto_refresh_interval === "number") {
            setAutoRefreshInterval(
              clampAutoRefreshInterval(prefObj.auto_refresh_interval),
            );
          }
          if (typeof prefObj.rewrite_copied_record_domains === "boolean") {
            setRewriteCopiedRecordDomains(
              prefObj.rewrite_copied_record_domains,
            );
          }
          if (typeof prefObj.default_per_page === "number") {
            setGlobalPerPage(clampDnsPageSize(prefObj.default_per_page));
          }
          if (
            prefObj.zone_per_page &&
            typeof prefObj.zone_per_page === "object"
          ) {
            setZonePerPage(clampZonePerPageMap(prefObj.zone_per_page));
          }
          if (typeof prefObj.show_unsupported_record_types === "boolean") {
            setShowUnsupportedRecordTypes(
              prefObj.show_unsupported_record_types,
            );
          }
          if (
            prefObj.zone_show_unsupported_record_types &&
            typeof prefObj.zone_show_unsupported_record_types === "object"
          ) {
            setZoneShowUnsupportedRecordTypes(
              prefObj.zone_show_unsupported_record_types,
            );
          }
          if (typeof prefObj.reopen_last_tabs === "boolean") {
            setReopenLastTabs(prefObj.reopen_last_tabs);
          }
          if (
            prefObj.reopen_zone_tabs &&
            typeof prefObj.reopen_zone_tabs === "object"
          ) {
            setReopenZoneTabs(prefObj.reopen_zone_tabs);
          }
          if (Array.isArray(prefObj.last_open_tabs)) {
            setLastOpenTabs(limitRestoredTabIds(prefObj.last_open_tabs));
          }
          // The paste preview opt-out is browser-owned on every platform: the
          // desktop preference file has no field for it.
          setConfirmPastePreview(storageManager.getConfirmPastePreview());
          // The desktop store owns the DNS table columns; every other table
          // rides on browser preferences. Preferences written before this
          // feature simply have no entry and fall through to the defaults.
          setTableColumns(
            normalizeTableColumnMap({
              ...storageManager.getTableColumns(),
              ...(Array.isArray(prefObj.dns_table_columns)
                ? { dnsRecords: prefObj.dns_table_columns }
                : {}),
            }),
          );
          if (typeof prefObj.confirm_logout === "boolean") {
            setConfirmLogout(prefObj.confirm_logout);
          }
          if (
            typeof prefObj.idle_logout_ms === "number" ||
            prefObj.idle_logout_ms === null
          ) {
            setIdleLogoutMs(prefObj.idle_logout_ms ?? null);
          }
          if (typeof prefObj.confirm_window_close === "boolean") {
            setConfirmWindowClose(prefObj.confirm_window_close);
          }
          if (typeof prefObj.close_tab_on_middle_click === "boolean") {
            setCloseTabOnMiddleClick(prefObj.close_tab_on_middle_click);
          }
          if (typeof prefObj.mcp_server_enabled === "boolean") {
            mcpServerEnabledRef.current = prefObj.mcp_server_enabled;
            setMcpServerEnabled(prefObj.mcp_server_enabled);
          }
          if (typeof prefObj.mcp_server_host === "string") {
            mcpServerHostRef.current = prefObj.mcp_server_host || "127.0.0.1";
            setMcpServerHost(prefObj.mcp_server_host || "127.0.0.1");
          }
          if (typeof prefObj.mcp_server_port === "number") {
            mcpServerPortRef.current = Math.max(
              1,
              Math.min(65535, Math.round(prefObj.mcp_server_port)),
            );
            setMcpServerPort(
              Math.max(1, Math.min(65535, Math.round(prefObj.mcp_server_port))),
            );
          }
          if (Array.isArray(prefObj.mcp_enabled_tools)) {
            // The local permission snapshot is the confirmed source of truth
            // while the off-view permission controller is bootstrapping. A
            // preference response may still contain the previous server
            // selection, so retain confirmed local tools until reconciliation
            // publishes the authoritative provisional/final result.
            const confirmedTools = normalizeMcpToolIds([
              ...mcpEnabledToolsRef.current,
              ...prefObj.mcp_enabled_tools,
            ]);
            const persistedPermissionSnapshot =
              storageManager.getMcpEnabledToolsSnapshot();
            const requestedTools = normalizeMcpToolIds([
              ...confirmedTools,
              ...persistedPermissionSnapshot.pendingHighRiskToolIds,
            ]);
            if (
              !sameMcpToolIds(confirmedTools, mcpEnabledToolsRef.current) ||
              !sameMcpToolIds(requestedTools, mcpRequestedToolsRef.current)
            ) {
              mcpPermissionsReadyRef.current = false;
              setMcpPermissionsReady(false);
            }
            mcpEnabledToolsRef.current = confirmedTools;
            mcpRequestedToolsRef.current = requestedTools;
            setMcpEnabledTools(confirmedTools);
            setMcpRequestedTools(requestedTools);
          }
          if (typeof prefObj.loading_overlay_timeout_ms === "number") {
            setLoadingOverlayTimeoutMs(
              Math.max(
                1000,
                Math.min(60000, prefObj.loading_overlay_timeout_ms),
              ),
            );
          }
          if (typeof prefObj.topology_resolution_max_hops === "number") {
            setTopologyResolutionMaxHops(
              Math.max(
                1,
                Math.min(15, Math.round(prefObj.topology_resolution_max_hops)),
              ),
            );
          }
          if (
            prefObj.topology_resolver_mode === "dns" ||
            prefObj.topology_resolver_mode === "doh"
          ) {
            setTopologyResolverMode(prefObj.topology_resolver_mode);
          }
          if (typeof prefObj.topology_dns_server === "string") {
            setTopologyDnsServer(prefObj.topology_dns_server || "1.1.1.1");
          }
          if (typeof prefObj.topology_custom_dns_server === "string") {
            setTopologyCustomDnsServer(prefObj.topology_custom_dns_server);
          }
          if (
            prefObj.topology_doh_provider === "google" ||
            prefObj.topology_doh_provider === "cloudflare" ||
            prefObj.topology_doh_provider === "quad9" ||
            prefObj.topology_doh_provider === "custom"
          ) {
            setTopologyDohProvider(prefObj.topology_doh_provider);
          }
          if (typeof prefObj.topology_doh_custom_url === "string") {
            setTopologyDohCustomUrl(prefObj.topology_doh_custom_url);
          }
          if (typeof prefObj.topology_export_confirm_path === "boolean") {
            setTopologyExportConfirmPath(prefObj.topology_export_confirm_path);
          }
          if (typeof prefObj.topology_export_folder_preset === "string") {
            setTopologyExportFolderPreset(
              prefObj.topology_export_folder_preset as ExportFolderPreset,
            );
          }
          if (typeof prefObj.topology_export_custom_path === "string") {
            setTopologyExportCustomPath(prefObj.topology_export_custom_path);
          }
          if (Array.isArray(prefObj.topology_copy_actions)) {
            setTopologyCopyActions(
              Array.from(
                new Set(
                  prefObj.topology_copy_actions
                    .map((v) => String(v).trim())
                    .filter(
                      (v): v is TopologyCopyAction =>
                        v === "mermaid" || v === "svg" || v === "png",
                    ),
                ),
              ),
            );
          }
          if (Array.isArray(prefObj.topology_export_actions)) {
            setTopologyExportActions(
              Array.from(
                new Set(
                  prefObj.topology_export_actions
                    .map((v) => String(v).trim())
                    .filter(
                      (v): v is TopologyExportAction =>
                        v === "mermaid" ||
                        v === "svg" ||
                        v === "png" ||
                        v === "pdf",
                    ),
                ),
              ),
            );
          }
          if (typeof prefObj.topology_disable_annotations === "boolean") {
            setTopologyDisableAnnotations(prefObj.topology_disable_annotations);
          }
          if (typeof prefObj.topology_disable_full_window === "boolean") {
            setTopologyDisableFullWindow(prefObj.topology_disable_full_window);
          }
          if (typeof prefObj.topology_lookup_timeout_ms === "number") {
            setTopologyLookupTimeoutMs(
              Math.max(
                250,
                Math.min(10000, Math.round(prefObj.topology_lookup_timeout_ms)),
              ),
            );
          }
          if (typeof prefObj.topology_disable_ptr_lookups === "boolean") {
            setTopologyDisablePtrLookups(prefObj.topology_disable_ptr_lookups);
          }
          if (typeof prefObj.topology_disable_geo_lookups === "boolean") {
            setTopologyDisableGeoLookups(prefObj.topology_disable_geo_lookups);
          }
          if (
            prefObj.topology_geo_provider === "auto" ||
            prefObj.topology_geo_provider === "ipwhois" ||
            prefObj.topology_geo_provider === "ipapi_co" ||
            prefObj.topology_geo_provider === "ip_api" ||
            prefObj.topology_geo_provider === "internal"
          ) {
            setTopologyGeoProvider(prefObj.topology_geo_provider);
          }
          if (typeof prefObj.topology_scan_resolution_chain === "boolean") {
            setTopologyScanResolutionChain(
              prefObj.topology_scan_resolution_chain,
            );
          }
          if (typeof prefObj.topology_disable_service_discovery === "boolean") {
            setTopologyDisableServiceDiscovery(
              prefObj.topology_disable_service_discovery,
            );
          }
          if (Array.isArray(prefObj.topology_tcp_services)) {
            setTopologyTcpServices(
              Array.from(
                new Set(
                  prefObj.topology_tcp_services
                    .map((v) => String(v).trim())
                    .filter(Boolean),
                ),
              ),
            );
          }
          if (Array.isArray(prefObj.propagation_resolvers)) {
            storageManager.setPropagationResolvers(
              prefObj.propagation_resolvers.map((v) => String(v)),
            );
          }
          if (Array.isArray(prefObj.propagation_custom_resolvers)) {
            storageManager.setPropagationCustomResolvers(
              prefObj.propagation_custom_resolvers.map((v) => String(v)),
            );
          }
          if (typeof prefObj.propagation_timeout_ms === "number") {
            storageManager.setPropagationTimeoutMs(
              prefObj.propagation_timeout_ms,
            );
          }
          if (typeof prefObj.propagation_attempts === "number") {
            storageManager.setPropagationAttempts(prefObj.propagation_attempts);
          }
          if (typeof prefObj.propagation_consensus_percent === "number") {
            storageManager.setPropagationConsensusPercent(
              prefObj.propagation_consensus_percent,
            );
          }
          if (typeof prefObj.propagation_watch_interval_s === "number") {
            storageManager.setPropagationWatchIntervalS(
              prefObj.propagation_watch_interval_s,
            );
          }
          if (typeof prefObj.audit_export_default_documents === "boolean") {
            setAuditExportDefaultDocuments(
              prefObj.audit_export_default_documents,
            );
          }
          if (typeof prefObj.confirm_clear_audit_logs === "boolean") {
            setConfirmClearAuditLogs(prefObj.confirm_clear_audit_logs);
          }
          if (typeof prefObj.audit_export_folder_preset === "string") {
            setAuditExportFolderPreset(
              prefObj.audit_export_folder_preset as ExportFolderPreset,
            );
          }
          if (typeof prefObj.audit_export_custom_path === "string") {
            setAuditExportCustomPath(prefObj.audit_export_custom_path);
          }
          if (
            typeof prefObj.audit_export_skip_destination_confirm === "boolean"
          ) {
            setAuditExportSkipDestinationConfirm(
              prefObj.audit_export_skip_destination_confirm,
            );
          }
          if (
            prefObj.domain_audit_categories &&
            typeof prefObj.domain_audit_categories === "object"
          ) {
            setDomainAuditCategories(
              sanitizeDomainAuditCategories(prefObj.domain_audit_categories),
            );
          }
          if (
            prefObj.session_settings_profiles &&
            typeof prefObj.session_settings_profiles === "object"
          ) {
            setSessionSettingsProfiles(prefObj.session_settings_profiles);
          } else {
            setSessionSettingsProfiles({});
          }
        })
        .catch((error) => {
          reportDnsManagerFailure(error, "Load desktop DNS preferences");
        })
        .finally(() => {
          if (active) setPrefsReady(true);
        });
      return () => {
        active = false;
      };
    }
    setRewriteCopiedRecordDomains(
      storageManager.getRewriteCopiedRecordDomains(),
    );
    setConfirmPastePreview(storageManager.getConfirmPastePreview());
    setTableColumns(normalizeTableColumnMap(storageManager.getTableColumns()));
    const last = storageManager.getLastZone();
    if (last) setSelectedZoneId(last);
    setGlobalPerPage(clampDnsPageSize(storageManager.getDefaultPerPage()));
    setZonePerPage(clampZonePerPageMap(storageManager.getZonePerPageMap()));
    setShowUnsupportedRecordTypes(
      storageManager.getShowUnsupportedRecordTypes(),
    );
    setZoneShowUnsupportedRecordTypes(
      storageManager.getZoneShowUnsupportedRecordTypesMap(),
    );
    setReopenLastTabs(storageManager.getReopenLastTabs());
    setReopenZoneTabs(storageManager.getReopenZoneTabs());
    setLastOpenTabs(limitRestoredTabIds(storageManager.getLastOpenTabs()));
    setPendingLastActiveTab(storageManager.getLastActiveTabId());
    setConfirmLogout(storageManager.getConfirmLogout());
    setIdleLogoutMs(storageManager.getIdleLogoutMs());
    setConfirmWindowClose(storageManager.getConfirmWindowClose());
    setCloseTabOnMiddleClick(storageManager.getCloseTabOnMiddleClick());
    setMcpServerEnabled(storageManager.getMcpServerEnabled());
    setMcpServerHost(storageManager.getMcpServerHost());
    setMcpServerPort(storageManager.getMcpServerPort());
    const permissionSnapshot = storageManager.getMcpEnabledToolsSnapshot();
    mcpEnabledToolsRef.current = permissionSnapshot.enabledTools;
    setMcpEnabledTools(permissionSnapshot.enabledTools);
    const requestedTools = normalizeMcpToolIds([
      ...permissionSnapshot.enabledTools,
      ...permissionSnapshot.pendingHighRiskToolIds,
    ]);
    mcpRequestedToolsRef.current = requestedTools;
    setMcpRequestedTools(requestedTools);
    mcpPermissionsReadyRef.current = false;
    setMcpPermissionsReady(false);
    setLoadingOverlayTimeoutMs(storageManager.getLoadingOverlayTimeoutMs());
    setTopologyResolutionMaxHops(storageManager.getTopologyResolutionMaxHops());
    setTopologyResolverMode(storageManager.getTopologyResolverMode());
    setTopologyDnsServer(storageManager.getTopologyDnsServer());
    setTopologyCustomDnsServer(storageManager.getTopologyCustomDnsServer());
    setTopologyDohProvider(storageManager.getTopologyDohProvider());
    setTopologyDohCustomUrl(storageManager.getTopologyDohCustomUrl());
    setTopologyExportConfirmPath(storageManager.getTopologyExportConfirmPath());
    setTopologyExportFolderPreset(
      storageManager.getTopologyExportFolderPreset() as ExportFolderPreset,
    );
    setTopologyExportCustomPath(storageManager.getTopologyExportCustomPath());
    setTopologyCopyActions(
      storageManager.getTopologyCopyActions() as TopologyCopyAction[],
    );
    setTopologyExportActions(
      storageManager.getTopologyExportActions() as TopologyExportAction[],
    );
    setTopologyDisableAnnotations(
      storageManager.getTopologyDisableAnnotations(),
    );
    setTopologyDisableFullWindow(storageManager.getTopologyDisableFullWindow());
    setTopologyLookupTimeoutMs(storageManager.getTopologyLookupTimeoutMs());
    setTopologyDisablePtrLookups(storageManager.getTopologyDisablePtrLookups());
    setTopologyDisableGeoLookups(storageManager.getTopologyDisableGeoLookups());
    setTopologyGeoProvider(storageManager.getTopologyGeoProvider());
    setTopologyScanResolutionChain(
      storageManager.getTopologyScanResolutionChain(),
    );
    setTopologyDisableServiceDiscovery(
      storageManager.getTopologyDisableServiceDiscovery(),
    );
    setTopologyTcpServices(storageManager.getTopologyTcpServices());
    setAuditExportDefaultDocuments(
      storageManager.getAuditExportDefaultDocuments(),
    );
    setConfirmClearAuditLogs(storageManager.getConfirmClearAuditLogs());
    setAuditExportFolderPreset(
      storageManager.getAuditExportFolderPreset() as ExportFolderPreset,
    );
    setAuditExportCustomPath(storageManager.getAuditExportCustomPath());
    setAuditExportSkipDestinationConfirm(
      storageManager.getAuditExportSkipDestinationConfirm(),
    );
    setDomainAuditCategories(
      sanitizeDomainAuditCategories(storageManager.getDomainAuditCategories()),
    );
    setSessionSettingsProfiles(storageManager.getSessionSettingsProfiles());
    setPrefsReady(true);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    mcpStartupMountedRef.current = true;
    return () => {
      mcpStartupMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const synchronizationKey = mcpStartupSynchronizationKey;
    if (
      !prefsReady ||
      !mcpPermissionsReady ||
      !isDesktop() ||
      synchronizationKey === null ||
      mcpStartupCompletedKeyRef.current === synchronizationKey ||
      mcpStartupInFlightKeyRef.current !== null
    ) {
      return;
    }

    const initialSynchronization = mcpStartupCompletedKeyRef.current === null;
    let synchronization: {
      enabled: boolean;
      host: string;
      port: number;
      enabledTools: string[];
    };
    if (initialSynchronization) {
      synchronization = {
        enabled: mcpServerEnabledRef.current,
        host: mcpServerHostRef.current.trim() || "127.0.0.1",
        port: Math.max(
          1,
          Math.min(65535, Math.round(mcpServerPortRef.current)),
        ),
        enabledTools: normalizeMcpToolIds(mcpEnabledToolsRef.current),
      };
    } else {
      if (mcpStatus === null) return;
      synchronization = {
        enabled: mcpStatus.running,
        host: mcpStatus.host.trim() || "127.0.0.1",
        port: Math.max(1, Math.min(65535, Math.round(mcpStatus.port))),
        enabledTools: normalizeMcpToolIds(mcpEnabledToolsRef.current),
      };
    }
    mcpStartupInFlightKeyRef.current = synchronizationKey;
    setMcpBusy(true);
    setMcpActionError(null);
    void (async () => {
      try {
        if (synchronization.enabled) {
          await TauriClient.startMcpServer(
            synchronization.host,
            synchronization.port,
            synchronization.enabledTools,
          );
        } else {
          await TauriClient.stopMcpServer();
        }
        const status = await TauriClient.getMcpServerStatus();
        if (
          mcpStartupMountedRef.current &&
          mcpPermissionsReadyRef.current &&
          mcpStartupSynchronizationKeyRef.current === synchronizationKey
        ) {
          setMcpStatus(status);
        }
      } catch (error) {
        if (
          mcpStartupMountedRef.current &&
          mcpPermissionsReadyRef.current &&
          mcpStartupSynchronizationKeyRef.current === synchronizationKey
        ) {
          const diagnostic = reportDnsManagerFailure(
            error,
            "Synchronize MCP server preferences",
          );
          setMcpActionError(diagnostic.message);
        }
      } finally {
        const exactSettledKey =
          mcpStartupMountedRef.current &&
          mcpPermissionsReadyRef.current &&
          mcpStartupSynchronizationKeyRef.current === synchronizationKey;
        if (exactSettledKey) {
          mcpStartupCompletedKeyRef.current = synchronizationKey;
        }
        if (mcpStartupInFlightKeyRef.current === synchronizationKey) {
          mcpStartupInFlightKeyRef.current = null;
        }
        if (mcpStartupMountedRef.current) {
          if (mcpStartupSynchronizationKeyRef.current === synchronizationKey) {
            setMcpBusy(false);
          }
          setMcpStartupDrainRevision((revision) => revision + 1);
        }
      }
    })();
  }, [
    mcpPermissionsReady,
    mcpStatus,
    mcpStartupDrainRevision,
    mcpStartupSynchronizationKey,
    prefsReady,
  ]);

  const persistTabStateBestEffort = useCallback(() => {
    const openTabIds = tabs.map((tab) => tab.id);
    const encoded =
      activeTab && activeTab.kind === "zone"
        ? `${activeTab.zoneId}|${actionTab}`
        : (activeTab?.id ?? "");

    storageManager.setLastOpenTabs(openTabIds);
    storageManager.setLastActiveTabId(encoded || null);
    if (activeTab?.kind === "zone") {
      storageManager.setLastZone(activeTab.zoneId);
    }

    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({
        last_open_tabs: openTabIds,
        last_active_tab: encoded || null,
        last_zone: activeTab?.kind === "zone" ? activeTab.zoneId : undefined,
      }).catch((error) => {
        reportDnsManagerFailure(error, "Persist desktop DNS tab state");
      });
    }
  }, [actionTab, activeTab, tabs]);

  useEffect(() => {
    if (!activeTab?.zoneId || activeTab.kind !== "zone") return;
    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({
        last_zone: activeTab.zoneId,
      }).catch((error) => {
        reportDnsManagerFailure(error, "Persist last desktop DNS zone");
      });
    } else {
      storageManager.setLastZone(activeTab.zoneId);
    }
  }, [activeTab?.kind, activeTab?.zoneId]);

  useEffect(() => {
    if (!prefsReady) return;
    if (reopenLastTabs && !restoredTabs) return;
    if (!activeTab) return;

    const encoded =
      activeTab.kind === "zone"
        ? `${activeTab.zoneId}|${actionTab}`
        : activeTab.id;

    storageManager.setLastActiveTabId(encoded);
    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({
        last_active_tab: encoded,
      }).catch((error) => {
        reportDnsManagerFailure(error, "Persist active desktop DNS tab");
      });
    }
  }, [actionTab, activeTab, prefsReady, reopenLastTabs, restoredTabs]);

  useEffect(() => {
    if (!prefsReady) return;
    if (isDesktop()) {
      persistDnsPreferenceFields({
        auto_refresh_interval: autoRefreshInterval ?? null,
      });
    } else {
      storageManager.setAutoRefreshInterval(autoRefreshInterval ?? null);
    }
  }, [autoRefreshInterval, prefsReady]);

  useEffect(() => {
    if (!autoRefreshInterval || autoRefreshInterval <= 0) return;
    let inFlightController: AbortController | null = null;
    const disposePoller = createCompletionScheduledPoller(async () => {
      if (!activeTab || activeTab.kind !== "zone") return;
      if (
        activeTab.editingRecord ||
        activeTab.showAddRecord ||
        activeTab.showImport
      ) {
        return;
      }
      const controller = new AbortController();
      inFlightController = controller;
      try {
        await loadRecords(activeTab, controller.signal);
      } finally {
        if (inFlightController === controller) inFlightController = null;
      }
    }, autoRefreshInterval);
    return () => {
      disposePoller();
      inFlightController?.abort();
      inFlightController = null;
    };
    // As above: the poller calls `loadRecords`, which mutates the active tab.
    // Depending on the whole `activeTab` object would tear down and rebuild the
    // poller on every completed refresh. Only the fields that should restart
    // it (identity, paging, and the dialogs that pause polling) are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab?.editingRecord,
    activeTab?.id,
    activeTab?.kind,
    activeTab?.page,
    activeTab?.perPage,
    activeTab?.showAddRecord,
    activeTab?.showImport,
    autoRefreshInterval,
    loadRecords,
  ]);

  useEffect(() => {
    if (!prefsReady) return;
    storageManager.setDefaultPerPage(globalPerPage);
    storageManager.setZonePerPageMap(zonePerPage);
    storageManager.setShowUnsupportedRecordTypes(showUnsupportedRecordTypes);
    storageManager.setZoneShowUnsupportedRecordTypesMap(
      zoneShowUnsupportedRecordTypes,
    );
    storageManager.setReopenLastTabs(reopenLastTabs);
    storageManager.setReopenZoneTabs(reopenZoneTabs);
    storageManager.setLastOpenTabs(lastOpenTabs);
    storageManager.setConfirmLogout(confirmLogout);
    storageManager.setIdleLogoutMs(idleLogoutMs);
    storageManager.setConfirmWindowClose(confirmWindowClose);
    storageManager.setCloseTabOnMiddleClick(closeTabOnMiddleClick);
    storageManager.setMcpServerEnabled(mcpServerEnabled);
    storageManager.setMcpServerHost(mcpServerHost);
    storageManager.setMcpServerPort(mcpServerPort);
    storageManager.setLoadingOverlayTimeoutMs(loadingOverlayTimeoutMs);
    storageManager.setTopologyResolutionMaxHops(topologyResolutionMaxHops);
    storageManager.setTopologyResolverMode(topologyResolverMode);
    storageManager.setTopologyDnsServer(topologyDnsServer);
    storageManager.setTopologyCustomDnsServer(topologyCustomDnsServer);
    storageManager.setTopologyDohProvider(topologyDohProvider);
    storageManager.setTopologyDohCustomUrl(topologyDohCustomUrl);
    storageManager.setTopologyExportConfirmPath(topologyExportConfirmPath);
    storageManager.setTopologyExportFolderPreset(topologyExportFolderPreset);
    storageManager.setTopologyExportCustomPath(topologyExportCustomPath);
    storageManager.setTopologyCopyActions(topologyCopyActions);
    storageManager.setTopologyExportActions(topologyExportActions);
    storageManager.setTopologyDisableAnnotations(topologyDisableAnnotations);
    storageManager.setTopologyDisableFullWindow(topologyDisableFullWindow);
    storageManager.setTopologyLookupTimeoutMs(topologyLookupTimeoutMs);
    storageManager.setTopologyDisablePtrLookups(topologyDisablePtrLookups);
    storageManager.setTopologyDisableGeoLookups(topologyDisableGeoLookups);
    storageManager.setTopologyGeoProvider(topologyGeoProvider);
    storageManager.setTopologyScanResolutionChain(topologyScanResolutionChain);
    storageManager.setTopologyDisableServiceDiscovery(
      topologyDisableServiceDiscovery,
    );
    storageManager.setTopologyTcpServices(topologyTcpServices);
    storageManager.setAuditExportDefaultDocuments(auditExportDefaultDocuments);
    storageManager.setConfirmClearAuditLogs(confirmClearAuditLogs);
    storageManager.setAuditExportFolderPreset(auditExportFolderPreset);
    storageManager.setAuditExportCustomPath(auditExportCustomPath);
    storageManager.setAuditExportSkipDestinationConfirm(
      auditExportSkipDestinationConfirm,
    );
    storageManager.setDomainAuditCategories(domainAuditCategories);
    storageManager.setRewriteCopiedRecordDomains(rewriteCopiedRecordDomains);
    storageManager.setConfirmPastePreview(confirmPastePreview);
    storageManager.setTableColumns(tableColumns);
    storageManager.setSessionSettingsProfile(
      currentSessionId,
      buildSessionSettingsProfile(),
    );

    if (isDesktop()) {
      persistDnsPreferenceFields({
        rewrite_copied_record_domains: rewriteCopiedRecordDomains,
        dns_table_columns: resolveTableColumns(
          "dnsRecords",
          tableColumns.dnsRecords,
        ),
        default_per_page: globalPerPage,
        zone_per_page: zonePerPage,
        show_unsupported_record_types: showUnsupportedRecordTypes,
        zone_show_unsupported_record_types: zoneShowUnsupportedRecordTypes,
        reopen_last_tabs: reopenLastTabs,
        reopen_zone_tabs: reopenZoneTabs,
        last_open_tabs: lastOpenTabs,
        confirm_logout: confirmLogout,
        idle_logout_ms: idleLogoutMs,
        confirm_window_close: confirmWindowClose,
        close_tab_on_middle_click: closeTabOnMiddleClick,
        mcp_server_enabled: mcpServerEnabled,
        mcp_server_host: mcpServerHost,
        mcp_server_port: mcpServerPort,
        mcp_enabled_tools: mcpEnabledTools,
        loading_overlay_timeout_ms: loadingOverlayTimeoutMs,
        topology_resolution_max_hops: topologyResolutionMaxHops,
        topology_resolver_mode: topologyResolverMode,
        topology_dns_server: topologyDnsServer,
        topology_custom_dns_server: topologyCustomDnsServer,
        topology_doh_provider: topologyDohProvider,
        topology_doh_custom_url: topologyDohCustomUrl,
        topology_export_confirm_path: topologyExportConfirmPath,
        topology_export_folder_preset: topologyExportFolderPreset,
        topology_export_custom_path: topologyExportCustomPath,
        topology_copy_actions: topologyCopyActions,
        topology_export_actions: topologyExportActions,
        topology_disable_annotations: topologyDisableAnnotations,
        topology_disable_full_window: topologyDisableFullWindow,
        topology_lookup_timeout_ms: topologyLookupTimeoutMs,
        topology_disable_ptr_lookups: topologyDisablePtrLookups,
        topology_disable_geo_lookups: topologyDisableGeoLookups,
        topology_geo_provider: topologyGeoProvider,
        topology_scan_resolution_chain: topologyScanResolutionChain,
        topology_disable_service_discovery: topologyDisableServiceDiscovery,
        topology_tcp_services: topologyTcpServices,
        audit_export_default_documents: auditExportDefaultDocuments,
        confirm_clear_audit_logs: confirmClearAuditLogs,
        audit_export_folder_preset: auditExportFolderPreset,
        audit_export_custom_path: auditExportCustomPath,
        audit_export_skip_destination_confirm:
          auditExportSkipDestinationConfirm,
        domain_audit_categories: domainAuditCategories,
        session_settings_profiles: {
          ...sessionSettingsProfiles,
          [currentSessionId]: buildSessionSettingsProfile(),
        },
      });
    }
  }, [
    rewriteCopiedRecordDomains,
    confirmPastePreview,
    tableColumns,
    globalPerPage,
    zonePerPage,
    showUnsupportedRecordTypes,
    zoneShowUnsupportedRecordTypes,
    reopenLastTabs,
    reopenZoneTabs,
    lastOpenTabs,
    confirmLogout,
    idleLogoutMs,
    confirmWindowClose,
    closeTabOnMiddleClick,
    mcpServerEnabled,
    mcpServerHost,
    mcpServerPort,
    mcpEnabledTools,
    loadingOverlayTimeoutMs,
    topologyResolutionMaxHops,
    topologyResolverMode,
    topologyDnsServer,
    topologyCustomDnsServer,
    topologyDohProvider,
    topologyDohCustomUrl,
    topologyExportConfirmPath,
    topologyExportFolderPreset,
    topologyExportCustomPath,
    topologyCopyActions,
    topologyExportActions,
    topologyDisableAnnotations,
    topologyDisableFullWindow,
    topologyLookupTimeoutMs,
    topologyDisablePtrLookups,
    topologyDisableGeoLookups,
    topologyGeoProvider,
    topologyScanResolutionChain,
    topologyDisableServiceDiscovery,
    topologyTcpServices,
    auditExportDefaultDocuments,
    confirmClearAuditLogs,
    auditExportFolderPreset,
    auditExportCustomPath,
    auditExportSkipDestinationConfirm,
    domainAuditCategories,
    currentSessionId,
    buildSessionSettingsProfile,
    sessionSettingsProfiles,
    prefsReady,
  ]);

  useEffect(() => {
    setSessionSettingsProfiles((prev) => ({
      ...prev,
      [currentSessionId]: buildSessionSettingsProfile(),
    }));
  }, [buildSessionSettingsProfile, currentSessionId]);

  useEffect(() => {
    if (!globalPerPage) return;
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.kind !== "zone") return tab;
        if (zonePerPage[tab.zoneId] !== undefined) return tab;
        return { ...tab, perPage: globalPerPage };
      }),
    );
  }, [globalPerPage, zonePerPage]);

  useEffect(() => {
    if (!reopenLastTabs || restoredTabs) return;
    if (!availableZones.length) return;
    if (!lastOpenTabs.length) {
      setRestoredTabs(true);
      return;
    }
    for (const tabId of lastOpenTabs) {
      if (tabId.startsWith("__")) {
        if (tabId === "__settings") openActionTab("settings");
        else if (tabId === "__audit") openActionTab("audit");
        else if (tabId === "__tags") openActionTab("tags");
        else if (tabId === "__registry") openActionTab("registry");
        continue;
      }
      if (reopenZoneTabs[tabId] === false) continue;
      openZoneTab(tabId);
    }
    setRestoredTabs(true);
  }, [
    reopenLastTabs,
    restoredTabs,
    availableZones,
    lastOpenTabs,
    reopenZoneTabs,
    openActionTab,
    openZoneTab,
  ]);

  useEffect(() => {
    if (!prefsReady) return;
    if (reopenLastTabs && !restoredTabs) return;
    if (!pendingLastActiveTab) return;
    if (!reopenLastTabs) {
      setPendingLastActiveTab("");
      return;
    }

    const parsed = parseLastActiveTab(pendingLastActiveTab);
    if (!parsed) {
      setPendingLastActiveTab("");
      return;
    }
    if (!lastOpenTabs.includes(parsed.tabId)) {
      setPendingLastActiveTab("");
      return;
    }

    if (parsed.tabId.startsWith("__")) {
      if (parsed.tabId === "__settings") openActionTab("settings");
      else if (parsed.tabId === "__audit") openActionTab("audit");
      else if (parsed.tabId === "__tags") openActionTab("tags");
      else if (parsed.tabId === "__registry") openActionTab("registry");
      setPendingLastActiveTab("");
      return;
    }

    const zoneExists = availableZones.some((z) => z.id === parsed.tabId);
    if (!zoneExists) return;
    if (parsed.action) setActionTab(parsed.action);
    setSelectedZoneId(parsed.tabId);
    openZoneTab(parsed.tabId);
    setActiveTabId(parsed.tabId);
    setPendingLastActiveTab("");
  }, [
    availableZones,
    openActionTab,
    openZoneTab,
    parseLastActiveTab,
    pendingLastActiveTab,
    lastOpenTabs,
    prefsReady,
    reopenLastTabs,
    restoredTabs,
  ]);

  useEffect(() => {
    if (!prefsReady) return;
    if (reopenLastTabs && !restoredTabs) return;
    const openTabIds = tabs.map((tab) => tab.id);
    setLastOpenTabs(openTabIds);
    if (isDesktop()) {
      void TauriClient.updatePreferenceFields({
        last_open_tabs: openTabIds,
      }).catch((error) => {
        reportDnsManagerFailure(error, "Persist open desktop DNS tabs");
      });
      return;
    }
    storageManager.setLastOpenTabs(openTabIds);
  }, [tabs, prefsReady, reopenLastTabs, restoredTabs]);

  useEffect(() => {
    if (!idleLogoutMs || idleLogoutMs <= 0) return;
    if (typeof window === "undefined") return;

    let timeout: number | undefined;
    const reset = () => {
      if (timeout) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        storageManager.clearSession();
        onLogout();
      }, idleLogoutMs);
    };

    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "pointermove",
      "keydown",
      "scroll",
      "touchstart",
      "wheel",
    ];

    for (const ev of events)
      window.addEventListener(ev, reset, { passive: true });
    reset();
    return () => {
      if (timeout) window.clearTimeout(timeout);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
  }, [idleLogoutMs, onLogout]);

  useEffect(() => {
    const flush = () => persistTabStateBestEffort();
    if (typeof window === "undefined") return;
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [persistTabStateBestEffort]);

  useEffect(() => {
    const onChanged = () => setTagsVersion((v) => v + 1);
    window.addEventListener("record-tags-changed", onChanged);
    return () => window.removeEventListener("record-tags-changed", onChanged);
  }, []);

  useEffect(() => {
    if (activeTab?.kind !== "tags") return;
    if (tagsZoneId) return;
    const last = storageManager.getLastZone();
    const next = last ?? availableZones[0]?.id ?? "";
    if (next) setTagsZoneId(next);
  }, [activeTab?.kind, availableZones, tagsZoneId]);

  useEffect(() => {
    if (activeTab?.kind !== "tags" || !tagsZoneId) return;
    const controller = new AbortController();
    void loadTagManagerRecords(tagsZoneId, controller.signal);
    return () => controller.abort();
  }, [activeTab?.kind, tagsZoneId, loadTagManagerRecords]);

  useEffect(() => {
    setTagAssociationSearch("");
    setTagAssociationDrafts({});
  }, [tagsZoneId]);

  useEffect(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    const overrides = storageManager.getAuditOverrides(activeTab.zoneId);
    setAuditOverridesByZone((prev) => ({
      ...prev,
      [activeTab.zoneId]: new Set(overrides),
    }));
  }, [activeTab]);

  const handleOverrideAuditItem = useCallback(
    (auditItemId: string) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      storageManager.setAuditOverride(activeTab.zoneId, auditItemId);
      setAuditOverridesByZone((prev) => {
        const existing = prev[activeTab.zoneId] ?? new Set();
        return {
          ...prev,
          [activeTab.zoneId]: new Set([...existing, auditItemId]),
        };
      });
    },
    [activeTab],
  );

  const handleClearAuditOverride = useCallback(
    (auditItemId: string) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      storageManager.clearAuditOverride(activeTab.zoneId, auditItemId);
      setAuditOverridesByZone((prev) => {
        const existing = prev[activeTab.zoneId] ?? new Set();
        const updated = new Set(existing);
        updated.delete(auditItemId);
        return {
          ...prev,
          [activeTab.zoneId]: updated,
        };
      });
    },
    [activeTab],
  );

  const handleClearAllAuditOverrides = useCallback(() => {
    if (!activeTab || activeTab.kind !== "zone") return;
    storageManager.clearAllAuditOverrides(activeTab.zoneId);
    setAuditOverridesByZone((prev) => ({
      ...prev,
      [activeTab.zoneId]: new Set(),
    }));
  }, [activeTab]);

  useEffect(() => {
    if (activeTab?.kind !== "zone") return;
    setRegistryLookupDomain(activeTab.zoneName);
    setRegistryChecksError(null);
    setRdapResult(null);
    setShowRawRdap(false);
    setRegistrarDomainResult(null);
    setRegistrarHealthResult(null);
  }, [activeTab?.id, activeTab?.kind, activeTab?.zoneName]);

  const runDomainRegistryChecks = useCallback(async () => {
    const domain = registryLookupDomain.trim().toLowerCase();
    if (!domain) return;
    setRegistryChecksLoading(true);
    setRegistryChecksError(null);

    const [rdap, domains, health] = await Promise.allSettled([
      fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`).then(
        async (res) => {
          if (!res.ok) {
            throw new Error(`RDAP lookup failed (${res.status})`);
          }
          return (await res.json()) as Record<string, unknown>;
        },
      ),
      registrarListAllDomains(),
      registrarHealthCheckAll(),
    ]);

    const errors: string[] = [];
    if (rdap.status === "fulfilled") {
      setRdapResult(rdap.value);
    } else {
      setRdapResult(null);
      errors.push(
        rdap.reason instanceof Error
          ? rdap.reason.message
          : String(rdap.reason),
      );
    }

    if (domains.status === "fulfilled") {
      const list = (
        Array.isArray(domains.value) ? domains.value : []
      ) as DomainInfo[];
      const match =
        list.find((d) => d.domain.toLowerCase() === domain) ??
        list.find((d) => d.domain.toLowerCase().endsWith(`.${domain}`)) ??
        null;
      setRegistrarDomainResult(match);
    } else {
      setRegistrarDomainResult(null);
      errors.push(
        domains.reason instanceof Error
          ? domains.reason.message
          : String(domains.reason),
      );
    }

    if (health.status === "fulfilled") {
      const checks = (
        Array.isArray(health.value) ? health.value : []
      ) as DomainHealthCheck[];
      const match =
        checks.find((h) => h.domain.toLowerCase() === domain) ?? null;
      setRegistrarHealthResult(match);
    } else {
      setRegistrarHealthResult(null);
      errors.push(
        health.reason instanceof Error
          ? health.reason.message
          : String(health.reason),
      );
    }

    setRegistryChecksError(errors.length ? errors.join(" | ") : null);
    setRegistryChecksLoading(false);
  }, [registrarHealthCheckAll, registrarListAllDomains, registryLookupDomain]);

  const filteredRecords = useMemo(() => {
    if (!activeTab || activeTab.kind !== "zone") return [];
    const query = activeTab.searchTerm.trim().toLowerCase();
    const requiresFilter = Boolean(activeTab.typeFilter || query);
    const base: DNSRecord[] = requiresFilter ? [] : activeTab.records;
    if (requiresFilter) {
      for (const record of activeTab.records) {
        if (activeTab.typeFilter && record.type !== activeTab.typeFilter)
          continue;
        if (!query) {
          base.push(record);
          continue;
        }
        const matchesRecord =
          record.name.toLowerCase().includes(query) ||
          record.type.toLowerCase().includes(query) ||
          record.content.toLowerCase().includes(query);
        if (matchesRecord) {
          base.push(record);
          continue;
        }
        const recordTags = storageManager.getRecordTags(
          activeTab.zoneId,
          record.id,
        );
        if (recordTags.some((tag) => tag.toLowerCase().includes(query))) {
          base.push(record);
        }
      }
    }

    if (!activeTab.sortKey || !activeTab.sortDir) return base;
    const dir = activeTab.sortDir === "asc" ? 1 : -1;
    const getTtl = (record: DNSRecord) => {
      const ttl = record.ttl;
      if (ttl === 1) return 0;
      if (typeof ttl === "number") return ttl;
      return 0;
    };

    const cmpText = (a: string, b: string) =>
      a.localeCompare(b, undefined, { sensitivity: "base" });

    const sorted = (base === activeTab.records ? [...base] : base).sort(
      (a, b) => {
        switch (activeTab.sortKey) {
          case "type":
            return dir * cmpText(a.type ?? "", b.type ?? "");
          case "name":
            return dir * cmpText(a.name ?? "", b.name ?? "");
          case "content":
            return dir * cmpText(a.content ?? "", b.content ?? "");
          case "ttl":
            return dir * (getTtl(a) - getTtl(b));
          case "proxied":
            return (
              dir * (Number(Boolean(a.proxied)) - Number(Boolean(b.proxied)))
            );
          default:
            return 0;
        }
      },
    );

    return sorted;
    // `tagsVersion` is a manual invalidation counter, not a value this memo
    // reads: tag matching above goes through `storageManager.getRecordTags`,
    // an imperative store ESLint cannot see. Dropping it would leave the
    // filtered list stale after a tag edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tagsVersion]);

  const visibleRecords = useMemo(
    () =>
      filteredRecords.length > DNS_RECORD_RENDER_LIMIT
        ? filteredRecords.slice(0, DNS_RECORD_RENDER_LIMIT)
        : filteredRecords,
    [filteredRecords],
  );
  const selectedRecordIds = useMemo(
    () => new Set(activeTab?.selectedIds ?? []),
    [activeTab?.selectedIds],
  );

  const tagCounts = useMemo(() => {
    if (!tagsZoneId) return {};
    return storageManager.getTagUsageCounts(tagsZoneId);
    // `tagsVersion` is a manual invalidation counter for the imperative
    // `storageManager` tag store, which ESLint cannot track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagsZoneId, tagsVersion]);

  const zoneTags = useMemo(() => {
    if (!tagsZoneId) return [];
    return storageManager.getZoneTags(tagsZoneId);
    // `tagsVersion` is a manual invalidation counter for the imperative
    // `storageManager` tag store, which ESLint cannot track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagsZoneId, tagsVersion]);

  const tagManagerRecordsByTag = useMemo(() => {
    const byTag: Record<string, DNSRecord[]> = {};
    if (!tagsZoneId) return byTag;
    for (const record of tagManagerRecords) {
      const recordTags = storageManager.getRecordTags(tagsZoneId, record.id);
      for (const tag of recordTags) {
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push(record);
      }
    }
    return byTag;
    // `tagsVersion` is a manual invalidation counter: the grouping above reads
    // `storageManager.getRecordTags`, an imperative store ESLint cannot track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagManagerRecords, tagsVersion, tagsZoneId]);

  const filteredTagManagerRecords = useMemo(() => {
    const search = tagAssociationSearch.trim().toLowerCase();
    const sorted = [...tagManagerRecords].sort((a, b) =>
      `${a.name}|${a.type}`.localeCompare(`${b.name}|${b.type}`, undefined, {
        sensitivity: "base",
      }),
    );
    if (!search || !tagsZoneId) return sorted;
    return sorted.filter((record) => {
      if (record.name.toLowerCase().includes(search)) return true;
      if (record.type.toLowerCase().includes(search)) return true;
      if (record.content.toLowerCase().includes(search)) return true;
      const tags = storageManager.getRecordTags(tagsZoneId, record.id);
      return tags.some((tag) => tag.toLowerCase().includes(search));
    });
    // `tagsVersion` is a manual invalidation counter: the search above reads
    // `storageManager.getRecordTags`, an imperative store ESLint cannot track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagAssociationSearch, tagManagerRecords, tagsVersion, tagsZoneId]);

  const visibleTagManagerRecords = useMemo(
    () => filteredTagManagerRecords.slice(0, 150),
    [filteredTagManagerRecords],
  );

  const attachTagToRecord = useCallback(
    (recordId: string, tagValue: string) => {
      if (!tagsZoneId) return;
      const tag = tagValue.trim();
      if (!tag) return;
      const current = storageManager.getRecordTags(tagsZoneId, recordId);
      if (current.includes(tag)) return;
      storageManager.setRecordTags(tagsZoneId, recordId, [...current, tag]);
    },
    [tagsZoneId],
  );

  const detachTagFromRecord = useCallback(
    (recordId: string, tagValue: string) => {
      if (!tagsZoneId) return;
      const current = storageManager.getRecordTags(tagsZoneId, recordId);
      storageManager.setRecordTags(
        tagsZoneId,
        recordId,
        current.filter((tag) => tag !== tagValue),
      );
    },
    [tagsZoneId],
  );

  const getAuditFieldValue = useCallback(
    (entry: Record<string, unknown>, field: AuditFilterField): string => {
      if (field === "details") {
        const details = { ...entry };
        delete details.timestamp;
        delete details.operation;
        delete details.resource;
        return JSON.stringify(details);
      }
      const value = entry[field];
      return typeof value === "string" ? value : "";
    },
    [],
  );

  const filteredAuditEntries = useMemo(() => {
    if (!auditEntries.length) return [];
    const search = auditSearch.trim().toLowerCase();
    const activeFilters = auditFilters
      .map((rule) => ({
        ...rule,
        value: rule.value.trim(),
      }))
      .filter((rule) => rule.value.length > 0);
    return auditEntries.filter((entry) => {
      if (search) {
        const payload = JSON.stringify(entry).toLowerCase();
        if (!payload.includes(search)) return false;
      }

      for (const rule of activeFilters) {
        const fieldValue = getAuditFieldValue(entry, rule.field);
        const haystack = fieldValue.toLowerCase();
        const needle = rule.value.toLowerCase();

        if (rule.operator === "equals" && haystack !== needle) return false;
        if (rule.operator === "not_equals" && haystack === needle) return false;
        if (rule.operator === "contains" && !haystack.includes(needle))
          return false;
        if (rule.operator === "not_contains" && haystack.includes(needle))
          return false;
        if (rule.operator === "starts_with" && !haystack.startsWith(needle))
          return false;
        if (rule.operator === "ends_with" && !haystack.endsWith(needle))
          return false;
        if (rule.operator === "matches") {
          try {
            const re = new RegExp(rule.value, "i");
            if (!re.test(fieldValue)) return false;
          } catch {
            return false;
          }
        }
        if (
          rule.operator === "gt" ||
          rule.operator === "gte" ||
          rule.operator === "lt" ||
          rule.operator === "lte"
        ) {
          const left =
            rule.field === "timestamp"
              ? Date.parse(fieldValue)
              : Number(fieldValue);
          const right =
            rule.field === "timestamp"
              ? Date.parse(rule.value)
              : Number(rule.value);
          if (Number.isNaN(left) || Number.isNaN(right)) return false;
          if (rule.operator === "gt" && !(left > right)) return false;
          if (rule.operator === "gte" && !(left >= right)) return false;
          if (rule.operator === "lt" && !(left < right)) return false;
          if (rule.operator === "lte" && !(left <= right)) return false;
        }
      }
      return true;
    });
  }, [auditEntries, auditFilters, auditSearch, getAuditFieldValue]);

  const orderedAuditEntries = useMemo(() => {
    const entries = [...filteredAuditEntries];
    const parseTime = (value: unknown) => {
      if (typeof value !== "string") return 0;
      const ts = Date.parse(value);
      return Number.isNaN(ts) ? 0 : ts;
    };
    entries.sort((a, b) => {
      if (auditSort.field === "operation") {
        const cmp = String(a.operation ?? "").localeCompare(
          String(b.operation ?? ""),
        );
        return auditSort.dir === "asc" ? cmp : -cmp;
      }
      if (auditSort.field === "resource") {
        const cmp = String(a.resource ?? "").localeCompare(
          String(b.resource ?? ""),
        );
        return auditSort.dir === "asc" ? cmp : -cmp;
      }
      const aTime = parseTime(a.timestamp);
      const bTime = parseTime(b.timestamp);
      return auditSort.dir === "asc" ? aTime - bTime : bTime - aTime;
    });
    return entries;
  }, [filteredAuditEntries, auditSort]);

  const limitedAuditEntries = useMemo(() => {
    if (auditLimit === "all") return orderedAuditEntries;
    const limit = Number(auditLimit);
    if (Number.isNaN(limit)) return orderedAuditEntries;
    return orderedAuditEntries.slice(0, limit);
  }, [orderedAuditEntries, auditLimit]);

  const clearAuditEntriesNow = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      await TauriClient.clearAuditEntries();
      setAuditEntries([]);
      setAuditError(null);
    } catch (error) {
      const diagnostic = reportDnsManagerFailure(
        error,
        "Clear desktop DNS audit entries",
      );
      setAuditError(diagnostic.message);
    }
  }, []);

  const createAuditFilterRule = useCallback(
    (
      field: AuditFilterField = "operation",
      operator: AuditFilterOperator = "contains",
      value = "",
    ): AuditFilterRule => ({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
      field,
      operator,
      value,
    }),
    [],
  );

  const addAuditFilter = useCallback(() => {
    setAuditFilters((prev) => [...prev, createAuditFilterRule()]);
  }, [createAuditFilterRule]);

  const updateAuditFilter = useCallback(
    (id: string, patch: Partial<Omit<AuditFilterRule, "id">>) => {
      setAuditFilters((prev) =>
        prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
      );
    },
    [],
  );

  const removeAuditFilter = useCallback((id: string) => {
    setAuditFilters((prev) => prev.filter((rule) => rule.id !== id));
  }, []);

  const applyAuditPreset = useCallback(
    (
      preset:
        | "errors"
        | "auth"
        | "dns"
        | "api_keys"
        | "zone_settings"
        | "cache"
        | "last24h"
        | "last7d"
        | "today"
        | "clear",
    ) => {
      if (preset === "clear") {
        setAuditFilters([]);
        return;
      }
      const now = Date.now();
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const presetRules: AuditFilterRule[] =
        preset === "errors"
          ? [createAuditFilterRule("details", "contains", '"success":false')]
          : preset === "auth"
            ? [createAuditFilterRule("operation", "contains", "auth:")]
            : preset === "dns"
              ? [createAuditFilterRule("operation", "contains", "dns:")]
              : preset === "api_keys"
                ? [createAuditFilterRule("operation", "contains", "api_key:")]
                : preset === "zone_settings"
                  ? [
                      createAuditFilterRule(
                        "operation",
                        "contains",
                        "zone_setting",
                      ),
                    ]
                  : preset === "cache"
                    ? [createAuditFilterRule("operation", "contains", "cache")]
                    : preset === "last24h"
                      ? [
                          createAuditFilterRule(
                            "timestamp",
                            "gte",
                            new Date(now - 24 * 60 * 60 * 1000).toISOString(),
                          ),
                        ]
                      : preset === "last7d"
                        ? [
                            createAuditFilterRule(
                              "timestamp",
                              "gte",
                              new Date(
                                now - 7 * 24 * 60 * 60 * 1000,
                              ).toISOString(),
                            ),
                          ]
                        : [
                            createAuditFilterRule(
                              "timestamp",
                              "gte",
                              startOfToday.toISOString(),
                            ),
                          ];

      setAuditFilters((prev) => {
        const existing = new Set(
          prev.map((r) => `${r.field}|${r.operator}|${r.value}`),
        );
        const additions = presetRules.filter(
          (r) => !existing.has(`${r.field}|${r.operator}|${r.value}`),
        );
        return [...prev, ...additions];
      });
    },
    [createAuditFilterRule],
  );

  const toggleAuditSort = useCallback(
    (field: "timestamp" | "operation" | "resource") => {
      setAuditSort((prev) => {
        if (prev.field !== field) {
          return { field, dir: field === "timestamp" ? "desc" : "asc" };
        }
        return { field, dir: prev.dir === "asc" ? "desc" : "asc" };
      });
    },
    [],
  );

  const exportSessionSettings = useCallback(() => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessionId: currentSessionId,
      settings: buildSessionSettingsProfile(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-settings-${currentSessionId}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast({
      title: t("Exported", "Exported"),
      description: t(
        "Session settings exported.",
        "Session settings exported.",
      ),
    });
  }, [buildSessionSettingsProfile, currentSessionId, t, toast]);

  const importSessionSettings = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as
          SessionSettingsProfile | { settings?: SessionSettingsProfile };
        const profile =
          parsed && typeof parsed === "object" && "settings" in parsed
            ? (parsed.settings as SessionSettingsProfile | undefined)
            : (parsed as SessionSettingsProfile);
        if (!profile || typeof profile !== "object") {
          throw new Error("Invalid settings file");
        }
        applySessionSettingsProfile(profile);
        const nextProfiles = {
          ...sessionSettingsProfiles,
          [currentSessionId]: profile,
        };
        setSessionSettingsProfiles(nextProfiles);
        storageManager.setSessionSettingsProfile(currentSessionId, profile);
        if (isDesktop()) {
          await TauriClient.updatePreferenceFields({
            session_settings_profiles: nextProfiles,
          });
        }
        toast({
          title: t("Imported", "Imported"),
          description: t(
            "Session settings imported.",
            "Session settings imported.",
          ),
        });
      } catch (error) {
        toast({
          title: t("Import failed", "Import failed"),
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      } finally {
        event.target.value = "";
      }
    },
    [
      applySessionSettingsProfile,
      currentSessionId,
      sessionSettingsProfiles,
      t,
      toast,
    ],
  );

  const cloneSessionSettingsFrom = useCallback(
    async (sourceSessionId: string) => {
      if (!sourceSessionId) return;
      const profile = sessionSettingsProfiles[sourceSessionId];
      if (!profile) {
        toast({
          title: t("Clone failed", "Clone failed"),
          description: t("No saved settings found for {{session}}.", {
            session: sourceSessionId,
            defaultValue: `No saved settings found for ${sourceSessionId}.`,
          }),
          variant: "destructive",
        });
        return;
      }
      applySessionSettingsProfile(profile);
      const nextProfiles = {
        ...sessionSettingsProfiles,
        [currentSessionId]: profile,
      };
      setSessionSettingsProfiles(nextProfiles);
      storageManager.setSessionSettingsProfile(currentSessionId, profile);
      if (isDesktop()) {
        try {
          await TauriClient.updatePreferenceFields({
            session_settings_profiles: nextProfiles,
          });
        } catch {
          // best effort
        }
      }
      toast({
        title: t("Cloned", "Cloned"),
        description: t("Applied settings from {{session}}.", {
          session: sourceSessionId,
          defaultValue: `Applied settings from ${sourceSessionId}.`,
        }),
      });
    },
    [
      applySessionSettingsProfile,
      currentSessionId,
      sessionSettingsProfiles,
      t,
      toast,
    ],
  );
  const handleAddRecord = async () => {
    if (!activeTab) return;
    // Normalize here rather than in the dialog: `onAdd` reads the draft back
    // out of tab state, so a normalizing `onRecordChange` in the same tick
    // would still submit the stale value.
    const draft = normalizeRecordCharacterStrings(activeTab.newRecord);
    if (!draft.type || !draft.name || !draft.content) {
      toast({
        title: t("Error", "Error"),
        description: t(
          "Please fill in all required fields",
          "Please fill in all required fields",
        ),
        variant: "destructive",
      });
      return;
    }

    try {
      const createdRecord = await createDNSRecord(activeTab.zoneId, draft);
      const bounded = retainDnsRecordsForUi([
        createdRecord,
        ...activeTab.records.filter((record) => record.id !== createdRecord.id),
      ]);
      const sourceRecordCount = Math.max(
        bounded.sourceRecordCount,
        activeTab.sourceRecordCount + 1,
      );
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: bounded.records,
        recordsLimited: prev.recordsLimited || bounded.limited,
        sourceRecordCount,
        newRecord: createEmptyRecord(),
        showAddRecord: false,
      }));
      cacheZoneRecords(activeTab.zoneId, activeTab.zoneName, bounded.records);
      pushUndo({
        description: `Create ${createdRecord.type} ${createdRecord.name}`,
        forward: {
          kind: "create",
          zoneId: activeTab.zoneId,
          record: createdRecord,
        },
        reverse: {
          kind: "delete",
          zoneId: activeTab.zoneId,
          recordId: createdRecord.id,
          record: createdRecord,
        },
      });
      toast({
        title: t("Success", "Success"),
        description: t(
          "DNS record created successfully",
          "DNS record created successfully",
        ),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to create DNS record: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to create DNS record: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleAddSuggestedRecord = useCallback(
    (suggestion: {
      recordType: DNSRecord["type"];
      name: string;
      content: string;
    }) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      const suggestedRecord: Partial<DNSRecord> = {
        ...createEmptyRecord(),
        type: suggestion.recordType,
        name: normalizeSuggestedRecordName(suggestion.name, activeTab.zoneName),
        content: suggestion.content,
        ttl: 300,
      };

      setActionTab("records");
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        showAddRecord: true,
        newRecord: suggestedRecord,
      }));
    },
    [activeTab, updateTab],
  );

  const handleUpdateRecord = async (record: DNSRecord) => {
    if (!activeTab) return;
    const oldRecord = activeTab.records.find((r) => r.id === record.id);
    try {
      const updatedRecord = await updateDNSRecord(
        activeTab.zoneId,
        record.id,
        record,
      );
      const nextRecordId = updatedRecord.id || record.id;
      if (nextRecordId !== record.id) {
        storageManager.moveRecordTags(
          activeTab.zoneId,
          record.id,
          nextRecordId,
        );
      }
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? { ...updatedRecord, id: nextRecordId } : r,
        ),
        selectedIds: Array.from(
          new Set(
            prev.selectedIds.map((id) =>
              id === record.id ? nextRecordId : id,
            ),
          ),
        ),
        editingRecord: null,
      }));
      if (oldRecord) {
        pushUndo({
          description: `Update ${record.type} ${record.name}`,
          forward: {
            kind: "update",
            zoneId: activeTab.zoneId,
            record: { ...updatedRecord, id: nextRecordId },
          },
          reverse: {
            kind: "update",
            zoneId: activeTab.zoneId,
            record: oldRecord,
          },
        });
      }
      toast({
        title: t("Success", "Success"),
        description: t(
          "DNS record updated successfully",
          "DNS record updated successfully",
        ),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to update DNS record: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to update DNS record: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleToggleProxy = async (record: DNSRecord, proxied: boolean) => {
    if (!activeTab) return;
    try {
      const updatedRecord = await updateDNSRecord(activeTab.zoneId, record.id, {
        ...record,
        proxied,
      });
      const nextRecordId = updatedRecord.id || record.id;
      if (nextRecordId !== record.id) {
        storageManager.moveRecordTags(
          activeTab.zoneId,
          record.id,
          nextRecordId,
        );
      }
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.map((r) =>
          r.id === record.id ? { ...updatedRecord, id: nextRecordId } : r,
        ),
        selectedIds: Array.from(
          new Set(
            prev.selectedIds.map((id) =>
              id === record.id ? nextRecordId : id,
            ),
          ),
        ),
      }));
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to update proxy: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to update proxy: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (!activeTab) return;
    const deletedRecord = activeTab.records.find((r) => r.id === recordId);
    try {
      await deleteDNSRecord(activeTab.zoneId, recordId);
      storageManager.clearRecordTags(activeTab.zoneId, recordId);
      updateTab(activeTab.id, (prev) => ({
        ...prev,
        records: prev.records.filter((r) => r.id !== recordId),
        selectedIds: prev.selectedIds.filter((id) => id !== recordId),
      }));
      if (deletedRecord) {
        pushUndo({
          description: `Delete ${deletedRecord.type} ${deletedRecord.name}`,
          forward: {
            kind: "delete",
            zoneId: activeTab.zoneId,
            recordId,
            record: deletedRecord,
          },
          reverse: {
            kind: "create",
            zoneId: activeTab.zoneId,
            record: deletedRecord,
          },
        });
      }
      toast({
        title: t("Success", "Success"),
        description: t(
          "DNS record deleted successfully",
          "DNS record deleted successfully",
        ),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to delete DNS record: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to delete DNS record: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  /**
   * Delete every selected record and report exactly what the API confirmed.
   *
   * The backend deletes one record at a time and resolves with both halves, so
   * a partial failure is silent unless it is read: only the ids it lists as
   * deleted leave the table, and anything it refused stays selected and
   * visible because it is still live at Cloudflare.
   */
  const handleBulkDelete = async () => {
    if (!activeTab || activeTab.kind !== "zone") return;
    const targetIds = activeTab.selectedIds;
    if (!targetIds.length) return;
    const zoneId = activeTab.zoneId;
    const zoneName = activeTab.zoneName;
    const tabId = activeTab.id;
    const targeted = activeTab.records.filter((r) => targetIds.includes(r.id));

    try {
      const result = await deleteBulkDnsRecords(zoneId, targetIds);
      const deletedIds = new Set(result.deleted);
      const deletedRecords = targeted.filter((r) => deletedIds.has(r.id));

      for (const id of deletedIds) storageManager.clearRecordTags(zoneId, id);
      updateTab(tabId, (prev) => ({
        ...prev,
        selectedIds: prev.selectedIds.filter((id) => !deletedIds.has(id)),
        records: prev.records.filter((r) => !deletedIds.has(r.id)),
      }));

      if (deletedRecords.length) {
        pushUndo({
          description: `Delete ${deletedRecords.length} record(s) from ${zoneName}`,
          forward: { kind: "bulk-delete", zoneId, records: deletedRecords },
          reverse: { kind: "bulk-create", zoneId, records: deletedRecords },
        });
      }

      if (result.failed.length) {
        toast({
          title: t("Partially deleted", "Partially deleted"),
          description: t(
            "Deleted {{deleted}} of {{total}}. {{failed}} record(s) still exist: {{reasons}}",
            {
              deleted: deletedIds.size,
              total: targetIds.length,
              failed: result.failed.length,
              reasons: describeBulkDeleteFailures(result.failed, targeted),
              defaultValue: `Deleted ${deletedIds.size} of ${targetIds.length}. ${result.failed.length} record(s) still exist: ${describeBulkDeleteFailures(result.failed, targeted)}`,
            },
          ),
          variant: "destructive",
        });
        return;
      }

      toast({
        title: t("Deleted", "Deleted"),
        description: t("{{count}} records deleted", {
          count: deletedIds.size,
          defaultValue: `${deletedIds.size} records deleted`,
        }),
      });
    } catch (err) {
      toast({
        title: t("Error", "Error"),
        description: err instanceof Error ? err.message : "Bulk delete failed",
        variant: "destructive",
      });
    }
  };

  /**
   * Apply one field to every selected record, one call at a time.
   *
   * Cloudflare rate-limits partway through large batches, so each record is
   * tracked on its own: the table is rebuilt from the records that actually
   * changed, the undo entry restores only those, and the toast names how many
   * were refused instead of leaving the whole batch unreported.
   */
  const handleBulkFieldChange = async (
    patch: Partial<Pick<DNSRecord, "ttl" | "proxied">>,
    describe: (count: number) => string,
    label: string,
  ) => {
    if (!activeTab || activeTab.kind !== "zone") return;
    const targetIds = activeTab.selectedIds;
    if (!targetIds.length) return;
    const zoneId = activeTab.zoneId;
    const tabId = activeTab.id;
    const targeted = activeTab.records.filter((r) => targetIds.includes(r.id));

    const before: DNSRecord[] = [];
    const after: DNSRecord[] = [];
    const applied = new Map<string, DNSRecord>();
    const failures: Array<{ record: DNSRecord; error: string }> = [];

    for (const rec of targeted) {
      try {
        const updated = await updateDNSRecord(zoneId, rec.id, {
          ...rec,
          ...patch,
        });
        // Trust the server echo when it comes back usable; fall back to the
        // patch we know was accepted rather than inventing a record.
        const next = updated?.id
          ? { ...rec, ...patch, ...updated }
          : { ...rec, ...patch };
        // Undo has to target whatever id the record carries now, not the one
        // it carried before the call.
        before.push({ ...rec, id: next.id });
        after.push(next);
        applied.set(rec.id, next);
      } catch (error) {
        failures.push({
          record: rec,
          error:
            error instanceof Error && error.message
              ? error.message
              : String(error),
        });
      }
    }

    if (after.length) {
      updateTab(tabId, (prev) => ({
        ...prev,
        records: prev.records.map((r) => applied.get(r.id) ?? r),
      }));
      pushUndo({
        description: `${label} on ${after.length} record(s)`,
        forward: { kind: "bulk-update", zoneId, records: after },
        reverse: { kind: "bulk-update", zoneId, records: before },
      });
    }

    if (failures.length) {
      toast({
        title: t("Partially updated", "Partially updated"),
        description: t(
          "{{updated}} of {{total}} updated. {{failed}} unchanged: {{reasons}}",
          {
            updated: after.length,
            total: targeted.length,
            failed: failures.length,
            reasons: describeBulkUpdateFailures(failures),
            defaultValue: `${after.length} of ${targeted.length} updated. ${failures.length} unchanged: ${describeBulkUpdateFailures(failures)}`,
          },
        ),
        variant: "destructive",
      });
      return;
    }

    toast({
      title: t("Updated", "Updated"),
      description: describe(after.length),
    });
  };

  const handleExport = async (format: "json" | "csv" | "bind") => {
    if (!activeTab || activeTab.kind !== "zone") return;
    exportRequestRef.current?.abort();
    const controller = new AbortController();
    exportRequestRef.current = controller;

    try {
      const completeRecords = await loadCompleteDnsRecordsForExport(
        getDNSRecords,
        activeTab.zoneId,
        controller.signal,
        format,
      );
      throwIfDnsOperationAborted(controller.signal);

      let content = "";
      let filename = "";
      let mimeType = "";

      if (isDesktop()) {
        const desktopRecords =
          completeRecords as unknown as import("@/lib/api/tauri-client").TauriDNSRecord[];
        try {
          switch (format) {
            case "json":
              content = await TauriClient.recordsToJson(
                desktopRecords,
                controller.signal,
              );
              filename = `${activeTab.zoneId}-records.json`;
              mimeType = "application/json";
              break;
            case "csv":
              content = await TauriClient.recordsToCsv(
                desktopRecords,
                controller.signal,
              );
              filename = `${activeTab.zoneId}-records.csv`;
              mimeType = "text/csv";
              break;
            case "bind":
              content = await TauriClient.recordsToBind(
                desktopRecords,
                controller.signal,
              );
              filename = `${activeTab.zoneId}.zone`;
              mimeType = "text/plain";
              break;
          }
        } catch {
          throwIfDnsOperationAborted(controller.signal);
          // Fall back to the frontend serializers using the same complete set.
        }
      }

      if (!content) {
        switch (format) {
          case "json":
            content = JSON.stringify(completeRecords, null, 2);
            filename = `${activeTab.zoneId}-records.json`;
            mimeType = "application/json";
            break;
          case "csv": {
            const escapeCSV = (value: unknown) =>
              `"${String(value ?? "").replace(/"/g, '""')}"`;
            const rows = [
              ["Type", "Name", "Content", "TTL", "Priority", "Proxied"]
                .map(escapeCSV)
                .join(","),
            ];
            for (const record of completeRecords) {
              rows.push(
                [
                  record.type,
                  record.name,
                  record.content,
                  record.ttl,
                  record.priority ?? "",
                  record.proxied ?? false,
                ]
                  .map(escapeCSV)
                  .join(","),
              );
            }
            content = rows.join("\n");
            filename = `${activeTab.zoneId}-records.csv`;
            mimeType = "text/csv";
            break;
          }
          case "bind": {
            const rows: string[] = [];
            for (const record of completeRecords) {
              const ttl = record.ttl || 300;
              const priority = record.priority ? `${record.priority} ` : "";
              rows.push(
                `${record.name}\t${ttl}\tIN\t${record.type}\t${priority}${record.content}`,
              );
            }
            content = rows.join("\n");
            filename = `${activeTab.zoneId}.zone`;
            mimeType = "text/plain";
            break;
          }
        }
      }

      throwIfDnsOperationAborted(controller.signal);
      if (content.length * 2 > DNS_EXPORT_ESTIMATED_BYTE_LIMIT) {
        throw new Error(
          `DNS export exceeds the ${DNS_EXPORT_ESTIMATED_BYTE_LIMIT / (1024 * 1024)} MiB in-memory output safety limit; no file was created.`,
        );
      }
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);

      toast({
        title: t("Success", "Success"),
        description: t(
          "Exported all {{count}} authoritative records as {{format}}.",
          {
            count: completeRecords.length,
            format: format.toUpperCase(),
            defaultValue: `Exported all ${completeRecords.length} authoritative records as ${format.toUpperCase()}.`,
          },
        ),
      });
    } catch (error) {
      if (controller.signal.aborted || (error as Error).name === "AbortError") {
        return;
      }
      toast({
        title: t("Error", "Error"),
        description: t(
          "Complete DNS export failed; no partial file was created: {{error}}",
          {
            error: (error as Error).message,
            defaultValue: `Complete DNS export failed; no partial file was created: ${(error as Error).message}`,
          },
        ),
        variant: "destructive",
      });
    } finally {
      if (exportRequestRef.current === controller) {
        exportRequestRef.current = null;
      }
    }
  };

  const handleImport = async (
    tab: ZoneTab,
    providedItems?: Partial<DNSRecord>[],
    dryRun?: boolean,
  ) => {
    try {
      let items: Partial<DNSRecord>[] | null = null;
      if (providedItems) items = providedItems as Partial<DNSRecord>[];
      else {
        switch (tab.importFormat) {
          case "json": {
            const imported = JSON.parse(tab.importData);
            items = Array.isArray(imported)
              ? imported
              : Array.isArray(imported.records)
                ? imported.records
                : null;
            break;
          }
          case "csv":
            items = isDesktop()
              ? ((await TauriClient.parseCsvRecords(
                  tab.importData,
                )) as Partial<DNSRecord>[])
              : parseCSVRecords(tab.importData);
            break;
          case "bind":
            items = isDesktop()
              ? ((await TauriClient.parseBindZone(
                  tab.importData,
                )) as Partial<DNSRecord>[])
              : parseBINDZone(tab.importData);
            break;
        }
      }

      if (!items) {
        throw new Error("Invalid format");
      }

      const valid: DNSRecord[] = [];
      let skipped = 0;

      for (const rawItem of items) {
        // Normalize before the duplicate check so an unquoted TXT import does
        // not create a second copy of an already normalized record.
        const item = rawItem
          ? normalizeRecordCharacterStrings(rawItem as Partial<DNSRecord>)
          : rawItem;
        if (item && item.type && item.name && item.content) {
          const exists = tab.records.some(
            (r) =>
              r.type === item.type &&
              r.name === item.name &&
              r.content === item.content,
          );
          if (!exists) {
            valid.push(item as DNSRecord);
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      }

      if (valid.length) {
        // What the backend confirmed, never what was attempted.
        let imported = 0;
        if (bulkCreateDNSRecords) {
          try {
            const result = await bulkCreateDNSRecords(
              tab.zoneId,
              valid,
              dryRun,
            );
            const created = Array.isArray(result?.created)
              ? (result.created as DNSRecord[])
              : [];
            // `skipped` is the backend's per-record rejection list; folding it
            // in is what keeps the toast from over-reporting the import.
            if (Array.isArray(result?.skipped))
              skipped += result.skipped.length;
            imported = created.length;
            if (!dryRun) {
              updateTab(tab.id, (prev) => ({
                ...prev,
                records: [...created, ...prev.records],
              }));
              pushBulkCreateUndo(
                tab.zoneId,
                created,
                `Import ${created.length} record(s) into ${tab.zoneName}`,
              );
            }
          } catch (err) {
            toast({
              title: t("Error", "Error"),
              description: t("Failed to import records: {{error}}", {
                error: (err as Error).message,
                defaultValue: `Failed to import records: ${(err as Error).message}`,
              }),
              variant: "destructive",
            });
            return;
          }
        } else {
          const createdRecords: DNSRecord[] = [];
          for (const v of valid) {
            try {
              const r = await createDNSRecord(tab.zoneId, v);
              createdRecords.push(r);
            } catch {
              skipped++;
            }
          }
          imported = createdRecords.length;
          if (!dryRun) {
            updateTab(tab.id, (prev) => ({
              ...prev,
              records: [...createdRecords, ...prev.records],
            }));
            pushBulkCreateUndo(
              tab.zoneId,
              createdRecords,
              `Import ${createdRecords.length} record(s) into ${tab.zoneName}`,
            );
          }
        }
        if (!dryRun) {
          if (imported) {
            updateTab(tab.id, (prev) => ({
              ...prev,
              importData: "",
              showImport: false,
            }));
            toast({
              title: t("Success", "Success"),
              description: t("Imported {{imported}} record(s){{suffix}}", {
                imported,
                suffix: skipped ? `, skipped ${skipped}` : "",
                defaultValue: `Imported ${imported} record(s)${skipped ? `, skipped ${skipped}` : ""}`,
              }),
            });
          } else {
            // Nothing landed, so the pasted source is kept for an exact retry.
            toast({
              title: t("Error", "Error"),
              description: t(
                "No records were imported. Skipped {{count}} item(s).",
                {
                  count: skipped,
                  defaultValue: `No records were imported. Skipped ${skipped} item(s).`,
                },
              ),
              variant: "destructive",
            });
          }
        } else {
          toast({
            title: t("Dry Run", "Dry Run"),
            description: t("Would import {{imported}} record(s){{suffix}}", {
              imported,
              suffix: skipped ? `, skipped ${skipped}` : "",
              defaultValue: `Would import ${imported} record(s)${skipped ? `, skipped ${skipped}` : ""}`,
            }),
          });
        }
      } else {
        toast({
          title: t("Error", "Error"),
          description: skipped
            ? t(
                "No new records imported. Skipped {{count}} invalid or duplicate item(s).",
                {
                  count: skipped,
                  defaultValue: `No new records imported. Skipped ${skipped} invalid or duplicate item(s).`,
                },
              )
            : t("No valid records found.", "No valid records found."),
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to import records: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to import records: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  /** Queue records for pasting, from wherever they were read. */
  const copyRecordsToBuffer = (
    records: readonly DNSRecord[],
    source: { zoneId: string; zoneName: string },
    description: string,
  ) => {
    setCopyBuffer({
      records: [...records],
      sourceZoneId: source.zoneId,
      sourceZoneName: source.zoneName,
    });
    toast({ title: t("Copied", "Copied"), description });
  };

  const handleCopySelected = () => {
    if (!activeTab) return;
    const selectedRecords = activeTab.records.filter((record) =>
      activeTab.selectedIds.includes(record.id),
    );
    if (!selectedRecords.length) {
      toast({
        title: t("Nothing selected", "Nothing selected"),
        description: t(
          "Select one or more records to copy.",
          "Select one or more records to copy.",
        ),
      });
      return;
    }
    copyRecordsToBuffer(
      selectedRecords,
      { zoneId: activeTab.zoneId, zoneName: activeTab.zoneName },
      t("Copied {{count}} record(s) from {{zone}}", {
        count: selectedRecords.length,
        zone: activeTab.zoneName,
        defaultValue: `Copied ${selectedRecords.length} record(s) from ${activeTab.zoneName}`,
      }),
    );
  };

  const handleCopySingle = (record: DNSRecord) => {
    if (!activeTab) return;
    copyRecordsToBuffer(
      [record],
      { zoneId: activeTab.zoneId, zoneName: activeTab.zoneName },
      t("Copied {{record}} from {{zone}}", {
        record: record.name,
        zone: activeTab.zoneName,
        defaultValue: `Copied ${record.name} from ${activeTab.zoneName}`,
      }),
    );
  };

  /** Zone Compare hands over the records the current zone is missing. */
  const handleCopyComparedRecords = (
    records: DNSRecord[],
    source: { zoneId: string; zoneName: string },
  ) => {
    if (!records.length) return;
    copyRecordsToBuffer(
      records,
      source,
      t("Copied {{count}} record(s) from {{zone}}", {
        count: records.length,
        zone: source.zoneName,
        defaultValue: `Copied ${records.length} record(s) from ${source.zoneName}`,
      }),
    );
  };

  const clearCopyBuffer = () => {
    setCopyBuffer(null);
    setShowCopyBuffer(false);
    setPastePreview(null);
    toast({
      title: t("Copy buffer cleared", "Copy buffer cleared"),
      description: t(
        "No records are queued for pasting.",
        "No records are queued for pasting.",
      ),
    });
  };

  /**
   * Rewrite, normalize and deduplicate the buffer against the destination
   * zone. `changed` reports whether the rewrite altered any name or content,
   * which is what decides if the paste is worth previewing.
   */
  const buildPastePlan = (
    tab: ZoneTab,
    buffer: { records: DNSRecord[]; sourceZoneName: string },
  ): {
    items: PreparedCopiedDnsRecord[];
    skipped: number;
    changed: boolean;
  } => {
    const recordKey = (record: {
      type?: string;
      name?: string;
      content?: string;
    }) => `${record.type ?? ""} ${record.name ?? ""} ${record.content ?? ""}`;

    const seen = new Set(tab.records.map(recordKey));
    const items: PreparedCopiedDnsRecord[] = [];
    let skipped = 0;
    let changed = false;

    for (const record of buffer.records) {
      const prepared = normalizeRecordCharacterStrings(
        prepareCopiedDnsRecord(
          record,
          buffer.sourceZoneName,
          tab.zoneName,
          rewriteCopiedRecordDomains,
        ),
      );
      changed ||=
        prepared.name !== record.name || prepared.content !== record.content;

      if (!prepared.type || !prepared.name || !prepared.content) {
        skipped++;
        continue;
      }
      const key = recordKey(prepared);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      items.push(prepared);
    }

    return { items, skipped, changed };
  };

  const performPaste = async (
    target: { tabId: string; zoneId: string; zoneName: string },
    items: PreparedCopiedDnsRecord[],
    skipped: number,
    dryRun: boolean,
  ) => {
    const describe = (count: number, totalSkipped: number) => {
      const suffix = totalSkipped ? `, skipped ${totalSkipped}` : "";
      return dryRun
        ? t("Would create {{count}} record(s) in {{zone}}{{suffix}}", {
            count,
            zone: target.zoneName,
            suffix,
            defaultValue: `Would create ${count} record(s) in ${target.zoneName}${suffix}`,
          })
        : t("Created {{count}} record(s) in {{zone}}{{suffix}}", {
            count,
            zone: target.zoneName,
            suffix,
            defaultValue: `Created ${count} record(s) in ${target.zoneName}${suffix}`,
          });
    };

    try {
      if (bulkCreateDNSRecords) {
        const result = await bulkCreateDNSRecords(target.zoneId, items, dryRun);
        const created = Array.isArray(result?.created)
          ? (result.created as DNSRecord[])
          : [];
        // The backend reports what it refused; folding it into the same count
        // keeps "Created N" from over-reporting.
        const rejected = Array.isArray(result?.skipped)
          ? result.skipped.length
          : 0;
        if (!dryRun) {
          updateTab(target.tabId, (prev) => ({
            ...prev,
            records: [...created, ...prev.records],
          }));
          pushBulkCreateUndo(
            target.zoneId,
            created,
            `Paste ${created.length} record(s) into ${target.zoneName}`,
          );
        }
        toast({
          title: dryRun ? t("Dry Run", "Dry Run") : t("Pasted", "Pasted"),
          description: describe(
            dryRun ? items.length : created.length,
            skipped + rejected,
          ),
        });
        return;
      }

      if (dryRun) {
        toast({
          title: t("Dry Run", "Dry Run"),
          description: describe(items.length, skipped),
        });
        return;
      }

      const createdRecords: DNSRecord[] = [];
      for (const record of items) {
        createdRecords.push(await createDNSRecord(target.zoneId, record));
      }
      updateTab(target.tabId, (prev) => ({
        ...prev,
        records: [...createdRecords, ...prev.records],
      }));
      pushBulkCreateUndo(
        target.zoneId,
        createdRecords,
        `Paste ${createdRecords.length} record(s) into ${target.zoneName}`,
      );
      toast({
        title: t("Pasted", "Pasted"),
        description: describe(createdRecords.length, skipped),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to paste records: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to paste records: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  };

  const handlePasteRecords = async () => {
    if (!activeTab || !copyBuffer) return;
    const plan = buildPastePlan(activeTab, copyBuffer);

    if (!plan.items.length) {
      toast({
        title: t("Nothing to paste", "Nothing to paste"),
        description: plan.skipped
          ? t(
              "No new records pasted. Skipped {{count}} duplicate or invalid record(s).",
              {
                count: plan.skipped,
                defaultValue: `No new records pasted. Skipped ${plan.skipped} duplicate or invalid record(s).`,
              },
            )
          : t("The copy buffer is empty.", "The copy buffer is empty."),
        variant: "destructive",
      });
      return;
    }

    // A quick paste stays quick: the preview only interrupts when the rewrite
    // actually altered a record, or when enough records are in flight that a
    // look before the write is worth it.
    const needsPreview =
      confirmPastePreview &&
      (plan.changed || plan.items.length > PASTE_PREVIEW_RECORD_THRESHOLD);

    if (needsPreview) {
      setPastePreview({
        tabId: activeTab.id,
        zoneId: activeTab.zoneId,
        zoneName: activeTab.zoneName,
        sourceZoneName: copyBuffer.sourceZoneName,
        items: plan.items,
        skipped: plan.skipped,
        sourceCount: copyBuffer.records.length,
      });
      return;
    }

    await performPaste(
      {
        tabId: activeTab.id,
        zoneId: activeTab.zoneId,
        zoneName: activeTab.zoneName,
      },
      plan.items,
      plan.skipped,
      false,
    );
  };

  const handleSetDevelopmentMode = useCallback(
    async (enabled: boolean) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          "development_mode",
          enabled ? "on" : "off",
        );
        setZoneDevMode(next);
        toast({
          title: t("Saved", "Saved"),
          description: enabled
            ? t(
                "Development mode enabled (cache bypass).",
                "Development mode enabled (cache bypass).",
              )
            : t("Development mode disabled.", "Development mode disabled."),
        });
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to update development mode: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to update development mode: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, t, toast, updateZoneSetting],
  );

  const handleSetCacheLevel = useCallback(
    async (level: string) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setCacheSettingsLoading(true);
        setCacheSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          "cache_level",
          level,
        );
        setZoneCacheLevel(next);
        toast({
          title: t("Saved", "Saved"),
          description: t("Cache level set to {{level}}.", {
            level,
            defaultValue: `Cache level set to ${level}.`,
          }),
        });
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to update cache level: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to update cache level: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        setCacheSettingsLoading(false);
      }
    },
    [activeTab, t, toast, updateZoneSetting],
  );

  const preparePurgeUrls = useCallback(() => {
    const urls = purgeUrlsInput
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const issues: string[] = [];

    for (const url of urls) {
      if (/\s/.test(url)) issues.push(`URL contains whitespace: ${url}`);
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          issues.push(`Unsupported URL scheme: ${url}`);
        }
      } catch {
        issues.push(`Not a valid URL: ${url}`);
      }
    }

    setPendingPurgeUrls(urls);
    setPendingPurgeIssues(issues);
    setShowPurgeUrlsConfirm(true);
  }, [purgeUrlsInput]);

  const confirmPurgeEverything = useCallback(async () => {
    if (!activeTab || activeTab.kind !== "zone") return;
    setShowPurgeEverythingConfirm(false);
    try {
      await purgeCache(activeTab.zoneId, { purge_everything: true });
      toast({
        title: t("Purged", "Purged"),
        description: t("Cache purged for {{zone}}.", {
          zone: activeTab.zoneName,
          defaultValue: `Cache purged for ${activeTab.zoneName}.`,
        }),
      });
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to purge cache: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to purge cache: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  }, [activeTab, purgeCache, t, toast]);

  const confirmPurgeUrls = useCallback(async () => {
    if (!activeTab || activeTab.kind !== "zone") return;
    const urls = pendingPurgeUrls;
    setShowPurgeUrlsConfirm(false);
    if (!urls.length) return;
    try {
      await purgeCache(activeTab.zoneId, { files: urls });
      toast({
        title: t("Purged", "Purged"),
        description: t("Purged {{count}} URL(s) for {{zone}}.", {
          count: urls.length,
          zone: activeTab.zoneName,
          defaultValue: `Purged ${urls.length} URL(s) for ${activeTab.zoneName}.`,
        }),
      });
      setPurgeUrlsInput("");
    } catch (error) {
      toast({
        title: t("Error", "Error"),
        description: t("Failed to purge URLs: {{error}}", {
          error: (error as Error).message,
          defaultValue: `Failed to purge URLs: ${(error as Error).message}`,
        }),
        variant: "destructive",
      });
    }
  }, [activeTab, pendingPurgeUrls, purgeCache, t, toast]);

  const handleSetSslTlsSetting = useCallback(
    async (
      settingId:
        | "ssl"
        | "min_tls_version"
        | "tls_1_3"
        | "always_use_https"
        | "automatic_https_rewrites"
        | "opportunistic_encryption",
      value: string,
    ) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      try {
        setSslSettingsLoading(true);
        setSslSettingsError(null);
        const next = await updateZoneSetting<string>(
          activeTab.zoneId,
          settingId,
          value,
        );
        switch (settingId) {
          case "ssl":
            setZoneSslMode(next);
            break;
          case "min_tls_version":
            setZoneMinTlsVersion(next);
            break;
          case "tls_1_3":
            setZoneTls13(next);
            break;
          case "always_use_https":
            setZoneAlwaysUseHttps(next);
            break;
          case "automatic_https_rewrites":
            setZoneAutoHttpsRewrites(next);
            break;
          case "opportunistic_encryption":
            setZoneOpportunisticEncryption(next);
            break;
        }
        toast({
          title: t("Saved", "Saved"),
          description: t("{{setting}} updated.", {
            setting: settingId.replace(/_/g, " "),
            defaultValue: `${settingId.replace(/_/g, " ")} updated.`,
          }),
        });
      } catch (error) {
        toast({
          title: t("Error", "Error"),
          description: t("Failed to update SSL/TLS setting: {{error}}", {
            error: (error as Error).message,
            defaultValue: `Failed to update SSL/TLS setting: ${(error as Error).message}`,
          }),
          variant: "destructive",
        });
      } finally {
        setSslSettingsLoading(false);
      }
    },
    [activeTab, t, toast, updateZoneSetting],
  );

  const handleLogout = () => {
    persistTabStateBestEffort();
    storageManager.clearSession();
    if (confirmLogout) {
      setShowLogoutConfirm(true);
      return;
    }
    onLogout();
  };

  const confirmAndLogout = () => {
    persistTabStateBestEffort();
    storageManager.clearSession();
    setShowLogoutConfirm(false);
    onLogout();
  };

  const selectedZoneData = activeTab
    ? availableZones.find((z) => z.id === activeTab.zoneId)
    : undefined;
  const actionHintRaw = ACTION_TABS.find((tab) => tab.id === actionTab)?.hint;
  const actionHint = actionHintRaw ? t(actionHintRaw, actionHintRaw) : "";
  const currentTopologyRecordState =
    topologyQueryKey && topologyRecordState.queryKey === topologyQueryKey
      ? topologyRecordState
      : EMPTY_DNS_TOPOLOGY_RECORD_STATE;

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (!activeTab || activeTab.kind !== "zone") return;
      updateTab(activeTab.id, (prev) => {
        if (prev.kind !== "zone") return prev;
        if (prev.sortKey !== key) {
          return { ...prev, sortKey: key, sortDir: "asc" };
        }
        if (prev.sortDir === "asc") {
          return { ...prev, sortDir: "desc" };
        }
        if (prev.sortDir === "desc") {
          return { ...prev, sortKey: null, sortDir: null };
        }
        return { ...prev, sortDir: "asc" };
      });
    },
    [activeTab, updateTab],
  );

  const sortIndicator = useCallback(
    (key: SortKey) => {
      if (!activeTab || activeTab.kind !== "zone") return "";
      if (activeTab.sortKey !== key || !activeTab.sortDir) return "";
      return activeTab.sortDir === "asc" ? "▲" : "▼";
    },
    [activeTab],
  );

  const rdapObject = (rdapResult ?? {}) as Record<string, unknown>;
  const rdapStatuses = Array.isArray(rdapObject.status)
    ? (rdapObject.status as unknown[]).map((s) => String(s))
    : [];
  const rdapNameservers = Array.isArray(rdapObject.nameservers)
    ? (rdapObject.nameservers as Array<Record<string, unknown>>)
        .map((ns) => String(ns.ldhName ?? ns.unicodeName ?? ""))
        .filter(Boolean)
    : [];
  const rdapEvents = Array.isArray(rdapObject.events)
    ? (rdapObject.events as Array<Record<string, unknown>>).map((event) => ({
        action: String(event.eventAction ?? "unknown"),
        date: String(event.eventDate ?? ""),
      }))
    : [];
  const rdapRegistrarEntity = Array.isArray(rdapObject.entities)
    ? (rdapObject.entities as Array<Record<string, unknown>>).find((entity) =>
        Array.isArray(entity.roles)
          ? (entity.roles as unknown[])
              .map((r) => String(r).toLowerCase())
              .includes("registrar")
          : false,
      )
    : undefined;
  const cacheOverlay = useLoadingOverlay(
    cacheSettingsLoading,
    loadingOverlayTimeoutMs,
  );
  const sslOverlay = useLoadingOverlay(
    sslSettingsLoading,
    loadingOverlayTimeoutMs,
  );
  const auditOverlay = useLoadingOverlay(
    activeTab?.kind === "zone" &&
      actionTab === "domain-audit" &&
      activeTab.isLoading,
    loadingOverlayTimeoutMs,
  );
  const registryOverlay = useLoadingOverlay(
    registryChecksLoading,
    loadingOverlayTimeoutMs,
  );
  const mcpRunning = mcpStatus?.running === true;
  const mcpUrl =
    mcpStatus?.url ?? `http://${mcpServerHost}:${mcpServerPort}/mcp`;
  const rawMcpLastError =
    (typeof mcpStatus?.lastError === "string" ? mcpStatus.lastError : null) ??
    (typeof mcpStatus?.last_error === "string" ? mcpStatus.last_error : null);
  const mcpLastError =
    mcpActionError ??
    (rawMcpLastError ? sanitizeRuntimeText(rawMcpLastError) : null);
  const mcpPermissionsInteractive =
    isDesktop() && activeTab?.kind === "settings" && settingsSubtab === "mcp";

  useEffect(() => {
    const portalHost = document.createElement("div");
    portalHost.dataset.mcpPermissionsMount = "true";
    setMcpPermissionsPortalHost(portalHost);
    return () => {
      portalHost.remove();
    };
  }, []);

  useEffect(() => {
    if (!mcpPermissionsPortalHost) return;
    const destination = mcpPermissionsInteractive
      ? mcpPermissionsViewRef.current
      : mcpPermissionsParkingRef.current;
    destination?.appendChild(mcpPermissionsPortalHost);
  }, [mcpPermissionsInteractive, mcpPermissionsPortalHost]);

  return (
    <AuthenticatedAppShell
      commandBar={
        <DnsAppCommandBar
          accountLabel={
            email?.trim() ||
            t("Cloudflare API session", "Cloudflare API session")
          }
          sessionLabel={
            currentSessionId === "__default"
              ? t("Active session", "Active session")
              : currentSessionId
          }
          showAudit={isDesktop()}
          showNotifications={isDesktop()}
          unreadCount={notificationsBadge ? notificationsUnread : 0}
          onOpenNotifications={() => openActionTab("notifications")}
          showAssistant={isDesktop()}
          onOpenAssistant={() => openActionTab("assistant")}
          onOpenAudit={() => openActionTab("audit")}
          onOpenRegistry={() => openActionTab("registry")}
          onOpenSettings={() => openActionTab("settings")}
          onOpenTags={() => openActionTab("tags")}
          onLogout={handleLogout}
        />
      }
      workspaceTabs={
        <DnsWorkspaceTabs
          items={tabs.map((tab) => ({
            id: tab.id,
            label:
              tab.kind === "zone"
                ? tab.zoneName
                : t(tab.zoneName, tab.zoneName),
            kind: tab.kind,
            status: tab.status,
          }))}
          activeId={activeTabId}
          closeOnMiddleClick={closeTabOnMiddleClick}
          onActivate={activateTab}
          onClose={closeTab}
          onOrderChange={applyTabOrder}
        />
      }
      connectionBar={
        <DnsConnectionBar
          zoneSelector={
            <>
              <Label className="sr-only" htmlFor="zone-select">
                {t("Domain/Zone", "Domain/Zone")}
              </Label>
              <Select
                // "" is Radix's placeholder sentinel, same as undefined, but it
                // keeps the underlying native select controlled from the first
                // render instead of flipping once a zone hydrates.
                value={selectedZoneId}
                onValueChange={(value) => {
                  setSelectedZoneId(value);
                  openZoneTab(value);
                }}
              >
                <SelectTrigger
                  id="zone-select"
                  aria-label={t("Domain/Zone", "Domain/Zone")}
                  className="h-8 border-border bg-card/70 text-xs text-foreground"
                >
                  <SelectValue
                    placeholder={t("Select a domain", "Select a domain")}
                  />
                </SelectTrigger>
                <SelectContent className="bg-popover/70 text-foreground">
                  {availableZones.map((zone: Zone) => (
                    <SelectItem
                      key={zone.id}
                      value={zone.id}
                      className="cursor-pointer"
                    >
                      {zone.name} ({zone.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          }
          activeContext={
            activeTab
              ? activeTab.kind === "zone"
                ? activeTab.zoneName
                : t(activeTab.zoneName, activeTab.zoneName)
              : t("No workspace selected", "No workspace selected")
          }
          activeStatus={
            // An action tab's name IS its label, so a second chip would just
            // render "Settings Settings". Only a zone has a distinct status.
            activeTab?.kind === "zone" ? activeTab.status : undefined
          }
          recordCount={
            activeTab?.kind === "zone" ? activeTab.records.length : undefined
          }
          visibleCount={
            activeTab?.kind === "zone" ? filteredRecords.length : undefined
          }
        />
      }
    >
      <div
        id={activeTab ? getDnsWorkspacePanelId(activeTab.id) : undefined}
        role={activeTab ? "tabpanel" : undefined}
        aria-labelledby={
          activeTab ? getDnsWorkspaceTabId(activeTab.id) : undefined
        }
        className="mx-auto w-full max-w-6xl space-y-6 p-4 pb-10 fade-in-up"
      >
        {activeTab ? (
          <Card className="min-h-[520px] border-border/60 bg-card/70 shadow-[0_20px_40px_rgba(0,0,0,0.18)] fade-in">
            <CardHeader className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="text-xl">
                    {activeTab.kind === "zone"
                      ? activeTab.zoneName
                      : t(activeTab.zoneName, activeTab.zoneName)}
                  </CardTitle>
                  {activeTab.kind === "zone" && (
                    <p className="text-xs text-muted-foreground">
                      {actionHint}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2" />
              </div>
              {activeTab.kind === "zone" && (
                <div
                  role="tablist"
                  aria-label={t("Zone views", "Zone views")}
                  aria-orientation="horizontal"
                  data-responsive-overflow="horizontal"
                  className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed fade-in"
                >
                  {ACTION_TABS.map((tab, index) => (
                    <button
                      key={tab.id}
                      ref={(node) => {
                        if (node) actionTabRefs.current.set(tab.id, node);
                        else actionTabRefs.current.delete(tab.id);
                      }}
                      id={getZoneActionTabId(tab.id)}
                      type="button"
                      role="tab"
                      aria-selected={actionTab === tab.id}
                      aria-controls={ZONE_ACTION_PANEL_ID}
                      tabIndex={actionTab === tab.id ? 0 : -1}
                      onClick={() => setActionTab(tab.id)}
                      onKeyDown={(event) =>
                        handleActionTabKeyDown(event, index)
                      }
                      data-active={actionTab === tab.id}
                      className="ui-segment"
                    >
                      {t(tab.label, tab.label)}
                    </button>
                  ))}
                </div>
              )}
            </CardHeader>
            <CardContent
              id={activeTab.kind === "zone" ? ZONE_ACTION_PANEL_ID : undefined}
              role={activeTab.kind === "zone" ? "tabpanel" : undefined}
              aria-labelledby={
                activeTab.kind === "zone"
                  ? getZoneActionTabId(actionTab)
                  : undefined
              }
            >
              {activeTab.kind === "zone" && actionTab === "records" && (
                <>
                  <div className="space-y-4 fade-in">
                    <div className="rounded-xl border border-border/60 bg-card/60 p-3">
                      <div className="mb-2 text-[11px] uppercase tracking-widest text-muted-foreground">
                        {t("Assigned nameservers", "Assigned nameservers")}
                      </div>
                      {selectedZoneData?.name_servers &&
                      selectedZoneData.name_servers.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {selectedZoneData.name_servers.map((ns) => (
                            <span
                              key={ns}
                              className="rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs text-foreground/90"
                            >
                              {ns}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Not available for this zone.",
                            "Not available for this zone.",
                          )}
                        </div>
                      )}
                    </div>
                    {activeTab.isLoading && (
                      <div className="space-y-3">
                        {Array.from({ length: 6 }).map((_, idx) => (
                          <div
                            key={`skeleton-${idx}`}
                            className="rounded-xl border border-border/50 bg-muted/30 p-4"
                          >
                            <div className="flex items-center gap-3">
                              <div className="skeleton h-4 w-4 rounded-md" />
                              <div className="skeleton h-6 w-16 rounded-md" />
                              <div className="skeleton h-4 w-36 rounded-md" />
                            </div>
                            <div className="mt-3 space-y-2">
                              <div className="skeleton h-3 w-5/6 rounded-md" />
                              <div className="skeleton h-3 w-2/3 rounded-md" />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid gap-3 md:grid-cols-[1.2fr_auto_auto_auto] md:items-center">
                      <div className="relative min-w-0">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder={t("Search records", "Search records")}
                          value={activeTab.searchTerm}
                          onChange={(e) =>
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              searchTerm: e.target.value,
                            }))
                          }
                          className="pl-9"
                        />
                      </div>
                      <Select
                        value={activeTab.typeFilter || "all"}
                        onValueChange={(v) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            typeFilter: v === "all" ? "" : (v as RecordType),
                          }))
                        }
                      >
                        <SelectTrigger
                          className="w-[180px]"
                          // Nothing on screen names this control, so without a
                          // label it announces only its current value ("A").
                          aria-label={t(
                            "Filter by record type",
                            "Filter by record type",
                          )}
                        >
                          <SelectValue
                            placeholder={t("All types", "All types")}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">
                            {t("All types", "All types")}
                          </SelectItem>
                          {RECORD_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {type}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={String(activeTab.perPage)}
                        onValueChange={(v) => {
                          const value = clampDnsPageSize(v);
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            perPage: value,
                            page: 1,
                          }));
                          setZonePerPage((prev) => ({
                            ...prev,
                            [activeTab.zoneId]: value,
                          }));
                        }}
                      >
                        <SelectTrigger
                          className="w-32"
                          aria-label={t("Records per page", "Records per page")}
                        >
                          <SelectValue
                            placeholder={t("Per page", "Per page")}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="25">25</SelectItem>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                          <SelectItem value="200">200</SelectItem>
                          <SelectItem value="500">500</SelectItem>
                          <SelectItem value="0">
                            {t("All (bounded)", "All (bounded)")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="flex flex-wrap items-center gap-2 justify-start md:justify-end">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() => void loadRecords(activeTab)}
                          disabled={activeTab.isLoading}
                          title={t(
                            "Force refresh from Cloudflare",
                            "Force refresh from Cloudflare",
                          )}
                          // `title` is a hover-only hint; the icon carries no
                          // text, so the button needs a name of its own.
                          aria-label={t(
                            "Refresh records from Cloudflare",
                            "Refresh records from Cloudflare",
                          )}
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              activeTab.isLoading && "animate-spin",
                            )}
                          />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              searchTerm: "",
                              typeFilter: "",
                              page: 1,
                            }))
                          }
                        >
                          <X className="h-3 w-3 mr-1" />
                          {t("Clear", "Clear")}
                        </Button>
                        <div className="inline-flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs">
                          <Filter className="h-3 w-3" />
                          {t("Page {{page}}", {
                            page: activeTab.page,
                            defaultValue: `Page ${activeTab.page}`,
                          })}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              page: Math.max(1, prev.page - 1),
                            }))
                          }
                          disabled={activeTab.page <= 1}
                        >
                          {t("Prev", "Prev")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              page: prev.page + 1,
                            }))
                          }
                        >
                          {t("Next", "Next")}
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <AddRecordDialog
                        open={activeTab.showAddRecord}
                        onOpenChange={(open) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            showAddRecord: open,
                          }))
                        }
                        record={activeTab.newRecord}
                        onRecordChange={(record) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            newRecord: record,
                          }))
                        }
                        onAdd={handleAddRecord}
                        zoneName={activeTab.zoneName}
                        showUnsupportedRecordTypes={
                          resolvedShowUnsupportedRecordTypes
                        }
                        apiKey={apiKey}
                        email={email}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleCopySelected}
                        disabled={!activeTab.selectedIds.length}
                      >
                        <Copy className="h-4 w-4 mr-2" />
                        {t("Copy selected", "Copy selected")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handlePasteRecords()}
                        disabled={!copyBuffer}
                      >
                        <ClipboardPaste className="h-4 w-4 mr-2" />
                        {t("Paste", "Paste")}{" "}
                        {copyBuffer ? `${copyBuffer.records.length}` : ""}
                      </Button>
                      {copyBuffer && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline underline-offset-2"
                            onClick={() => setShowCopyBuffer(true)}
                          >
                            {t("Buffer: {{count}} from {{zone}}", {
                              count: copyBuffer.records.length,
                              zone: copyBuffer.sourceZoneName,
                              defaultValue: `Buffer: ${copyBuffer.records.length} from ${copyBuffer.sourceZoneName}`,
                            })}
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            onClick={clearCopyBuffer}
                          >
                            <X className="mr-1 h-3 w-3" />
                            {t("Clear buffer", "Clear buffer")}
                          </Button>
                        </div>
                      )}
                      {activeTab.selectedIds.length > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              selectedIds: [],
                            }))
                          }
                        >
                          {t("Clear selection", "Clear selection")}
                        </Button>
                      )}
                    </div>
                    {!activeTab.isLoading &&
                    (activeTab.recordLoadState?.status === "error" ||
                      activeTab.recordLoadState?.status === "stale") ? (
                      <DnsRecordLoadNotice
                        state={activeTab.recordLoadState}
                        onRetry={() => void loadRecords(activeTab)}
                      />
                    ) : null}
                    {activeTab.isLoading ? (
                      <div className="text-center py-8">
                        {t("Loading...", "Loading...")}
                      </div>
                    ) : activeTab.recordLoadState?.status ===
                      "error" ? null : filteredRecords.length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <div>
                          {activeTab.recordLoadState?.status === "stale"
                            ? t(
                                "No cached or previously loaded DNS records are available.",
                                "No cached or previously loaded DNS records are available.",
                              )
                            : activeTab.records.length === 0
                              ? t(
                                  "This zone has no DNS records.",
                                  "This zone has no DNS records.",
                                )
                              : t(
                                  "No DNS records match the current filters.",
                                  "No DNS records match the current filters.",
                                )}
                        </div>
                        {activeTab.recordLoadState?.status !== "stale" &&
                        activeTab.records.length > 0 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-3"
                            onClick={() =>
                              updateTab(activeTab.id, (prev) => ({
                                ...prev,
                                searchTerm: "",
                                typeFilter: "",
                                page: 1,
                              }))
                            }
                          >
                            {t("Clear filters", "Clear filters")}
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {(activeTab.recordsLimited ||
                          filteredRecords.length > visibleRecords.length) && (
                          <div
                            role="status"
                            aria-live="polite"
                            data-testid="dns-record-limit-notice"
                            className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
                          >
                            {activeTab.recordsLimited
                              ? t(
                                  "This zone has at least {{source}} source records. The UI retains the first {{retained}} records and renders {{rendered}} matching rows at once. Refine the filters to narrow the view. Exports refetch the complete authoritative zone and never use this bounded UI subset.",
                                  {
                                    source: Math.max(
                                      activeTab.sourceRecordCount,
                                      activeTab.records.length,
                                    ),
                                    retained: activeTab.records.length,
                                    rendered: visibleRecords.length,
                                    defaultValue: `This zone has at least ${Math.max(activeTab.sourceRecordCount, activeTab.records.length)} source records. The UI retains the first ${activeTab.records.length} records and renders ${visibleRecords.length} matching rows at once. Refine the filters to narrow the view. Exports refetch the complete authoritative zone and never use this bounded UI subset.`,
                                  },
                                )
                              : t(
                                  "The UI retained {{retained}} source records for this page and is rendering the first {{shown}} of {{total}} matching rows. Refine the filters to narrow the view.",
                                  {
                                    retained: activeTab.records.length,
                                    shown: visibleRecords.length,
                                    total: filteredRecords.length,
                                    defaultValue: `The UI retained ${activeTab.records.length} source records for this page and is rendering the first ${visibleRecords.length} of ${filteredRecords.length} matching rows. Refine the filters to narrow the view.`,
                                  },
                                )}
                          </div>
                        )}
                        <div
                          data-testid="dns-records-table"
                          className="glass-surface glass-sheen ui-table rounded-xl"
                        >
                          <div
                            className="ui-table-head"
                            style={{
                              gridTemplateColumns: dnsRecordGridTemplate,
                            }}
                          >
                            {dnsRecordColumns.map((column) => {
                              switch (column) {
                                case "select":
                                  return <span key={column} />;
                                case "type":
                                case "name":
                                case "content":
                                case "ttl":
                                case "proxied": {
                                  const labels = {
                                    type: t("Type", "Type"),
                                    name: t("Name", "Name"),
                                    content: t("Content", "Content"),
                                    ttl: t("TTL", "TTL"),
                                    proxied: t("Proxy", "Proxy"),
                                  } as const;
                                  return (
                                    <button
                                      key={column}
                                      type="button"
                                      className="text-left hover:text-foreground"
                                      onClick={() => toggleSort(column)}
                                    >
                                      {labels[column]}{" "}
                                      <span className="opacity-70">
                                        {sortIndicator(column)}
                                      </span>
                                    </button>
                                  );
                                }
                                case "comment":
                                  return (
                                    <span key={column}>
                                      {t("Comment", "Comment")}
                                    </span>
                                  );
                                case "tags":
                                  return (
                                    <span key={column}>
                                      {t("Tags", "Tags")}
                                    </span>
                                  );
                                case "actions":
                                  return (
                                    <span key={column} className="text-right">
                                      {t("Actions", "Actions")}
                                    </span>
                                  );
                                default:
                                  return null;
                              }
                            })}
                          </div>
                          {visibleRecords.map((record) => {
                            const isSelected = selectedRecordIds.has(record.id);
                            return (
                              <RecordRow
                                key={record.id}
                                zoneId={activeTab.zoneId}
                                zoneName={activeTab.zoneName}
                                record={record}
                                columns={dnsRecordColumns}
                                gridTemplateColumns={dnsRecordGridTemplate}
                                isEditing={
                                  activeTab.editingRecord === record.id
                                }
                                isSelected={isSelected}
                                isRevealed={revealedRecordId === record.id}
                                simulateSPF={simulateSPF}
                                getSPFGraph={getSPFGraph}
                                onSelectChange={(checked) =>
                                  updateTab(activeTab.id, (prev) => ({
                                    ...prev,
                                    selectedIds: checked
                                      ? [...prev.selectedIds, record.id]
                                      : prev.selectedIds.filter(
                                          (id) => id !== record.id,
                                        ),
                                  }))
                                }
                                onEdit={() =>
                                  updateTab(activeTab.id, (prev) => ({
                                    ...prev,
                                    editingRecord: record.id,
                                  }))
                                }
                                onSave={(updatedRecord: DNSRecord) =>
                                  handleUpdateRecord(updatedRecord)
                                }
                                onCancel={() =>
                                  updateTab(activeTab.id, (prev) => ({
                                    ...prev,
                                    editingRecord: null,
                                  }))
                                }
                                onDelete={() => handleDeleteRecord(record.id)}
                                onToggleProxy={(next) =>
                                  handleToggleProxy(record, next)
                                }
                                onCopy={() => handleCopySingle(record)}
                                onClone={async () => {
                                  try {
                                    const cloned = await createDNSRecord(
                                      activeTab.zoneId,
                                      {
                                        ...record,
                                        name: `${record.name}-copy`,
                                      },
                                    );
                                    updateTab(activeTab.id, (prev) => ({
                                      ...prev,
                                      records: [cloned, ...prev.records],
                                    }));
                                    pushUndo({
                                      description: `Clone ${record.type} ${record.name}`,
                                      forward: {
                                        kind: "create",
                                        zoneId: activeTab.zoneId,
                                        record: cloned,
                                      },
                                      reverse: {
                                        kind: "delete",
                                        zoneId: activeTab.zoneId,
                                        recordId: cloned.id,
                                        record: cloned,
                                      },
                                    });
                                    toast({
                                      title: t("Cloned", "Cloned"),
                                      description: `${cloned.type} ${cloned.name}`,
                                    });
                                  } catch (err) {
                                    toast({
                                      title: t("Error", "Error"),
                                      description:
                                        err instanceof Error
                                          ? err.message
                                          : "Clone failed",
                                      variant: "destructive",
                                    });
                                  }
                                }}
                              />
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                  <BulkEditBar
                    selectedCount={activeTab.selectedIds.length}
                    onBulkDelete={handleBulkDelete}
                    onDeselectAll={() =>
                      updateTab(activeTab.id, (prev) => ({
                        ...prev,
                        selectedIds: [],
                      }))
                    }
                    onBulkSetTTL={(ttl: number) =>
                      handleBulkFieldChange(
                        { ttl },
                        (count) =>
                          t("TTL set on {{count}} records", {
                            count,
                            defaultValue: `TTL set on ${count} records`,
                          }),
                        "Set TTL",
                      )
                    }
                    onBulkSetProxy={(proxied: boolean) =>
                      handleBulkFieldChange(
                        { proxied },
                        (count) =>
                          t("Proxy set on {{count}} records", {
                            count,
                            defaultValue: `Proxy set on ${count} records`,
                          }),
                        "Set proxy",
                      )
                    }
                    onBulkExport={() => handleExport("json")}
                  />
                </>
              )}
              {activeTab.kind === "zone" && actionTab === "import" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <Card className="border-border/60 bg-card/70">
                    <CardHeader>
                      <CardTitle className="text-lg">
                        {t("Import Records", "Import Records")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t(
                          "Bring in records from CSV, JSON, or BIND zone files.",
                          "Bring in records from CSV, JSON, or BIND zone files.",
                        )}
                      </p>
                      <ImportExportDialog
                        open={activeTab.showImport}
                        onOpenChange={(open) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            showImport: open,
                          }))
                        }
                        importData={activeTab.importData}
                        importFormat={activeTab.importFormat}
                        onImportDataChange={(value) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            importData: value,
                          }))
                        }
                        onImportFormatChange={(value) =>
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            importFormat: value,
                          }))
                        }
                        onImport={(items, dryRun) =>
                          handleImport(activeTab, items, dryRun)
                        }
                        serverExport={handleExport}
                        onExport={handleExport}
                      />
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-card/70">
                    <CardHeader>
                      <CardTitle className="text-lg">
                        {t("Export Records", "Export Records")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        {t(
                          "Download zone data locally or run server-side exports.",
                          "Download zone data locally or run server-side exports.",
                        )}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => handleExport("json")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          {t("Export JSON", "Export JSON")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleExport("csv")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          {t("Export CSV", "Export CSV")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => handleExport("bind")}
                        >
                          <FileDown className="h-4 w-4 mr-2" />
                          {t("Export BIND", "Export BIND")}
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setActionTab("records")}
                        >
                          <FileUp className="h-4 w-4 mr-2" />
                          {t("Back to records", "Back to records")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
              {activeTab.kind === "zone" && actionTab === "zone-settings" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Zone settings", "Zone settings")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Per-page override", "Per-page override")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          value={
                            zonePerPage[activeTab.zoneId] === undefined
                              ? "inherit"
                              : String(zonePerPage[activeTab.zoneId])
                          }
                          onValueChange={(v) => {
                            if (v === "inherit") {
                              setZonePerPage((prev) => {
                                const next = { ...prev };
                                delete next[activeTab.zoneId];
                                return next;
                              });
                              updateTab(activeTab.id, (prev) => ({
                                ...prev,
                                perPage: globalPerPage,
                                page: 1,
                              }));
                              notifySaved(
                                t("Zone per-page set to inherit ({{count}}).", {
                                  count: globalPerPage,
                                  defaultValue: `Zone per-page set to inherit (${globalPerPage}).`,
                                }),
                              );
                              return;
                            }
                            const value = clampDnsPageSize(v);
                            setZonePerPage((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: value,
                            }));
                            updateTab(activeTab.id, (prev) => ({
                              ...prev,
                              perPage: value,
                              page: 1,
                            }));
                            notifySaved(
                              t("Zone per-page set to {{count}}.", {
                                count: value,
                                defaultValue: `Zone per-page set to ${value}.`,
                              }),
                            );
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue
                              placeholder={t("Per page", "Per page")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              {t("Inherit", "Inherit")} ({globalPerPage})
                            </SelectItem>
                            <SelectItem value="25">25</SelectItem>
                            <SelectItem value="50">50</SelectItem>
                            <SelectItem value="100">100</SelectItem>
                            <SelectItem value="200">200</SelectItem>
                            <SelectItem value="500">500</SelectItem>
                            <SelectItem value="0">{t("All", "All")}</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Overrides the global default for this zone only.",
                            "Overrides the global default for this zone only.",
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t(
                          "Unsupported record types",
                          "Unsupported record types",
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          value={
                            Object.prototype.hasOwnProperty.call(
                              zoneShowUnsupportedRecordTypes,
                              activeTab.zoneId,
                            )
                              ? zoneShowUnsupportedRecordTypes[activeTab.zoneId]
                                ? "show"
                                : "hide"
                              : "inherit"
                          }
                          onValueChange={(v) => {
                            if (v === "inherit") {
                              setZoneShowUnsupportedRecordTypes((prev) => {
                                const next = { ...prev };
                                delete next[activeTab.zoneId];
                                return next;
                              });
                              notifySaved(
                                t(
                                  "Zone unsupported record types set to inherit ({{state}}).",
                                  {
                                    state: showUnsupportedRecordTypes
                                      ? t("Show", "Show").toLowerCase()
                                      : t("Hide", "Hide").toLowerCase(),
                                    defaultValue: `Zone unsupported record types set to inherit (${
                                      showUnsupportedRecordTypes
                                        ? "show"
                                        : "hide"
                                    }).`,
                                  },
                                ),
                              );
                              return;
                            }
                            const enabled = v === "show";
                            setZoneShowUnsupportedRecordTypes((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: enabled,
                            }));
                            notifySaved(
                              enabled
                                ? t(
                                    "Zone will show unsupported record types in Add Record.",
                                    "Zone will show unsupported record types in Add Record.",
                                  )
                                : t(
                                    "Zone will hide unsupported record types in Add Record.",
                                    "Zone will hide unsupported record types in Add Record.",
                                  ),
                            );
                          }}
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue
                              placeholder={t("Inherit", "Inherit")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">
                              {t("Inherit", "Inherit")} (
                              {showUnsupportedRecordTypes
                                ? t("Show", "Show")
                                : t("Hide", "Hide")}
                              )
                            </SelectItem>
                            <SelectItem value="hide">
                              {t("Hide", "Hide")}
                            </SelectItem>
                            <SelectItem value="show">
                              {t("Show", "Show")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls whether non-Cloudflare record types appear in the Type dropdown for this zone.",
                            "Controls whether non-Cloudflare record types appear in the Type dropdown for this zone.",
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Reopen on launch", "Reopen on launch")}
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={reopenZoneTabs[activeTab.zoneId] !== false}
                          onCheckedChange={(checked: boolean) => {
                            setReopenZoneTabs((prev) => ({
                              ...prev,
                              [activeTab.zoneId]: checked,
                            }));
                            notifySaved(
                              checked
                                ? t(
                                    "Zone will reopen on launch.",
                                    "Zone will reopen on launch.",
                                  )
                                : t(
                                    "Zone will not reopen on launch.",
                                    "Zone will not reopen on launch.",
                                  ),
                            );
                          }}
                        />
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls whether this zone restores when tabs reopen.",
                            "Controls whether this zone restores when tabs reopen.",
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "cache" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Cache", "Cache")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        {t("Cloudflare cache controls for {{zone}}.", {
                          zone: activeTab.zoneName,
                          defaultValue: `Cloudflare cache controls for ${activeTab.zoneName}.`,
                        })}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() =>
                            void refreshCacheSettings(activeTab.zoneId)
                          }
                          disabled={cacheSettingsLoading}
                          title={t(
                            "Force refresh from Cloudflare",
                            "Force refresh from Cloudflare",
                          )}
                          aria-label={t(
                            "Refresh cache settings from Cloudflare",
                            "Refresh cache settings from Cloudflare",
                          )}
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              cacheSettingsLoading && "animate-spin",
                            )}
                          />
                        </Button>
                        {cacheSettingsLoading && (
                          <div className="text-xs text-muted-foreground">
                            {t("Loading…", "Loading…")}
                          </div>
                        )}
                      </div>
                    </div>
                    {cacheSettingsError && (
                      <div className="text-xs text-destructive">
                        {cacheSettingsError}
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Development mode", "Development mode")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneDevMode ? (
                          <Switch
                            checked={zoneDevMode.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetDevelopmentMode(checked)
                            }
                            disabled={!apiKey || cacheSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Temporarily bypasses cache (Cloudflare may auto-disable after a few hours).",
                            "Temporarily bypasses cache (Cloudflare may auto-disable after a few hours).",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Cache level", "Cache level")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneCacheLevel ? (
                          <Select
                            value={zoneCacheLevel.value ?? "basic"}
                            onValueChange={(v) => handleSetCacheLevel(v)}
                            disabled={!apiKey || cacheSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue
                                placeholder={t("Cache level", "Cache level")}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              {zoneCacheLevel.value &&
                              !["basic", "aggressive", "simplified"].includes(
                                zoneCacheLevel.value,
                              ) ? (
                                <SelectItem value={zoneCacheLevel.value}>
                                  {t("{{value}} (current)", {
                                    value: zoneCacheLevel.value,
                                    defaultValue: `${zoneCacheLevel.value} (current)`,
                                  })}
                                </SelectItem>
                              ) : null}
                              <SelectItem value="basic">
                                {t("Basic", "Basic")}
                              </SelectItem>
                              <SelectItem value="aggressive">
                                {t("Aggressive", "Aggressive")}
                              </SelectItem>
                              <SelectItem value="simplified">
                                {t("Simplified", "Simplified")}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls how aggressively Cloudflare caches your content.",
                            "Controls how aggressively Cloudflare caches your content.",
                          )}
                        </div>
                        <div className="w-full space-y-1 rounded-lg border border-border/60 bg-card/55 p-2 text-[11px] text-muted-foreground">
                          {(["basic", "aggressive", "simplified"] as const).map(
                            (level) => (
                              <div
                                key={level}
                                className={cn(
                                  "rounded-md px-2 py-1",
                                  zoneCacheLevel?.value === level
                                    ? "bg-primary/10 text-foreground"
                                    : "bg-transparent",
                                )}
                              >
                                <span className="font-medium capitalize">
                                  {level}
                                </span>
                                :{" "}
                                {t(
                                  CACHE_LEVEL_DETAILS[level],
                                  CACHE_LEVEL_DETAILS[level],
                                )}
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-start">
                      <div className="font-medium text-sm">
                        {t("Purge cache", "Purge cache")}
                      </div>
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setShowPurgeEverythingConfirm(true)}
                            disabled={!apiKey}
                          >
                            {t("Purge everything", "Purge everything")}
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
                            {t(
                              "Purge URLs (one per line)",
                              "Purge URLs (one per line)",
                            )}
                          </Label>
                          <Textarea
                            value={purgeUrlsInput}
                            onChange={(e) => setPurgeUrlsInput(e.target.value)}
                            placeholder={`https://${activeTab.zoneName}/path\nhttps://${activeTab.zoneName}/asset.js`}
                            className="min-h-24 resize-y"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => preparePurgeUrls()}
                              disabled={!apiKey || !purgeUrlsInput.trim()}
                            >
                              {t("Purge URLs…", "Purge URLs…")}
                            </Button>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Validations warn, but you can still force purge.",
                                "Validations warn, but you can still force purge.",
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    {cacheOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t(
                          "Loading cache settings...",
                          "Loading cache settings...",
                        )}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "ssl-tls" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("SSL/TLS", "SSL/TLS")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-muted-foreground">
                        {t("SSL/TLS controls for {{zone}}.", {
                          zone: activeTab.zoneName,
                          defaultValue: `SSL/TLS controls for ${activeTab.zoneName}.`,
                        })}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 text-xs"
                          onClick={() =>
                            void refreshSslSettings(activeTab.zoneId)
                          }
                          disabled={sslSettingsLoading}
                          title={t(
                            "Force refresh from Cloudflare",
                            "Force refresh from Cloudflare",
                          )}
                          aria-label={t(
                            "Refresh SSL settings from Cloudflare",
                            "Refresh SSL settings from Cloudflare",
                          )}
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              sslSettingsLoading && "animate-spin",
                            )}
                          />
                        </Button>
                        {sslSettingsLoading && (
                          <div className="text-xs text-muted-foreground">
                            {t("Loading…", "Loading…")}
                          </div>
                        )}
                      </div>
                    </div>
                    {sslSettingsError && (
                      <div className="text-xs text-destructive">
                        {sslSettingsError}
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Encryption mode", "Encryption mode")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneSslMode ? (
                          <Select
                            value={zoneSslMode.value ?? "off"}
                            onValueChange={(v) =>
                              handleSetSslTlsSetting("ssl", v)
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue
                                placeholder={t("SSL mode", "SSL mode")}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="off">
                                {t("Off", "Off")}
                              </SelectItem>
                              <SelectItem value="flexible">
                                {t("Flexible", "Flexible")}
                              </SelectItem>
                              <SelectItem value="full">
                                {t("Full", "Full")}
                              </SelectItem>
                              <SelectItem value="strict">
                                {t("Full (strict)", "Full (strict)")}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Controls how Cloudflare connects to your origin.",
                            "Controls how Cloudflare connects to your origin.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Minimum TLS version", "Minimum TLS version")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneMinTlsVersion ? (
                          <Select
                            value={zoneMinTlsVersion.value ?? "1.2"}
                            onValueChange={(v) =>
                              handleSetSslTlsSetting("min_tls_version", v)
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue
                                placeholder={t("Min TLS", "Min TLS")}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1.0">1.0</SelectItem>
                              <SelectItem value="1.1">1.1</SelectItem>
                              <SelectItem value="1.2">1.2</SelectItem>
                              <SelectItem value="1.3">1.3</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Affects client connections to Cloudflare edge.",
                            "Affects client connections to Cloudflare edge.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("TLS 1.3", "TLS 1.3")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneTls13 ? (
                          <Switch
                            checked={zoneTls13.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "tls_1_3",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Enables TLS 1.3 for client connections.",
                            "Enables TLS 1.3 for client connections.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t("Always Use HTTPS", "Always Use HTTPS")}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneAlwaysUseHttps ? (
                          <Switch
                            checked={zoneAlwaysUseHttps.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "always_use_https",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Redirect HTTP to HTTPS at the edge.",
                            "Redirect HTTP to HTTPS at the edge.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t(
                          "Automatic HTTPS Rewrites",
                          "Automatic HTTPS Rewrites",
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneAutoHttpsRewrites ? (
                          <Switch
                            checked={zoneAutoHttpsRewrites.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "automatic_https_rewrites",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Rewrites mixed content links to HTTPS when possible.",
                            "Rewrites mixed content links to HTTPS when possible.",
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-[200px_1fr] md:items-center">
                      <div className="font-medium text-sm">
                        {t(
                          "Opportunistic encryption",
                          "Opportunistic encryption",
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        {zoneOpportunisticEncryption ? (
                          <Switch
                            checked={zoneOpportunisticEncryption.value === "on"}
                            onCheckedChange={(checked: boolean) =>
                              handleSetSslTlsSetting(
                                "opportunistic_encryption",
                                checked ? "on" : "off",
                              )
                            }
                            disabled={!apiKey || sslSettingsLoading}
                          />
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t("Unavailable.", "Unavailable.")}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Enables opportunistic encryption to the edge when supported.",
                            "Enables opportunistic encryption to the edge when supported.",
                          )}
                        </div>
                      </div>
                    </div>
                    {sslOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t(
                          "Loading SSL/TLS settings...",
                          "Loading SSL/TLS settings...",
                        )}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "domain-audit" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Domain audits", "Domain audits")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm text-muted-foreground">
                        {t(
                          "Audits run against the records currently loaded for",
                          "Audits run against the records currently loaded for",
                        )}{" "}
                        <span className="font-medium text-foreground/90">
                          {activeTab.zoneName}
                        </span>
                        .
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const controller = new AbortController();
                            void loadRecords(activeTab, controller.signal);
                          }}
                        >
                          {t("Refresh records", "Refresh records")}
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-3 text-sm">
                      <div className="font-medium">{t("Checks", "Checks")}</div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={domainAuditCategories.email}
                          onChange={(e) =>
                            setDomainAuditCategories((prev) => ({
                              ...prev,
                              email: e.target.checked,
                            }))
                          }
                        />
                        {t("Email (SPF/DKIM/DMARC)", "Email (SPF/DKIM/DMARC)")}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={domainAuditCategories.security}
                          onChange={(e) =>
                            setDomainAuditCategories((prev) => ({
                              ...prev,
                              security: e.target.checked,
                            }))
                          }
                        />
                        {t("Security (CAA)", "Security (CAA)")}
                      </label>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          className="checkbox-themed"
                          checked={domainAuditCategories.hygiene}
                          onChange={(e) =>
                            setDomainAuditCategories((prev) => ({
                              ...prev,
                              hygiene: e.target.checked,
                            }))
                          }
                        />
                        {t(
                          "Hygiene (private IPs, deprecated)",
                          "Hygiene (private IPs, deprecated)",
                        )}
                      </label>
                      <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                          checked={domainAuditShowPassed}
                          onCheckedChange={(checked: boolean) =>
                            setDomainAuditShowPassed(checked)
                          }
                        />
                        {t("Show passed", "Show passed")}
                      </div>
                      {auditOverridesByZone[activeTab.zoneId]?.size > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs"
                          onClick={handleClearAllAuditOverrides}
                        >
                          {t("Clear {{count}} override", {
                            count: auditOverridesByZone[activeTab.zoneId].size,
                            defaultValue: `Clear ${auditOverridesByZone[activeTab.zoneId].size} override`,
                          })}
                          {auditOverridesByZone[activeTab.zoneId].size !== 1
                            ? "s"
                            : ""}
                        </Button>
                      )}
                    </div>

                    <div className="rounded-xl border border-border/60 bg-card/60 p-2">
                      {domainAuditVisibleItems.length === 0 ? (
                        <div className="px-3 py-6 text-sm text-muted-foreground">
                          {t(
                            "No issues detected (with current filters).",
                            "No issues detected (with current filters).",
                          )}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {domainAuditVisibleItems.map((item) => {
                            const isOverridden = auditOverridesByZone[
                              activeTab.zoneId
                            ]?.has(item.id);
                            const originalSeverity =
                              isOverridden &&
                              item.title.includes("(overridden)")
                                ? (item.details.match(
                                    /Original severity: (\w+)/,
                                  )?.[1] as
                                    "fail" | "warn" | "info" | undefined)
                                : undefined;
                            const displaySeverity =
                              originalSeverity ?? item.severity;
                            // The bogon/private-IP checks list records, so
                            // give each one a control that jumps to its row
                            // instead of the audit's plain-text summary.
                            const specialIpFindings =
                              item.id === "special-a"
                                ? findSpecialIpRecords(activeTab.records, "A")
                                : item.id === "special-aaaa"
                                  ? findSpecialIpRecords(
                                      activeTab.records,
                                      "AAAA",
                                    )
                                  : [];

                            const badge =
                              displaySeverity === "fail"
                                ? "bg-destructive/20 text-destructive border-destructive/30"
                                : displaySeverity === "warn"
                                  ? "bg-amber-500/15 text-amber-200 border-amber-500/30"
                                  : displaySeverity === "info"
                                    ? "bg-sky-500/15 text-sky-200 border-sky-500/30"
                                    : "bg-emerald-500/15 text-emerald-200 border-emerald-500/30";

                            return (
                              <div
                                key={item.id}
                                className="rounded-xl border border-border/60 bg-muted/10 p-3"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span
                                        className={cn(
                                          "rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-widest",
                                          badge,
                                          isOverridden && "opacity-60",
                                        )}
                                      >
                                        {displaySeverity}
                                      </span>
                                      {isOverridden && (
                                        <span className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] uppercase tracking-widest text-emerald-200">
                                          {t("overridden", "overridden")}
                                        </span>
                                      )}
                                      <div
                                        className={cn(
                                          "font-medium text-sm",
                                          isOverridden &&
                                            "line-through opacity-60",
                                        )}
                                      >
                                        {item.title.replace(
                                          " (overridden)",
                                          "",
                                        )}
                                      </div>
                                    </div>
                                    {specialIpFindings.length > 0 ? (
                                      <SpecialIpAuditFindings
                                        findings={specialIpFindings}
                                        onGoToRecord={revealRecord}
                                      />
                                    ) : (
                                      <div className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                                        {item.details}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    {item.severity !== "pass" &&
                                      !isOverridden && (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="text-xs"
                                          onClick={() =>
                                            handleOverrideAuditItem(item.id)
                                          }
                                          title={t(
                                            "Mark as acknowledged/passing",
                                            "Mark as acknowledged/passing",
                                          )}
                                        >
                                          {t("Override", "Override")}
                                        </Button>
                                      )}
                                    {isOverridden && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-xs"
                                        onClick={() =>
                                          handleClearAuditOverride(item.id)
                                        }
                                        title={t(
                                          "Remove override",
                                          "Remove override",
                                        )}
                                      >
                                        {t("Restore", "Restore")}
                                      </Button>
                                    )}
                                    {item.suggestion && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                          handleAddSuggestedRecord(
                                            item.suggestion!,
                                          )
                                        }
                                      >
                                        {t(
                                          "Add suggested record…",
                                          "Add suggested record…",
                                        )}
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground">
                      {t(
                        "These checks are best-practice heuristics based only on records currently present in this zone.",
                        "These checks are best-practice heuristics based only on records currently present in this zone.",
                      )}
                    </div>
                    {auditOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t(
                          "Loading audit data...",
                          "Loading audit data...",
                        )}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "domain-registry" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Domain Registry Tools", "Domain Registry Tools")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="relative space-y-4">
                    <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
                      <Input
                        value={registryLookupDomain}
                        onChange={(e) =>
                          setRegistryLookupDomain(e.target.value)
                        }
                        placeholder={t("example.com", "example.com")}
                      />
                      <Button
                        onClick={() => void runDomainRegistryChecks()}
                        disabled={
                          !registryLookupDomain.trim() || registryChecksLoading
                        }
                      >
                        {registryChecksLoading
                          ? t("Checking...", "Checking...")
                          : t("Check Everything", "Check Everything")}
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(
                            `https://rdap.org/domain/${encodeURIComponent(
                              registryLookupDomain.trim(),
                            )}`,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                        disabled={!registryLookupDomain.trim()}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        {t("RDAP Tool", "RDAP Tool")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.open(
                            `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(
                              registryLookupDomain.trim(),
                            )}`,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        }
                        disabled={!registryLookupDomain.trim()}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        {t("WHOIS Tool", "WHOIS Tool")}
                      </Button>
                    </div>

                    {registryChecksError && (
                      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive-foreground">
                        {registryChecksError}
                      </div>
                    )}
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="rounded-xl border border-border/60 bg-card/60 p-3 space-y-2">
                        <div className="text-sm font-medium">
                          {t("Registrar API Match", "Registrar API Match")}
                        </div>
                        {registrarDomainResult ? (
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div>
                              {t("Domain:", "Domain:")}{" "}
                              <span className="text-foreground">
                                {registrarDomainResult.domain}
                              </span>
                            </div>
                            <div>
                              {t("Registrar:", "Registrar:")}{" "}
                              <span className="text-foreground">
                                {registrarDomainResult.registrar}
                              </span>
                            </div>
                            <div>
                              {t("Status:", "Status:")}{" "}
                              <span className="text-foreground">
                                {registrarDomainResult.status}
                              </span>
                            </div>
                            <div>
                              {t("Expires:", "Expires:")}{" "}
                              <span
                                className="text-foreground"
                                title={
                                  formatHumanizedDateTime(
                                    registrarDomainResult.expires_at,
                                  ).full
                                }
                              >
                                {
                                  formatHumanizedDateTime(
                                    registrarDomainResult.expires_at,
                                  ).short
                                }
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "No registrar-api match found for this domain.",
                              "No registrar-api match found for this domain.",
                            )}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-border/60 bg-card/60 p-3 space-y-2">
                        <div className="text-sm font-medium">
                          {t("Health Checks", "Health Checks")}
                        </div>
                        {registrarHealthResult ? (
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div>
                              {t("Overall:", "Overall:")}{" "}
                              <span className="text-foreground">
                                {registrarHealthResult.status}
                              </span>
                            </div>
                            {registrarHealthResult.checks.map((check) => (
                              <div key={check.name}>
                                {check.name}:{" "}
                                <span className="text-foreground">
                                  {check.message}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "No health check data for this domain yet.",
                              "No health check data for this domain yet.",
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-card/60 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium">
                          {t("RDAP Response", "RDAP Response")}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              if (!rdapResult) return;
                              const summary = [
                                `Domain: ${String(rdapObject.ldhName ?? rdapObject.unicodeName ?? "—")}`,
                                `Handle: ${String(rdapObject.handle ?? "—")}`,
                                `Registrar API: ${registrarDomainResult?.registrar ?? "—"}`,
                                `Registrar Entity: ${String(rdapRegistrarEntity?.handle ?? "—")}`,
                                `Status: ${rdapStatuses.length ? rdapStatuses.join(", ") : "—"}`,
                                `Nameservers: ${rdapNameservers.length ? rdapNameservers.join(", ") : "—"}`,
                              ].join("\n");
                              const payload = showRawRdap
                                ? JSON.stringify(rdapResult, null, 2)
                                : summary;
                              void navigator.clipboard
                                .writeText(payload)
                                .then(() =>
                                  toast({
                                    title: t("Copied", "Copied"),
                                    description: t(
                                      "Registry data copied to clipboard.",
                                      "Registry data copied to clipboard.",
                                    ),
                                  }),
                                )
                                .catch((error) =>
                                  toast({
                                    title: t("Copy failed", "Copy failed"),
                                    description:
                                      error instanceof Error
                                        ? error.message
                                        : String(error),
                                    variant: "destructive",
                                  }),
                                );
                            }}
                            disabled={!rdapResult}
                          >
                            <Copy className="h-3.5 w-3.5 mr-1" />
                            {t("Copy", "Copy")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShowRawRdap((prev) => !prev)}
                            disabled={!rdapResult}
                          >
                            {showRawRdap
                              ? t("Show Table", "Show Table")
                              : t("Show Raw JSON", "Show Raw JSON")}
                          </Button>
                        </div>
                      </div>
                      {rdapResult ? (
                        showRawRdap ? (
                          <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-3 text-[11px]">
                            {JSON.stringify(rdapResult, null, 2)}
                          </pre>
                        ) : (
                          <div className="space-y-3">
                            <div className="overflow-auto rounded-lg border border-border/60 bg-muted/10">
                              <table className="w-full text-xs">
                                <tbody>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Domain", "Domain")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {String(
                                        rdapObject.ldhName ??
                                          rdapObject.unicodeName ??
                                          "—",
                                      )}
                                    </td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Handle", "Handle")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {String(rdapObject.handle ?? "—")}
                                    </td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Object Class", "Object Class")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {String(
                                        rdapObject.objectClassName ?? "—",
                                      )}
                                    </td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Port 43", "Port 43")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {String(rdapObject.port43 ?? "—")}
                                    </td>
                                  </tr>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Registrar (API)", "Registrar (API)")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {registrarDomainResult?.registrar ?? "—"}
                                    </td>
                                  </tr>
                                  <tr>
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Status", "Status")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {rdapStatuses.length
                                        ? rdapStatuses.join(", ")
                                        : "—"}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>

                            <div className="overflow-auto rounded-lg border border-border/60 bg-muted/10">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-border/40 text-muted-foreground">
                                    <th className="px-3 py-2 text-left font-medium">
                                      {t("Event", "Event")}
                                    </th>
                                    <th className="px-3 py-2 text-left font-medium">
                                      {t("Date", "Date")}
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rdapEvents.length ? (
                                    rdapEvents.map((event, idx) => (
                                      <tr
                                        key={`${event.action}-${idx}`}
                                        className="border-b border-border/30 last:border-b-0"
                                      >
                                        <td className="px-3 py-2">
                                          {event.action}
                                        </td>
                                        <td
                                          className="px-3 py-2"
                                          title={
                                            formatHumanizedDateTime(event.date)
                                              .full
                                          }
                                        >
                                          {
                                            formatHumanizedDateTime(event.date)
                                              .short
                                          }
                                        </td>
                                      </tr>
                                    ))
                                  ) : (
                                    <tr>
                                      <td
                                        className="px-3 py-2 text-muted-foreground"
                                        colSpan={2}
                                      >
                                        {t(
                                          "No events returned.",
                                          "No events returned.",
                                        )}
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>

                            <div className="overflow-auto rounded-lg border border-border/60 bg-muted/10">
                              <table className="w-full text-xs">
                                <tbody>
                                  <tr className="border-b border-border/40">
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t(
                                        "Registrar Entity",
                                        "Registrar Entity",
                                      )}
                                    </td>
                                    <td className="px-3 py-2">
                                      {String(
                                        rdapRegistrarEntity?.handle ?? "—",
                                      )}
                                    </td>
                                  </tr>
                                  <tr>
                                    <td className="px-3 py-2 font-medium text-muted-foreground">
                                      {t("Nameservers", "Nameservers")}
                                    </td>
                                    <td className="px-3 py-2">
                                      {rdapNameservers.length
                                        ? rdapNameservers.join(", ")
                                        : "—"}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          {t(
                            "Run checks to load RDAP response.",
                            "Run checks to load RDAP response.",
                          )}
                        </div>
                      )}
                    </div>
                    {registryOverlay.visible && (
                      <SectionLoadingOverlay
                        label={t(
                          "Loading registry data...",
                          "Loading registry data...",
                        )}
                      />
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "zone" && actionTab === "topology" && (
                <>
                  {currentTopologyRecordState.status === "ready" ? (
                    <div className="space-y-3">
                      {(topologySearchTerm.trim() || topologyTypeFilter) && (
                        <div
                          role="status"
                          data-testid="dns-topology-source-filter-notice"
                          className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
                        >
                          The authoritative topology source is narrowed by the
                          current Records search/type filters. All{" "}
                          {currentTopologyRecordState.records.length} matching
                          records were retained after scanning{" "}
                          {currentTopologyRecordState.scannedRecordCount} source
                          records.
                        </div>
                      )}
                      <ZoneTopologyTab
                        zoneName={activeTab.zoneName}
                        records={currentTopologyRecordState.records}
                        isLoading={false}
                        maxResolutionHops={topologyResolutionMaxHops}
                        resolverMode={topologyResolverMode}
                        dnsServer={topologyDnsServer}
                        customDnsServer={topologyCustomDnsServer}
                        dohProvider={topologyDohProvider}
                        dohCustomUrl={topologyDohCustomUrl}
                        exportConfirmPath={topologyExportConfirmPath}
                        exportFolderPreset={topologyExportFolderPreset}
                        exportCustomPath={topologyExportCustomPath}
                        copyActions={topologyCopyActions}
                        exportActions={topologyExportActions}
                        disableAnnotations={topologyDisableAnnotations}
                        disableFullWindow={topologyDisableFullWindow}
                        lookupTimeoutMs={topologyLookupTimeoutMs}
                        disablePtrLookups={topologyDisablePtrLookups}
                        disableGeoLookups={topologyDisableGeoLookups}
                        geoProvider={topologyGeoProvider}
                        scanResolutionChain={topologyScanResolutionChain}
                        disableServiceDiscovery={
                          topologyDisableServiceDiscovery
                        }
                        tcpServicePorts={topologyTcpServices
                          .map((v) => Number(v))
                          .filter((v) => Number.isFinite(v) && v > 0)}
                        emailRouting={
                          topologyIntegrations?.zoneId === activeTab.zoneId
                            ? topologyIntegrations.emailRouting
                            : undefined
                        }
                        workerRoutes={
                          topologyIntegrations?.zoneId === activeTab.zoneId
                            ? topologyIntegrations.workerRoutes
                            : undefined
                        }
                        emailRoutingUnavailable={
                          topologyIntegrations?.zoneId === activeTab.zoneId &&
                          topologyIntegrations.emailRoutingUnavailable
                        }
                        onRefresh={async () => {
                          await Promise.all([
                            loadRecords(activeTab),
                            loadTopologyRecords(
                              activeTab.zoneId,
                              topologyQueryKey,
                              topologySearchTerm,
                              topologyTypeFilter,
                            ),
                          ]);
                        }}
                        onEditRecord={(record) => {
                          setActionTab("records");
                          updateTab(activeTab.id, (prev) => ({
                            ...prev,
                            editingRecord: record.id,
                          }));
                        }}
                      />
                    </div>
                  ) : (
                    <Card className="border-border/60 bg-card/70">
                      <CardHeader>
                        <CardTitle className="text-lg">Topology</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {(currentTopologyRecordState.status === "idle" ||
                          currentTopologyRecordState.status === "loading") && (
                          <div
                            role="status"
                            data-testid="dns-topology-record-loading"
                            className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"
                          >
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            Loading the complete bounded topology record set…
                          </div>
                        )}
                        {currentTopologyRecordState.status === "too-large" && (
                          <div
                            role="alert"
                            data-testid="dns-topology-record-limit"
                            className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
                          >
                            More than{" "}
                            {DNS_TOPOLOGY_RECORD_LIMIT.toLocaleString()}{" "}
                            authoritative DNS records match the current Records
                            search/type filters. No graph was constructed or
                            silently truncated. Narrow the search or select a
                            record type in Records, then reopen Topology.
                          </div>
                        )}
                        {currentTopologyRecordState.status ===
                          "scan-limited" && (
                          <div
                            role="alert"
                            data-testid="dns-topology-scan-limit"
                            className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
                          >
                            The authoritative topology scan reached its{" "}
                            {(
                              DNS_TOPOLOGY_SCAN_PAGE_LIMIT *
                              DNS_API_PAGE_SIZE_LIMIT
                            ).toLocaleString()}
                            -record safety bound before completeness could be
                            proven. No graph was constructed. Narrow the current
                            Records search/type filters before trying again.
                          </div>
                        )}
                        {currentTopologyRecordState.status === "error" && (
                          <div
                            role="alert"
                            data-testid="dns-topology-record-error"
                            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                          >
                            Failed to load authoritative topology records:{" "}
                            {currentTopologyRecordState.error}
                          </div>
                        )}
                        {(currentTopologyRecordState.status === "too-large" ||
                          currentTopologyRecordState.status ===
                            "scan-limited") && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setActionTab("records")}
                          >
                            Narrow in Records
                          </Button>
                        )}
                        {currentTopologyRecordState.status === "error" && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              void loadTopologyRecords(
                                activeTab.zoneId,
                                topologyQueryKey,
                                topologySearchTerm,
                                topologyTypeFilter,
                              )
                            }
                          >
                            Retry topology load
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </>
              )}

              {/* ── New Panels ───────────────────────────────────── */}

              {activeTab.kind === "zone" && actionTab === "analytics" && (
                <AnalyticsPanel
                  zoneId={activeTab.zoneId}
                  getZoneAnalytics={getZoneAnalytics}
                />
              )}

              {activeTab.kind === "zone" && actionTab === "firewall" && (
                <FirewallPanel
                  zoneId={activeTab.zoneId}
                  getFirewallRules={getFirewallRules}
                  createFirewallRule={createFirewallRule}
                  updateFirewallRule={updateFirewallRule}
                  deleteFirewallRule={deleteFirewallRule}
                  getIpAccessRules={getIpAccessRules}
                  createIpAccessRule={createIpAccessRule}
                  deleteIpAccessRule={deleteIpAccessRule}
                  getWafRulesets={getWafRulesets}
                />
              )}

              {activeTab.kind === "zone" && actionTab === "workers" && (
                <WorkersPanel
                  zoneId={activeTab.zoneId}
                  getWorkerRoutes={getWorkerRoutes}
                  createWorkerRoute={createWorkerRoute}
                  deleteWorkerRoute={deleteWorkerRoute}
                />
              )}

              {activeTab.kind === "zone" && actionTab === "email-routing" && (
                <EmailRoutingPanel
                  zoneId={activeTab.zoneId}
                  getEmailRoutingSettings={getEmailRoutingSettings}
                  getEmailRoutingRules={getEmailRoutingRules}
                  createEmailRoutingRule={createEmailRoutingRule}
                  deleteEmailRoutingRule={deleteEmailRoutingRule}
                />
              )}

              {activeTab.kind === "zone" && actionTab === "propagation" && (
                <PropagationChecker
                  zoneName={activeTab.zoneName}
                  checkDnsPropagation={checkDnsPropagation}
                />
              )}

              {activeTab.kind === "zone" && actionTab === "zone-compare" && (
                <ZoneCompare
                  zones={zones}
                  currentZoneId={activeTab.zoneId}
                  getDNSRecords={getDNSRecords}
                  onCopyRecords={handleCopyComparedRecords}
                  columns={zoneCompareColumns}
                />
              )}

              {/* The reference opens at whichever type the record list is
                  filtered to, so "filter to CAA, then read about CAA" is one
                  click rather than a search. */}
              {activeTab.kind === "zone" && actionTab === "reference" && (
                <RecordTypeReference initialType={activeTab.typeFilter} />
              )}

              {activeTab.kind === "audit" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <CardTitle className="text-lg">
                        {t("Audit log", "Audit log")}
                      </CardTitle>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={() => loadAuditEntries()}
                          title={t("Refresh", "Refresh")}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          <span className="text-xs">
                            {t("Refresh", "Refresh")}
                          </span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={() => {
                            if (confirmClearAuditLogs) {
                              setShowClearAuditConfirm(true);
                              return;
                            }
                            void clearAuditEntriesNow();
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                          title={t("Clear logs", "Clear logs")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("Clear", "Clear")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={async () => {
                            if (!isDesktop()) return;
                            try {
                              const path = await TauriClient.saveAuditEntries(
                                "json",
                                auditExportFolderPreset,
                                auditExportCustomPath,
                                auditExportSkipDestinationConfirm,
                              );
                              toast({
                                title: t("Export complete", "Export complete"),
                                description: t("Saved to {{path}}", {
                                  path,
                                  defaultValue: `Saved to ${path}`,
                                }),
                                action: (
                                  <ToastAction
                                    altText={t(
                                      "Open export folder",
                                      "Open export folder",
                                    )}
                                    onClick={() => {
                                      void TauriClient.openPathInFileManager(
                                        path,
                                      ).catch((error) => {
                                        toast({
                                          title: t(
                                            "Open folder failed",
                                            "Open folder failed",
                                          ),
                                          description:
                                            error instanceof Error
                                              ? error.message
                                              : String(error),
                                          variant: "destructive",
                                        });
                                      });
                                    }}
                                  >
                                    {t("Open folder", "Open folder")}
                                  </ToastAction>
                                ),
                              });
                            } catch (error) {
                              const message =
                                error instanceof Error
                                  ? error.message
                                  : String(error);
                              if (message.toLowerCase().includes("cancel"))
                                return;
                              toast({
                                title: t("Export failed", "Export failed"),
                                description: message,
                                variant: "destructive",
                              });
                            }
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                          title={t("Export JSON", "Export JSON")}
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("JSON", "JSON")}</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 px-2"
                          onClick={async () => {
                            if (!isDesktop()) return;
                            try {
                              const path = await TauriClient.saveAuditEntries(
                                "csv",
                                auditExportFolderPreset,
                                auditExportCustomPath,
                                auditExportSkipDestinationConfirm,
                              );
                              toast({
                                title: t("Export complete", "Export complete"),
                                description: t("Saved to {{path}}", {
                                  path,
                                  defaultValue: `Saved to ${path}`,
                                }),
                                action: (
                                  <ToastAction
                                    altText={t(
                                      "Open export folder",
                                      "Open export folder",
                                    )}
                                    onClick={() => {
                                      void TauriClient.openPathInFileManager(
                                        path,
                                      ).catch((error) => {
                                        toast({
                                          title: t(
                                            "Open folder failed",
                                            "Open folder failed",
                                          ),
                                          description:
                                            error instanceof Error
                                              ? error.message
                                              : String(error),
                                          variant: "destructive",
                                        });
                                      });
                                    }}
                                  >
                                    {t("Open folder", "Open folder")}
                                  </ToastAction>
                                ),
                              });
                            } catch (error) {
                              const message =
                                error instanceof Error
                                  ? error.message
                                  : String(error);
                              if (message.toLowerCase().includes("cancel"))
                                return;
                              toast({
                                title: t("Export failed", "Export failed"),
                                description: message,
                                variant: "destructive",
                              });
                            }
                          }}
                          disabled={!isDesktop() || auditEntries.length === 0}
                          title={t("Export CSV", "Export CSV")}
                        >
                          <FileDown className="h-3.5 w-3.5" />
                          <span className="text-xs">{t("CSV", "CSV")}</span>
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-2 md:grid-cols-[1fr_120px_auto]">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder={t(
                            "Search audit entries",
                            "Search audit entries",
                          )}
                          value={auditSearch}
                          onChange={(e) => setAuditSearch(e.target.value)}
                          className="h-8 pl-9 text-xs"
                        />
                      </div>
                      <Select value={auditLimit} onValueChange={setAuditLimit}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder={t("Limit", "Limit")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                          <SelectItem value="250">250</SelectItem>
                          <SelectItem value="500">500</SelectItem>
                          <SelectItem value="1000">1000</SelectItem>
                          <SelectItem value="all">{t("All", "All")}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 px-2"
                        onClick={addAuditFilter}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span className="text-xs">
                          {t("Add filter", "Add filter")}
                        </span>
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("errors")}
                      >
                        {t("Errors", "Errors")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("auth")}
                      >
                        {t("Auth Ops", "Auth Ops")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("dns")}
                      >
                        {t("DNS Ops", "DNS Ops")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("api_keys")}
                      >
                        {t("API Keys", "API Keys")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("zone_settings")}
                      >
                        {t("Zone Settings", "Zone Settings")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("cache")}
                      >
                        {t("Cache Ops", "Cache Ops")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("last24h")}
                      >
                        {t("Last 24h", "Last 24h")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("last7d")}
                      >
                        {t("Last 7d", "Last 7d")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("today")}
                      >
                        {t("Today", "Today")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => applyAuditPreset("clear")}
                      >
                        {t("Clear Filters", "Clear Filters")}
                      </Button>
                    </div>
                    {auditFilters.length > 0 && (
                      <div className="space-y-2 rounded-lg border border-border/60 bg-card/50 p-2">
                        {auditFilters.map((rule) => (
                          <div
                            key={rule.id}
                            className="grid gap-2 md:grid-cols-[140px_130px_1fr_auto]"
                          >
                            <Select
                              value={rule.field}
                              onValueChange={(v) =>
                                updateAuditFilter(rule.id, {
                                  field: v as AuditFilterField,
                                })
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue
                                  placeholder={t("Field", "Field")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="operation">
                                  {t("Operation", "Operation")}
                                </SelectItem>
                                <SelectItem value="resource">
                                  {t("Resource", "Resource")}
                                </SelectItem>
                                <SelectItem value="timestamp">
                                  {t("Timestamp", "Timestamp")}
                                </SelectItem>
                                <SelectItem value="details">
                                  {t("Details", "Details")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <Select
                              value={rule.operator}
                              onValueChange={(v) =>
                                updateAuditFilter(rule.id, {
                                  operator: v as AuditFilterOperator,
                                })
                              }
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue
                                  placeholder={t("Operator", "Operator")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="equals">
                                  {t("equals", "equals")}
                                </SelectItem>
                                <SelectItem value="not_equals">
                                  {t("not equals", "not equals")}
                                </SelectItem>
                                <SelectItem value="contains">
                                  {t("contains", "contains")}
                                </SelectItem>
                                <SelectItem value="not_contains">
                                  {t("not contains", "not contains")}
                                </SelectItem>
                                <SelectItem value="starts_with">
                                  {t("starts with", "starts with")}
                                </SelectItem>
                                <SelectItem value="ends_with">
                                  {t("ends with", "ends with")}
                                </SelectItem>
                                <SelectItem value="matches">
                                  {t("matches (regex)", "matches (regex)")}
                                </SelectItem>
                                <SelectItem value="gt">
                                  {t(
                                    "greater than (&gt;)",
                                    "greater than (&gt;)",
                                  )}
                                </SelectItem>
                                <SelectItem value="gte">
                                  {t(
                                    "greater/equal (&gt;=)",
                                    "greater/equal (&gt;=)",
                                  )}
                                </SelectItem>
                                <SelectItem value="lt">
                                  {t("less than (&lt;)", "less than (&lt;)")}
                                </SelectItem>
                                <SelectItem value="lte">
                                  {t(
                                    "less/equal (&lt;=)",
                                    "less/equal (&lt;=)",
                                  )}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              value={rule.value}
                              onChange={(e) =>
                                updateAuditFilter(rule.id, {
                                  value: e.target.value,
                                })
                              }
                              className="h-8 text-xs"
                              placeholder={t("Value", "Value")}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2"
                              onClick={() => removeAuditFilter(rule.id)}
                              title={t("Remove filter", "Remove filter")}
                              aria-label={t("Remove filter", "Remove filter")}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                        <div className="text-[11px] text-muted-foreground">
                          {t(
                            "For timestamp comparisons, use ISO date/time values (example: {{value}}).",
                            {
                              value: "2026-02-06T12:00:00Z",
                              defaultValue:
                                "For timestamp comparisons, use ISO date/time values (example: 2026-02-06T12:00:00Z).",
                            },
                          )}
                        </div>
                      </div>
                    )}
                    {!isDesktop() && (
                      <div className="text-xs text-muted-foreground">
                        {t(
                          "Audit log is only available in the desktop app.",
                          "Audit log is only available in the desktop app.",
                        )}
                      </div>
                    )}
                    {auditLoading && (
                      <div className="text-sm text-muted-foreground">
                        {t("Loading audit entries…", "Loading audit entries…")}
                      </div>
                    )}
                    {auditError && (
                      <div className="text-sm text-destructive">
                        {auditError}
                      </div>
                    )}
                    {!auditLoading &&
                      !auditError &&
                      limitedAuditEntries.length === 0 && (
                        <div className="text-sm text-muted-foreground">
                          {t(
                            "No audit entries match the current filters.",
                            "No audit entries match the current filters.",
                          )}
                        </div>
                      )}
                    {!auditLoading &&
                      !auditError &&
                      limitedAuditEntries.length > 0 && (
                        <div className="overflow-auto rounded-lg border border-border/60">
                          <div
                            className="grid gap-3 border-b border-border/60 bg-muted/50 px-4 py-2 text-[11px] uppercase tracking-widest text-muted-foreground"
                            style={{
                              gridTemplateColumns: auditLogGridTemplate,
                            }}
                          >
                            {auditLogColumns.map((column) => {
                              if (column === "details") {
                                return (
                                  <div key={column}>
                                    {t("Details", "Details")}
                                  </div>
                                );
                              }
                              const field = column as
                                "timestamp" | "operation" | "resource";
                              const labels = {
                                timestamp: t("Timestamp", "Timestamp"),
                                operation: t("Operation", "Operation"),
                                resource: t("Resource", "Resource"),
                              } as const;
                              return (
                                <button
                                  key={column}
                                  type="button"
                                  className="flex items-center gap-1 text-left hover:text-foreground"
                                  onClick={() => toggleAuditSort(field)}
                                >
                                  {labels[field]}
                                  <ArrowUpDown className="h-3 w-3" />
                                  <span className="text-[10px]">
                                    {auditSort.field === field
                                      ? auditSort.dir === "asc"
                                        ? t("ASC", "ASC")
                                        : t("DESC", "DESC")
                                      : ""}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                          <div className="divide-y divide-white/10">
                            {limitedAuditEntries.map((entry, index) => {
                              const timestamp =
                                typeof entry.timestamp === "string"
                                  ? entry.timestamp
                                  : "unknown";
                              const operation =
                                typeof entry.operation === "string"
                                  ? entry.operation
                                  : "operation";
                              const resource =
                                typeof entry.resource === "string"
                                  ? entry.resource
                                  : "resource";
                              const timestampShort = formatAuditTimestampShort(
                                entry.timestamp,
                              );
                              const timestampFull = formatAuditTimestampFull(
                                entry.timestamp,
                              );
                              return (
                                <details
                                  key={`${timestamp}-${index}`}
                                  className="px-4 py-3 text-sm"
                                >
                                  <summary
                                    className="grid gap-3 cursor-pointer list-none"
                                    style={{
                                      gridTemplateColumns: auditLogGridTemplate,
                                    }}
                                  >
                                    {auditLogColumns.map((column) => {
                                      switch (column) {
                                        case "timestamp":
                                          return (
                                            <div
                                              key={column}
                                              className="text-xs text-muted-foreground"
                                              title={timestampFull}
                                            >
                                              {timestampShort}
                                            </div>
                                          );
                                        case "operation":
                                          return (
                                            <div
                                              key={column}
                                              className="font-medium"
                                            >
                                              {operation}
                                            </div>
                                          );
                                        case "resource":
                                          return (
                                            <div
                                              key={column}
                                              className="truncate text-muted-foreground"
                                            >
                                              {resource}
                                            </div>
                                          );
                                        case "details":
                                          return (
                                            <div
                                              key={column}
                                              className="text-xs text-muted-foreground hover:text-foreground"
                                            >
                                              {t("View", "View")}
                                            </div>
                                          );
                                        default:
                                          return null;
                                      }
                                    })}
                                  </summary>
                                  <div className="mt-3 rounded-md border border-border/60 bg-card/60 p-3 text-xs text-muted-foreground">
                                    <div className="mb-2">
                                      <span className="font-medium text-foreground">
                                        {t(
                                          "Full timestamp:",
                                          "Full timestamp:",
                                        )}
                                      </span>{" "}
                                      {timestampFull}
                                    </div>
                                    <pre className="whitespace-pre-wrap">
                                      {JSON.stringify(entry, null, 2)}
                                    </pre>
                                  </div>
                                </details>
                              );
                            })}
                          </div>
                        </div>
                      )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "tags" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Tag manager", "Tag manager")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
                      <div className="font-medium">{t("Zone", "Zone")}</div>
                      <Select
                        value={tagsZoneId || undefined}
                        onValueChange={(value) => {
                          setTagsZoneId(value);
                          setRenameTagFrom(null);
                          setRenameTagTo("");
                        }}
                      >
                        <SelectTrigger className="w-72">
                          <SelectValue
                            placeholder={t("Select a zone", "Select a zone")}
                          />
                        </SelectTrigger>
                        <SelectContent className="bg-popover/70 text-foreground">
                          {availableZones.map((zone: Zone) => (
                            <SelectItem
                              key={zone.id}
                              value={zone.id}
                              className="cursor-pointer"
                            >
                              {zone.name} ({zone.status})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {!tagsZoneId ? (
                      <div className="text-sm text-muted-foreground">
                        {t(
                          "Select a zone to manage its tags.",
                          "Select a zone to manage its tags.",
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value)}
                            placeholder={t("New tag", "New tag")}
                            className="h-9 w-56"
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              const next = newTag.trim();
                              if (!next) return;
                              storageManager.addZoneTag(tagsZoneId, next);
                              notifySaved(
                                t("Tag added: {{tag}}", {
                                  tag: next,
                                  defaultValue: `Tag added: ${next}`,
                                }),
                              );
                              setNewTag("");
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const next = newTag.trim();
                              if (!next) return;
                              storageManager.addZoneTag(tagsZoneId, next);
                              notifySaved(
                                t("Tag added: {{tag}}", {
                                  tag: next,
                                  defaultValue: `Tag added: ${next}`,
                                }),
                              );
                              setNewTag("");
                            }}
                          >
                            {t("Add tag", "Add tag")}
                          </Button>
                          <div className="text-xs text-muted-foreground">
                            {t(
                              "Tags are local-only and can be attached to records.",
                              "Tags are local-only and can be attached to records.",
                            )}
                          </div>
                        </div>

                        <div className="glass-surface glass-sheen glass-fade rounded-xl overflow-hidden">
                          <div className="grid grid-cols-[1fr_90px_1fr_160px] gap-2 px-3 py-2 text-[11px] uppercase tracking-widest text-muted-foreground border-b border-border/60">
                            <div>{t("Tag", "Tag")}</div>
                            <div className="text-right">
                              {t("Used", "Used")}
                            </div>
                            <div>{t("Linked records", "Linked records")}</div>
                            <div className="text-right">
                              {t("Actions", "Actions")}
                            </div>
                          </div>
                          {zoneTags.length === 0 ? (
                            <div className="px-3 py-6 text-sm text-muted-foreground">
                              {t(
                                "No tags yet. Add one above or create tags from a record's expanded panel.",
                                "No tags yet. Add one above or create tags from a record's expanded panel.",
                              )}
                            </div>
                          ) : (
                            <div className="divide-y divide-white/10">
                              {zoneTags.map((tag) => {
                                const linkedRecords =
                                  tagManagerRecordsByTag[tag] ?? [];
                                const preview = linkedRecords.slice(0, 2);
                                const remaining = Math.max(
                                  0,
                                  linkedRecords.length - preview.length,
                                );
                                return (
                                  <div
                                    key={tag}
                                    className="grid grid-cols-[1fr_90px_1fr_160px] items-center gap-2 px-3 py-2"
                                  >
                                    <div className="min-w-0">
                                      {renameTagFrom === tag ? (
                                        <Input
                                          value={renameTagTo}
                                          onChange={(e) =>
                                            setRenameTagTo(e.target.value)
                                          }
                                          className="h-8"
                                          autoFocus
                                          onKeyDown={(e) => {
                                            if (e.key !== "Enter") return;
                                            e.preventDefault();
                                            const next = renameTagTo.trim();
                                            if (!next) return;
                                            storageManager.renameTag(
                                              tagsZoneId,
                                              tag,
                                              next,
                                            );
                                            notifySaved(
                                              t(
                                                "Tag renamed: {{from}} -> {{to}}",
                                                {
                                                  from: tag,
                                                  to: next,
                                                  defaultValue: `Tag renamed: ${tag} -> ${next}`,
                                                },
                                              ),
                                            );
                                            setRenameTagFrom(null);
                                            setRenameTagTo("");
                                          }}
                                        />
                                      ) : (
                                        <Tag className="text-[9px] px-2 py-0.5">
                                          {tag}
                                        </Tag>
                                      )}
                                    </div>
                                    <div className="text-right text-sm text-muted-foreground">
                                      {tagCounts[tag] ?? 0}
                                    </div>
                                    <div className="min-w-0 text-xs text-muted-foreground">
                                      {preview.length ? (
                                        <>
                                          {preview.map((record) => (
                                            <span
                                              key={record.id}
                                              className="mr-2 inline-block truncate max-w-[180px]"
                                            >
                                              {record.name} ({record.type})
                                            </span>
                                          ))}
                                          {remaining > 0 && (
                                            <span>
                                              +
                                              {t("{{count}} more", {
                                                count: remaining,
                                                defaultValue: `${remaining} more`,
                                              })}
                                            </span>
                                          )}
                                        </>
                                      ) : (
                                        <span>
                                          {t("Not linked", "Not linked")}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex justify-end gap-2">
                                      {renameTagFrom === tag ? (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-8"
                                            onClick={() => {
                                              const next = renameTagTo.trim();
                                              if (!next) return;
                                              storageManager.renameTag(
                                                tagsZoneId,
                                                tag,
                                                next,
                                              );
                                              notifySaved(
                                                t(
                                                  "Tag renamed: {{from}} -> {{to}}",
                                                  {
                                                    from: tag,
                                                    to: next,
                                                    defaultValue: `Tag renamed: ${tag} -> ${next}`,
                                                  },
                                                ),
                                              );
                                              setRenameTagFrom(null);
                                              setRenameTagTo("");
                                            }}
                                          >
                                            {t("Save", "Save")}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-8"
                                            onClick={() => {
                                              setRenameTagFrom(null);
                                              setRenameTagTo("");
                                            }}
                                          >
                                            {t("Cancel", "Cancel")}
                                          </Button>
                                        </>
                                      ) : (
                                        <>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-8"
                                            onClick={() => {
                                              setRenameTagFrom(tag);
                                              setRenameTagTo(tag);
                                            }}
                                          >
                                            {t("Rename", "Rename")}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="destructive"
                                            className="h-8"
                                            onClick={() => {
                                              storageManager.deleteTag(
                                                tagsZoneId,
                                                tag,
                                              );
                                              notifySaved(
                                                t("Tag deleted: {{tag}}", {
                                                  tag,
                                                  defaultValue: `Tag deleted: ${tag}`,
                                                }),
                                              );
                                            }}
                                          >
                                            {t("Delete", "Delete")}
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-medium">
                              {t("Record associations", "Record associations")}
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                value={tagAssociationSearch}
                                onChange={(e) =>
                                  setTagAssociationSearch(e.target.value)
                                }
                                placeholder={t(
                                  "Search records or tags",
                                  "Search records or tags",
                                )}
                                className="h-8 w-64"
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8"
                                onClick={() =>
                                  void loadTagManagerRecords(tagsZoneId)
                                }
                                disabled={tagManagerRecordsLoading}
                              >
                                {t("Refresh", "Refresh")}
                              </Button>
                            </div>
                          </div>
                          {tagManagerRecordsLoading ? (
                            <div className="text-sm text-muted-foreground">
                              {t("Loading records...", "Loading records...")}
                            </div>
                          ) : tagManagerRecordsError ? (
                            <div className="text-sm text-destructive">
                              {t("Failed to load records: {{error}}", {
                                error: tagManagerRecordsError,
                                defaultValue: `Failed to load records: ${tagManagerRecordsError}`,
                              })}
                            </div>
                          ) : filteredTagManagerRecords.length === 0 ? (
                            <div className="text-sm text-muted-foreground">
                              {t(
                                "No records found for this zone.",
                                "No records found for this zone.",
                              )}
                            </div>
                          ) : (
                            <div className="divide-y divide-white/10 rounded-lg border border-border/50 bg-card/40">
                              {visibleTagManagerRecords.map((record) => {
                                const recordTags = storageManager.getRecordTags(
                                  tagsZoneId,
                                  record.id,
                                );
                                const draftTag =
                                  tagAssociationDrafts[record.id] ?? "";
                                const listId = `tag-association-options-${record.id}`;
                                return (
                                  <div
                                    key={record.id}
                                    className="grid gap-3 px-3 py-3 md:grid-cols-[1.2fr_1.6fr_1fr]"
                                  >
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-medium">
                                        {record.name}
                                      </div>
                                      <div className="truncate text-xs text-muted-foreground">
                                        {record.type} | {record.content}
                                      </div>
                                    </div>
                                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                                      {recordTags.length ? (
                                        recordTags.map((tag) => (
                                          <span
                                            key={tag}
                                            className="inline-flex items-center gap-1"
                                          >
                                            <Tag className="text-[9px] px-2 py-0.5">
                                              {tag}
                                            </Tag>
                                            <button
                                              type="button"
                                              className="ui-icon-button h-5 w-5"
                                              aria-label={t(
                                                "Remove tag {{tag}}",
                                                {
                                                  tag,
                                                  defaultValue: `Remove tag ${tag}`,
                                                },
                                              )}
                                              onClick={() =>
                                                detachTagFromRecord(
                                                  record.id,
                                                  tag,
                                                )
                                              }
                                            >
                                              <X className="h-3 w-3" />
                                            </button>
                                          </span>
                                        ))
                                      ) : (
                                        <span className="text-xs text-muted-foreground">
                                          {t("No tags", "No tags")}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Input
                                        list={listId}
                                        value={draftTag}
                                        onChange={(e) =>
                                          setTagAssociationDrafts((prev) => ({
                                            ...prev,
                                            [record.id]: e.target.value,
                                          }))
                                        }
                                        onKeyDown={(e) => {
                                          if (e.key !== "Enter") return;
                                          e.preventDefault();
                                          attachTagToRecord(
                                            record.id,
                                            draftTag,
                                          );
                                          setTagAssociationDrafts((prev) => ({
                                            ...prev,
                                            [record.id]: "",
                                          }));
                                        }}
                                        placeholder={t(
                                          "Attach tag",
                                          "Attach tag",
                                        )}
                                        className="h-8"
                                      />
                                      <datalist id={listId}>
                                        {zoneTags.map((tag) => (
                                          <option key={tag} value={tag} />
                                        ))}
                                      </datalist>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8"
                                        onClick={() => {
                                          attachTagToRecord(
                                            record.id,
                                            draftTag,
                                          );
                                          setTagAssociationDrafts((prev) => ({
                                            ...prev,
                                            [record.id]: "",
                                          }));
                                        }}
                                      >
                                        {t("Attach", "Attach")}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {tagManagerRecordsLimited && (
                            <div
                              role="status"
                              className="text-xs text-amber-800 dark:text-amber-200"
                            >
                              {t(
                                "Tag management is using the first {{count}} records to keep this large zone responsive.",
                                {
                                  count: DNS_RECORD_MEMORY_LIMIT,
                                  defaultValue: `Tag management is using the first ${DNS_RECORD_MEMORY_LIMIT} records to keep this large zone responsive.`,
                                },
                              )}
                            </div>
                          )}
                          {filteredTagManagerRecords.length >
                            visibleTagManagerRecords.length && (
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Showing first {{count}} records. Refine search to narrow the list.",
                                {
                                  count: visibleTagManagerRecords.length,
                                  defaultValue: `Showing first ${visibleTagManagerRecords.length} records. Refine search to narrow the list.`,
                                },
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
              {activeTab.kind === "registry" && (
                <RegistryMonitor monitor={registrarMonitor} />
              )}
              {activeTab.kind === "notifications" && (
                <NotificationsPanel
                  onOpenZone={openZoneTab}
                  onRevealRecord={revealNotificationRecord}
                />
              )}
              {activeTab.kind === "assistant" && <AiAssistantPanel />}
              {activeTab.kind === "settings" && (
                <Card className="border-border/60 bg-card/70">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {t("Session settings", "Session settings")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div
                      role="toolbar"
                      aria-label={t(
                        "Session settings sections",
                        "Session settings sections",
                      )}
                      className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
                    >
                      <button
                        onClick={() => setSettingsSubtab("general")}
                        data-active={settingsSubtab === "general"}
                        className="ui-segment"
                      >
                        {t("General", "General")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("columns")}
                        data-active={settingsSubtab === "columns"}
                        className="ui-segment"
                      >
                        {t("Columns", "Columns")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("topology")}
                        data-active={settingsSubtab === "topology"}
                        className="ui-segment"
                      >
                        {t("Topology", "Topology")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("audit")}
                        data-active={settingsSubtab === "audit"}
                        className="ui-segment"
                      >
                        {t("Audit", "Audit")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("mcp")}
                        data-active={settingsSubtab === "mcp"}
                        className="ui-segment"
                      >
                        {t("MCP", "MCP")}
                      </button>
                      <button
                        onClick={() => setSettingsSubtab("profiles")}
                        data-active={settingsSubtab === "profiles"}
                        className="ui-segment"
                      >
                        {t("Profiles", "Profiles")}
                      </button>
                    </div>
                    {settingsSubtab === "general" && (
                      <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Rewrite copied record domains",
                              "Rewrite copied record domains",
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Switch
                              checked={rewriteCopiedRecordDomains}
                              onCheckedChange={(checked) => {
                                setRewriteCopiedRecordDomains(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Copied record domain rewriting enabled.",
                                        "Copied record domain rewriting enabled.",
                                      )
                                    : t(
                                        "Copied record domain rewriting disabled.",
                                        "Copied record domain rewriting disabled.",
                                      ),
                                );
                              }}
                              aria-label={t(
                                "Rewrite copied record domains",
                                "Rewrite copied record domains",
                              )}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Replace source-zone domain suffixes with the destination zone when pasting records.",
                                "Replace source-zone domain suffixes with the destination zone when pasting records.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Preview pasted records",
                              "Preview pasted records",
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Switch
                              checked={confirmPastePreview}
                              onCheckedChange={(checked) => {
                                setConfirmPastePreview(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Paste preview enabled.",
                                        "Paste preview enabled.",
                                      )
                                    : t(
                                        "Paste preview disabled.",
                                        "Paste preview disabled.",
                                      ),
                                );
                              }}
                              aria-label={t(
                                "Preview pasted records",
                                "Preview pasted records",
                              )}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Confirm rewritten names and content before a paste that changed a record, or that creates more than two.",
                                "Confirm rewritten names and content before a paste that changed a record, or that creates more than two.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Auto refresh", "Auto refresh")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(autoRefreshInterval ?? 0)}
                              onValueChange={(v) => {
                                const next = clampAutoRefreshInterval(v);
                                setAutoRefreshInterval(next);
                                notifySaved(
                                  next
                                    ? t("Auto refresh set to {{seconds}}s.", {
                                        seconds: next / 1000,
                                        defaultValue: `Auto refresh set to ${next / 1000}s.`,
                                      })
                                    : t(
                                        "Auto refresh off.",
                                        "Auto refresh off.",
                                      ),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue
                                  placeholder={t(
                                    "Auto-refresh",
                                    "Auto-refresh",
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="0">
                                  {t("Off", "Off")}
                                </SelectItem>
                                <SelectItem value="60000">
                                  {t("1 min", "1 min")}
                                </SelectItem>
                                <SelectItem value="300000">
                                  {t("5 min", "5 min")}
                                </SelectItem>
                                <SelectItem value="600000">
                                  {t("10 min", "10 min")}
                                </SelectItem>
                                <SelectItem value="1800000">
                                  {t("30 min", "30 min")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Pauses while editing records or dialogs are open.",
                                "Pauses while editing records or dialogs are open.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Default per-page", "Default per-page")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(globalPerPage)}
                              onValueChange={(v) => {
                                const next = clampDnsPageSize(v);
                                setGlobalPerPage(next);
                                notifySaved(
                                  t("Default per-page set to {{count}}.", {
                                    count: next,
                                    defaultValue: `Default per-page set to ${next}.`,
                                  }),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue
                                  placeholder={t("Per page", "Per page")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="25">25</SelectItem>
                                <SelectItem value="50">50</SelectItem>
                                <SelectItem value="100">100</SelectItem>
                                <SelectItem value="200">200</SelectItem>
                                <SelectItem value="500">500</SelectItem>
                                <SelectItem value="0">
                                  {t("All", "All")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "New zone tabs inherit this value unless overridden.",
                                "New zone tabs inherit this value unless overridden.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Loader timeout", "Loader timeout")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(
                                Math.round(loadingOverlayTimeoutMs / 1000),
                              )}
                              onValueChange={(v) => {
                                const sec = Number(v);
                                const clampedSec = Math.max(
                                  1,
                                  Math.min(60, Number.isNaN(sec) ? 60 : sec),
                                );
                                setLoadingOverlayTimeoutMs(clampedSec * 1000);
                                notifySaved(
                                  t("Loader timeout set to {{seconds}}s.", {
                                    seconds: clampedSec,
                                    defaultValue: `Loader timeout set to ${clampedSec}s.`,
                                  }),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue
                                  placeholder={t("Timeout", "Timeout")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="5">
                                  {t("5 s", "5 s")}
                                </SelectItem>
                                <SelectItem value="10">
                                  {t("10 s", "10 s")}
                                </SelectItem>
                                <SelectItem value="20">
                                  {t("20 s", "20 s")}
                                </SelectItem>
                                <SelectItem value="30">
                                  {t("30 s", "30 s")}
                                </SelectItem>
                                <SelectItem value="45">
                                  {t("45 s", "45 s")}
                                </SelectItem>
                                <SelectItem value="60">
                                  {t("60 s", "60 s")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Max 60s. Loading overlay auto-hides after timeout.",
                                "Max 60s. Loading overlay auto-hides after timeout.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Unsupported record types",
                              "Unsupported record types",
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={showUnsupportedRecordTypes}
                              onCheckedChange={(checked: boolean) => {
                                setShowUnsupportedRecordTypes(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Unsupported record types will show in Add Record.",
                                        "Unsupported record types will show in Add Record.",
                                      )
                                    : t(
                                        "Add Record will show Cloudflare-supported types only.",
                                        "Add Record will show Cloudflare-supported types only.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Controls the Type dropdown default. Zones can override this.",
                                "Controls the Type dropdown default. Zones can override this.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Reopen last tabs", "Reopen last tabs")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={reopenLastTabs}
                              onCheckedChange={(checked: boolean) => {
                                setReopenLastTabs(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Will reopen last tabs on launch.",
                                        "Will reopen last tabs on launch.",
                                      )
                                    : t(
                                        "Will not reopen last tabs on launch.",
                                        "Will not reopen last tabs on launch.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Restore tabs from the last session on launch.",
                                "Restore tabs from the last session on launch.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Middle-click closes tabs",
                              "Middle-click closes tabs",
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={closeTabOnMiddleClick}
                              onCheckedChange={(checked: boolean) => {
                                setCloseTabOnMiddleClick(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Middle-click tab close enabled.",
                                        "Middle-click tab close enabled.",
                                      )
                                    : t(
                                        "Middle-click tab close disabled.",
                                        "Middle-click tab close disabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Controls whether pressing the mouse wheel on a tab closes it.",
                                "Controls whether pressing the mouse wheel on a tab closes it.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Confirm logout", "Confirm logout")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={confirmLogout}
                              onCheckedChange={(checked: boolean) => {
                                setConfirmLogout(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Logout confirmation enabled.",
                                        "Logout confirmation enabled.",
                                      )
                                    : t(
                                        "Logout confirmation disabled.",
                                        "Logout confirmation disabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Show a confirmation dialog when logging out.",
                                "Show a confirmation dialog when logging out.",
                              )}
                            </div>
                          </div>
                        </div>
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t(
                                "Confirm window close",
                                "Confirm window close",
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={confirmWindowClose}
                                onCheckedChange={(checked: boolean) => {
                                  setConfirmWindowClose(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Window close confirmation enabled.",
                                          "Window close confirmation enabled.",
                                        )
                                      : t(
                                          "Window close confirmation disabled.",
                                          "Window close confirmation disabled.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Show a confirmation dialog when closing the app window.",
                                  "Show a confirmation dialog when closing the app window.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Auto logout (idle)", "Auto logout (idle)")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(idleLogoutMs ?? 0)}
                              onValueChange={(v) => {
                                const next = Number(v);
                                setIdleLogoutMs(next ? next : null);
                                notifySaved(
                                  next
                                    ? t(
                                        "Auto logout after {{minutes}} min idle.",
                                        {
                                          minutes: Math.round(next / 60000),
                                          defaultValue: `Auto logout after ${Math.round(next / 60000)} min idle.`,
                                        },
                                      )
                                    : t(
                                        "Auto logout disabled.",
                                        "Auto logout disabled.",
                                      ),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue
                                  placeholder={t(
                                    "Idle timeout",
                                    "Idle timeout",
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent className="bg-popover/70 text-foreground">
                                <SelectItem value="0">
                                  {t("Never", "Never")}
                                </SelectItem>
                                <SelectItem value="60000">
                                  {t("1 min", "1 min")}
                                </SelectItem>
                                <SelectItem value="120000">
                                  {t("2 min", "2 min")}
                                </SelectItem>
                                <SelectItem value="300000">
                                  {t("5 min", "5 min")}
                                </SelectItem>
                                <SelectItem value="600000">
                                  {t("10 min", "10 min")}
                                </SelectItem>
                                <SelectItem value="1800000">
                                  {t("30 min", "30 min")}
                                </SelectItem>
                                <SelectItem value="3600000">
                                  {t("1 hour", "1 hour")}
                                </SelectItem>
                                <SelectItem value="14400000">
                                  {t("4 hours", "4 hours")}
                                </SelectItem>
                                <SelectItem value="86400000">
                                  {t("24 hours", "24 hours")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Logs out automatically after inactivity.",
                                "Logs out automatically after inactivity.",
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {settingsSubtab === "columns" && (
                      <div
                        className="space-y-3"
                        data-testid="settings-columns-panel"
                      >
                        <p className="text-xs text-muted-foreground">
                          {t(
                            "Choose which columns each table shows. Locked columns identify the row and stay visible; at least one column always remains.",
                            "Choose which columns each table shows. Locked columns identify the row and stay visible; at least one column always remains.",
                          )}
                        </p>
                        {TABLE_COLUMN_GROUPS.map((group) => {
                          const visible = resolveTableColumns(
                            group.id,
                            tableColumns[group.id],
                          );
                          const isDefault =
                            visible.join(",") ===
                            getDefaultTableColumns(group.id).join(",");
                          return (
                            <fieldset
                              key={group.id}
                              data-testid={`column-group-${group.id}`}
                              className="rounded-xl border border-border/60 bg-card/60 px-4 py-3"
                            >
                              <legend className="flex items-center gap-2 px-1 text-sm font-medium">
                                {t(group.label, group.label)}
                                <span className="text-[10px] font-normal uppercase tracking-widest text-muted-foreground">
                                  {t("{{shown}} of {{total}} shown", {
                                    shown: visible.length,
                                    total: group.columns.length,
                                    defaultValue: `${visible.length} of ${group.columns.length} shown`,
                                  })}
                                </span>
                              </legend>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs text-muted-foreground">
                                  {t(group.description, group.description)}
                                </p>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7"
                                  disabled={isDefault}
                                  onClick={() => {
                                    resetTableColumns(group.id);
                                    notifySaved(
                                      t(
                                        "{{table}} columns reset to defaults.",
                                        {
                                          table: t(group.label, group.label),
                                          defaultValue: `${group.label} columns reset to defaults.`,
                                        },
                                      ),
                                    );
                                  }}
                                >
                                  {t("Reset", "Reset")}
                                </Button>
                              </div>
                              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {group.columns.map((column) => {
                                  const checked = visible.includes(column.id);
                                  const lockedOn = Boolean(column.required);
                                  const lastOne =
                                    checked &&
                                    !lockedOn &&
                                    !canHideTableColumn(
                                      group.id,
                                      visible,
                                      column.id,
                                    );
                                  const label = t(column.label, column.label);
                                  return (
                                    <label
                                      key={column.id}
                                      data-column-id={column.id}
                                      data-locked={
                                        lockedOn || lastOne ? "true" : "false"
                                      }
                                      className="flex items-start gap-2 rounded-lg border border-border/50 bg-background/20 px-3 py-2 text-xs"
                                    >
                                      <input
                                        type="checkbox"
                                        className="checkbox-themed mt-0.5"
                                        checked={checked}
                                        disabled={lockedOn || lastOne}
                                        aria-label={`${t(group.label, group.label)}: ${label}`}
                                        onChange={(event) => {
                                          setTableColumnVisible(
                                            group.id,
                                            column.id,
                                            event.target.checked,
                                          );
                                          notifySaved(
                                            event.target.checked
                                              ? t("{{column}} column shown.", {
                                                  column: label,
                                                  defaultValue: `${label} column shown.`,
                                                })
                                              : t("{{column}} column hidden.", {
                                                  column: label,
                                                  defaultValue: `${label} column hidden.`,
                                                }),
                                          );
                                        }}
                                      />
                                      <span className="min-w-0">
                                        <span className="flex flex-wrap items-center gap-1 font-medium text-foreground/90">
                                          {label}
                                          {lockedOn && (
                                            <Tag className="text-[8px] px-1.5 py-0.5">
                                              {t("Always on", "Always on")}
                                            </Tag>
                                          )}
                                          {!lockedOn && lastOne && (
                                            <Tag className="text-[8px] px-1.5 py-0.5">
                                              {t("Last column", "Last column")}
                                            </Tag>
                                          )}
                                        </span>
                                        {column.description && (
                                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                            {t(
                                              column.description,
                                              column.description,
                                            )}
                                          </span>
                                        )}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </fieldset>
                          );
                        })}
                      </div>
                    )}
                    {settingsSubtab === "topology" && (
                      <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Topology resolution hops",
                              "Topology resolution hops",
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(topologyResolutionMaxHops)}
                              onValueChange={(v) => {
                                const next = Number(v);
                                const clamped = Math.max(
                                  1,
                                  Math.min(15, Number.isNaN(next) ? 15 : next),
                                );
                                setTopologyResolutionMaxHops(clamped);
                                notifySaved(
                                  t(
                                    "Topology CNAME resolution hops set to {{count}}.",
                                    {
                                      count: clamped,
                                      defaultValue: `Topology CNAME resolution hops set to ${clamped}.`,
                                    },
                                  ),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue
                                  placeholder={t("Max hops", "Max hops")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {Array.from({ length: 15 }).map((_, idx) => {
                                  const value = idx + 1;
                                  return (
                                    <SelectItem
                                      key={value}
                                      value={String(value)}
                                    >
                                      {value}
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Max recursive hostname resolution depth for topology (1-15).",
                                "Max recursive hostname resolution depth for topology (1-15).",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Topology request mode",
                              "Topology request mode",
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={topologyResolverMode}
                              onValueChange={(v) => {
                                const next: TopologyResolverMode =
                                  v === "doh" ? "doh" : "dns";
                                setTopologyResolverMode(next);
                                notifySaved(
                                  next === "doh"
                                    ? t(
                                        "Topology mode set to DoH requests.",
                                        "Topology mode set to DoH requests.",
                                      )
                                    : t(
                                        "Topology mode set to standard DNS requests.",
                                        "Topology mode set to standard DNS requests.",
                                      ),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue placeholder={t("Mode", "Mode")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="dns">
                                  {t("DNS (UDP/TCP)", "DNS (UDP/TCP)")}
                                </SelectItem>
                                <SelectItem value="doh">
                                  {t(
                                    "DNS-over-HTTPS (DoH)",
                                    "DNS-over-HTTPS (DoH)",
                                  )}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Choose whether topology resolves via normal DNS or DoH.",
                                "Choose whether topology resolves via normal DNS or DoH.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("DNS server", "DNS server")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={topologyDnsServer.trim()}
                              onValueChange={(v) => {
                                setTopologyDnsServer(v);
                                notifySaved(
                                  t("Topology DNS server set to {{server}}.", {
                                    server: v,
                                    defaultValue: `Topology DNS server set to ${v}.`,
                                  }),
                                );
                              }}
                            >
                              <SelectTrigger className="w-52">
                                <SelectValue
                                  placeholder={t("DNS server", "DNS server")}
                                >
                                  {t(
                                    TOPOLOGY_DNS_SERVER_LABELS[
                                      topologyDnsServer.trim()
                                    ] ?? topologyDnsServer.trim(),
                                    TOPOLOGY_DNS_SERVER_LABELS[
                                      topologyDnsServer.trim()
                                    ] ?? topologyDnsServer.trim(),
                                  )}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent className="w-[var(--radix-select-trigger-width)]">
                                <SelectItem value="1.1.1.1">
                                  {t(
                                    "1.1.1.1 (Cloudflare default)",
                                    "1.1.1.1 (Cloudflare default)",
                                  )}
                                </SelectItem>
                                <SelectItem value="1.0.0.1">
                                  {t(
                                    "1.0.0.1 (Cloudflare)",
                                    "1.0.0.1 (Cloudflare)",
                                  )}
                                </SelectItem>
                                <SelectItem value="8.8.8.8">
                                  {t("8.8.8.8 (Google)", "8.8.8.8 (Google)")}
                                </SelectItem>
                                <SelectItem value="8.8.4.4">
                                  {t("8.8.4.4 (Google)", "8.8.4.4 (Google)")}
                                </SelectItem>
                                <SelectItem value="9.9.9.9">
                                  {t("9.9.9.9 (Quad9)", "9.9.9.9 (Quad9)")}
                                </SelectItem>
                                <SelectItem value="149.112.112.112">
                                  {t(
                                    "149.112.112.112 (Quad9)",
                                    "149.112.112.112 (Quad9)",
                                  )}
                                </SelectItem>
                                <SelectItem value="208.67.222.222">
                                  {t(
                                    "208.67.222.222 (OpenDNS)",
                                    "208.67.222.222 (OpenDNS)",
                                  )}
                                </SelectItem>
                                <SelectItem value="208.67.220.220">
                                  {t(
                                    "208.67.220.220 (OpenDNS)",
                                    "208.67.220.220 (OpenDNS)",
                                  )}
                                </SelectItem>
                                <SelectItem value="94.140.14.14">
                                  {t(
                                    "94.140.14.14 (AdGuard)",
                                    "94.140.14.14 (AdGuard)",
                                  )}
                                </SelectItem>
                                <SelectItem value="76.76.2.0">
                                  {t(
                                    "76.76.2.0 (Control D)",
                                    "76.76.2.0 (Control D)",
                                  )}
                                </SelectItem>
                                <SelectItem value="custom">
                                  {t("Custom", "Custom")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Common resolvers list. Default is 1.1.1.1.",
                                "Common resolvers list. Default is 1.1.1.1.",
                              )}
                            </div>
                          </div>
                        </div>
                        {topologyDnsServer === "custom" && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t("Custom DNS server", "Custom DNS server")}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Input
                                value={topologyCustomDnsServer}
                                onChange={(event) =>
                                  setTopologyCustomDnsServer(event.target.value)
                                }
                                onBlur={() => {
                                  setTopologyCustomDnsServer((prev) =>
                                    prev.trim(),
                                  );
                                  notifySaved(
                                    t(
                                      "Custom DNS server updated.",
                                      "Custom DNS server updated.",
                                    ),
                                  );
                                }}
                                className="min-w-[320px]"
                                placeholder={t(
                                  "e.g. 192.168.1.1",
                                  "e.g. 192.168.1.1",
                                )}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "IP address used when DNS server is set to Custom.",
                                  "IP address used when DNS server is set to Custom.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {topologyResolverMode === "doh" && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t("Custom DoH endpoint", "Custom DoH endpoint")}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Input
                                value={topologyDohCustomUrl}
                                onChange={(event) =>
                                  setTopologyDohCustomUrl(event.target.value)
                                }
                                onBlur={() => {
                                  setTopologyDohCustomUrl((prev) =>
                                    prev.trim(),
                                  );
                                  notifySaved(
                                    t(
                                      "Custom DoH endpoint updated.",
                                      "Custom DoH endpoint updated.",
                                    ),
                                  );
                                }}
                                className="min-w-[320px]"
                                placeholder={t(
                                  "https://dns.google/resolve or https://your-doh.example/dns-query",
                                  "https://dns.google/resolve or https://your-doh.example/dns-query",
                                )}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Optional override for DoH mode.",
                                  "Optional override for DoH mode.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Lookup timeout", "Lookup timeout")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <Select
                              value={String(topologyLookupTimeoutMs)}
                              onValueChange={(v) => {
                                const next = Number(v);
                                const clamped = Math.max(
                                  250,
                                  Math.min(
                                    10000,
                                    Number.isNaN(next) ? 1200 : next,
                                  ),
                                );
                                setTopologyLookupTimeoutMs(clamped);
                                notifySaved(
                                  t(
                                    "Topology lookup timeout set to {{ms}}ms.",
                                    {
                                      ms: clamped,
                                      defaultValue: `Topology lookup timeout set to ${clamped}ms.`,
                                    },
                                  ),
                                );
                              }}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue
                                  placeholder={t("Timeout", "Timeout")}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="250">
                                  {t("250 ms", "250 ms")}
                                </SelectItem>
                                <SelectItem value="500">
                                  {t("500 ms", "500 ms")}
                                </SelectItem>
                                <SelectItem value="800">
                                  {t("800 ms", "800 ms")}
                                </SelectItem>
                                <SelectItem value="1200">
                                  {t("1200 ms", "1200 ms")}
                                </SelectItem>
                                <SelectItem value="2000">
                                  {t("2000 ms", "2000 ms")}
                                </SelectItem>
                                <SelectItem value="3000">
                                  {t("3000 ms", "3000 ms")}
                                </SelectItem>
                                <SelectItem value="5000">
                                  {t("5000 ms", "5000 ms")}
                                </SelectItem>
                                <SelectItem value="8000">
                                  {t("8000 ms", "8000 ms")}
                                </SelectItem>
                                <SelectItem value="10000">
                                  {t("10000 ms", "10000 ms")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Per DNS/DoH lookup timeout for topology chain resolution.",
                                "Per DNS/DoH lookup timeout for topology chain resolution.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Disable end-node PTR lookups",
                              "Disable end-node PTR lookups",
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisablePtrLookups}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisablePtrLookups(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "PTR lookups disabled for topology end nodes.",
                                        "PTR lookups disabled for topology end nodes.",
                                      )
                                    : t(
                                        "PTR lookups enabled for topology end nodes.",
                                        "PTR lookups enabled for topology end nodes.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Skip reverse DNS lookups to speed up topology loading.",
                                "Skip reverse DNS lookups to speed up topology loading.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Don't scan resolution chain",
                              "Don't scan resolution chain",
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={!topologyScanResolutionChain}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyScanResolutionChain(!checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Topology will skip recursive CNAME chain scanning.",
                                        "Topology will skip recursive CNAME chain scanning.",
                                      )
                                    : t(
                                        "Topology will scan full recursive CNAME chains.",
                                        "Topology will scan full recursive CNAME chains.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Faster lookups, but omits intermediate chain hops.",
                                "Faster lookups, but omits intermediate chain hops.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Disable GEO detection",
                              "Disable GEO detection",
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableGeoLookups}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableGeoLookups(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "IP GEO detection disabled for topology.",
                                        "IP GEO detection disabled for topology.",
                                      )
                                    : t(
                                        "IP GEO detection enabled for topology.",
                                        "IP GEO detection enabled for topology.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Turns off country enrichment for resolved IP nodes.",
                                "Turns off country enrichment for resolved IP nodes.",
                              )}
                            </div>
                          </div>
                        </div>
                        {!topologyDisableGeoLookups && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t("GEO lookup service", "GEO lookup service")}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={topologyGeoProvider}
                                onValueChange={(v) => {
                                  const next =
                                    (v as TopologyGeoProvider) || "auto";
                                  setTopologyGeoProvider(next);
                                  notifySaved(
                                    t(
                                      "Topology GEO provider set to {{provider}}.",
                                      {
                                        provider: next,
                                        defaultValue: `Topology GEO provider set to ${next}.`,
                                      },
                                    ),
                                  );
                                }}
                              >
                                <SelectTrigger className="w-56">
                                  <SelectValue
                                    placeholder={t(
                                      "GEO provider",
                                      "GEO provider",
                                    )}
                                  >
                                    {t(
                                      TOPOLOGY_GEO_PROVIDER_LABELS[
                                        topologyGeoProvider
                                      ],
                                      TOPOLOGY_GEO_PROVIDER_LABELS[
                                        topologyGeoProvider
                                      ],
                                    )}
                                  </SelectValue>
                                </SelectTrigger>
                                <SelectContent className="w-[var(--radix-select-trigger-width)]">
                                  <SelectItem value="auto">
                                    {t(
                                      "Auto (multi-provider fallback)",
                                      "Auto (multi-provider fallback)",
                                    )}
                                  </SelectItem>
                                  <SelectItem value="ipwhois">
                                    ipwho.is
                                  </SelectItem>
                                  <SelectItem value="ipapi_co">
                                    ipapi.co
                                  </SelectItem>
                                  <SelectItem value="ip_api">
                                    ip-api.com
                                  </SelectItem>
                                  <SelectItem value="internal">
                                    {t(
                                      "Internal only (private/reserved IPs)",
                                      "Internal only (private/reserved IPs)",
                                    )}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Chooses GEO source; Auto tries multiple services and falls back.",
                                  "Chooses GEO source; Auto tries multiple services and falls back.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "Disable service discovery",
                              "Disable service discovery",
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableServiceDiscovery}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableServiceDiscovery(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Topology service discovery disabled.",
                                        "Topology service discovery disabled.",
                                      )
                                    : t(
                                        "Topology service discovery enabled.",
                                        "Topology service discovery enabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Disables manual service probing in topology tab.",
                                "Disables manual service probing in topology tab.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t(
                              "TCP services to probe",
                              "TCP services to probe",
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2"
                                >
                                  {t("{{count}} selected", {
                                    count: topologyTcpServices.length,
                                    defaultValue: `${topologyTcpServices.length} selected`,
                                  })}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="max-h-72 w-60 overflow-auto">
                                {TOPOLOGY_TCP_SERVICE_OPTIONS.map((opt) => {
                                  const value = String(opt.port);
                                  const checked =
                                    topologyTcpServices.includes(value);
                                  return (
                                    <DropdownMenuCheckboxItem
                                      key={opt.port}
                                      className="pl-6"
                                      checked={checked}
                                      onCheckedChange={(next) => {
                                        setTopologyTcpServices((prev) => {
                                          const set = new Set(prev);
                                          if (next) set.add(value);
                                          else set.delete(value);
                                          const out = Array.from(set);
                                          return out.length
                                            ? out
                                            : ["80", "443", "22"];
                                        });
                                      }}
                                      onSelect={(event) =>
                                        event.preventDefault()
                                      }
                                    >
                                      {t(opt.label, opt.label)}
                                    </DropdownMenuCheckboxItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Multi-select common TCP services for simple discovery.",
                                "Multi-select common TCP services for simple discovery.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Disable annotations", "Disable annotations")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableAnnotations}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableAnnotations(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Topology annotations disabled.",
                                        "Topology annotations disabled.",
                                      )
                                    : t(
                                        "Topology annotations enabled.",
                                        "Topology annotations enabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Hides annotation tools in topology view.",
                                "Hides annotation tools in topology view.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Disable full window", "Disable full window")}
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={topologyDisableFullWindow}
                              onCheckedChange={(checked: boolean) => {
                                setTopologyDisableFullWindow(checked);
                                notifySaved(
                                  checked
                                    ? t(
                                        "Full-window topology mode disabled.",
                                        "Full-window topology mode disabled.",
                                      )
                                    : t(
                                        "Full-window topology mode enabled.",
                                        "Full-window topology mode enabled.",
                                      ),
                                );
                              }}
                            />
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Hides full-window graph action in topology controls.",
                                "Hides full-window graph action in topology controls.",
                              )}
                            </div>
                          </div>
                        </div>
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t(
                                "Confirm path to export",
                                "Confirm path to export",
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={topologyExportConfirmPath}
                                onCheckedChange={(checked: boolean) => {
                                  setTopologyExportConfirmPath(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Topology exports will ask for destination.",
                                          "Topology exports will ask for destination.",
                                        )
                                      : t(
                                          "Topology exports will save directly to default path.",
                                          "Topology exports will save directly to default path.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Applies to topology code/SVG/PNG export actions.",
                                  "Applies to topology code/SVG/PNG export actions.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t(
                                "Topology export path",
                                "Topology export path",
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={topologyExportFolderPreset}
                                onValueChange={(v) => {
                                  setTopologyExportFolderPreset(
                                    v as ExportFolderPreset,
                                  );
                                  notifySaved(
                                    t(
                                      "Topology export preset set to {{preset}}.",
                                      {
                                        preset: v,
                                        defaultValue: `Topology export preset set to ${v}.`,
                                      },
                                    ),
                                  );
                                }}
                              >
                                <SelectTrigger className="w-52">
                                  <SelectValue
                                    placeholder={t(
                                      "Folder preset",
                                      "Folder preset",
                                    )}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="system">
                                    {t("System default", "System default")}
                                  </SelectItem>
                                  <SelectItem value="documents">
                                    {t("Documents", "Documents")}
                                  </SelectItem>
                                  <SelectItem value="downloads">
                                    {t("Downloads", "Downloads")}
                                  </SelectItem>
                                  <SelectItem value="desktop">
                                    {t("Desktop", "Desktop")}
                                  </SelectItem>
                                  <SelectItem value="custom">
                                    {t("Custom path", "Custom path")}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Default export location for topology assets.",
                                  "Default export location for topology assets.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() &&
                          topologyExportFolderPreset === "custom" && (
                            <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                              <div className="font-medium">
                                {t("Custom export path", "Custom export path")}
                              </div>
                              <Input
                                value={topologyExportCustomPath}
                                onChange={(e) =>
                                  setTopologyExportCustomPath(e.target.value)
                                }
                                placeholder={t(
                                  "C:\\Users\\You\\Documents\\Topology Exports",
                                  "C:\\Users\\You\\Documents\\Topology Exports",
                                )}
                              />
                            </div>
                          )}
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Copy actions", "Copy actions")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2"
                                >
                                  {t("{{count}} selected", {
                                    count: topologyCopyActions.length,
                                    defaultValue: `${topologyCopyActions.length} selected`,
                                  })}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="max-h-72 w-60 overflow-auto">
                                {TOPOLOGY_COPY_ACTION_OPTIONS.map((opt) => {
                                  const checked = topologyCopyActions.includes(
                                    opt.value,
                                  );
                                  return (
                                    <DropdownMenuCheckboxItem
                                      key={opt.value}
                                      className="pl-6"
                                      checked={checked}
                                      onCheckedChange={(next) => {
                                        setTopologyCopyActions((prev) => {
                                          const set = new Set(prev);
                                          if (next) set.add(opt.value);
                                          else if (set.size > 1)
                                            set.delete(opt.value);
                                          return Array.from(set);
                                        });
                                      }}
                                      onSelect={(event) =>
                                        event.preventDefault()
                                      }
                                    >
                                      {t(opt.label, opt.label)}
                                    </DropdownMenuCheckboxItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Controls which actions appear in topology Copy menu.",
                                "Controls which actions appear in topology Copy menu.",
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Export actions", "Export actions")}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2"
                                >
                                  {t("{{count}} selected", {
                                    count: topologyExportActions.length,
                                    defaultValue: `${topologyExportActions.length} selected`,
                                  })}
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="max-h-72 w-60 overflow-auto">
                                {TOPOLOGY_EXPORT_ACTION_OPTIONS.map((opt) => {
                                  const checked =
                                    topologyExportActions.includes(opt.value);
                                  return (
                                    <DropdownMenuCheckboxItem
                                      key={opt.value}
                                      className="pl-6"
                                      checked={checked}
                                      onCheckedChange={(next) => {
                                        setTopologyExportActions((prev) => {
                                          const set = new Set(prev);
                                          if (next) set.add(opt.value);
                                          else if (set.size > 1)
                                            set.delete(opt.value);
                                          return Array.from(set);
                                        });
                                      }}
                                      onSelect={(event) =>
                                        event.preventDefault()
                                      }
                                    >
                                      {t(opt.label, opt.label)}
                                    </DropdownMenuCheckboxItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <div className="text-xs text-muted-foreground">
                              {t(
                                "Controls which actions appear in topology Export menu.",
                                "Controls which actions appear in topology Export menu.",
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    {settingsSubtab === "audit" && (
                      <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                        <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                          <div className="font-medium">
                            {t("Audit categories", "Audit categories")}
                          </div>
                          <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="checkbox-themed"
                                checked={domainAuditCategories.email}
                                onChange={(e) =>
                                  setDomainAuditCategories((prev) => ({
                                    ...prev,
                                    email: e.target.checked,
                                  }))
                                }
                              />
                              {t("Email", "Email")}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="checkbox-themed"
                                checked={domainAuditCategories.security}
                                onChange={(e) =>
                                  setDomainAuditCategories((prev) => ({
                                    ...prev,
                                    security: e.target.checked,
                                  }))
                                }
                              />
                              {t("Security", "Security")}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                className="checkbox-themed"
                                checked={domainAuditCategories.hygiene}
                                onChange={(e) =>
                                  setDomainAuditCategories((prev) => ({
                                    ...prev,
                                    hygiene: e.target.checked,
                                  }))
                                }
                              />
                              {t("Hygiene", "Hygiene")}
                            </label>
                          </div>
                        </div>
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t(
                                "Export folder preset",
                                "Export folder preset",
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <Select
                                value={auditExportFolderPreset}
                                onValueChange={(v) => {
                                  setAuditExportFolderPreset(
                                    v as ExportFolderPreset,
                                  );
                                  notifySaved(
                                    t(
                                      "Audit export preset set to {{preset}}.",
                                      {
                                        preset: v,
                                        defaultValue: `Audit export preset set to ${v}.`,
                                      },
                                    ),
                                  );
                                }}
                              >
                                <SelectTrigger className="w-52">
                                  <SelectValue
                                    placeholder={t(
                                      "Folder preset",
                                      "Folder preset",
                                    )}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="system">
                                    {t("System default", "System default")}
                                  </SelectItem>
                                  <SelectItem value="documents">
                                    {t("Documents", "Documents")}
                                  </SelectItem>
                                  <SelectItem value="downloads">
                                    {t("Downloads", "Downloads")}
                                  </SelectItem>
                                  <SelectItem value="desktop">
                                    {t("Desktop", "Desktop")}
                                  </SelectItem>
                                  <SelectItem value="custom">
                                    {t("Custom path", "Custom path")}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Choose the default start folder for audit exports.",
                                  "Choose the default start folder for audit exports.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t(
                                "Don't confirm destination",
                                "Don't confirm destination",
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={auditExportSkipDestinationConfirm}
                                onCheckedChange={(checked: boolean) => {
                                  setAuditExportSkipDestinationConfirm(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Audit exports will save directly without destination dialog.",
                                          "Audit exports will save directly without destination dialog.",
                                        )
                                      : t(
                                          "Audit exports will ask for destination.",
                                          "Audit exports will ask for destination.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Enabled by default.",
                                  "Enabled by default.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                        {isDesktop() &&
                          auditExportFolderPreset === "custom" && (
                            <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                              <div className="font-medium">
                                {t("Custom export path", "Custom export path")}
                              </div>
                              <Input
                                value={auditExportCustomPath}
                                onChange={(e) =>
                                  setAuditExportCustomPath(e.target.value)
                                }
                                placeholder={t(
                                  "C:\\Users\\You\\Documents\\Audit Exports",
                                  "C:\\Users\\You\\Documents\\Audit Exports",
                                )}
                              />
                            </div>
                          )}
                        {isDesktop() && (
                          <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                            <div className="font-medium">
                              {t(
                                "Confirm clear audit logs",
                                "Confirm clear audit logs",
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <Switch
                                checked={confirmClearAuditLogs}
                                onCheckedChange={(checked: boolean) => {
                                  setConfirmClearAuditLogs(checked);
                                  notifySaved(
                                    checked
                                      ? t(
                                          "Clear-audit confirmation enabled.",
                                          "Clear-audit confirmation enabled.",
                                        )
                                      : t(
                                          "Clear-audit confirmation disabled.",
                                          "Clear-audit confirmation disabled.",
                                        ),
                                  );
                                }}
                              />
                              <div className="text-xs text-muted-foreground">
                                {t(
                                  "Ask before deleting all audit entries.",
                                  "Ask before deleting all audit entries.",
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {settingsSubtab === "mcp" && (
                      <div className="divide-y divide-white/10 rounded-xl border border-border/60 bg-card/60 text-sm">
                        {!isDesktop() ? (
                          <div className="px-4 py-4 text-xs text-muted-foreground">
                            {t(
                              "MCP server management is only available in the desktop app.",
                              "MCP server management is only available in the desktop app.",
                            )}
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                              <div className="font-medium">
                                {t("Server status", "Server status")}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Tag>
                                  {mcpRunning
                                    ? t("Running", "Running")
                                    : t("Stopped", "Stopped")}
                                </Tag>
                                <span className="text-xs text-muted-foreground">
                                  {mcpUrl}
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2"
                                  onClick={() => void refreshMcpStatus()}
                                  disabled={mcpBusy}
                                >
                                  {t("Refresh", "Refresh")}
                                </Button>
                              </div>
                            </div>
                            <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                              <div className="font-medium">
                                {t("Enable MCP server", "Enable MCP server")}
                              </div>
                              <div className="flex items-center gap-3">
                                <Switch
                                  checked={mcpServerEnabled}
                                  disabled={mcpBusy || !mcpPermissionsReady}
                                  onCheckedChange={(checked: boolean) => {
                                    void setMcpServerRunning(checked);
                                  }}
                                />
                                <div className="text-xs text-muted-foreground">
                                  {t(
                                    "Server is off by default. Enable to accept local MCP clients.",
                                    "Server is off by default. Enable to accept local MCP clients.",
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-center">
                              <div className="font-medium">
                                {t("Bind host", "Bind host")}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Input
                                  value={mcpServerHost}
                                  disabled={mcpBusy}
                                  onChange={(event) =>
                                    setMcpServerHost(event.target.value)
                                  }
                                  placeholder="127.0.0.1"
                                  className="h-8 w-52"
                                />
                                <Input
                                  type="number"
                                  value={String(mcpServerPort)}
                                  disabled={mcpBusy}
                                  onChange={(event) => {
                                    const value = Number(event.target.value);
                                    setMcpServerPort(
                                      Number.isNaN(value)
                                        ? 8787
                                        : Math.max(
                                            1,
                                            Math.min(65535, Math.round(value)),
                                          ),
                                    );
                                  }}
                                  className="h-8 w-28"
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2"
                                  onClick={() =>
                                    void setMcpServerRunning(
                                      mcpServerEnabled,
                                      mcpServerHost,
                                      mcpServerPort,
                                    )
                                  }
                                  disabled={
                                    mcpBusy ||
                                    !mcpServerEnabled ||
                                    !mcpPermissionsReady
                                  }
                                >
                                  {t("Apply + restart", "Apply + restart")}
                                </Button>
                              </div>
                            </div>
                            <div className="grid gap-3 px-4 py-3 md:grid-cols-[180px_1fr] md:items-start">
                              <div className="font-medium">
                                {t("Tool access", "Tool access")}
                              </div>
                              <div ref={mcpPermissionsViewRef} />
                            </div>
                            {mcpLastError && (
                              <div className="px-4 py-3">
                                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground/90">
                                  {mcpLastError}
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {settingsSubtab === "profiles" && (
                      <div className="space-y-3 rounded-xl border border-border/60 bg-card/60 p-4 text-sm">
                        <div className="text-xs text-muted-foreground">
                          {t("Current session:", "Current session:")}{" "}
                          <span className="font-medium text-foreground">
                            {currentSessionId}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={exportSessionSettings}
                          >
                            <FileDown className="mr-2 h-4 w-4" />
                            {t("Export settings", "Export settings")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              settingsImportInputRef.current?.click()
                            }
                          >
                            <FileUp className="mr-2 h-4 w-4" />
                            {t("Import settings", "Import settings")}
                          </Button>
                          <input
                            ref={settingsImportInputRef}
                            type="file"
                            className="hidden"
                            accept="application/json"
                            onChange={(e) => void importSessionSettings(e)}
                          />
                        </div>
                        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                          <div className="space-y-1">
                            <Label>
                              {t("Clone from session", "Clone from session")}
                            </Label>
                            <Select
                              value={cloneSourceSessionId}
                              onValueChange={setCloneSourceSessionId}
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t(
                                    "Pick saved session profile",
                                    "Pick saved session profile",
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {sessionProfileIds
                                  .filter((id) => id !== currentSessionId)
                                  .map((id) => (
                                    <SelectItem key={id} value={id}>
                                      {id}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            size="sm"
                            disabled={!cloneSourceSessionId}
                            onClick={() =>
                              void cloneSessionSettingsFrom(
                                cloneSourceSessionId,
                              )
                            }
                          >
                            {t("Clone", "Clone")}
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Settings className="h-4 w-4" />
                      {t(
                        "Settings can be exported/imported and cloned across sessions.",
                        "Settings can be exported/imported and cloned across sessions.",
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/60 bg-card/60">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              {t(
                "Select a zone to open it in a new tab.",
                "Select a zone to open it in a new tab.",
              )}
            </CardContent>
          </Card>
        )}
      </div>
      <div
        ref={mcpPermissionsParkingRef}
        data-testid="mcp-permissions-parking"
        hidden
        inert
        aria-hidden="true"
      />
      {mcpPermissionsPortalHost &&
        isDesktop() &&
        createPortal(
          <McpToolPermissions
            enabledTools={mcpRequestedTools}
            interactive={mcpPermissionsInteractive}
            onApplied={handleMcpPermissionsApplied}
            onError={handleMcpPermissionsError}
          />,
          mcpPermissionsPortalHost,
        )}
      <Dialog
        open={showClearAuditConfirm}
        onOpenChange={setShowClearAuditConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Clear audit logs", "Clear audit logs")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "This deletes all audit entries stored on this device. This cannot be undone.",
                "This deletes all audit entries stored on this device. This cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="checkbox-themed"
              checked={!confirmClearAuditLogs}
              onChange={(e) => {
                const disable = e.target.checked;
                setConfirmClearAuditLogs(!disable);
                notifySaved(
                  disable
                    ? t(
                        "Clear-audit confirmation disabled.",
                        "Clear-audit confirmation disabled.",
                      )
                    : t(
                        "Clear-audit confirmation enabled.",
                        "Clear-audit confirmation enabled.",
                      ),
                );
              }}
            />
            {t("Don't ask again", "Don't ask again")}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowClearAuditConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              className="flex-1 bg-red-500/80 text-white hover:bg-red-500 hover:text-white shadow-[0_0_18px_rgba(255,80,80,0.25)] hover:shadow-[0_0_26px_rgba(255,90,90,0.45)] transition"
              onClick={async () => {
                if (!isDesktop()) return;
                await clearAuditEntriesNow();
                setShowClearAuditConfirm(false);
              }}
            >
              {t("Clear logs", "Clear logs")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showPurgeEverythingConfirm}
        onOpenChange={setShowPurgeEverythingConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Purge entire cache?", "Purge entire cache?")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "This purges cached content for the active zone. It can temporarily increase origin load.",
                "This purges cached content for the active zone. It can temporarily increase origin load.",
              )}
            </DialogDescription>
          </DialogHeader>
          {activeTab?.kind === "zone" ? (
            <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
              <div className="font-semibold">{activeTab.zoneName}</div>
              <div className="mt-1 text-muted-foreground">
                {t("Purge: everything", "Purge: everything")}
              </div>
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowPurgeEverythingConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={() => void confirmPurgeEverything()}
            >
              {t("Purge", "Purge")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showPurgeUrlsConfirm}
        onOpenChange={setShowPurgeUrlsConfirm}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Purge URLs?", "Purge URLs?")}</DialogTitle>
            <DialogDescription>
              {t(
                "Cloudflare may reject invalid URLs. You can still attempt to purge anyway.",
                "Cloudflare may reject invalid URLs. You can still attempt to purge anyway.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-card/60 p-3 text-xs">
            <div className="font-semibold">
              {t("{{count}} URL(s)", {
                count: pendingPurgeUrls.length,
                defaultValue: `${pendingPurgeUrls.length} URL(s)`,
              })}
            </div>
            {pendingPurgeIssues.length > 0 ? (
              <div className="mt-2 space-y-1">
                <div className="text-destructive font-medium">
                  {t("Warnings", "Warnings")}
                </div>
                <ul className="list-disc pl-4 text-destructive/90">
                  {pendingPurgeIssues.slice(0, 8).map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                {pendingPurgeIssues.length > 8 ? (
                  <div className="text-muted-foreground">
                    +
                    {t("{{count}} more…", {
                      count: pendingPurgeIssues.length - 8,
                      defaultValue: `${pendingPurgeIssues.length - 8} more…`,
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-2 text-muted-foreground">
                {t("No issues detected.", "No issues detected.")}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowPurgeUrlsConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button className="flex-1" onClick={() => void confirmPurgeUrls()}>
              {t("Purge", "Purge")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Log out", "Log out")}</DialogTitle>
            <DialogDescription>
              {t(
                "Are you sure you want to log out? You'll need to sign in again to manage records.",
                "Are you sure you want to log out? You'll need to sign in again to manage records.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="checkbox-themed"
              checked={!confirmLogout}
              onChange={(e) => {
                const disable = e.target.checked;
                setConfirmLogout(!disable);
                notifySaved(
                  disable
                    ? t(
                        "Logout confirmation disabled.",
                        "Logout confirmation disabled.",
                      )
                    : t(
                        "Logout confirmation enabled.",
                        "Logout confirmation enabled.",
                      ),
                );
              }}
            />
            {t("Don't ask again", "Don't ask again")}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowLogoutConfirm(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={confirmAndLogout}
            >
              {t("Log out", "Log out")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showCopyBuffer && !!copyBuffer}
        onOpenChange={setShowCopyBuffer}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Copy buffer", "Copy buffer")}</DialogTitle>
            <DialogDescription>
              {copyBuffer
                ? t(
                    "{{count}} record(s) queued from {{zone}}. Pasting creates them in the active zone.",
                    {
                      count: copyBuffer.records.length,
                      zone: copyBuffer.sourceZoneName,
                      defaultValue: `${copyBuffer.records.length} record(s) queued from ${copyBuffer.sourceZoneName}. Pasting creates them in the active zone.`,
                    },
                  )
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-64 space-y-1 overflow-y-auto rounded border p-2"
            data-testid="copy-buffer-list"
          >
            {copyBuffer?.records.map((record) => (
              <div
                key={record.id}
                data-testid="copy-buffer-row"
                className="border-b p-1 last:border-b-0"
              >
                <div className="font-mono text-sm">
                  {record.type} {record.name}
                </div>
                <div className="break-all text-xs text-muted-foreground">
                  {record.content}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={clearCopyBuffer}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              {t("Clear buffer", "Clear buffer")}
            </Button>
            <Button className="flex-1" onClick={() => setShowCopyBuffer(false)}>
              {t("Close", "Close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {pastePreview && (
        <ImportPreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPastePreview(null);
          }}
          items={pastePreview.items}
          sourceItemCount={pastePreview.sourceCount}
          title={t("Paste Preview", "Paste Preview")}
          description={t(
            "Review the rewritten names and content before creating these records in {{zone}}.",
            {
              zone: pastePreview.zoneName,
              defaultValue: `Review the rewritten names and content before creating these records in ${pastePreview.zoneName}.`,
            },
          )}
          confirmLabel={t("Paste Selected", "Paste Selected")}
          askAgain={{
            label: t(
              "Ask before pasting rewritten records",
              "Ask before pasting rewritten records",
            ),
            checked: confirmPastePreview,
            onChange: setConfirmPastePreview,
          }}
          onConfirm={(items, dryRun) => {
            const target = {
              tabId: pastePreview.tabId,
              zoneId: pastePreview.zoneId,
              zoneName: pastePreview.zoneName,
            };
            // Deselected rows count as skipped so the toast still adds up.
            const skipped =
              pastePreview.skipped + (pastePreview.items.length - items.length);
            setPastePreview(null);
            void performPaste(
              target,
              items as PreparedCopiedDnsRecord[],
              skipped,
              dryRun === true,
            );
          }}
          onCancel={() => setPastePreview(null)}
        />
      )}
      <HotkeyHelpDialog />
    </AuthenticatedAppShell>
  );
}

DNSManager.repointPairedDnsOp = repointPairedDnsOp;
DNSManager.clampDnsPageSize = clampDnsPageSize;
DNSManager.clampAutoRefreshInterval = clampAutoRefreshInterval;
DNSManager.retainDnsRecordsForUi = retainDnsRecordsForUi;
DNSManager.loadCompleteDnsRecordsForExport = loadCompleteDnsRecordsForExport;
DNSManager.loadAuthoritativeDnsRecordsForTopology =
  loadAuthoritativeDnsRecordsForTopology;
DNSManager.limitRestoredTabIds = limitRestoredTabIds;
DNSManager.appendBoundedZoneTab = appendBoundedZoneTab;
DNSManager.evictInactiveTabRecords = evictInactiveTabRecords;
DNSManager.createCompletionScheduledPoller = createCompletionScheduledPoller;
DNSManager.createRequestGenerationTracker = createRequestGenerationTracker;
DNSManager.DNS_RECORD_MEMORY_LIMIT = DNS_RECORD_MEMORY_LIMIT;
DNSManager.DNS_RECORD_RENDER_LIMIT = DNS_RECORD_RENDER_LIMIT;
DNSManager.DNS_API_PAGE_SIZE_LIMIT = DNS_API_PAGE_SIZE_LIMIT;
DNSManager.DNS_EXPORT_RECORD_LIMIT = DNS_EXPORT_RECORD_LIMIT;
DNSManager.DNS_EXPORT_ESTIMATED_BYTE_LIMIT = DNS_EXPORT_ESTIMATED_BYTE_LIMIT;
DNSManager.DNS_OPEN_ZONE_TAB_LIMIT = DNS_OPEN_ZONE_TAB_LIMIT;
DNSManager.DNS_TOPOLOGY_RECORD_LIMIT = DNS_TOPOLOGY_RECORD_LIMIT;
DNSManager.DNS_TOPOLOGY_SCAN_PAGE_LIMIT = DNS_TOPOLOGY_SCAN_PAGE_LIMIT;
