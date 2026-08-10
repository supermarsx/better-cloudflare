import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import { humanizeSeconds } from "./describe-utils";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function parseSOAContent(value: string | undefined) {
  const raw = (value ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const parts = raw ? raw.split(" ").filter(Boolean) : [];
  const [mname, rname, serial, refresh, retry, expire, minimum] = parts;
  const toNum = (v: string | undefined) => {
    if (!v) return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  return {
    mname: mname ?? "",
    rname: rname ?? "",
    serial: toNum(serial),
    refresh: toNum(refresh),
    retry: toNum(retry),
    expire: toNum(expire),
    minimum: toNum(minimum),
    fieldCount: parts.length,
  };
}

function emailToRname(value: string) {
  const v = value.trim();
  if (!v) return "";
  if (v.includes("@")) {
    const [local, domain] = v.split("@");
    if (!domain) return normalizeDnsName(v.replace("@", "."));
    return normalizeDnsName(`${local}.${domain}`);
  }
  return normalizeDnsName(v);
}

function composeSOA(fields: {
  mname: string;
  rname: string;
  serial: number | undefined;
  refresh: number | undefined;
  retry: number | undefined;
  expire: number | undefined;
  minimum: number | undefined;
}) {
  const parts = [
    normalizeDnsName(fields.mname),
    normalizeDnsName(fields.rname),
    fields.serial,
    fields.refresh,
    fields.retry,
    fields.expire,
    fields.minimum,
  ].map((p) => String(p ?? "").trim());

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Read an SOA RNAME back as an email address: the first dot stands in for the
 * `@`, so `hostmaster.example.com` is `hostmaster@example.com`.
 */
function rnameToEmail(value: string) {
  const v = normalizeDnsName(value);
  if (!v) return "";
  if (v.includes("@")) return v;
  const dot = v.indexOf(".");
  if (dot <= 0) return v;
  return `${v.slice(0, dot)}@${v.slice(dot + 1)}`;
}

export type SoaFields = {
  mname: string;
  /** Either an email address or the DNS-name (RNAME) form of one. */
  admin: string;
  serial: number | undefined;
  refresh: number | undefined;
  retry: number | undefined;
  expire: number | undefined;
  minimum: number | undefined;
};

/**
 * Plain-English description of the zone parameters this SOA sets.
 *
 * The timer wording follows RFC 1035 §3.3.13 and RFC 2308: `minimum` is the
 * negative caching TTL, not a default TTL for the zone's records, and saying so
 * is the main thing this summary is for.
 */
export function describeSOA(fields: SoaFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const mname = normalizeDnsName(fields.mname);
  const rname = emailToRname(fields.admin);
  const email = rnameToEmail(rname);

  const headline =
    mname || email
      ? `Declares ${mname || "the nameserver named here"} to be the primary nameserver holding the master copy of this zone and ${email || "the contact named here"} to be its administrative contact, and sets the timers secondary nameservers follow when copying the zone.`
      : "Declares which nameserver holds the master copy of this zone, who administers it, and the timers secondary nameservers follow when copying it.";

  if (rname.includes(".")) {
    details.push(
      `The contact is stored as ${rname}: an SOA has no room for an @, so the first dot stands in for it and this means ${email}.`,
    );
  }

  if (fields.serial !== undefined) {
    details.push(
      `Serial ${fields.serial} is the version number a secondary compares against its own copy; it only transfers the zone again once this number increases, so it has to be raised on every change.`,
    );
  }
  if (fields.refresh !== undefined) {
    details.push(
      `A secondary checks the primary for a higher serial every ${humanizeSeconds(fields.refresh)}.`,
    );
  }
  if (fields.retry !== undefined) {
    details.push(
      `When that check fails, the secondary retries every ${humanizeSeconds(fields.retry)} rather than waiting for the next refresh.`,
    );
  }
  if (fields.expire !== undefined) {
    details.push(
      `A secondary that has been unable to reach the primary for ${humanizeSeconds(fields.expire)} stops answering for the zone entirely, instead of serving data it can no longer confirm.`,
    );
  }
  if (fields.minimum !== undefined) {
    details.push(
      `Minimum is the negative caching TTL: resolvers remember a “this name does not exist” answer for up to ${humanizeSeconds(fields.minimum)}, capped by this record's own TTL. Despite the name it is not a default TTL for the zone's records.`,
    );
  }
  details.push(
    "Secondaries are normally also told about changes by NOTIFY, so a raised serial usually propagates well before the refresh timer next expires.",
  );

  unknowns.push(
    "Whether these values take effect depends on the DNS provider; many generate and manage the SOA themselves and ignore or reject edits to it.",
  );

  return { headline, details, unknowns };
}

export function SoaBuilder({
  record,
  onRecordChange,
  zoneName,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  zoneName?: string;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [mname, setMname] = useState<string>("");
  const [admin, setAdmin] = useState<string>("");
  const [serial, setSerial] = useState<number | undefined>(undefined);
  const [refresh, setRefresh] = useState<number | undefined>(undefined);
  const [retry, setRetry] = useState<number | undefined>(undefined);
  const [expire, setExpire] = useState<number | undefined>(undefined);
  const [minimum, setMinimum] = useState<number | undefined>(undefined);

  const { fieldIds, helpIds } = useBuilderFieldIds([
    "mname",
    "rname",
    "serial",
    "refresh",
    "retry",
    "expire",
    "minimum",
  ] as const);

  const summary = useMemo(
    () =>
      describeSOA({ mname, admin, serial, refresh, retry, expire, minimum }),
    [admin, expire, minimum, mname, refresh, retry, serial],
  );

  const didAutoDefaults = useRef(false);

  const apply = (
    next?: Partial<{
      mname: string;
      admin: string;
      serial: number | undefined;
      refresh: number | undefined;
      retry: number | undefined;
      expire: number | undefined;
      minimum: number | undefined;
    }>,
  ) => {
    const nextMname = next?.mname ?? mname;
    const nextAdmin = next?.admin ?? admin;
    const nextSerial = next?.serial ?? serial;
    const nextRefresh = next?.refresh ?? refresh;
    const nextRetry = next?.retry ?? retry;
    const nextExpire = next?.expire ?? expire;
    const nextMinimum = next?.minimum ?? minimum;
    onRecordChange({
      ...record,
      content: composeSOA({
        mname: nextMname,
        rname: emailToRname(nextAdmin),
        serial: nextSerial,
        refresh: nextRefresh,
        retry: nextRetry,
        expire: nextExpire,
        minimum: nextMinimum,
      }),
    });
  };

  useEffect(() => {
    if (record.type !== "SOA") return;
    const parsed = parseSOAContent(record.content);
    setMname(parsed.mname);
    setAdmin(parsed.rname);
    setSerial(parsed.serial);
    setRefresh(parsed.refresh);
    setRetry(parsed.retry);
    setExpire(parsed.expire);
    setMinimum(parsed.minimum);
    didAutoDefaults.current = false;
  }, [record.type, record.content]);

  useEffect(() => {
    if (record.type !== "SOA") return;
    const content = (record.content ?? "").trim();
    if (content) return;
    if (didAutoDefaults.current) return;
    didAutoDefaults.current = true;

    const zn = (zoneName ?? "").trim();
    const defaultMname = zn ? `ns1.${zn}` : "";
    const defaultRname = zn ? `hostmaster.${zn}` : "";
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const nextSerial = Number(`${y}${m}${d}01`);

    setMname(defaultMname);
    setAdmin(defaultRname);
    setSerial(nextSerial);
    setRefresh(7200);
    setRetry(3600);
    setExpire(1209600);
    setMinimum(3600);

    onRecordChange({
      ...record,
      name: (record.name ?? "").trim() ? record.name : "@",
      content: composeSOA({
        mname: defaultMname,
        rname: defaultRname,
        serial: nextSerial,
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minimum: 3600,
      }),
    });
  }, [
    onRecordChange,
    record,
    record.content,
    record.name,
    record.type,
    zoneName,
  ]);

  const validation = useMemo(() => {
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const fieldIssues: Record<
      "mname" | "rname" | "serial" | "refresh" | "retry" | "expire" | "minimum",
      string[]
    > = {
      mname: [],
      rname: [],
      serial: [],
      refresh: [],
      retry: [],
      expire: [],
      minimum: [],
    };
    const pushUnique = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const parsed = parseSOAContent(record.content);
    const soaName = (record.name ?? "").trim();

    const isValidDnsLabel = (label: string) => {
      if (!label) return false;
      if (label.length > 63) return false;
      if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
      if (label.startsWith("-") || label.endsWith("-")) return false;
      return true;
    };

    const isValidHostname = (value: string) => {
      const v = normalizeDnsName(value);
      if (!v) return false;
      if (v.length > 253) return false;
      if (/\s/.test(v)) return false;
      if (v.includes("://") || v.includes("/")) return false;
      const labels = v.split(".");
      if (labels.some((l) => l.length === 0)) return false;
      return labels.every(isValidDnsLabel);
    };

    if (parsed.fieldCount !== 7) {
      pushUnique(
        issues,
        "SOA content should have 7 fields: mname rname serial refresh retry expire minimum.",
      );
    }

    if (soaName && soaName !== "@") {
      pushUnique(nameIssues, 'SOA: name is typically "@".');
    }

    if (!parsed.mname) {
      pushUnique(fieldIssues.mname, "Primary NS (mname) is required.");
    } else {
      if (!isValidHostname(parsed.mname)) {
        pushUnique(fieldIssues.mname, "mname must be a valid hostname.");
      }
      if (!normalizeDnsName(parsed.mname).includes(".")) {
        pushUnique(
          fieldIssues.mname,
          "mname should usually be a FQDN (contain at least one dot).",
        );
      }
      if (normalizeDnsName(parsed.mname).includes("_")) {
        pushUnique(fieldIssues.mname, "mname should not contain underscores.");
      }
    }

    if (!parsed.rname) {
      pushUnique(fieldIssues.rname, "Admin (rname) is required.");
    } else {
      const r = normalizeDnsName(parsed.rname);
      if (r.includes("@")) {
        pushUnique(
          fieldIssues.rname,
          "rname must not contain @ (use DNS-name form).",
        );
      }
      if (!isValidHostname(r)) {
        pushUnique(
          fieldIssues.rname,
          "rname must be a valid DNS name (represents an email address).",
        );
      }
      if (!r.includes(".")) {
        pushUnique(
          fieldIssues.rname,
          "rname should usually contain a dot (like hostmaster.example.com).",
        );
      }
    }

    const validateUint32 = (
      n: number | undefined,
      label: keyof typeof fieldIssues,
    ) => {
      if (n === undefined) {
        pushUnique(
          fieldIssues[label],
          `${label} is required and must be a number.`,
        );
        return;
      }
      if (!Number.isFinite(n)) {
        pushUnique(fieldIssues[label], `${label} must be a finite number.`);
        return;
      }
      if (n < 0) pushUnique(fieldIssues[label], `${label} must be >= 0.`);
      if (n > 4294967295)
        pushUnique(fieldIssues[label], `${label} must be <= 4294967295.`);
    };

    validateUint32(parsed.serial, "serial");
    validateUint32(parsed.refresh, "refresh");
    validateUint32(parsed.retry, "retry");
    validateUint32(parsed.expire, "expire");
    validateUint32(parsed.minimum, "minimum");

    if (parsed.serial !== undefined) {
      const serialStr = String(parsed.serial);
      if (!/^\d{10}$/.test(serialStr)) {
        pushUnique(
          fieldIssues.serial,
          "Serial should commonly be YYYYMMDDnn (10 digits).",
        );
      }
    }

    const validateSecondsRange = (
      value: number | undefined,
      label: "refresh" | "retry" | "expire" | "minimum",
      min: number,
      max: number,
    ) => {
      if (value === undefined) return;
      if (value > 0 && (value < min || value > max)) {
        pushUnique(
          fieldIssues[label],
          `${label} is unusual; common range is ${min}–${max} seconds.`,
        );
      }
      if (value === 0) {
        pushUnique(fieldIssues[label], `${label} of 0 is unusual.`);
      }
    };

    validateSecondsRange(parsed.refresh, "refresh", 900, 86400);
    validateSecondsRange(parsed.retry, "retry", 300, 86400);
    validateSecondsRange(parsed.expire, "expire", 604800, 2419200);
    validateSecondsRange(parsed.minimum, "minimum", 60, 86400);

    if (
      parsed.refresh !== undefined &&
      parsed.retry !== undefined &&
      parsed.refresh > 0 &&
      parsed.retry > 0 &&
      parsed.retry >= parsed.refresh
    ) {
      pushUnique(fieldIssues.retry, "retry is usually less than refresh.");
    }
    if (
      parsed.expire !== undefined &&
      parsed.refresh !== undefined &&
      parsed.expire > 0 &&
      parsed.refresh > 0 &&
      parsed.expire <= parsed.refresh
    ) {
      pushUnique(
        fieldIssues.expire,
        "expire is usually much greater than refresh.",
      );
    }

    for (const msgs of Object.values(fieldIssues)) {
      for (const msg of msgs) pushUnique(issues, `SOA: ${msg}`);
    }

    const canonical = composeSOA({
      mname,
      rname: emailToRname(admin),
      serial,
      refresh,
      retry,
      expire,
      minimum,
    });

    return { issues, nameIssues, fieldIssues, canonical };
  }, [
    admin,
    expire,
    minimum,
    mname,
    record.content,
    record.name,
    refresh,
    retry,
    serial,
  ]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "SOA") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: validation.issues,
      nameIssues: validation.nameIssues,
      canonical: validation.canonical,
    });
  }, [
    onWarningsChange,
    record.type,
    validation.canonical,
    validation.issues,
    validation.nameIssues,
  ]);

  if (record.type !== "SOA") return null;

  return (
    <div className="space-y-3">
      <RecordSummary summary={summary} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.mname}
            descriptionId={helpIds.mname}
            label="Primary NS (mname)"
            help="Hostname of the nameserver that holds the master copy of this zone and that secondaries transfer it from. Use a fully qualified hostname such as ns1.example.com."
          />
          <Input
            id={fieldIds.mname}
            aria-describedby={helpIds.mname}
            value={mname}
            placeholder="e.g., ns1.example.com"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const v = e.target.value;
              setMname(v);
              apply({ mname: v });
            }}
          />
          {validation.fieldIssues.mname.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.mname.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.rname}
            descriptionId={helpIds.rname}
            label="Admin email (rname)"
            help="Email address of the zone administrator. SOA stores it with the @ replaced by a dot, so hostmaster@example.com is written hostmaster.example.com; you can paste either form here."
          />
          <Input
            id={fieldIds.rname}
            aria-describedby={helpIds.rname}
            value={admin}
            placeholder="e.g., hostmaster@example.com"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const v = e.target.value;
              setAdmin(v);
              apply({ admin: v });
            }}
          />
          <div className="text-xs text-muted-foreground">
            You can paste an email; it will be converted to DNS-name form
            (replace <code>@</code> with a dot).
          </div>
          {validation.fieldIssues.rname.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.rname.join(" ")}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.serial}
            descriptionId={helpIds.serial}
            label="Serial"
            help="Version number of the zone. A secondary only transfers the zone again once this increases, so raise it on every change; ten digits in YYYYMMDDnn form is the usual convention."
          />
          <div className="flex gap-2">
            <Input
              id={fieldIds.serial}
              aria-describedby={helpIds.serial}
              type="number"
              value={serial ?? ""}
              placeholder="YYYYMMDDnn (e.g., 2026012601)"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setSerial(val);
                apply({ serial: val });
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const now = new Date();
                const y = now.getFullYear();
                const m = String(now.getMonth() + 1).padStart(2, "0");
                const d = String(now.getDate()).padStart(2, "0");
                const val = Number(`${y}${m}${d}01`);
                setSerial(val);
                apply({ serial: val });
              }}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const val = (serial ?? 0) + 1;
                setSerial(val);
                apply({ serial: val });
              }}
            >
              +1
            </Button>
          </div>
          {validation.fieldIssues.serial.length > 0 && (
            <div className="mt-1 text-xs text-red-600">
              {validation.fieldIssues.serial.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.refresh}
            descriptionId={helpIds.refresh}
            label="Refresh"
            help="How often, in seconds, a secondary checks the primary for a higher serial. Anything from 900 to 86400 is normal; 7200 is a sensible default."
          />
          <Input
            id={fieldIds.refresh}
            aria-describedby={helpIds.refresh}
            type="number"
            value={refresh ?? ""}
            placeholder="7200"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              const val = Number.isNaN(n) ? undefined : n;
              setRefresh(val);
              apply({ refresh: val });
            }}
          />
          <div className="text-xs text-muted-foreground">Seconds.</div>
          {validation.fieldIssues.refresh.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.refresh.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.retry}
            descriptionId={helpIds.retry}
            label="Retry"
            help="How long, in seconds, a secondary waits before retrying after a failed refresh check. It should be shorter than refresh; 3600 is typical."
          />
          <Input
            id={fieldIds.retry}
            aria-describedby={helpIds.retry}
            type="number"
            value={retry ?? ""}
            placeholder="3600"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              const val = Number.isNaN(n) ? undefined : n;
              setRetry(val);
              apply({ retry: val });
            }}
          />
          <div className="text-xs text-muted-foreground">Seconds.</div>
          {validation.fieldIssues.retry.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.retry.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.expire}
            descriptionId={helpIds.expire}
            label="Expire"
            help="How long, in seconds, a secondary keeps serving the zone while it cannot reach the primary, after which it stops answering for the zone entirely. One to four weeks is typical; 1209600 is two weeks."
          />
          <Input
            id={fieldIds.expire}
            aria-describedby={helpIds.expire}
            type="number"
            value={expire ?? ""}
            placeholder="1209600"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              const val = Number.isNaN(n) ? undefined : n;
              setExpire(val);
              apply({ expire: val });
            }}
          />
          <div className="text-xs text-muted-foreground">Seconds.</div>
          {validation.fieldIssues.expire.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.expire.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.minimum}
            descriptionId={helpIds.minimum}
            label="Minimum"
            help="The negative caching TTL in seconds: how long resolvers remember that a name in this zone does not exist. It is not a default TTL for records. 300 to 86400 is normal; 3600 is a sensible default."
          />
          <Input
            id={fieldIds.minimum}
            aria-describedby={helpIds.minimum}
            type="number"
            value={minimum ?? ""}
            placeholder="3600"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              const val = Number.isNaN(n) ? undefined : n;
              setMinimum(val);
              apply({ minimum: val });
            }}
          />
          <div className="text-xs text-muted-foreground">
            Seconds (negative caching TTL in modern DNS).
          </div>
          {validation.fieldIssues.minimum.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.minimum.join(" ")}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="text-xs font-semibold text-muted-foreground">
          Preview (content)
        </div>
        <pre className="mt-1 whitespace-pre-wrap text-xs">
          {validation.canonical}
        </pre>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRecordChange({ ...record, name: "@" })}
          >
            Use @ name
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const zn = (zoneName ?? "").trim();
              const nextMname = zn ? `ns1.${zn}` : mname;
              const nextAdmin = zn ? `hostmaster.${zn}` : admin;
              setMname(nextMname);
              setAdmin(nextAdmin);
              setRefresh(7200);
              setRetry(3600);
              setExpire(1209600);
              setMinimum(3600);
              apply({
                mname: nextMname,
                admin: nextAdmin,
                refresh: 7200,
                retry: 3600,
                expire: 1209600,
                minimum: 3600,
              });
            }}
          >
            Common defaults
          </Button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        Many DNS providers manage SOA automatically; changes may be ignored or
        rejected. This tool still lets you submit it.
      </div>
    </div>
  );
}
