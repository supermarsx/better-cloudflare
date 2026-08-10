/**
 * Text helpers shared by the guided builders' `describe*` functions.
 *
 * These are deliberately free of React so the plain-English summaries can be
 * unit tested as pure data.
 */

/** Join a list into readable prose: "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[], conjunction = "and") {
  const parts = items.filter((item) => item.trim().length > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] as string;
  const head = parts.slice(0, -1).join(", ");
  return `${head} ${conjunction} ${parts[parts.length - 1]}`;
}

/** Pluralize a count: `pluralize(1, "record")` -> "1 record". */
export function pluralize(count: number, singular: string, plural?: string) {
  const word = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count} ${word}`;
}

/**
 * Render a value for inclusion in prose, falling back to a neutral placeholder
 * when the user has not filled it in yet.
 */
export function orPlaceholder(value: string | undefined, placeholder: string) {
  const trimmed = (value ?? "").trim();
  return trimmed || placeholder;
}

/** Describe a TTL-style second count in human terms ("1 day", "4 hours"). */
export function humanizeSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return `${seconds} seconds`;
  const units: Array<[number, string]> = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return pluralize(count, name);
    }
  }
  return pluralize(seconds, "second");
}

/**
 * Turn `mailto:a@x.test, mailto:b@y.test` into `a@x.test and b@y.test`.
 * Non-mailto URIs are kept verbatim so nothing is misrepresented.
 */
export function describeReportUris(value: string) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part.toLowerCase().startsWith("mailto:")
        ? part.slice("mailto:".length)
        : part,
    );
  return joinList(parts);
}

/** Capitalize the first letter so details read as sentences. */
export function sentence(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
