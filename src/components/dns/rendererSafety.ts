export interface Utf8RetentionResult {
  value: string;
  bytes: number;
  truncated: boolean;
}

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 3;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Measure a string without allocating an encoded copy. When `stopAfterBytes`
 * is supplied, measurement stops as soon as the result exceeds that ceiling.
 */
export function utf8ByteLengthUpTo(
  value: string,
  stopAfterBytes = Number.POSITIVE_INFINITY,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? 0xfffd;
    bytes += utf8BytesForCodePoint(codePoint);
    if (bytes > stopAfterBytes) return bytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

/**
 * Retain at most `maxBytes` of a string without splitting a UTF-8 code point.
 * Traversal stops immediately after the first value that does not fit.
 */
export function retainUtf8(
  value: string,
  maxBytes: number,
): Utf8RetentionResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0xfffd;
    const codePointBytes = utf8BytesForCodePoint(codePoint);
    if (bytes + codePointBytes > maxBytes) {
      return {
        value: value.slice(0, index),
        bytes,
        truncated: true,
      };
    }
    bytes += codePointBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }

  return { value, bytes, truncated: false };
}
