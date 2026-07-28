export type RequestErrorKind =
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "malformed-response"
  | "validation"
  | "configuration"
  | "unknown";

export type RequestErrorSource =
  | "browser"
  | "client"
  | "server"
  | "cloudflare"
  | "tauri"
  | "unknown";

export interface RequestErrorContext {
  endpoint?: string;
  requestUrl?: string;
  operation?: string;
  command?: string;
  source?: RequestErrorSource;
  timedOut?: boolean;
}

export interface ProviderErrorDetail {
  code?: string;
  message?: string;
}

export interface RequestErrorMetadata {
  source?: RequestErrorSource;
  endpoint?: string;
  requestUrl?: string;
  operation?: string;
  command?: string;
  status?: number;
  statusText?: string;
  code?: string;
  requestId?: string;
  retryAfter?: string;
  retryable?: boolean;
  diagnosticId?: string;
  providerErrors?: readonly ProviderErrorDetail[];
}

const MAX_DETAIL_LENGTH = 320;
const MAX_PROVIDER_DETAIL_LENGTH = 240;
const MAX_PROVIDER_ERRORS = 5;
const MAX_ENDPOINT_LENGTH = 160;
const MAX_OPERATION_LENGTH = 80;
const MAX_COMMAND_LENGTH = 80;
const MAX_HEADER_VALUE_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function redact(value: string, maxLength = MAX_DETAIL_LENGTH): string {
  return value
    .replace(
      /([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|auth|cookie)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(["']?)(authorization|proxy[-_ ]?authorization|api[-_ ]?(?:key|token)|x[-_ ]?auth[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret|password|cookie|set[-_ ]?cookie)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      "$2=[redacted]",
    )
    .replace(/\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-jwt]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const withoutQuery = endpoint.split(/[?#]/, 1)[0];
  return redact(withoutQuery, MAX_ENDPOINT_LENGTH) || undefined;
}

function safeRequestUrl(requestUrl?: string): string | undefined {
  if (!requestUrl) return undefined;
  try {
    const url = new URL(requestUrl, "http://local.invalid");
    const origin =
      url.origin === "http://local.invalid"
        ? ""
        : `${url.protocol}//${url.host}`;
    return `${origin}${url.pathname}`.slice(0, MAX_ENDPOINT_LENGTH);
  } catch {
    return safeEndpoint(requestUrl);
  }
}

function safeLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = redact(value, maxLength);
  return normalized || undefined;
}

function safeOperation(operation?: string): string | undefined {
  return safeLabel(operation, MAX_OPERATION_LENGTH);
}

function safeCommand(command?: string): string | undefined {
  return safeLabel(command, MAX_COMMAND_LENGTH);
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value);
  return /^[\w.-]{1,64}$/.test(code) ? code : undefined;
}

function safeStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function safeHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return redact(String(value), MAX_HEADER_VALUE_LENGTH) || undefined;
}

function endpointSuffix(endpoint?: string): string {
  const safe = safeEndpoint(endpoint);
  return safe ? ` (${safe})` : "";
}

function retryableFor(kind: RequestErrorKind, status?: number): boolean {
  if (
    kind === "network" ||
    kind === "timeout" ||
    kind === "malformed-response"
  ) {
    return true;
  }
  if (kind !== "http" || status === undefined) return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sourceFor(kind: RequestErrorKind): RequestErrorSource {
  if (kind === "network") return "browser";
  if (
    kind === "timeout" ||
    kind === "aborted" ||
    kind === "validation" ||
    kind === "configuration"
  ) {
    return "client";
  }
  if (kind === "http" || kind === "malformed-response") return "server";
  return "unknown";
}

function createDiagnosticId(): string {
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `REQ-${Date.now().toString(36).toUpperCase()}-${random.toUpperCase()}`;
}

function validationDetail(error: unknown): string | undefined {
  if (!isRecord(error) || !Array.isArray(error.issues)) return undefined;
  const details = error.issues
    .slice(0, 3)
    .map((issue) => {
      if (!isRecord(issue) || typeof issue.message !== "string") return "";
      const path = Array.isArray(issue.path)
        ? issue.path
            .filter(
              (part) => typeof part === "string" || typeof part === "number",
            )
            .join(".")
        : "";
      return `${path ? `${path}: ` : ""}${issue.message}`;
    })
    .filter(Boolean)
    .join("; ");
  return details ? redact(details) : undefined;
}

function candidateRecords(error: unknown): Record<string, unknown>[] {
  if (!isRecord(error)) return [];
  const records = [error];
  for (const key of ["error", "cause", "data"]) {
    if (isRecord(error[key])) records.push(error[key]);
  }
  return records;
}

function firstField(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function rawDetail(error: unknown): string | undefined {
  if (typeof error === "string") return redact(error);
  if (error instanceof Error && error.message) return redact(error.message);
  const records = candidateRecords(error);
  for (const record of records) {
    for (const key of ["message", "error", "detail", "reason", "description"]) {
      const value = record[key];
      if (typeof value === "string") return redact(value);
      if (typeof value === "number" || typeof value === "boolean") {
        return redact(String(value));
      }
    }
  }
  return undefined;
}

function metadataFromUnknown(error: unknown): RequestErrorMetadata {
  const records = candidateRecords(error);
  const sourceValue = firstField(records, ["source"]);
  const source =
    sourceValue === "browser" ||
    sourceValue === "client" ||
    sourceValue === "server" ||
    sourceValue === "cloudflare" ||
    sourceValue === "tauri"
      ? sourceValue
      : undefined;
  return {
    source,
    status: safeStatus(firstField(records, ["status", "statusCode"])),
    statusText: safeLabel(
      firstField(records, ["statusText", "status_message"]) as
        | string
        | undefined,
      MAX_HEADER_VALUE_LENGTH,
    ),
    code: safeCode(firstField(records, ["code", "errorCode"])),
    command: safeCommand(
      firstField(records, ["command", "cmd"]) as string | undefined,
    ),
    requestId: safeHeaderValue(
      firstField(records, [
        "requestId",
        "request_id",
        "cfRay",
        "cf_ray",
        "traceId",
        "trace_id",
      ]),
    ),
    retryAfter: safeHeaderValue(
      firstField(records, ["retryAfter", "retry_after"]),
    ),
  };
}

function joinDetail(message: string, detail?: string): string {
  if (!detail) return message;
  const punctuation = /[.!?]$/.test(message) ? "" : ".";
  return `${message}${punctuation} Server detail: ${detail}`;
}

function statusMessage(
  status: number,
  statusText?: string,
  detail?: string,
): string {
  const statusLabel = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  if (status === 401) {
    return joinDetail(
      `Authentication was rejected (${statusLabel}). Check that the API token or key is current and that the email matches global-key authentication`,
      detail,
    );
  }
  if (status === 403) {
    return joinDetail(
      `Cloudflare or the configured backend denied this operation (${statusLabel}). Check token permissions, account access, and key/email pairing`,
      detail,
    );
  }
  if (status === 404) {
    return joinDetail(
      `The configured backend endpoint was not found (${statusLabel}). Check the public API base URL and ensure the backend version provides this route`,
      detail,
    );
  }
  if (status === 429) {
    return joinDetail(
      `The service rate limit was reached (${statusLabel}). Wait before retrying`,
      detail,
    );
  }
  if (status >= 500) {
    return joinDetail(
      `The backend or upstream service failed (${statusLabel}). Retry shortly; if it continues, inspect the request ID and server logs`,
      detail,
    );
  }
  return joinDetail(`Request failed (${statusLabel})`, detail);
}

export class RequestError extends Error {
  readonly name = "RequestError";
  readonly source: RequestErrorSource;
  readonly endpoint?: string;
  readonly requestUrl?: string;
  readonly operation?: string;
  readonly command?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryAfter?: string;
  readonly retryable: boolean;
  readonly diagnosticId?: string;
  readonly providerErrors: readonly Readonly<ProviderErrorDetail>[];
  readonly providerCodes: readonly string[];
  readonly providerMessages: readonly string[];
  readonly context: Readonly<RequestErrorMetadata>;

  constructor(
    readonly kind: RequestErrorKind,
    message: string,
    context: RequestErrorMetadata = {},
    options?: ErrorOptions,
  ) {
    super(redact(message, 640), options);
    this.source = context.source ?? sourceFor(kind);
    this.endpoint = safeEndpoint(context.endpoint);
    this.requestUrl = safeRequestUrl(context.requestUrl);
    this.operation = safeOperation(context.operation);
    this.command = safeCommand(context.command);
    this.status = safeStatus(context.status);
    this.statusText = safeLabel(context.statusText, MAX_HEADER_VALUE_LENGTH);
    this.requestId = safeHeaderValue(context.requestId);
    this.retryAfter = safeHeaderValue(context.retryAfter);
    this.providerErrors = Object.freeze(
      (context.providerErrors ?? []).slice(0, MAX_PROVIDER_ERRORS).map((item) =>
        Object.freeze({
          ...(safeCode(item.code) ? { code: safeCode(item.code) } : {}),
          ...(typeof item.message === "string" && item.message
            ? {
                message: redact(item.message, MAX_PROVIDER_DETAIL_LENGTH),
              }
            : {}),
        }),
      ),
    );
    this.code =
      safeCode(context.code) ??
      this.providerErrors.find((item) => item.code)?.code;
    this.retryable = context.retryable ?? retryableFor(this.kind, this.status);
    this.diagnosticId =
      safeHeaderValue(context.diagnosticId) ??
      (kind === "unknown" ? createDiagnosticId() : undefined);
    this.providerCodes = Object.freeze(
      this.providerErrors.flatMap((item) => (item.code ? [item.code] : [])),
    );
    this.providerMessages = Object.freeze(
      this.providerErrors.flatMap((item) =>
        item.message ? [item.message] : [],
      ),
    );
    this.context = Object.freeze({
      source: this.source,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      ...(this.requestUrl ? { requestUrl: this.requestUrl } : {}),
      ...(this.operation ? { operation: this.operation } : {}),
      ...(this.command ? { command: this.command } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.statusText ? { statusText: this.statusText } : {}),
      ...(this.code ? { code: this.code } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}),
      retryable: this.retryable,
      ...(this.diagnosticId ? { diagnosticId: this.diagnosticId } : {}),
      ...(this.providerErrors.length
        ? { providerErrors: this.providerErrors }
        : {}),
    });
  }
}

export function backendConfigurationError(detail?: string): RequestError {
  return new RequestError(
    "configuration",
    joinDetail(
      "The web API backend is not configured. Set NEXT_PUBLIC_SERVER_API_BASE to an HTTP(S) backend that exposes the Better Cloudflare API, then rebuild the static web app",
      detail ? redact(detail) : undefined,
    ),
    {
      source: "client",
      operation: "configure backend",
      retryable: false,
    },
  );
}

export function normalizeRequestError(
  error: unknown,
  context: RequestErrorContext = {},
): RequestError {
  if (error instanceof RequestError) return error;

  const endpoint = safeEndpoint(context.endpoint);
  const requestUrl = safeRequestUrl(context.requestUrl);
  const operation = safeOperation(context.operation);
  const command = safeCommand(context.command);
  const extracted = metadataFromUnknown(error);
  const source = context.source ?? extracted.source;
  const detail = rawDetail(error);
  const records = candidateRecords(error);
  const name =
    error instanceof Error
      ? error.name
      : (safeLabel(firstField(records, ["name"]) as string | undefined, 80) ??
        "");
  const code = extracted.code ?? "";
  const common = {
    source,
    endpoint,
    requestUrl,
    operation,
    command: command ?? extracted.command,
    status: extracted.status,
    statusText: extracted.statusText,
    code: extracted.code,
    requestId: extracted.requestId,
    retryAfter: extracted.retryAfter,
  };

  if (context.timedOut || name === "TimeoutError" || code === "ETIMEDOUT") {
    return new RequestError(
      "timeout",
      `Request timed out. Check connectivity and backend availability, then try again.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "client", retryable: true },
      { cause: error },
    );
  }

  if (
    name === "AbortError" ||
    name === "CanceledError" ||
    name === "CancelledError" ||
    code === "ERR_CANCELED"
  ) {
    return new RequestError(
      "aborted",
      `Request was cancelled. Retry when you are ready.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "client", retryable: false },
      { cause: error },
    );
  }

  const invalid = validationDetail(error);
  if (invalid) {
    return new RequestError(
      "validation",
      `Invalid input: ${invalid}`,
      { ...common, source: source ?? "client", retryable: false },
      { cause: error },
    );
  }

  if (extracted.status !== undefined) {
    return new RequestError(
      "http",
      statusMessage(extracted.status, extracted.statusText, detail),
      {
        ...common,
        source: source ?? "server",
        retryable: retryableFor("http", extracted.status),
      },
      { cause: error },
    );
  }

  const normalizedDetail = detail?.toLowerCase() ?? "";
  const browserReportsOffline =
    typeof navigator !== "undefined" && navigator.onLine === false;
  if (
    browserReportsOffline ||
    /err_internet_disconnected|device is offline|network is offline|not connected to (?:the )?internet/.test(
      normalizedDetail,
    )
  ) {
    return new RequestError(
      "network",
      `This device appears to be offline. Restore network connectivity, then retry.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "browser", retryable: true },
      { cause: error },
    );
  }
  if (
    code === "ECONNREFUSED" ||
    /(?:connection|connect).*(?:refused|actively refused)|econnrefused/.test(
      normalizedDetail,
    )
  ) {
    return new RequestError(
      "network",
      `The backend refused the connection. Confirm the configured server is running and reachable.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "browser", retryable: true },
      { cause: error },
    );
  }
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /(?:dns|name resolution|getaddrinfo|host not found)/.test(normalizedDetail)
  ) {
    return new RequestError(
      "network",
      `The backend hostname could not be resolved. Check the configured server address and DNS connectivity.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "browser", retryable: true },
      { cause: error },
    );
  }
  if (
    /(?:certificate|cert_|tls|ssl|self[- ]signed|secure connection)/.test(
      normalizedDetail,
    )
  ) {
    return new RequestError(
      "network",
      `A TLS or certificate error prevented a secure connection. Check the backend URL, certificate chain, and system clock.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "browser", retryable: true },
      { cause: error },
    );
  }
  if (/cors|cross-origin|access-control-allow-origin/.test(normalizedDetail)) {
    return new RequestError(
      "network",
      `The browser blocked the request because of CORS policy. Allow this app origin on the configured backend.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "browser", retryable: false },
      { cause: error },
    );
  }

  const isKnownNetworkFailure =
    /^(failed to fetch|fetch failed|load failed|network error|network request failed|networkerror when attempting to fetch resource\.?)$/i.test(
      detail?.trim() ?? "",
    );
  if (
    error instanceof TypeError ||
    name === "TypeError" ||
    code === "ERR_NETWORK" ||
    isKnownNetworkFailure
  ) {
    return new RequestError(
      "network",
      `The browser could not complete the request. Browser fetch errors hide whether the cause is offline connectivity, DNS, TLS, CORS, or a stopped backend; check those in that order.${endpointSuffix(endpoint)}`,
      { ...common, source: source ?? "browser", retryable: true },
      { cause: error },
    );
  }

  if (
    /invalid (?:api )?(?:key|token)|authentication failed|unauthori[sz]ed|forbidden/.test(
      normalizedDetail,
    )
  ) {
    return new RequestError(
      "http",
      joinDetail(
        "Cloudflare rejected the supplied credentials. Check the token or key, required permissions, and email for global-key authentication",
        detail,
      ),
      { ...common, source: source ?? "cloudflare", retryable: false },
      { cause: error },
    );
  }

  const diagnosticId = createDiagnosticId();
  return new RequestError(
    "unknown",
    `${joinDetail(
      "The request failed unexpectedly",
      detail,
    )}. Diagnostic ID: ${diagnosticId}`,
    {
      ...common,
      source: source ?? "unknown",
      retryable: false,
      diagnosticId,
    },
    { cause: error },
  );
}

interface ErrorPayloadDetail {
  detail?: string;
  code?: string;
  source: RequestErrorSource;
  providerErrors: ProviderErrorDetail[];
}

function errorDetail(payload: unknown): ErrorPayloadDetail {
  if (typeof payload === "string") {
    return { detail: redact(payload), source: "server", providerErrors: [] };
  }
  if (!isRecord(payload)) {
    return { source: "server", providerErrors: [] };
  }
  if (Array.isArray(payload.errors)) {
    const providerErrors: ProviderErrorDetail[] = [];
    for (const item of payload.errors.slice(0, MAX_PROVIDER_ERRORS)) {
      if (!isRecord(item)) continue;
      const code = safeCode(item.code);
      const message =
        typeof item.message === "string"
          ? redact(item.message, MAX_PROVIDER_DETAIL_LENGTH)
          : undefined;
      if (code || message) providerErrors.push({ code, message });
    }
    if (providerErrors.length) {
      const parts = providerErrors.map(({ code, message }) => {
        if (code && message) return `${code}: ${message}`;
        return message ?? code!;
      });
      const omitted = Math.max(0, payload.errors.length - MAX_PROVIDER_ERRORS);
      if (omitted)
        parts.push(`and ${omitted} more error${omitted === 1 ? "" : "s"}`);
      return {
        detail: parts.join("; "),
        code: providerErrors.find((item) => item.code)?.code,
        source: "cloudflare",
        providerErrors,
      };
    }
  }
  for (const key of ["message", "error", "detail", "reason"]) {
    if (typeof payload[key] === "string") {
      return {
        detail: redact(payload[key]),
        code: safeCode(payload.code),
        source: "server",
        providerErrors: [],
      };
    }
  }
  return {
    code: safeCode(payload.code),
    source: Array.isArray(payload.errors) ? "cloudflare" : "server",
    providerErrors: [],
  };
}

function responseHeader(response: Response, names: readonly string[]) {
  for (const name of names) {
    const value = response.headers.get(name);
    if (value) return safeHeaderValue(value);
  }
  return undefined;
}

export function requestErrorFromResponse(
  response: Response,
  endpoint: string,
  bodyText: string,
  operation?: string,
  requestUrl?: string,
): RequestError {
  const safePath = safeEndpoint(endpoint);
  let detail: string | undefined;
  let code: string | undefined;
  let source: RequestErrorSource = "server";
  let providerErrors: ProviderErrorDetail[] = [];
  if (bodyText) {
    try {
      ({ detail, code, source, providerErrors } = errorDetail(
        JSON.parse(bodyText),
      ));
    } catch {
      detail = redact(bodyText);
    }
  }
  return new RequestError(
    "http",
    statusMessage(response.status, response.statusText, detail),
    {
      source,
      endpoint: safePath,
      requestUrl,
      operation,
      status: response.status,
      statusText: response.statusText,
      code,
      requestId: responseHeader(response, [
        "cf-ray",
        "x-request-id",
        "x-correlation-id",
        "traceparent",
      ]),
      retryAfter: responseHeader(response, ["retry-after"]),
      retryable: retryableFor("http", response.status),
      providerErrors,
    },
  );
}

export function malformedResponseError(
  endpoint: string,
  cause: unknown,
  context: {
    operation?: string;
    status?: number;
    statusText?: string;
    requestUrl?: string;
    requestId?: string;
  } = {},
): RequestError {
  const safePath = safeEndpoint(endpoint);
  return new RequestError(
    "malformed-response",
    `The server returned invalid JSON for a successful response. Retry once; if it continues, use the request ID to inspect server logs.${endpointSuffix(safePath)}`,
    {
      source: "server",
      endpoint: safePath,
      requestUrl: context.requestUrl,
      operation: context.operation,
      status: context.status,
      statusText: context.statusText,
      requestId: context.requestId,
      retryable: true,
    },
    { cause },
  );
}

export function formatRequestError(error: unknown): string {
  const normalized = normalizeRequestError(error);
  const details = [
    normalized.source !== "unknown" ? `source ${normalized.source}` : "",
    normalized.command ? `command ${normalized.command}` : "",
    normalized.operation ? `operation ${normalized.operation}` : "",
    normalized.endpoint ? `endpoint ${normalized.endpoint}` : "",
    normalized.requestUrl ? `URL ${normalized.requestUrl}` : "",
    normalized.status !== undefined
      ? `status ${normalized.status}${normalized.statusText ? ` ${normalized.statusText}` : ""}`
      : "",
    normalized.code ? `code ${normalized.code}` : "",
    normalized.requestId ? `request ID ${normalized.requestId}` : "",
    normalized.retryAfter ? `retry after ${normalized.retryAfter}` : "",
    `retryable ${normalized.retryable ? "yes" : "no"}`,
  ].filter(Boolean);
  return details.length
    ? `${normalized.message} [${details.join("; ")}]`
    : normalized.message;
}
