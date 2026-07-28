export type RequestErrorKind =
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "malformed-response"
  | "validation"
  | "unknown";

export type RequestErrorSource =
  | "browser"
  | "client"
  | "server"
  | "cloudflare"
  | "unknown";

export interface RequestErrorContext {
  endpoint?: string;
  operation?: string;
  timedOut?: boolean;
}

export interface ProviderErrorDetail {
  code?: string;
  message?: string;
}

export interface RequestErrorMetadata {
  source?: RequestErrorSource;
  endpoint?: string;
  operation?: string;
  status?: number;
  /**
   * The first provider code, retained for compatibility with existing callers.
   * Use `providerCodes` when every Cloudflare code is needed.
   */
  code?: string;
  retryable?: boolean;
  providerErrors?: readonly ProviderErrorDetail[];
}

const MAX_DETAIL_LENGTH = 180;
const MAX_PROVIDER_DETAIL_LENGTH = 240;
const MAX_PROVIDER_ERRORS = 5;
const MAX_ENDPOINT_LENGTH = 120;
const MAX_OPERATION_LENGTH = 80;

function safeEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const withoutQuery = endpoint.split(/[?#]/, 1)[0];
  return withoutQuery.slice(0, MAX_ENDPOINT_LENGTH);
}

function safeOperation(operation?: string): string | undefined {
  if (!operation) return undefined;
  const normalized = operation.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_OPERATION_LENGTH) : undefined;
}

function redact(value: string, maxLength = MAX_DETAIL_LENGTH): string {
  return value
    .replace(
      /(["']?)(authorization|proxy[-_ ]?authorization|api[-_ ]?(?:key|token)|x[-_ ]?auth[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret|password|cookie|set[-_ ]?cookie)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$2=[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function endpointSuffix(endpoint?: string): string {
  const safe = safeEndpoint(endpoint);
  return safe ? ` (${safe})` : "";
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value);
  return /^[\w.-]{1,32}$/.test(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  if (kind === "timeout" || kind === "aborted" || kind === "validation") {
    return "client";
  }
  if (kind === "http" || kind === "malformed-response") return "server";
  return "unknown";
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

export class RequestError extends Error {
  readonly name = "RequestError";
  readonly source: RequestErrorSource;
  readonly endpoint?: string;
  readonly operation?: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;
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
    super(message, options);
    this.source = context.source ?? sourceFor(kind);
    this.endpoint = safeEndpoint(context.endpoint);
    this.operation = safeOperation(context.operation);
    this.status = context.status;
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
      ...(this.operation ? { operation: this.operation } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.code ? { code: this.code } : {}),
      retryable: this.retryable,
      ...(this.providerErrors.length
        ? { providerErrors: this.providerErrors }
        : {}),
    });
  }
}

export function normalizeRequestError(
  error: unknown,
  context: RequestErrorContext = {},
): RequestError {
  if (error instanceof RequestError) return error;

  const endpoint = safeEndpoint(context.endpoint);
  const operation = safeOperation(context.operation);
  if (context.timedOut) {
    return new RequestError(
      "timeout",
      `Request timed out. Check your connection and try again.${endpointSuffix(endpoint)}`,
      { source: "client", endpoint, operation, retryable: true },
      { cause: error },
    );
  }

  const name =
    isRecord(error) && typeof error.name === "string" ? error.name : "";
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (name === "TimeoutError" || code === "ETIMEDOUT") {
    return new RequestError(
      "timeout",
      `Request timed out. Check your connection and try again.${endpointSuffix(endpoint)}`,
      { source: "client", endpoint, operation, retryable: true },
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
      { source: "client", endpoint, operation, retryable: false },
      { cause: error },
    );
  }

  const message =
    typeof error === "string"
      ? error
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : "";
  const isKnownNetworkFailure =
    /^(failed to fetch|fetch failed|load failed|network error|network request failed|networkerror when attempting to fetch resource\.?)$/i.test(
      message.trim(),
    );
  if (
    error instanceof TypeError ||
    name === "TypeError" ||
    code === "ERR_NETWORK" ||
    isKnownNetworkFailure
  ) {
    return new RequestError(
      "network",
      `The browser could not complete the request and cannot distinguish between offline connectivity, DNS, TLS, or CORS failures. Check your connection, the server address and certificate, and browser/CORS settings, then try again.${endpointSuffix(endpoint)}`,
      { source: "browser", endpoint, operation, retryable: true },
      { cause: error },
    );
  }

  const invalid = validationDetail(error);
  if (invalid) {
    return new RequestError(
      "validation",
      `Invalid input: ${invalid}`,
      { source: "client", endpoint, operation, retryable: false },
      { cause: error },
    );
  }

  return new RequestError(
    "unknown",
    `Unexpected request error. Try again.${endpointSuffix(endpoint)}`,
    { source: "unknown", endpoint, operation, retryable: false },
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
  if (typeof payload.message === "string") {
    return {
      detail: redact(payload.message),
      code: safeCode(payload.code),
      source: "server",
      providerErrors: [],
    };
  }
  if (typeof payload.error === "string") {
    return {
      detail: redact(payload.error),
      code: safeCode(payload.code),
      source: "server",
      providerErrors: [],
    };
  }
  if (typeof payload.detail === "string") {
    return {
      detail: redact(payload.detail),
      code: safeCode(payload.code),
      source: "server",
      providerErrors: [],
    };
  }
  return {
    code: safeCode(payload.code),
    source: Array.isArray(payload.errors) ? "cloudflare" : "server",
    providerErrors: [],
  };
}

export function requestErrorFromResponse(
  response: Response,
  endpoint: string,
  bodyText: string,
  operation?: string,
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
  const context = [
    `HTTP ${response.status}`,
    code ? `code ${code}` : "",
  ].filter(Boolean);
  const message = `Request failed (${context.join(", ")})${safePath ? ` at ${safePath}` : ""}${detail ? `: ${detail}` : "."}`;
  return new RequestError("http", message, {
    source,
    endpoint: safePath,
    operation,
    status: response.status,
    code,
    retryable: retryableFor("http", response.status),
    providerErrors,
  });
}

export function malformedResponseError(
  endpoint: string,
  cause: unknown,
  context: { operation?: string; status?: number } = {},
): RequestError {
  const safePath = safeEndpoint(endpoint);
  return new RequestError(
    "malformed-response",
    `Server returned invalid JSON for a successful response. Try again; if the problem continues, contact support.${endpointSuffix(safePath)}`,
    {
      source: "server",
      endpoint: safePath,
      operation: context.operation,
      status: context.status,
      retryable: true,
    },
    { cause },
  );
}

export function formatRequestError(error: unknown): string {
  return normalizeRequestError(error).message;
}
