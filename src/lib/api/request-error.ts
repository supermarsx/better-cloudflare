export type RequestErrorKind =
  | "network"
  | "timeout"
  | "aborted"
  | "http"
  | "malformed-response"
  | "validation"
  | "unknown";

export interface RequestErrorContext {
  endpoint?: string;
  timedOut?: boolean;
}

const MAX_DETAIL_LENGTH = 180;
const MAX_ENDPOINT_LENGTH = 120;

function safeEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const withoutQuery = endpoint.split(/[?#]/, 1)[0];
  return withoutQuery.slice(0, MAX_ENDPOINT_LENGTH);
}

function redact(value: string): string {
  return value
    .replace(
      /(["']?)(authorization|proxy[-_ ]?authorization|api[-_ ]?(?:key|token)|x[-_ ]?auth[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|token|secret|password|cookie|set[-_ ]?cookie)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$2=[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
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

  constructor(
    readonly kind: RequestErrorKind,
    message: string,
    readonly context: {
      endpoint?: string;
      status?: number;
      code?: string;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function normalizeRequestError(
  error: unknown,
  context: RequestErrorContext = {},
): RequestError {
  if (error instanceof RequestError) return error;

  const endpoint = safeEndpoint(context.endpoint);
  if (context.timedOut) {
    return new RequestError(
      "timeout",
      `Request timed out. Check your connection and try again.${endpointSuffix(endpoint)}`,
      { endpoint },
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
      { endpoint },
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
      { endpoint },
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
      `Unable to reach the server. Check your connection; you may be offline or the request may be blocked by CORS. Then try again.${endpointSuffix(endpoint)}`,
      { endpoint },
      { cause: error },
    );
  }

  const invalid = validationDetail(error);
  if (invalid) {
    return new RequestError(
      "validation",
      `Invalid input: ${invalid}`,
      { endpoint },
      { cause: error },
    );
  }

  return new RequestError(
    "unknown",
    `Unexpected request error. Try again.${endpointSuffix(endpoint)}`,
    { endpoint },
    { cause: error },
  );
}

function errorDetail(payload: unknown): { detail?: string; code?: string } {
  if (typeof payload === "string") return { detail: redact(payload) };
  if (!isRecord(payload)) return {};
  if (Array.isArray(payload.errors)) {
    const parts: string[] = [];
    let firstCode: string | undefined;
    for (const item of payload.errors.slice(0, 3)) {
      if (!isRecord(item)) continue;
      const code = safeCode(item.code);
      const message =
        typeof item.message === "string" ? redact(item.message) : "";
      firstCode ??= code;
      if (code && message) parts.push(`${code}: ${message}`);
      else if (message) parts.push(message);
      else if (code) parts.push(code);
    }
    if (parts.length)
      return { detail: redact(parts.join(", ")), code: firstCode };
  }
  if (typeof payload.message === "string") {
    return { detail: redact(payload.message), code: safeCode(payload.code) };
  }
  if (typeof payload.error === "string") {
    return { detail: redact(payload.error), code: safeCode(payload.code) };
  }
  if (typeof payload.detail === "string") {
    return { detail: redact(payload.detail), code: safeCode(payload.code) };
  }
  return { code: safeCode(payload.code) };
}

export function requestErrorFromResponse(
  response: Response,
  endpoint: string,
  bodyText: string,
): RequestError {
  const safePath = safeEndpoint(endpoint);
  let detail: string | undefined;
  let code: string | undefined;
  if (bodyText) {
    try {
      ({ detail, code } = errorDetail(JSON.parse(bodyText)));
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
    endpoint: safePath,
    status: response.status,
    code,
  });
}

export function malformedResponseError(
  endpoint: string,
  cause: unknown,
): RequestError {
  const safePath = safeEndpoint(endpoint);
  return new RequestError(
    "malformed-response",
    `Server returned invalid JSON for a successful response. Try again; if the problem continues, contact support.${endpointSuffix(safePath)}`,
    { endpoint: safePath },
    { cause },
  );
}

export function formatRequestError(error: unknown): string {
  return normalizeRequestError(error).message;
}
