/**
 * Offline validation for DNS records read from a file.
 *
 * The rule set is `src/lib/dns/validation.ts` — the repository's zod schema,
 * which until now had no production importer because it does
 * `import net from "node:net"` and therefore could never evaluate in the
 * browser renderer. In a Node CLI that import is unremarkable, so the schema is
 * used here as-is rather than duplicated.
 *
 * Around the schema sit the checks Cloudflare enforces at the API boundary but
 * the schema deliberately leaves to it: the plan TTL range (a warning, not an
 * error), proxiable record types, name shape, zone containment, and the RFC
 * 1034 rule that a CNAME may not share its owner name with any other record —
 * a whole-file rule no single-record schema can decide. Every finding carries
 * the source line or record index so a migration can be checked before a live
 * zone is touched.
 */
import type { DNSRecord } from "../../src/types/dns";
import { dnsRecordSchema } from "../../src/lib/dns/validation";
import type { SourceRecord } from "./records";

export type Severity = "error" | "warning";

/** One reason a record would be rejected, or one thing worth knowing about it. */
export interface ValidationIssue {
  severity: Severity;
  message: string;
}

/** Everything found about a single record. */
export interface RecordReport {
  index: number;
  line: number | null;
  /** `TYPE name` when known, for display next to the location. */
  label: string;
  issues: ValidationIssue[];
}

/** The result of validating a whole file. */
export interface ValidationReport {
  recordCount: number;
  reports: RecordReport[];
  errorCount: number;
  warningCount: number;
  /**
   * Behaviour of the shared rule set that the operator should know about — a
   * rule that was relaxed, or an input that was reinterpreted before it was
   * checked. Nothing of that kind is applied silently.
   */
  notes: string[];
}

/** Options that only apply when the caller knows the destination zone. */
export interface ValidateOptions {
  /** Apex of the zone the records are destined for, if known. */
  zone?: string;
}

/** Cloudflare accepts `1` (automatic) or a TTL between these bounds. */
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;

/** Only these types may be served through the Cloudflare proxy. */
const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);

const DNS_LABEL = /^(?:\*|[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?)$/u;

function normalizeName(name: string): string {
  const trimmed = name.trim();
  const withoutRoot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  return withoutRoot.toLowerCase();
}

function checkName(name: string, issues: ValidationIssue[]): void {
  const bare = normalizeName(name);
  if (bare === "" || bare === "@") return;
  if (bare.length > 253) {
    issues.push({
      severity: "error",
      message: `name is ${bare.length} characters; the maximum is 253`,
    });
    return;
  }
  for (const label of bare.split(".")) {
    if (label.length === 0) {
      issues.push({ severity: "error", message: "name has an empty label" });
      return;
    }
    if (label.length > 63) {
      issues.push({
        severity: "error",
        message: `name label "${label}" is ${label.length} characters; the maximum is 63`,
      });
      return;
    }
    if (!DNS_LABEL.test(label)) {
      issues.push({
        severity: "error",
        message: `name label "${label}" is not a valid DNS label`,
      });
      return;
    }
  }
}

function checkTTL(ttl: unknown, issues: ValidationIssue[]): void {
  if (ttl === undefined || ttl === "auto" || ttl === 1) return;
  if (typeof ttl !== "number" || !Number.isInteger(ttl)) {
    issues.push({
      severity: "error",
      message: `ttl must be an integer or "auto"; got ${JSON.stringify(ttl)}`,
    });
    return;
  }
  if (ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    issues.push({
      severity: "warning",
      message: `ttl ${ttl} is outside Cloudflare's accepted range of ${MIN_TTL_SECONDS}-${MAX_TTL_SECONDS} seconds (or 1 for automatic)`,
    });
  }
}

function checkZoneContainment(
  name: string,
  zone: string,
  issues: ValidationIssue[],
): void {
  const bare = normalizeName(name);
  const apex = normalizeName(zone);
  if (bare === "" || bare === "@" || bare === apex) return;
  if (!bare.endsWith(`.${apex}`)) {
    issues.push({
      severity: "error",
      message: `name "${name}" is not inside zone "${zone}"`,
    });
  }
}

function labelFor(record: Partial<DNSRecord>): string {
  const type = record.type?.trim() || "?";
  const name = record.name?.trim() || "?";
  return `${type} ${name}`;
}

function validateOne(
  source: SourceRecord,
  options: ValidateOptions,
): RecordReport {
  const issues: ValidationIssue[] = [];
  const record = source.record;

  if (source.malformed) {
    issues.push({ severity: "error", message: source.malformed });
    return { index: source.index, line: source.line, label: "?", issues };
  }

  for (const field of ["type", "name", "content"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({
        severity: "error",
        message: `${field} is missing or empty`,
      });
    }
  }

  if (issues.length === 0) {
    const type = (record.type ?? "").toUpperCase();
    const parsed = dnsRecordSchema.safeParse({
      type,
      name: record.name,
      content: record.content,
      ...(record.ttl !== undefined ? { ttl: record.ttl } : {}),
      ...(record.priority !== undefined ? { priority: record.priority } : {}),
      ...(record.proxied !== undefined ? { proxied: record.proxied } : {}),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".");
        issues.push({
          severity: "error",
          message: path ? `${path}: ${issue.message}` : issue.message,
        });
      }
    }

    checkName(record.name ?? "", issues);
    checkTTL(record.ttl, issues);
    if (options.zone) {
      checkZoneContainment(record.name ?? "", options.zone, issues);
    }
    if (record.proxied === true && !PROXIABLE_TYPES.has(type)) {
      issues.push({
        severity: "error",
        message: `${type} records cannot be proxied; only ${[...PROXIABLE_TYPES].join(", ")} can`,
      });
    }
  }

  return {
    index: source.index,
    line: source.line,
    label: labelFor(record),
    issues,
  };
}

/**
 * Checks that need the whole file: a CNAME may not share its owner name with
 * any other record (RFC 1034 §3.6.2), and an exact duplicate of an earlier
 * record will be rejected as already existing.
 */
function checkAcrossRecords(
  sources: SourceRecord[],
  reports: RecordReport[],
): void {
  const byName = new Map<string, number[]>();
  const seen = new Map<string, number>();

  sources.forEach((source, position) => {
    if (source.malformed) return;
    const name = normalizeName(source.record.name ?? "");
    const type = (source.record.type ?? "").toUpperCase();
    const content = (source.record.content ?? "").trim();
    if (!name || !type) return;

    const positions = byName.get(name);
    if (positions) positions.push(position);
    else byName.set(name, [position]);

    const key = `${type}|${name}|${content.toLowerCase()}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, position);
      return;
    }
    const firstReport = reports[first];
    const where =
      firstReport.line === null
        ? `record ${firstReport.index}`
        : `line ${firstReport.line}`;
    reports[position].issues.push({
      severity: "warning",
      message: `duplicate of the record at ${where}`,
    });
  });

  for (const positions of byName.values()) {
    if (positions.length < 2) continue;
    const types = positions.map((position) =>
      (sources[position].record.type ?? "").toUpperCase(),
    );
    if (!types.includes("CNAME")) continue;
    const conflicting = types.some((type) => type !== "CNAME");
    for (const position of positions) {
      reports[position].issues.push({
        severity: "error",
        message: conflicting
          ? "a CNAME may not share its name with any other record (RFC 1034 §3.6.2)"
          : "a name may hold only one CNAME record",
      });
    }
  }
}

/** Validate every record in a loaded file. */
export function validateRecords(
  sources: SourceRecord[],
  options: ValidateOptions = {},
): ValidationReport {
  const reports = sources.map((source) => validateOne(source, options));
  checkAcrossRecords(sources, reports);

  let errorCount = 0;
  let warningCount = 0;
  for (const report of reports) {
    for (const issue of report.issues) {
      if (issue.severity === "error") errorCount++;
      else warningCount++;
    }
  }

  return {
    recordCount: sources.length,
    reports,
    errorCount,
    warningCount,
    // No rule is currently relaxed or reinterpreted: `dnsRecordSchema` accepts
    // Cloudflare's SRV shape directly, so nothing has to be compensated for
    // here. The field stays part of the report so the `--json` shape is stable.
    notes: [],
  };
}
