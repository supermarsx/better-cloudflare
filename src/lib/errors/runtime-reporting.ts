import {
  RESOURCE_LIMITS,
  truncateUtf8,
  utf8ByteLength,
} from "@/lib/resource-limits";

export type RuntimeErrorSource =
  | "react-boundary"
  | "next-route"
  | "next-global"
  | "global-error"
  | "unhandled-rejection"
  | "runtime";

export interface RuntimeErrorContext {
  source?: RuntimeErrorSource;
  label?: string;
  componentStack?: string;
  /**
   * Some user actions must remain individually traceable even when they
   * repeat a recently reported bootstrap failure.
   */
  deduplicate?: boolean;
  /**
   * Allow a caller that owns the user-facing toast to record a diagnostic
   * without also producing a second global toast.
   */
  notifyListeners?: boolean;
}

export interface RuntimeDiagnostic {
  id: string;
  fingerprint: string;
  source: RuntimeErrorSource;
  label?: string;
  name: string;
  message: string;
  code?: string;
  stack?: string;
  componentStack?: string;
  timestamp: string;
  lastSeenAt: string;
  occurrences: number;
}

export interface RuntimeReportResult {
  diagnostic: RuntimeDiagnostic;
  duplicate: boolean;
}

type RuntimeReportListener = (diagnostic: RuntimeDiagnostic) => void;

export const RUNTIME_REPORT_DEDUPLICATION_WINDOW_MS = 10_000;

let diagnosticCounter = 0;
let dispatching = false;
const listeners = new Set<RuntimeReportListener>();
const diagnostics: RuntimeDiagnostic[] = [];
const recentByFingerprint = new Map<
  string,
  { lastSeen: number; diagnostic: RuntimeDiagnostic }
>();

interface InstalledGlobalHandlers {
  references: number;
  onError: EventListener;
  onUnhandledRejection: EventListener;
}

const installedGlobalHandlers = new WeakMap<Window, InstalledGlobalHandlers>();

function redactRuntimeSecrets(value: string): string {
  return value
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
      "$1[redacted]@",
    )
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted-jwt]",
    )
    .replace(
      /\bBearer\s+(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;&}]+)/gi,
      "Bearer [redacted]",
    )
    .replace(
      /(["']?)(authorization|proxy[-_ ]?authorization|api[-_ ]?(?:key|token)|x[-_ ]?auth[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret|password|cookie|set[-_ ]?cookie)\1\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;&}]+)/gi,
      "$2=[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|auth|cookie)=)[^&#\s]+/gi,
      "$1[redacted]",
    );
}

function isSecretFieldName(value: string): boolean {
  return /^(?:authorization|proxy[-_ ]?authorization|api[-_ ]?(?:key|token)|x[-_ ]?auth[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret|password|cookie|set[-_ ]?cookie)$/i.test(
    value,
  );
}

function boundedUntrustedInput(value: string, maxBytes: number): string {
  const redacted = redactRuntimeSecrets(value);
  const bounded = truncateUtf8(redacted, maxBytes);
  if (bounded.length === redacted.length) return bounded;

  const marker = "[truncated]";
  const markerBytes = utf8ByteLength(marker);
  if (maxBytes <= markerBytes) return truncateUtf8(marker, maxBytes);
  const withoutPartialToken = bounded.replace(/\S*$/u, "");
  return `${truncateUtf8(withoutPartialToken, maxBytes - markerBytes)}${marker}`;
}

interface SerializationState {
  readonly seen: WeakSet<object>;
  nodes: number;
  remainingStringBytes: number;
}

function consumeSerializedString(
  value: string,
  state: SerializationState,
): string {
  if (state.remainingStringBytes <= 0) return "[truncated]";
  const bounded = boundedUntrustedInput(value, state.remainingStringBytes);
  state.remainingStringBytes -= utf8ByteLength(bounded);
  return bounded;
}

function boundedSerializable(
  value: unknown,
  depth: number,
  state: SerializationState,
): unknown {
  if (state.nodes >= RESOURCE_LIMITS.runtimeDiagnostics.serializationMaxNodes) {
    return "[truncated]";
  }
  state.nodes += 1;

  if (typeof value === "string") {
    return consumeSerializedString(value, state);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return "[bigint]";
  }
  if (typeof value === "symbol") {
    const description = value.description
      ? consumeSerializedString(value.description, state)
      : "";
    return description ? `[symbol ${description}]` : "[symbol]";
  }
  if (typeof value === "function") {
    const name = value.name
      ? consumeSerializedString(value.name, state)
      : "anonymous";
    return `[function ${name}]`;
  }
  if (value === undefined) return undefined;
  if (depth >= RESOURCE_LIMITS.runtimeDiagnostics.serializationMaxDepth) {
    return "[max-depth]";
  }
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value);

  if (value instanceof Date) {
    try {
      return consumeSerializedString(value.toISOString(), state);
    } catch {
      return "[invalid-date]";
    }
  }

  const maxEntries = RESOURCE_LIMITS.runtimeDiagnostics.serializationMaxEntries;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const retainedLength = Math.min(value.length, maxEntries);
    for (let index = 0; index < retainedLength; index += 1) {
      try {
        result.push(boundedSerializable(value[index], depth + 1, state));
      } catch {
        result.push("[unreadable]");
      }
    }
    if (value.length > retainedLength) {
      result.push(`[${value.length - retainedLength} more items]`);
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  let retainedEntries = 0;
  try {
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (retainedEntries >= maxEntries) {
        result["[truncated]"] = "additional properties omitted";
        break;
      }
      const safeKey = consumeSerializedString(key, state);
      try {
        result[safeKey] = isSecretFieldName(key)
          ? "[redacted]"
          : boundedSerializable(
              (value as Record<string, unknown>)[key],
              depth + 1,
              state,
            );
      } catch {
        result[safeKey] = "[unreadable]";
      }
      retainedEntries += 1;
    }
  } catch {
    return "[unserializable value]";
  }
  return result;
}

function safeString(value: unknown): string {
  const serializedLimit =
    RESOURCE_LIMITS.runtimeDiagnostics.serializedTraceHardBytes;
  if (typeof value === "string") {
    return boundedUntrustedInput(value, serializedLimit);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return "[bigint]";
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  try {
    const serialized = JSON.stringify(
      boundedSerializable(value, 0, {
        seen: new WeakSet<object>(),
        nodes: 0,
        remainingStringBytes: serializedLimit,
      }),
    );
    if (typeof serialized === "string") {
      return boundedUntrustedInput(serialized, serializedLimit);
    }
  } catch {
    return "[unserializable value]";
  }
  return "[unserializable value]";
}

export function sanitizeRuntimeText(
  value: unknown,
  maxBytes: number = RESOURCE_LIMITS.runtimeDiagnostics.messageHardBytes,
): string {
  const redacted = redactRuntimeSecrets(safeString(value)).replace(/\s+$/g, "");
  return truncateUtf8(redacted, maxBytes);
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
}

function diagnosticParts(error: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  const record = errorRecord(error);
  const name =
    error instanceof Error
      ? error.name || "Error"
      : typeof record?.name === "string"
        ? record.name
        : "RuntimeError";
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof record?.message === "string"
          ? record.message
          : safeString(error);
  const rawCode =
    typeof record?.code === "string" || typeof record?.code === "number"
      ? String(record.code)
      : typeof record?.digest === "string"
        ? record.digest
        : undefined;
  const rawStack =
    error instanceof Error
      ? error.stack
      : typeof record?.stack === "string"
        ? record.stack
        : undefined;

  return {
    name: sanitizeRuntimeText(name, 120) || "RuntimeError",
    message:
      sanitizeRuntimeText(
        rawMessage,
        RESOURCE_LIMITS.runtimeDiagnostics.messageHardBytes,
      ) || "An unexpected runtime error occurred.",
    ...(rawCode
      ? { code: sanitizeRuntimeText(rawCode, 120) || undefined }
      : {}),
    ...(rawStack
      ? {
          stack:
            sanitizeRuntimeText(
              rawStack,
              RESOURCE_LIMITS.runtimeDiagnostics.stackHardBytes,
            ) || undefined,
        }
      : {}),
  };
}

function fingerprintFor(parts: ReturnType<typeof diagnosticParts>): string {
  const firstStackLine = parts.stack?.split("\n", 2)[1]?.trim() ?? "";
  const input = truncateUtf8(
    [parts.name, parts.message, parts.code ?? "", firstStackLine].join("|"),
    RESOURCE_LIMITS.runtimeDiagnostics.fingerprintInputHardBytes,
  );
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function nextDiagnosticId(): string {
  diagnosticCounter = (diagnosticCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `runtime-${Date.now().toString(36)}-${diagnosticCounter.toString(36)}`;
}

function pruneExpiredFingerprints(now: number): void {
  for (const [fingerprint, recent] of recentByFingerprint) {
    if (now - recent.lastSeen > RUNTIME_REPORT_DEDUPLICATION_WINDOW_MS) {
      recentByFingerprint.delete(fingerprint);
    }
  }
}

function evictOldestFingerprint(): void {
  let oldestFingerprint: string | undefined;
  let oldestSeen = Infinity;
  for (const [fingerprint, recent] of recentByFingerprint) {
    if (recent.lastSeen < oldestSeen) {
      oldestSeen = recent.lastSeen;
      oldestFingerprint = fingerprint;
    }
  }
  if (!oldestFingerprint) return;
  const recent = recentByFingerprint.get(oldestFingerprint);
  recentByFingerprint.delete(oldestFingerprint);
  if (!recent) return;
  const diagnosticIndex = diagnostics.indexOf(recent.diagnostic);
  if (diagnosticIndex >= 0) diagnostics.splice(diagnosticIndex, 1);
}

function enforceFingerprintCapacity(): void {
  while (
    recentByFingerprint.size >
    RESOURCE_LIMITS.runtimeDiagnostics.recentFingerprintsHard
  ) {
    evictOldestFingerprint();
  }
}

function removeDiagnosticFingerprint(diagnostic: RuntimeDiagnostic): void {
  const recent = recentByFingerprint.get(diagnostic.fingerprint);
  if (recent?.diagnostic === diagnostic) {
    recentByFingerprint.delete(diagnostic.fingerprint);
  }
}

function notifyRuntimeReportListeners(
  diagnostic: RuntimeDiagnostic,
  context: RuntimeErrorContext,
): void {
  if (context.notifyListeners === false || dispatching) return;

  dispatching = true;
  try {
    for (const listener of listeners) {
      try {
        listener(diagnostic);
      } catch {
        // Reporting must never create another runtime failure loop.
      }
    }
  } finally {
    dispatching = false;
  }
}

export function createRuntimeDiagnostic(
  error: unknown,
  context: RuntimeErrorContext = {},
): RuntimeDiagnostic {
  const parts = diagnosticParts(error);
  const now = new Date().toISOString();
  const normalizedContext = {
    source: context.source ?? "runtime",
    label: context.label
      ? sanitizeRuntimeText(context.label, 160) || undefined
      : undefined,
    componentStack: context.componentStack
      ? sanitizeRuntimeText(
          context.componentStack,
          RESOURCE_LIMITS.runtimeDiagnostics.componentStackHardBytes,
        ) || undefined
      : undefined,
  };

  return {
    id: nextDiagnosticId(),
    fingerprint: fingerprintFor(parts),
    source: normalizedContext.source,
    ...(normalizedContext.label ? { label: normalizedContext.label } : {}),
    name: parts.name,
    message: parts.message,
    ...(parts.code ? { code: parts.code } : {}),
    ...(parts.stack ? { stack: parts.stack } : {}),
    ...(normalizedContext.componentStack
      ? { componentStack: normalizedContext.componentStack }
      : {}),
    timestamp: now,
    lastSeenAt: now,
    occurrences: 1,
  };
}

export function formatRuntimeDiagnostic(diagnostic: RuntimeDiagnostic): string {
  return [
    `Diagnostic ID: ${diagnostic.id}`,
    `Time: ${diagnostic.timestamp}`,
    `Source: ${diagnostic.source}`,
    diagnostic.label ? `Area: ${diagnostic.label}` : "",
    `Error: ${diagnostic.name}`,
    diagnostic.code ? `Code: ${diagnostic.code}` : "",
    `Message: ${diagnostic.message}`,
    diagnostic.occurrences > 1
      ? `Occurrences: ${diagnostic.occurrences} (last ${diagnostic.lastSeenAt})`
      : "",
    diagnostic.stack ? `Stack:\n${diagnostic.stack}` : "",
    diagnostic.componentStack
      ? `Component stack:\n${diagnostic.componentStack}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function copyRuntimeDiagnostic(
  diagnostic: RuntimeDiagnostic,
): Promise<boolean> {
  const text = formatRuntimeDiagnostic(diagnostic);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Continue to the DOM fallback without reporting another runtime error.
  }

  try {
    if (typeof document === "undefined") return false;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied =
      typeof document.execCommand === "function"
        ? document.execCommand("copy")
        : false;
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export function reportRuntimeError(
  error: unknown,
  context: RuntimeErrorContext = {},
): RuntimeReportResult {
  const candidate = createRuntimeDiagnostic(error, context);
  const now = Date.now();
  pruneExpiredFingerprints(now);
  const recent = recentByFingerprint.get(candidate.fingerprint);

  if (
    context.deduplicate !== false &&
    recent &&
    now - recent.lastSeen <= RUNTIME_REPORT_DEDUPLICATION_WINDOW_MS
  ) {
    recent.lastSeen = now;
    recent.diagnostic.occurrences = Math.min(
      recent.diagnostic.occurrences + 1,
      Number.MAX_SAFE_INTEGER,
    );
    recent.diagnostic.lastSeenAt = candidate.lastSeenAt;
    notifyRuntimeReportListeners(recent.diagnostic, context);
    return { diagnostic: recent.diagnostic, duplicate: true };
  }

  diagnostics.unshift(candidate);
  const isSilentNonDeduplicatingReport =
    context.deduplicate === false && context.notifyListeners === false;
  if (!isSilentNonDeduplicatingReport) {
    recentByFingerprint.set(candidate.fingerprint, {
      lastSeen: now,
      diagnostic: candidate,
    });
  }
  const evictedDiagnostics = diagnostics.splice(
    RESOURCE_LIMITS.runtimeDiagnostics.retainedCountHard,
  );
  for (const diagnostic of evictedDiagnostics) {
    removeDiagnosticFingerprint(diagnostic);
  }
  enforceFingerprintCapacity();

  notifyRuntimeReportListeners(candidate, context);

  return { diagnostic: candidate, duplicate: false };
}

export function subscribeRuntimeReports(
  listener: RuntimeReportListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRuntimeDiagnostics(): readonly RuntimeDiagnostic[] {
  return diagnostics;
}

export function installGlobalRuntimeReporting(
  target: Window = window,
): () => void {
  const existing = installedGlobalHandlers.get(target);
  if (existing) {
    existing.references += 1;
    return () => {
      existing.references -= 1;
      if (existing.references > 0) return;
      target.removeEventListener("error", existing.onError);
      target.removeEventListener(
        "unhandledrejection",
        existing.onUnhandledRejection,
      );
      installedGlobalHandlers.delete(target);
    };
  }

  const onError: EventListener = (event) => {
    const errorEvent = event as ErrorEvent;
    reportRuntimeError(errorEvent.error ?? errorEvent.message, {
      source: "global-error",
      label: errorEvent.filename
        ? `${errorEvent.filename}:${errorEvent.lineno}:${errorEvent.colno}`
        : "window",
    });
  };
  const onUnhandledRejection: EventListener = (event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    reportRuntimeError(rejectionEvent.reason, {
      source: "unhandled-rejection",
      label: "promise",
    });
  };

  const installed: InstalledGlobalHandlers = {
    references: 1,
    onError,
    onUnhandledRejection,
  };
  installedGlobalHandlers.set(target, installed);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    installed.references -= 1;
    if (installed.references > 0) return;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
    installedGlobalHandlers.delete(target);
  };
}

export function resetRuntimeReportingForTests(): void {
  diagnostics.splice(0);
  recentByFingerprint.clear();
  listeners.clear();
  diagnosticCounter = 0;
  dispatching = false;
}
