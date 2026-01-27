import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function parseSOAContent(value: string | undefined) {
  const raw = (value ?? "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  const didAutoDefaults = useRef(false);

  const apply = (next?: Partial<{
    mname: string;
    admin: string;
    serial: number | undefined;
    refresh: number | undefined;
    retry: number | undefined;
    expire: number | undefined;
    minimum: number | undefined;
  }>) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [onRecordChange, record, record.content, record.name, record.type, zoneName]);

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
        pushUnique(fieldIssues.rname, "rname must not contain @ (use DNS-name form).");
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
        pushUnique(fieldIssues[label], `${label} is required and must be a number.`);
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
        pushUnique(fieldIssues.serial, "Serial should commonly be YYYYMMDDnn (10 digits).");
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
      pushUnique(fieldIssues.expire, "expire is usually much greater than refresh.");
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
    record.type,
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
  }, [onWarningsChange, record.type, validation.canonical, validation.issues, validation.nameIssues]);

  if (record.type !== "SOA") return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Primary NS (mname)</Label>
          <Input
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
          <Label className="text-xs">Admin email (rname)</Label>
          <Input
            value={admin}
            placeholder="e.g., hostmaster@example.com"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const v = e.target.value;
              setAdmin(v);
              apply({ admin: v });
            }}
          />
          <div className="text-xs text-muted-foreground">
            You can paste an email; it will be converted to DNS-name form (replace{" "}
            <code>@</code> with a dot).
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
          <Label className="text-xs">Serial</Label>
          <div className="flex gap-2">
            <Input
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
          <Label className="text-xs">Refresh</Label>
          <Input
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
          <Label className="text-xs">Retry</Label>
          <Input
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
          <Label className="text-xs">Expire</Label>
          <Input
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
          <Label className="text-xs">Minimum</Label>
          <Input
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
        <pre className="mt-1 whitespace-pre-wrap text-xs">{validation.canonical}</pre>
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

