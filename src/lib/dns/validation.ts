import { z } from "zod";
import net from "net";
import { parseNAPTR } from "./dns-parsers";
import { validateSPF } from "./spf";
import { RECORD_TYPES } from "../../types/dns";

/**
 * Highest value the 31-bit DNS TTL field can hold. Matches `MAX_TTL_SECONDS` in
 * `src-tauri/crates/bc-dns-tools/src/validate.rs`.
 */
const MAX_TTL_SECONDS = 2_147_483_647;

/**
 * Zod schema describing a DNS record input the application accepts for
 * create/update operations.
 *
 * - `type` should be one of the supported record types
 * - `name` is the record name (host or subdomain)
 * - `content` contains the record contents (IP, domain, etc.)
 * - `ttl` can be a number of seconds or the string 'auto'
 * - `priority` optional (for MX records)
 * - `proxied` optional boolean for Cloudflare proxy
 *
 * The rules here are the browser/Node counterpart of the Rust validator in
 * `src-tauri/crates/bc-dns-tools/src/validate.rs` and follow its split: a value
 * is rejected only when it is unambiguously invalid for the record type, so a
 * local rule can never block a record Cloudflare would have accepted. Two
 * checks therefore stay out of this schema on purpose:
 *
 * - **which types may be proxied** — provider- and plan-specific, so Cloudflare
 *   stays the authority (the Rust validator omits it for the same reason). The
 *   CLI reports it as its own check.
 * - **CNAME owner-name collisions** (RFC 1034 §3.6.2) — a whole-zone rule that
 *   cannot be decided from one record, so it lives in the CLI's cross-record
 *   pass instead.
 */
export const dnsRecordSchema = z
  .object({
    type: z.enum(RECORD_TYPES),
    name: z.string(),
    content: z.string(),
    ttl: z.union([z.literal("auto"), z.number().int()]).optional(),
    priority: z.number().int().optional(),
    proxied: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    // TTL: `1` is Cloudflare's "automatic", `0` is not a usable record TTL, and
    // the wire field is 31 bits wide. Plan-specific floors (Cloudflare's 60
    // second free-plan minimum) are deliberately not enforced here — they are
    // Cloudflare's to apply, and the CLI reports them as warnings.
    if (typeof val.ttl === "number") {
      if (val.ttl < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "TTL must be 1 for automatic or a positive number of seconds",
        });
      } else if (val.ttl > MAX_TTL_SECONDS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `TTL must be at most ${MAX_TTL_SECONDS} seconds`,
        });
      }
    }
    // MX records should provide an integer priority
    if (val.type === "MX") {
      if (typeof val.priority !== "number" || !Number.isInteger(val.priority)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MX records must include an integer priority",
        });
      }
      // MX content should be a simple hostname — no spaces
      if (
        typeof val.content !== "string" ||
        val.content.trim().length === 0 ||
        /\s+/.test(val.content)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MX content must be a non-empty hostname with no spaces",
        });
      }
    }
    // A/AAAA content validation
    if (val.type === "A") {
      if (typeof val.content !== "string" || net.isIP(val.content) !== 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A record content must be a valid IPv4 address",
        });
      }
    }
    if (val.type === "AAAA") {
      if (typeof val.content !== "string" || net.isIP(val.content) !== 6) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AAAA record content must be a valid IPv6 address",
        });
      }
    }
    // SRV record content is "priority weight port target" in presentation form.
    //
    // Cloudflare, however, commonly returns SRV content as the three fields
    // "weight port target" and carries the priority in its own `priority`
    // column — the same shape `record-copy.ts` and `export-api.ts` each handle
    // explicitly. That record is valid, so it is accepted here whenever a
    // separate integer `priority` is present. Three fields *without* a priority
    // stays an error: the priority is then genuinely missing.
    if (val.type === "SRV") {
      const fields = String(val.content).trim().split(/\s+/u);
      const hasSeparatePriority =
        typeof val.priority === "number" && Number.isInteger(val.priority);
      // How many leading numeric fields the content is expected to carry.
      const numericFields = fields.length === 3 && hasSeparatePriority ? 2 : 3;
      const wellFormed =
        fields.length === numericFields + 1 &&
        fields.slice(0, numericFields).every((field) => /^\d+$/u.test(field)) &&
        fields[numericFields].length > 0;
      if (!wellFormed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'SRV content must be: "priority weight port target", or ' +
            '"weight port target" when the priority is a separate field',
        });
      }
    }
    // TLSA record: usage selector matching-type data
    if (val.type === "TLSA") {
      const tlsaRe = /^\s*\d+\s+\d+\s+\d+\s+\S+\s*$/;
      if (!tlsaRe.test(String(val.content))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TLSA content must be: "usage selector matching-type data"',
        });
      }
    }
    // SSHFP record: algorithm fptype fingerprint
    if (val.type === "SSHFP") {
      const sshfpRe = /^\s*\d+\s+\d+\s+[0-9A-Fa-f]+\s*$/;
      if (!sshfpRe.test(String(val.content))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SSHFP content must be: "algorithm fptype fingerprint"',
        });
      }
    }
    // NAPTR record: order preference flags service regexp replacement
    if (val.type === "NAPTR") {
      // Tokenised by the same parser the rest of the app reads NAPTR content
      // with. A second tokeniser here would be a second definition of what a
      // NAPTR record *is*, and content accepted under the weaker of the two
      // would be re-read as something else everywhere downstream.
      const parsed = parseNAPTR(val.content);
      if (parsed.order === undefined || parsed.preference === undefined) {
        // `parseNAPTR` is the only thing that decides acceptance. The two
        // checks below refine the *message* for the most common mistakes; they
        // can never accept content the parser rejected.
        const [rawOrder, rawPreference] = String(val.content)
          .trim()
          .split(/[ \t]+/u);
        const isUint16Field = (field?: string) =>
          field !== undefined &&
          /^\d{1,5}$/u.test(field) &&
          Number(field) <= 65_535;
        if (!isUint16Field(rawOrder)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR order must be an integer in 0-65535",
          });
        } else if (!isUint16Field(rawPreference)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR preference must be an integer in 0-65535",
          });
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'NAPTR content must be: "order preference flags service regexp ' +
              'replacement" — exactly six fields, with no raw control ' +
              "characters, line breaks, or over-long fields",
          });
        }
      } else {
        // flags should be non-empty and single token
        if (
          !parsed.flags ||
          parsed.flags.trim() === "" ||
          /\s/u.test(parsed.flags)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR flags must be a non-empty token",
          });
        }
        // service should be a non-empty token and not contain spaces
        if (
          !parsed.service ||
          parsed.service.trim() === "" ||
          /\s/u.test(parsed.service)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR service must be a non-empty token",
          });
        }
        // REGEXP and REPLACEMENT are mutually exclusive (RFC 3403 §4.1), so an
        // empty REGEXP is not just legal but required for the terminal `S`/`A`
        // flag forms — `100 10 "S" "SIP+D2U" "" _sip._udp.example.com.` is a
        // valid record. The previous rule only appeared to allow it because the
        // local tokeniser kept the `""` quotes in the field value and so never
        // saw the field as empty. It is now the pair that must not be empty.
        if (
          (!parsed.regexp || parsed.regexp.trim() === "") &&
          (!parsed.replacement || parsed.replacement.trim() === "")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR regexp and replacement must not both be empty",
          });
        }
        // replacement should be a domain (or @)
        if (!parsed.replacement || parsed.replacement.trim() === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR replacement must be a non-empty token",
          });
        }
      }
    }
    // Hostname-like records: CNAME, NS, PTR, ALIAS, ANAME - basic hostname validation
    if (["CNAME", "NS", "PTR", "ALIAS", "ANAME"].includes(String(val.type))) {
      const hostnameRe =
        /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)\.?$/;
      if (!hostnameRe.test(String(val.content))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${val.type} content must be a valid hostname`,
        });
      }
    }
    // SPF record validation (simple): must start with v=spf1 and parse okay
    if (String(val.type) === "SPF") {
      const v = validateSPF(val.content);
      if (!v.ok) {
        for (const p of v.problems) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `SPF: ${p}` });
        }
      }
    }
  });

export type DNSRecordInput = z.infer<typeof dnsRecordSchema>;
