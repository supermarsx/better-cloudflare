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

const MAX_MESSAGE_LENGTH = 1200;
const MAX_STACK_LENGTH = 6000;
const MAX_COMPONENT_STACK_LENGTH = 4000;
const MAX_DIAGNOSTICS = 30;
const DEDUPLICATION_WINDOW_MS = 10_000;
const MAX_RECENT_FINGERPRINTS = 100;

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

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[circular]";
        seen.add(nested);
      }
      if (typeof nested === "bigint") return String(nested);
      if (typeof nested === "symbol") return String(nested);
      if (typeof nested === "function")
        return `[function ${nested.name || "anonymous"}]`;
      return nested;
    });
    if (typeof serialized === "string") return serialized;
  } catch {
    // Fall through to bounded string coercion.
  }
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unserializable value]";
    }
  }
}

export function sanitizeRuntimeText(
  value: unknown,
  maxLength = MAX_MESSAGE_LENGTH,
): string {
  return safeString(value)
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
      "$1[redacted]@",
    )
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[redacted-jwt]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(["']?)(authorization|proxy[-_ ]?authorization|api[-_ ]?(?:key|token)|x[-_ ]?auth[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret|password|cookie|set[-_ ]?cookie)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$2=[redacted]",
    )
    .replace(
      /([?&](?:api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(/\s+$/g, "")
    .slice(0, Math.max(0, maxLength));
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
      sanitizeRuntimeText(rawMessage, MAX_MESSAGE_LENGTH) ||
      "An unexpected runtime error occurred.",
    ...(rawCode
      ? { code: sanitizeRuntimeText(rawCode, 120) || undefined }
      : {}),
    ...(rawStack
      ? { stack: sanitizeRuntimeText(rawStack, MAX_STACK_LENGTH) || undefined }
      : {}),
  };
}

function fingerprintFor(parts: ReturnType<typeof diagnosticParts>): string {
  const firstStackLine = parts.stack?.split("\n", 2)[1]?.trim() ?? "";
  const input = [
    parts.name,
    parts.message,
    parts.code ?? "",
    firstStackLine,
  ].join("|");
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

function pruneRecentFingerprints(now: number): void {
  for (const [fingerprint, recent] of recentByFingerprint) {
    if (now - recent.lastSeen > DEDUPLICATION_WINDOW_MS) {
      recentByFingerprint.delete(fingerprint);
    }
  }

  while (recentByFingerprint.size >= MAX_RECENT_FINGERPRINTS) {
    let oldestFingerprint: string | undefined;
    let oldestSeen = Infinity;
    for (const [fingerprint, recent] of recentByFingerprint) {
      if (recent.lastSeen < oldestSeen) {
        oldestSeen = recent.lastSeen;
        oldestFingerprint = fingerprint;
      }
    }
    if (!oldestFingerprint) break;
    recentByFingerprint.delete(oldestFingerprint);
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
          MAX_COMPONENT_STACK_LENGTH,
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
  pruneRecentFingerprints(now);
  const recent = recentByFingerprint.get(candidate.fingerprint);

  if (recent && now - recent.lastSeen <= DEDUPLICATION_WINDOW_MS) {
    recent.lastSeen = now;
    recent.diagnostic.occurrences += 1;
    recent.diagnostic.lastSeenAt = candidate.lastSeenAt;
    return { diagnostic: recent.diagnostic, duplicate: true };
  }

  diagnostics.unshift(candidate);
  diagnostics.splice(MAX_DIAGNOSTICS);
  recentByFingerprint.set(candidate.fingerprint, {
    lastSeen: now,
    diagnostic: candidate,
  });

  if (!dispatching) {
    dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener(candidate);
        } catch {
          // Reporting must never create another runtime failure loop.
        }
      }
    } finally {
      dispatching = false;
    }
  }

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
