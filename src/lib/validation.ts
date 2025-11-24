import { z } from "zod";
import net from "net";
import { validateSPF } from "./spf";
import { RECORD_TYPES } from "../types/dns";

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
    // SRV record content should be: priority weight port target
    if (val.type === "SRV") {
      const srvRe = /^\s*\d+\s+\d+\s+\d+\s+\S+\s*$/;
      if (!srvRe.test(String(val.content))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SRV content must be: "priority weight port target"',
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
      const splitNaptrTokens = (s: string) => {
        const tokens: string[] = [];
        let current = "";
        let inQuote = false;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch === '"') {
            inQuote = !inQuote;
            current += ch;
            continue;
          }
          if (ch === " " && !inQuote) {
            if (current.trim().length > 0) {
              tokens.push(current.trim());
              current = "";
            }
            continue;
          }
          current += ch;
        }
        if (current.trim().length > 0) tokens.push(current.trim());
        return tokens;
      };
      const parts = splitNaptrTokens(String(val.content).trim());
      if (parts.length < 6) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'NAPTR content must be: "order preference flags service regexp replacement"',
        });
      } else {
        if (!/^\d+$/.test(parts[0])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR order must be an integer",
          });
        }
        if (!/^\d+$/.test(parts[1])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR preference must be an integer",
          });
        }
        // flags should be non-empty and single token
        if (
          !parts[2] ||
          typeof parts[2] !== "string" ||
          parts[2].trim() === ""
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR flags must be a non-empty token",
          });
        }
        // service should be a non-empty token and not contain spaces
        if (
          !parts[3] ||
          typeof parts[3] !== "string" ||
          parts[3].trim() === "" ||
          /\s/.test(parts[3])
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR service must be a non-empty token",
          });
        }
        // regexp should be a quoted string or slash-delimited regex
        if (
          !parts[4] ||
          typeof parts[4] !== "string" ||
          parts[4].trim() === ""
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "NAPTR regexp must be non-empty",
          });
        }
        // replacement should be a domain (or @)
        if (
          !parts[5] ||
          typeof parts[5] !== "string" ||
          parts[5].trim() === ""
        ) {
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
