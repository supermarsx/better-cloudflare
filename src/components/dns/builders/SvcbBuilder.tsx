import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { BuilderWarningsChange, RecordDraft } from "./types";

type SvcParam = {
  id: string;
  key: string;
  value: string;
  mode: "keyValue" | "flag";
};

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeDnsName(value: string) {
  const v = value.trim();
  if (v === ".") return ".";
  return v.replace(/\.$/, "");
}

function isValidDnsLabel(label: string) {
  if (!label) return false;
  if (label.length > 63) return false;
  if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return true;
}

function looksLikeHostname(value: string) {
  const v = normalizeDnsName(value);
  if (!v) return false;
  if (v === ".") return true;
  if (/\s/.test(v)) return false;
  if (v.length > 253) return false;
  if (v.includes("..")) return false;
  if (v.includes("://") || v.includes("/")) return false;
  const labels = v.split(".");
  if (labels.some((l) => l.length === 0)) return false;
  return labels.every(isValidDnsLabel);
}

function isHex(value: string) {
  return /^[0-9a-fA-F]+$/.test(value);
}

function isBase64Like(value: string) {
  if (!value) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return true;
}

function isValidIPv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

function isValidIPv6(value: string) {
  if (!value.includes(":")) return false;
  if (!/^[0-9a-fA-F:]+$/.test(value)) return false;
  const double = value.includes("::");
  if (double && value.indexOf("::") !== value.lastIndexOf("::")) return false;
  const groups = value.split(":").filter((g) => g.length > 0);
  if (groups.some((g) => g.length > 4)) return false;
  return double ? groups.length <= 7 : groups.length === 8;
}

function normalizeIPv6(value: string) {
  const input = value.trim().toLowerCase();
  if (!isValidIPv6(input)) return null;
  const hasDouble = input.includes("::");
  const parts = input.split("::");
  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = hasDouble && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const leftNums = left.map((g) => Number.parseInt(g, 16));
  const rightNums = right.map((g) => Number.parseInt(g, 16));
  if (
    leftNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ||
    rightNums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)
  )
    return null;
  const total = leftNums.length + rightNums.length;
  if (!hasDouble && total !== 8) return null;
  if (hasDouble && total > 8) return null;
  const fill = hasDouble ? new Array(8 - total).fill(0) : [];
  return [...leftNums, ...fill, ...rightNums];
}

function ipv6InPrefix(value: string, base: string, prefix: number) {
  const v = normalizeIPv6(value);
  const b = normalizeIPv6(base);
  if (!v || !b) return false;
  let bits = prefix;
  for (let i = 0; i < 8; i++) {
    if (bits <= 0) return true;
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : ((0xffff << (16 - take)) & 0xffff);
    if ((v[i] & mask) !== (b[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

function ipv4ToInt(value: string) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
  const parts = value.split(".").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (
    ((parts[0] << 24) >>> 0) |
    ((parts[1] << 16) >>> 0) |
    ((parts[2] << 8) >>> 0) |
    (parts[3] >>> 0)
  ) >>> 0;
}

function ipv4InCidr(value: string, base: string, prefix: number) {
  const v = ipv4ToInt(value);
  const b = ipv4ToInt(base);
  if (v === null || b === null) return false;
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1) >>> 0) >>> 0;
  return ((v & mask) >>> 0) === ((b & mask) >>> 0);
}

function quoteIfNeeded(value: string) {
  const v = value ?? "";
  if (!v) return '""';
  if (/\s/.test(v) || /"/.test(v))
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return v;
}

function splitTokens(value: string) {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== "\\") {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (current.trim()) tokens.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function unquote(value: string) {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    const inner = v.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

function parseSvcbContent(content?: string) {
  const raw = (content ?? "").trim();
  if (!raw) {
    return {
      priority: undefined as number | undefined,
      target: "",
      params: [] as SvcParam[],
      extra: "",
    };
  }

  const tokens = splitTokens(raw);
  const priorityStr = tokens[0];
  const target = tokens[1] ?? "";
  const priority = priorityStr && /^\d+$/.test(priorityStr)
    ? Number.parseInt(priorityStr, 10)
    : undefined;

  const params: SvcParam[] = [];
  const extras: string[] = [];
  for (const tok of tokens.slice(2)) {
    const eq = tok.indexOf("=");
    if (eq === -1) {
      params.push({ id: newId(), key: tok, value: "", mode: "flag" });
      continue;
    }
    const key = tok.slice(0, eq);
    const value = tok.slice(eq + 1);
    if (!key) {
      extras.push(tok);
      continue;
    }
    params.push({
      id: newId(),
      key,
      value: unquote(value),
      mode: "keyValue",
    });
  }

  return { priority, target: unquote(target), params, extra: extras.join(" ") };
}

function composeSvcb(priority?: number, target?: string, params?: SvcParam[]) {
  const parts: string[] = [];
  if (priority !== undefined && !Number.isNaN(Number(priority)))
    parts.push(String(priority));
  const t = (target ?? "").trim();
  if (t) parts.push(t === "." ? "." : normalizeDnsName(t));

  for (const p of params ?? []) {
    const key = (p.key ?? "").trim();
    if (!key) continue;
    if (p.mode === "flag") {
      parts.push(key);
      continue;
    }
    const v = (p.value ?? "").trim();
    parts.push(`${key}=${quoteIfNeeded(v)}`);
  }
  return parts.join(" ").trim();
}

const PARAM_PRESETS = [
  { value: "alpn", label: "alpn", mode: "keyValue" as const },
  { value: "port", label: "port", mode: "keyValue" as const },
  { value: "ipv4hint", label: "ipv4hint", mode: "keyValue" as const },
  { value: "ipv6hint", label: "ipv6hint", mode: "keyValue" as const },
  { value: "ech", label: "ech", mode: "keyValue" as const },
  { value: "dohpath", label: "dohpath", mode: "keyValue" as const },
  { value: "mandatory", label: "mandatory", mode: "keyValue" as const },
  { value: "no-default-alpn", label: "no-default-alpn", mode: "flag" as const },
  { value: "custom", label: "Custom…", mode: "keyValue" as const },
] as const;

export function SvcbBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [priority, setPriority] = useState<number | undefined>(undefined);
  const [target, setTarget] = useState<string>("");
  const [params, setParams] = useState<SvcParam[]>([]);

  const kind = record.type === "HTTPS" ? "HTTPS" : "SVCB";

  useEffect(() => {
    if (record.type !== "SVCB" && record.type !== "HTTPS") return;
    const parsed = parseSvcbContent(record.content);
    setPriority(parsed.priority);
    setTarget(parsed.target);
    setParams(parsed.params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "SVCB" && record.type !== "HTTPS") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const p = priority;
    const t = (target ?? "").trim();
    if (p === undefined) push(issues, `${kind}: priority is required.`);
    else if (p < 0 || p > 65535) push(issues, `${kind}: priority must be 0–65535.`);

    if (!t) push(issues, `${kind}: target name is required (use "." for alias mode).`);
    if (t && t !== "." && !looksLikeHostname(t))
      push(issues, `${kind}: target name does not look like a hostname (or ".").`);

    if (p === 0 && params.length > 0)
      push(issues, `${kind}: priority 0 is alias mode; svcparams are usually not allowed.`);

    // Validate known parameters
    const keyCounts = new Map<string, number>();
    for (const param of params) {
      const key = (param.key ?? "").trim();
      if (!key) continue;
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    for (const [k, c] of keyCounts.entries()) {
      if (c > 1 && k !== "ipv4hint" && k !== "ipv6hint")
        push(issues, `${kind}: parameter "${k}" appears multiple times.`);
    }

    const mandatory = params.find((x) => x.key === "mandatory" && x.mode === "keyValue");
    if (mandatory) {
      const raw = (mandatory.value ?? "").trim();
      const keys = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const k of keys) {
        if (!keyCounts.has(k))
          push(issues, `${kind}: mandatory includes "${k}" but that parameter is missing.`);
      }
      if (keys.length === 0) push(issues, `${kind}: mandatory value is empty.`);
    }

    const alpn = params.find((x) => x.key === "alpn" && x.mode === "keyValue");
    const noDefault = params.some((x) => x.key === "no-default-alpn" && x.mode === "flag");
    if (noDefault && !alpn) push(issues, `${kind}: no-default-alpn is set but alpn is missing.`);
    if (alpn) {
      const tokens = alpn.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (tokens.length === 0) push(issues, `${kind}: alpn value is empty.`);
    }

    const port = params.find((x) => x.key === "port" && x.mode === "keyValue");
    if (port) {
      const n = Number.parseInt(port.value.trim(), 10);
      if (port.value.trim() === "") push(issues, `${kind}: port value is empty.`);
      else if (Number.isNaN(n) || n < 1 || n > 65535)
        push(issues, `${kind}: port should be 1–65535.`);
    }

    const ipv4hint = params.filter((x) => x.key === "ipv4hint" && x.mode === "keyValue");
    for (const h of ipv4hint) {
      const ips = h.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ips.length === 0) push(issues, `${kind}: ipv4hint is empty.`);
      for (const ip of ips) {
        if (!isValidIPv4(ip)) push(issues, `${kind}: ipv4hint contains invalid IPv4 "${ip}".`);
        else {
          if (ipv4InCidr(ip, "10.0.0.0", 8))
            push(issues, `${kind}: ipv4hint includes private IPv4 (10.0.0.0/8).`);
          else if (ipv4InCidr(ip, "172.16.0.0", 12))
            push(issues, `${kind}: ipv4hint includes private IPv4 (172.16.0.0/12).`);
          else if (ipv4InCidr(ip, "192.168.0.0", 16))
            push(issues, `${kind}: ipv4hint includes private IPv4 (192.168.0.0/16).`);
          else if (ipv4InCidr(ip, "127.0.0.0", 8))
            push(issues, `${kind}: ipv4hint includes loopback IPv4 (127.0.0.0/8).`);
          else if (ipv4InCidr(ip, "169.254.0.0", 16))
            push(issues, `${kind}: ipv4hint includes link-local IPv4 (169.254.0.0/16).`);
        }
      }
    }

    const ipv6hint = params.filter((x) => x.key === "ipv6hint" && x.mode === "keyValue");
    for (const h of ipv6hint) {
      const ips = h.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ips.length === 0) push(issues, `${kind}: ipv6hint is empty.`);
      for (const ip of ips) {
        if (!isValidIPv6(ip)) push(issues, `${kind}: ipv6hint contains invalid IPv6 "${ip}".`);
        else {
          const c = ip.toLowerCase();
          if (c === "::") push(issues, `${kind}: ipv6hint includes unspecified IPv6 (::).`);
          else if (c === "::1") push(issues, `${kind}: ipv6hint includes loopback IPv6 (::1).`);
          else if (ipv6InPrefix(c, "fc00::", 7))
            push(issues, `${kind}: ipv6hint includes unique local IPv6 (fc00::/7).`);
          else if (ipv6InPrefix(c, "fe80::", 10))
            push(issues, `${kind}: ipv6hint includes link-local IPv6 (fe80::/10).`);
          else if (ipv6InPrefix(c, "2001:db8::", 32))
            push(issues, `${kind}: ipv6hint includes documentation IPv6 (2001:db8::/32).`);
        }
      }
    }

    const ech = params.find((x) => x.key === "ech" && x.mode === "keyValue");
    if (ech) {
      const b64 = ech.value.trim();
      if (!b64) push(issues, `${kind}: ech value is empty.`);
      else if (!isBase64Like(b64)) push(issues, `${kind}: ech does not look like base64.`);
      else if (b64.length % 4 !== 0) push(issues, `${kind}: ech base64 length is unusual.`);
    }

    const dohpath = params.find((x) => x.key === "dohpath" && x.mode === "keyValue");
    if (dohpath) {
      const v = dohpath.value.trim();
      if (!v) push(issues, `${kind}: dohpath is empty.`);
      if (v && !v.startsWith("/"))
        push(issues, `${kind}: dohpath usually starts with "/" (e.g., "/dns-query{?dns}").`);
      if (v && /\s/.test(v)) push(issues, `${kind}: dohpath contains spaces.`);
    }

    // Warn about unknown keys that look suspicious
    for (const param of params) {
      const key = (param.key ?? "").trim();
      if (!key) push(issues, `${kind}: parameter key is empty.`);
      if (key && !/^[a-z0-9-]+$/.test(key))
        push(issues, `${kind}: parameter key "${key}" contains unusual characters.`);
      if (param.mode === "keyValue") {
        const v = (param.value ?? "").trim();
        if (key && v === "" && key !== "mandatory")
          push(issues, `${kind}: parameter "${key}" has an empty value.`);
      }
    }

    const canonical = composeSvcb(priority, target, params);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical)
      push(issues, `${kind}: content differs from builder settings (Apply canonical to normalize).`);

    const name = (record.name ?? "").trim();
    if (!name)
      push(nameIssues, `${kind}: name is typically @ (apex) or a service label.`);

    return { canonical, issues, nameIssues };
  }, [kind, params, priority, record.content, record.name, record.type, target]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "SVCB" && record.type !== "HTTPS") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [
    diagnostics.canonical,
    diagnostics.issues,
    diagnostics.nameIssues,
    onWarningsChange,
    record.type,
  ]);

  if (record.type !== "SVCB" && record.type !== "HTTPS") return null;

  const apply = (next: {
    priority?: number;
    target?: string;
    params?: SvcParam[];
  }) => {
    const has = (k: keyof typeof next) =>
      Object.prototype.hasOwnProperty.call(next, k);
    const pr = has("priority") ? next.priority : priority;
    const tg = has("target") ? next.target : target;
    const ps = has("params") ? next.params ?? [] : params;
    onRecordChange({
      ...record,
      content: composeSvcb(pr, tg, ps),
    });
  };

  const addParam = (key: string, mode: SvcParam["mode"]) => {
    const next: SvcParam[] = [
      ...params,
      { id: newId(), key, value: "", mode },
    ];
    setParams(next);
    apply({ params: next });
  };

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            {kind} builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>priority target params…</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Priority</Label>
            <Input
              type="number"
              placeholder="1"
              value={priority ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value;
                const val = raw === "" ? undefined : Number.parseInt(raw, 10);
                const next = Number.isNaN(Number(val)) ? undefined : val;
                setPriority(next);
                apply({ priority: next });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              0 = alias mode; &gt;0 = service mode. Lower wins.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-4">
            <Label className="text-xs">Target name</Label>
            <Input
              placeholder='e.g., svc.example.com or "."'
              value={target}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setTarget(e.target.value);
                apply({ target: e.target.value });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Hostname (no scheme/path). Use <code>.</code> for alias mode.
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-muted-foreground">
              Parameters
            </div>
            <Select
              value=""
              onValueChange={(value: string) => {
                if (!value) return;
                const preset = PARAM_PRESETS.find((p) => p.value === value);
                if (!preset) return;
                if (preset.value === "custom") {
                  addParam("", "keyValue");
                  return;
                }
                addParam(preset.value, preset.mode);
              }}
            >
              <SelectTrigger className="h-9 w-48">
                <SelectValue placeholder="Add param…" />
              </SelectTrigger>
              <SelectContent>
                {PARAM_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {params.length === 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              No parameters. Add common params like <code>alpn</code>, <code>port</code>,{" "}
              <code>ipv4hint</code>, <code>ipv6hint</code>, <code>ech</code>.
            </div>
          )}

          <div className="mt-2 space-y-2">
            {params.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-1 gap-2 sm:grid-cols-12"
              >
                <div className="sm:col-span-3">
                  <Input
                    placeholder="key"
                    value={p.key}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const next: SvcParam[] = params.map((x) =>
                        x.id === p.id ? { ...x, key: e.target.value } : x,
                      );
                      setParams(next);
                      apply({ params: next });
                    }}
                  />
                </div>

                <div className="sm:col-span-7">
                  {p.mode === "flag" ? (
                    <div className="flex h-9 items-center text-[11px] text-muted-foreground">
                      Flag parameter (no value).
                    </div>
                  ) : (
                    <Input
                      placeholder={
                        p.key === "alpn"
                          ? "e.g., h2,h3"
                          : p.key === "port"
                            ? "e.g., 443"
                            : p.key === "ipv4hint"
                              ? "e.g., 203.0.113.10,203.0.113.11"
                              : p.key === "ipv6hint"
                                ? "e.g., 2001:db8::1,2001:db8::2"
                                : p.key === "ech"
                                  ? "base64…"
                                  : p.key === "dohpath"
                                    ? "/dns-query{?dns}"
                                    : p.key === "mandatory"
                                      ? "e.g., alpn,port"
                                      : "value"
                      }
                      value={p.value}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        const next: SvcParam[] = params.map((x) =>
                          x.id === p.id ? { ...x, value: e.target.value } : x,
                        );
                        setParams(next);
                        apply({ params: next });
                      }}
                    />
                  )}
                </div>

                <div className="sm:col-span-2 flex items-center justify-end gap-2">
                  <Select
                    value={p.mode}
                    onValueChange={(value: string) => {
                      const mode = value === "flag" ? "flag" : "keyValue";
                      const next: SvcParam[] = params.map((x) =>
                        x.id === p.id
                          ? {
                              ...x,
                              mode,
                              value: mode === "flag" ? "" : x.value,
                            }
                          : x,
                      );
                      setParams(next);
                      apply({ params: next });
                    }}
                  >
                    <SelectTrigger className="h-9 w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keyValue">key=value</SelectItem>
                      <SelectItem value="flag">flag</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = params.filter((x) => x.id !== p.id);
                      setParams(next);
                      apply({ params: next });
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseSvcbContent(record.content);
              setPriority(parsed.priority);
              setTarget(parsed.target);
              setParams(parsed.params);
            }}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            onClick={() => onRecordChange({ ...record, content: diagnostics.canonical })}
          >
            Apply canonical to content
          </Button>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Preview (canonical)
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
            {diagnostics.canonical}
          </pre>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Recommendations
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              Use <code>alpn=h2,h3</code> to advertise HTTP/2 and HTTP/3.
            </li>
            <li>
              Use <code>port=443</code> if the service is not on the default port.
            </li>
            <li>
              Use <code>ipv4hint</code>/<code>ipv6hint</code> to speed up connection setup.
            </li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">{kind} warnings</div>
            <div className="scrollbar-themed mt-2 max-h-40 overflow-auto pr-2">
              <ul className="list-disc pl-5 text-xs text-foreground/85">
                {diagnostics.nameIssues.map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {diagnostics.issues.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

