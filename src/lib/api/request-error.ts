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
  | "network"
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
  remediation?: string;
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
const MAX_SERIALIZED_ERROR_LENGTH = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSerializedError(error: unknown): unknown {
  const candidate =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  if (!candidate || candidate.length > MAX_SERIALIZED_ERROR_LENGTH) {
    return error;
  }
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return error;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : error;
  } catch {
    return error;
  }
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

/**
 * Signals that a hostname genuinely failed to resolve.
 *
 * This deliberately does not match the bare substring `dns`. Better Cloudflare
 * manages DNS, so every legitimate record-level failure it reports contains
 * that substring — "DNS record validation failed…", "Authoritative DNS lookup
 * failed closed…", "DNS export format must be json, csv, or bind". Matching on
 * `dns` alone re-diagnosed all of them as name-resolution failures and replaced
 * the actionable text with "check your system DNS, VPN, firewall".
 *
 * Every alternative below is a resolver error code, a resolver API name, or a
 * fixed phrase a resolver emits — never a description of a DNS record:
 * libc/Node (`getaddrinfo`, `EAI_*`, `ENOTFOUND`, "Temporary failure in name
 * resolution", "nodename nor servname provided"), hyper/reqwest ("failed to
 * lookup address information"), Windows ("No such host is known"), curl
 * ("Could not resolve host"), Chromium (`ERR_NAME_NOT_RESOLVED`,
 * `DNS_PROBE_FINISHED_NXDOMAIN`), and this app's own transport error, whose
 * text is "dns failure contacting <host>…".
 */
const DNS_RESOLUTION_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EAI_NODATA",
  "EAI_FAIL",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
]);

const DNS_RESOLUTION_DETAIL =
  /\b(?:enotfound|eai_again|eai_noname|eai_nodata|eai_fail|nxdomain)\b|getaddrinfo|err_name_not_resolved|err_name_resolution_failed|dns_probe_finished|\bname resolution\b|\bdns resolution\b|\bdns (?:failure|failed)\b|lookup address information|nodename nor servname|\bno such host\b|\bhost(?:name)? not found\b|(?:could not|couldn't|cannot|can't|unable to|failed to) resolve (?:the )?(?:host|hostname|host name|domain|name|address)/;

/**
 * Signals that TLS itself failed, rather than prose that mentions TLS.
 *
 * Same trap as the resolution heuristic: `TLSA`, `CERT`, and `CAA` are DNS
 * record types this app builds and validates, so their help and validation
 * text is full of "TLSA content must be…", "CERT: certificate data is
 * required", and "checked by the certificate authority". Bare `tls`, `ssl`,
 * and `certificate` matched all of those. Word boundaries exclude `TLSA`, and
 * `certificate` now has to appear with an actual failure.
 */
const TLS_FAILURE_DETAIL =
  /\b(?:tls|ssl)\b|\bcert_[a-z_]+|\berr_cert[a-z_]*|self[- ]signed|secure connection|certificate (?:chain|verif\w+|expired|has expired|is not trusted|common name)|(?:invalid|untrusted|expired|unknown|bad|revoked)(?: [a-z]+){0,3} certificate|unable to (?:get|verify)(?: [a-z]+){0,4} certificate/;

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
  const records: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [error];
  const seen = new Set<Record<string, unknown>>();
  while (pending.length && records.length < 8) {
    const record = pending.shift()!;
    if (seen.has(record)) continue;
    seen.add(record);
    records.push(record);
    for (const key of ["error", "cause", "data", "details"]) {
      if (isRecord(record[key])) pending.push(record[key]);
    }
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

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requestKindFromUnknown(
  records: readonly Record<string, unknown>[],
): RequestErrorKind | undefined {
  const value = firstField(records, ["kind", "failure_kind"]);
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "authentication":
    case "rate_limited":
    case "provider":
      return "http";
    case "network":
      return "network";
    case "timeout":
      return "timeout";
    case "malformed_response":
      return "malformed-response";
    default:
      return undefined;
  }
}

function providerErrorsFromRecords(
  records: readonly Record<string, unknown>[],
): ProviderErrorDetail[] {
  for (const record of records) {
    const value = record.provider_errors ?? record.providerErrors;
    if (!Array.isArray(value)) continue;
    const parsed = value
      .slice(0, MAX_PROVIDER_ERRORS)
      .flatMap((item): ProviderErrorDetail[] => {
        if (!isRecord(item)) return [];
        const code = safeCode(item.code);
        const message =
          typeof item.message === "string"
            ? redact(item.message, MAX_PROVIDER_DETAIL_LENGTH)
            : undefined;
        return code || message ? [{ code, message }] : [];
      });
    if (parsed.length) return parsed;
  }

  const codeValue = firstField(records, ["provider_codes", "providerCodes"]);
  const messageValue = firstField(records, [
    "provider_messages",
    "providerMessages",
  ]);
  const codes = Array.isArray(codeValue)
    ? codeValue
        .slice(0, MAX_PROVIDER_ERRORS)
        .map(safeCode)
        .filter((value): value is string => Boolean(value))
    : [];
  const messages = Array.isArray(messageValue)
    ? messageValue
        .slice(0, MAX_PROVIDER_ERRORS)
        .map((value) =>
          typeof value === "string"
            ? redact(value, MAX_PROVIDER_DETAIL_LENGTH)
            : undefined,
        )
        .filter((value): value is string => Boolean(value))
    : [];
  return Array.from(
    {
      length: Math.min(
        MAX_PROVIDER_ERRORS,
        Math.max(codes.length, messages.length),
      ),
    },
    (_, index) => ({
      ...(codes[index] ? { code: codes[index] } : {}),
      ...(messages[index] ? { message: messages[index] } : {}),
    }),
  );
}

interface ExtractedRequestMetadata extends RequestErrorMetadata {
  kind?: RequestErrorKind;
}

function metadataFromUnknown(error: unknown): ExtractedRequestMetadata {
  const records = candidateRecords(error);
  const sourceValue = firstField(records, ["source"]);
  const source =
    sourceValue === "browser" ||
    sourceValue === "client" ||
    sourceValue === "server" ||
    sourceValue === "network" ||
    sourceValue === "cloudflare" ||
    sourceValue === "tauri"
      ? sourceValue
      : undefined;
  return {
    kind: requestKindFromUnknown(records),
    source,
    operation: safeOperation(
      firstField(records, ["operation"]) as string | undefined,
    ),
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
      firstField(records, [
        "retryAfter",
        "retry_after",
        "retryAfterSecs",
        "retry_after_secs",
      ]),
    ),
    retryable: safeBoolean(firstField(records, ["retryable"])),
    remediation: safeLabel(
      firstField(records, ["remediation"]) as string | undefined,
      MAX_DETAIL_LENGTH,
    ),
    providerErrors: providerErrorsFromRecords(records),
  };
}

function joinDetail(message: string, detail?: string): string {
  if (!detail) return message;
  const punctuation = /[.!?]$/.test(message) ? "" : ".";
  return `${message}${punctuation} Server detail: ${detail}`;
}

function providerDetail(
  providerErrors: readonly ProviderErrorDetail[] | undefined,
): string | undefined {
  if (!providerErrors?.length) return undefined;
  return providerErrors
    .map(({ code, message }) =>
      code && message ? `${code}: ${message}` : (message ?? code ?? ""),
    )
    .filter(Boolean)
    .join("; ");
}

function combineDetails(
  ...values: Array<string | undefined>
): string | undefined {
  const unique = Array.from(
    new Set(values.map((value) => value?.trim()).filter(Boolean)),
  );
  return unique.length ? unique.join("; ") : undefined;
}

function withRemediation(message: string, remediation?: string): string {
  const safe = remediation ? redact(remediation) : undefined;
  return safe ? `${message} Next step: ${safe}` : message;
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
  readonly remediation?: string;
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
    this.remediation = context.remediation
      ? redact(context.remediation, MAX_DETAIL_LENGTH)
      : undefined;
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
      ...(this.remediation ? { remediation: this.remediation } : {}),
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
  const parsedError = parseSerializedError(error);
  if (parsedError !== error) {
    return normalizeRequestError(parsedError, context);
  }

  const endpoint = safeEndpoint(context.endpoint);
  const requestUrl = safeRequestUrl(context.requestUrl);
  const operation = safeOperation(context.operation);
  const command = safeCommand(context.command);
  const extracted = metadataFromUnknown(error);
  const source = extracted.source ?? context.source;
  const detail = rawDetail(error);
  const structuredDetail = combineDetails(
    detail,
    providerDetail(extracted.providerErrors),
  );
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
    operation: extracted.operation ?? operation,
    command: command ?? extracted.command,
    status: extracted.status,
    statusText: extracted.statusText,
    code: extracted.code,
    requestId: extracted.requestId,
    retryAfter: extracted.retryAfter,
    remediation: extracted.remediation,
    providerErrors: extracted.providerErrors,
  };

  if (
    context.timedOut ||
    extracted.kind === "timeout" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT"
  ) {
    return new RequestError(
      "timeout",
      withRemediation(
        `Request timed out. Check connectivity and backend availability, then try again.${endpointSuffix(endpoint)}`,
        extracted.remediation,
      ),
      {
        ...common,
        source: source ?? "client",
        retryable: extracted.retryable ?? true,
      },
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

  if (extracted.kind === "malformed-response") {
    return new RequestError(
      "malformed-response",
      withRemediation(
        joinDetail(
          common.operation === "dns:list" ||
            common.command === "get_dns_records"
            ? `Cloudflare returned a malformed response while listing DNS records. Retry once; if it continues, inspect the request ID and provider status.${endpointSuffix(endpoint)}`
            : common.status === 401 ||
                common.status === 403 ||
                common.operation?.toLowerCase().startsWith("auth:") === true ||
                common.command?.toLowerCase() === "verify_token"
              ? `The authentication service returned a malformed response. Retry once; if it continues, inspect the request ID and provider status.${endpointSuffix(endpoint)}`
              : `Cloudflare returned a malformed response for the requested operation. Retry once; if it continues, inspect the request ID and provider status.${endpointSuffix(endpoint)}`,
          structuredDetail,
        ),
        extracted.remediation,
      ),
      {
        ...common,
        source: source ?? "server",
        retryable: extracted.retryable ?? true,
      },
      { cause: error },
    );
  }

  const isAuthContext =
    common.status === 401 ||
    common.status === 403 ||
    common.operation?.toLowerCase().startsWith("auth:") === true ||
    common.command?.toLowerCase() === "verify_token";

  if (extracted.kind === "network") {
    return new RequestError(
      "network",
      withRemediation(
        `Cloudflare could not be reached. Check internet connectivity, proxy, DNS, and TLS settings, then retry.${endpointSuffix(endpoint)}`,
        extracted.remediation,
      ),
      {
        ...common,
        source: source ?? "network",
        retryable: extracted.retryable ?? true,
      },
      { cause: error },
    );
  }

  // A backend `AppError::Validation` serialises as `code: "VALIDATION"` plus,
  // when the caller knows what is wrong, an `issues` array. Either way the
  // input was rejected before anything left the machine, so classify it here —
  // ahead of the status and prose rules — rather than letting it fall through
  // to a Cloudflare or connectivity diagnosis.
  const invalid =
    validationDetail(error) ?? (code === "VALIDATION" ? detail : undefined);
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
      withRemediation(
        statusMessage(extracted.status, extracted.statusText, structuredDetail),
        extracted.remediation,
      ),
      {
        ...common,
        source: source ?? "server",
        retryable:
          extracted.retryable ?? retryableFor("http", extracted.status),
      },
      { cause: error },
    );
  }

  if (extracted.kind === "http" && !isAuthContext) {
    return new RequestError(
      "http",
      withRemediation(
        joinDetail(
          "Cloudflare could not complete the requested operation",
          detail,
        ),
        extracted.remediation,
      ),
      {
        ...common,
        source: extracted.source ?? source ?? "cloudflare",
        retryable: extracted.retryable ?? true,
      },
      { cause: error },
    );
  }

  if (extracted.kind === "http") {
    const rawKind = firstField(records, ["kind", "failure_kind"]);
    const normalizedKind =
      typeof rawKind === "string" ? rawKind.trim().toLowerCase() : "";
    const baseMessage =
      normalizedKind === "rate_limited"
        ? "Cloudflare rate-limited credential verification. Wait for the retry interval before trying again"
        : normalizedKind === "authentication"
          ? "Cloudflare rejected the supplied credentials. Check the token or key, required permissions, and email for global-key authentication"
          : "Cloudflare could not complete credential verification. Retry shortly and check provider status if the failure continues";
    return new RequestError(
      "http",
      withRemediation(
        joinDetail(baseMessage, structuredDetail),
        extracted.remediation,
      ),
      {
        ...common,
        source: source ?? "cloudflare",
        retryable: extracted.retryable ?? normalizedKind !== "authentication",
      },
      { cause: error },
    );
  }

  const normalizedDetail = detail?.toLowerCase() ?? "";
  const nativeOperation = source === "tauri" || command !== undefined;
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
    const remediation = nativeOperation
      ? "Check internet connectivity, system DNS, proxy or VPN settings, firewall policy, and required service availability, then retry."
      : "Confirm NEXT_PUBLIC_SERVER_API_BASE points to a running, reachable backend and check local network and firewall access.";

    return new RequestError(
      "network",
      withRemediation(
        `${nativeOperation ? "The desktop operation could not connect to a required service or Cloudflare upstream." : "The configured web backend refused the connection."}${endpointSuffix(endpoint)}`,
        remediation,
      ),
      {
        ...common,
        source: source ?? "browser",
        retryable: true,
        remediation,
      },
      { cause: error },
    );
  }
  if (
    DNS_RESOLUTION_CODES.has(code.toUpperCase()) ||
    DNS_RESOLUTION_DETAIL.test(normalizedDetail)
  ) {
    const remediation = nativeOperation
      ? "Check system DNS, internet connectivity, proxy or VPN settings, and firewall policy, then retry."
      : "Check NEXT_PUBLIC_SERVER_API_BASE, the backend hostname, and system DNS connectivity.";

    return new RequestError(
      "network",
      withRemediation(
        `${nativeOperation ? "The desktop operation could not resolve a required service or Cloudflare upstream hostname." : "The configured web backend hostname could not be resolved."}${endpointSuffix(endpoint)}`,
        remediation,
      ),
      {
        ...common,
        source: source ?? "browser",
        retryable: true,
        remediation,
      },
      { cause: error },
    );
  }
  if (TLS_FAILURE_DETAIL.test(normalizedDetail)) {
    const remediation = nativeOperation
      ? "Check the system clock, trust store, TLS interception, proxy or VPN settings, and firewall policy, then retry."
      : "Check NEXT_PUBLIC_SERVER_API_BASE, the backend certificate chain, TLS interception, and the system clock.";

    return new RequestError(
      "network",
      withRemediation(
        `${nativeOperation ? "A TLS or certificate error prevented the desktop operation from reaching a required service or Cloudflare upstream." : "A TLS or certificate error prevented a secure connection to the configured web backend."}${endpointSuffix(endpoint)}`,
        remediation,
      ),
      {
        ...common,
        source: source ?? "browser",
        retryable: true,
        remediation,
      },
      { cause: error },
    );
  }
  if (
    /\bcors\b|cross-origin|access-control-allow-origin/.test(normalizedDetail)
  ) {
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
    isAuthContext &&
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

function decodeHtmlTextEntitiesOnce(value: string): string {
  return value.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&nbsp;":
        return " ";
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&#39;":
        return "'";
      default:
        return entity;
    }
  });
}

function summarizeHtmlResponse(bodyText: string): string {
  const title = bodyText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const visibleText = decodeHtmlTextEntitiesOnce(
    bodyText
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  const summary = combineDetails(
    title ? `page title: ${title}` : undefined,
    visibleText,
  );
  return summary
    ? `The backend returned an HTML error page (${redact(summary)})`
    : "The backend returned an HTML error page";
}

function summarizeResponseBody(
  bodyText: string,
  contentType?: string | null,
): string {
  const trimmed = bodyText.trim();
  if (
    contentType?.toLowerCase().includes("text/html") ||
    /^(?:<!doctype\s+html|<html\b)/i.test(trimmed)
  ) {
    return summarizeHtmlResponse(trimmed);
  }
  return redact(trimmed);
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
      detail = summarizeResponseBody(
        bodyText,
        response.headers.get("content-type"),
      );
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
    contentType?: string;
    responseKind?: "invalid-json" | "unexpected-html" | "unexpected-content";
  } = {},
): RequestError {
  const safePath = safeEndpoint(endpoint);
  const message =
    context.responseKind === "unexpected-html"
      ? `The server returned an HTML page instead of the expected JSON response. Check the configured API base URL, reverse proxy route, and authentication redirects.${endpointSuffix(safePath)}`
      : context.responseKind === "unexpected-content"
        ? `The server returned a non-JSON response where JSON was required. Check the configured API base URL and backend response contract.${endpointSuffix(safePath)}`
        : `The server returned invalid JSON for a successful response. Retry once; if it continues, use the request ID to inspect server logs.${endpointSuffix(safePath)}`;
  return new RequestError(
    "malformed-response",
    context.contentType
      ? `${message} Content type: ${redact(context.contentType, MAX_HEADER_VALUE_LENGTH)}.`
      : message,
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
    normalized.remediation ? `next step ${normalized.remediation}` : "",
    normalized.providerCodes.length
      ? `provider codes ${normalized.providerCodes.join(", ")}`
      : "",
    normalized.providerMessages.length
      ? `provider messages ${normalized.providerMessages.join("; ")}`
      : "",
    `retryable ${normalized.retryable ? "yes" : "no"}`,
  ].filter(Boolean);
  return details.length
    ? `${normalized.message} [${details.join("; ")}]`
    : normalized.message;
}
