/** Centralized hard ceilings for frontend-retained resources. */
const MEBIBYTE = 1024 * 1024;

export const RESOURCE_LIMITS = {
  responseBody: {
    hardBytes: 10 * MEBIBYTE,
  },
  runtimeDiagnostics: {
    messageHardBytes: 1200,
    stackHardBytes: 6000,
    componentStackHardBytes: 4000,
    serializedTraceHardBytes: 16 * 1024,
    fingerprintInputHardBytes: 2048,
    retainedCountHard: 30,
    recentFingerprintsHard: 100,
    serializationMaxDepth: 6,
    serializationMaxEntries: 50,
    serializationMaxNodes: 200,
  },
  offlineCache: {
    hardEntries: 50,
    hardBytes: 5 * MEBIBYTE,
    recoveryScanHardKeys: 500,
  },
  undoRedo: {
    defaultEntries: 50,
    hardEntries: 100,
  },
} as const;

const utf8Encoder = new TextEncoder();
const INITIAL_RESPONSE_BUFFER_BYTES = 16 * 1024;

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function assertSafeIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

/**
 * Truncate to a UTF-8 byte ceiling without consuming part of a code point.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const limitBytes = assertSafeIntegerInRange(
    maxBytes,
    0,
    Number.MAX_SAFE_INTEGER,
    "UTF-8 byte limit",
  );
  if (limitBytes === 0 || value.length === 0) return "";

  const target = new Uint8Array(Math.min(limitBytes, value.length * 3));
  const { read } = utf8Encoder.encodeInto(value, target);
  return read === value.length ? value : value.slice(0, read);
}

/**
 * Normalize an optional caller-supplied count without permitting it to exceed
 * a centralized hard ceiling.
 */
export function boundedResourceCount(
  requested: number | undefined,
  defaultCount: number,
  hardCount: number,
): number {
  const maximum = assertSafeIntegerInRange(
    hardCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "Resource hard count",
  );
  const fallback = assertSafeIntegerInRange(
    defaultCount,
    0,
    maximum,
    "Resource default count",
  );
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(requested)));
}

export class ResponseBodyLimitError extends Error {
  readonly name = "ResponseBodyLimitError";

  constructor(
    readonly limitBytes: number,
    readonly observedBytes?: number,
    readonly declaredBytes?: number,
  ) {
    super(
      declaredBytes !== undefined
        ? `Response declared ${declaredBytes} bytes, exceeding the ${limitBytes}-byte limit.`
        : `Response exceeded the ${limitBytes}-byte limit while streaming.`,
    );
  }
}

function normalizeResponseLimit(maxBytes: number): number {
  return assertSafeIntegerInRange(
    maxBytes,
    1,
    RESOURCE_LIMITS.responseBody.hardBytes,
    "Response byte limit",
  );
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Read a response incrementally and cancel its reader as soon as the hard
 * limit is known to be exceeded.
 */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number = RESOURCE_LIMITS.responseBody.hardBytes,
): Promise<string> {
  const limitBytes = normalizeResponseLimit(maxBytes);
  const declaredBytes = contentLength(response);
  if (declaredBytes !== undefined && declaredBytes > limitBytes) {
    const error = new ResponseBodyLimitError(
      limitBytes,
      undefined,
      declaredBytes,
    );
    const body = response.body;
    if (body) {
      try {
        await body.cancel(error);
      } catch {
        // Preserve the more useful limit error.
      }
    }
    throw error;
  }

  const body = (
    response as Response & {
      body?: ReadableStream<Uint8Array> | null;
    }
  ).body;
  if (body === null) return "";
  if (!body) {
    // Response.body is always present in production Fetch implementations.
    // This compatibility path supports response-like test doubles.
    const text = await response.text();
    const observedBytes = utf8ByteLength(text);
    if (observedBytes > limitBytes) {
      throw new ResponseBodyLimitError(limitBytes, observedBytes);
    }
    return text;
  }

  const reader = body.getReader();
  let readerFinished = false;
  let readerCancelled = false;
  const cancel = async (reason: unknown): Promise<void> => {
    if (readerCancelled || readerFinished) return;
    readerCancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // The original limit/read error is more useful than cancellation errors.
    }
  };

  try {
    let retained = new Uint8Array(
      Math.min(limitBytes, declaredBytes ?? INITIAL_RESPONSE_BUFFER_BYTES),
    );
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        readerFinished = true;
        break;
      }
      if (value.byteLength === 0) continue;
      const nextBytes = totalBytes + value.byteLength;
      if (nextBytes > limitBytes) {
        const error = new ResponseBodyLimitError(limitBytes, nextBytes);
        await cancel(error);
        throw error;
      }
      if (nextBytes > retained.byteLength) {
        const nextCapacity = Math.min(
          limitBytes,
          Math.max(
            nextBytes,
            INITIAL_RESPONSE_BUFFER_BYTES,
            retained.byteLength * 2,
          ),
        );
        const grown = new Uint8Array(nextCapacity);
        grown.set(retained.subarray(0, totalBytes));
        retained = grown;
      }
      retained.set(value, totalBytes);
      totalBytes = nextBytes;
    }

    return totalBytes === 0
      ? ""
      : new TextDecoder().decode(retained.subarray(0, totalBytes));
  } catch (error) {
    await cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
