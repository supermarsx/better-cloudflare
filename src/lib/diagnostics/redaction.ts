/**
 * The text scrub every free-form string in a diagnostics payload goes through.
 *
 * Structure is the first and stronger defence: the builder in
 * `diagnostics-report.ts` reads an allow-list of fields, so a credential is
 * absent because nothing ever looked at it. This module handles the strings
 * that are *not* structured — a backend's error message, a stack trace, a
 * refusal reason — where a secret or an identifier can arrive inside otherwise
 * ordinary prose.
 *
 * Credential patterns are already handled, and well, by
 * {@link sanitizeRuntimeText} in `@/lib/errors/runtime-reporting`: bearer
 * tokens, `key=value` credential pairs, JWTs, userinfo in URLs. None of that
 * is restated here. This module adds the two classes that error reporting has
 * no reason to care about but a pasted blob does.
 *
 * # The local account name
 *
 * It appears in every absolute path on every platform, and is very often the
 * user's real name. {@link redactUserPaths} removes the account segment and
 * keeps the rest of the path, because which directory a failure happened in is
 * frequently the whole diagnosis.
 *
 * # The user's own zone names
 *
 * A service error can name a zone in prose — "RDAP lookup for example.com
 * failed" — which would put a domain in a payload whose whole policy is that
 * domains are counts. The obvious fix, a regular expression for
 * domain-shaped text, is worse than it looks: `propagation.ts`,
 * `Object.keys` and `styles.css` are all domain-shaped, so a generic pattern
 * shreds the stack traces that are the most useful thing in the payload.
 *
 * So the redaction is driven by data instead of by shape.
 * {@link createDiagnosticsScrubber} is given the zone names the workspace
 * actually holds and removes exactly those, with any subdomain of them. That
 * is precise in both directions: it cannot mangle a stack frame, and it cannot
 * miss the user's own domain, which is the one that identifies them.
 *
 * # Opaque identifiers
 *
 * The same argument, for the same reason. A Cloudflare zone or account id is
 * 32 hexadecimal characters with no structure a pattern could key on, and it
 * reaches error prose the same way a zone name does — "RDAP lookup failed for
 * account 0a1b2c…". There is nothing to match on, so the identifiers the
 * workspace holds are passed in and matched literally.
 *
 * Unlike zone names, identifiers have no opt-in. Publishing a zone's name is
 * a choice a user can reasonably make about their own domain; publishing the
 * internal id it is addressed by is never the thing they meant to share, and
 * is never what diagnoses a bug.
 */
import { sanitizeRuntimeText } from "@/lib/errors/runtime-reporting";

/** What a redacted home-directory segment is replaced with. */
export const REDACTED_USER = "[user]";
/** What a redacted zone name, or a subdomain of one, is replaced with. */
export const REDACTED_ZONE = "[zone]";
/** What a redacted email address is replaced with. */
export const REDACTED_EMAIL = "[email]";
/** What a redacted zone or account identifier is replaced with. */
export const REDACTED_IDENTIFIER = "[id]";

/** How many zone names the redactor will build a pattern from. */
const MAX_REDACTED_ZONES = 200;

/** How many opaque identifiers the redactor will build a pattern from. */
const MAX_REDACTED_IDENTIFIERS = 400;

/**
 * Shortest identifier the redactor will match literally.
 *
 * A Cloudflare zone or account id is 32 hex characters, so this is generous.
 * The floor exists because a short literal is not an identifier, it is a word,
 * and replacing every occurrence of a word would corrupt prose rather than
 * protect anything.
 */
const MIN_IDENTIFIER_LENGTH = 8;

/**
 * Shortest zone name the redactor will act on.
 *
 * `a.co` is four characters and is the shortest thing that can be a real zone.
 * A shorter value is malformed, and acting on it would mean replacing a
 * one- or two-character fragment everywhere it occurred.
 */
const MIN_ZONE_NAME_LENGTH = 4;

/**
 * A home directory and the account name inside it.
 *
 * Matches `C:\Users\alice`, `/Users/alice`, `/home/alice` and the forward-slash
 * spellings that appear inside `file://` URLs, capturing the separator so the
 * replacement keeps the original path's style. The name segment stops at a
 * separator or at any character that cannot appear in a path component, so a
 * path quoted mid-sentence does not swallow the rest of the line.
 *
 * `C:\Users\Public` over-matches and becomes `C:\Users\[user]`. That is the
 * right way for this to be wrong.
 */
const HOME_DIRECTORY_PATTERN =
  /((?:[A-Za-z]:)?[\\/](?:Users|home)[\\/])([^\\/\s"'`<>|?*:;,)\]}]+)/gu;

/**
 * An email address.
 *
 * Applied unconditionally and with no opt-in, because an address identifies a
 * person rather than an asset, and because the `@` makes the pattern
 * unambiguous — unlike a bare domain, nothing in a stack trace looks like
 * this. The Cloudflare account email in particular reaches error text through
 * the legacy auth header path.
 */
const EMAIL_PATTERN =
  /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/gu;

/**
 * Replace the account name in any home-directory path.
 *
 * Nothing else about the path is touched: `C:\Users\[user]\AppData\Roaming\…`
 * keeps everything diagnostic while dropping the only part that names a
 * person.
 */
export function redactUserPaths(value: string): string {
  return value.replace(
    HOME_DIRECTORY_PATTERN,
    (_match, prefix: string) => `${prefix}${REDACTED_USER}`,
  );
}

/** Replace every email address. */
export function redactEmailAddresses(value: string): string {
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Build a function that removes these zone names and any subdomain of them.
 *
 * One alternation rather than one pass per zone, with the longest name first
 * so `mail.example.com` is matched before `example.com` and the whole hostname
 * is replaced rather than its tail. Returns the identity function when there
 * is nothing to redact, so the common case costs no regular expression at all.
 */
export function buildZoneRedactor(
  zoneNames: Iterable<string>,
): (value: string) => string {
  const names = [
    ...new Set(
      [...zoneNames]
        .filter(
          (name) =>
            typeof name === "string" &&
            name.length >= MIN_ZONE_NAME_LENGTH &&
            name.includes("."),
        )
        .map((name) => name.trim().toLowerCase().replace(/\.$/u, "")),
    ),
  ]
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_REDACTED_ZONES);

  if (names.length === 0) return (value) => value;

  const pattern = new RegExp(
    `(?:[A-Za-z0-9_-]+\\.)*(?:${names.map(escapeForRegExp).join("|")})\\.?`,
    "giu",
  );
  return (value) => value.replace(pattern, REDACTED_ZONE);
}

/**
 * Build a function that removes these identifiers wherever they appear.
 *
 * Literal matching, longest first, so an identifier that contains another is
 * replaced whole. Values shorter than {@link MIN_IDENTIFIER_LENGTH} are
 * ignored — see the constant.
 */
export function buildIdentifierRedactor(
  identifiers: Iterable<string>,
): (value: string) => string {
  const values = [
    ...new Set(
      [...identifiers].filter(
        (value) =>
          typeof value === "string" && value.length >= MIN_IDENTIFIER_LENGTH,
      ),
    ),
  ]
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_REDACTED_IDENTIFIERS);

  if (values.length === 0) return (value) => value;

  const pattern = new RegExp(values.map(escapeForRegExp).join("|"), "gu");
  return (value) => value.replace(pattern, REDACTED_IDENTIFIER);
}

/** Scrubs one externally-supplied string down to a bounded, safe form. */
export type DiagnosticsScrubber = (
  value: unknown,
  maxBytes: number,
) => string | null;

export interface DiagnosticsScrubberOptions {
  /**
   * Zone names to remove from prose, along with any subdomain of them.
   *
   * Passed for every free-form string, including when the user has opted in
   * to publishing zone names: the opt-in publishes them in one labelled
   * section, which is a channel the user can see and judge. An error message
   * is not that channel, and a record name that happens to appear in one is
   * withheld at every opt-in level.
   */
  zoneNames?: Iterable<string>;
  /**
   * Opaque identifiers — zone ids, account ids — to remove from prose.
   *
   * No opt-in: see the module comment.
   */
  identifiers?: Iterable<string>;
}

/**
 * The full scrub for one externally-supplied string.
 *
 * Order is load-bearing. {@link sanitizeRuntimeText} runs first because it is
 * the pass that removes credentials and also the pass that bounds the length;
 * running a replacement before it could rewrite bytes inside a token and stop
 * the token from being recognised. The identifier passes then run over what
 * survived.
 *
 * Returns `null` for anything that is not a non-empty string, so an absent
 * field and a field that scrubbed down to nothing are reported identically —
 * as absent, rather than as an empty string a reader has to interpret.
 */
export function createDiagnosticsScrubber(
  options: DiagnosticsScrubberOptions = {},
): DiagnosticsScrubber {
  const redactZones = buildZoneRedactor(options.zoneNames ?? []);
  const redactIdentifiers = buildIdentifierRedactor(options.identifiers ?? []);
  return (value, maxBytes) => {
    if (typeof value !== "string" || value.trim().length === 0) return null;
    const scrubbed = redactIdentifiers(
      redactZones(
        redactEmailAddresses(
          redactUserPaths(sanitizeRuntimeText(value, maxBytes)),
        ),
      ),
    ).trim();
    return scrubbed.length > 0 ? scrubbed : null;
  };
}
