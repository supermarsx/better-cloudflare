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
import { Switch } from "@/components/ui/switch";

import type { BuilderWarningsChange, RecordDraft } from "./types";

type AplEntry = {
  id: string;
  negated: boolean;
  familyMode: "preset" | "custom";
  family: number | undefined;
  address: string;
  prefix: number | undefined;
};

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function parseAplContent(content?: string): AplEntry[] {
  const raw = (content ?? "")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return [];
  const tokens = raw.split(" ").filter(Boolean);
  return tokens.map((tok) => {
    const negated = tok.startsWith("!");
    const rest0 = negated ? tok.slice(1) : tok;
    const colonIdx = rest0.indexOf(":");
    const famStr = colonIdx >= 0 ? rest0.slice(0, colonIdx) : "";
    const rest = colonIdx >= 0 ? rest0.slice(colonIdx + 1) : rest0;
    const slashIdx = rest.indexOf("/");
    const addr = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
    const prefixStr = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "";
    const fam = Number.parseInt(famStr, 10);
    const prefix = Number.parseInt(prefixStr, 10);
    const family = Number.isNaN(fam) ? undefined : fam;
    const prefixVal = Number.isNaN(prefix) ? undefined : prefix;
    const familyMode: AplEntry["familyMode"] =
      family === 1 || family === 2 ? "preset" : "custom";
    return {
      id: newId(),
      negated,
      familyMode,
      family,
      address: addr ?? "",
      prefix: prefixVal,
    };
  });
}

function composeApl(entries: AplEntry[]) {
  return entries
    .map((e) => {
      const fam = e.family ?? 0;
      const addr = (e.address ?? "").trim();
      const prefix =
        e.prefix === undefined || Number.isNaN(Number(e.prefix))
          ? undefined
          : Number(e.prefix);
      const tail = prefix === undefined ? `${fam}:${addr}` : `${fam}:${addr}/${prefix}`;
      return `${e.negated ? "!" : ""}${tail}`.trim();
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function AplBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [entries, setEntries] = useState<AplEntry[]>([]);

  useEffect(() => {
    if (record.type !== "APL") return;
    setEntries(parseAplContent(record.content));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "APL") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    if (entries.length === 0) push(issues, "APL: add at least one address prefix entry.");

    for (const [idx, e] of entries.entries()) {
      const prefixTag = `APL entry ${idx + 1}:`;
      const fam = e.family;
      const addr = (e.address ?? "").trim();
      const pre = e.prefix;

      if (fam === undefined) push(issues, `${prefixTag} address family is required (1=IPv4, 2=IPv6).`);
      if (!addr) push(issues, `${prefixTag} address is required.`);
      if (pre === undefined) push(issues, `${prefixTag} prefix length is required (e.g., /24).`);

      if (fam === 1) {
        if (addr && !isValidIPv4(addr)) push(issues, `${prefixTag} IPv4 address is invalid.`);
        if (pre !== undefined && (pre < 0 || pre > 32))
          push(issues, `${prefixTag} IPv4 prefix must be 0–32.`);
        if (addr && isValidIPv4(addr)) {
          if (ipv4InCidr(addr, "10.0.0.0", 8)) push(issues, `${prefixTag} IPv4 is private (10.0.0.0/8).`);
          else if (ipv4InCidr(addr, "172.16.0.0", 12)) push(issues, `${prefixTag} IPv4 is private (172.16.0.0/12).`);
          else if (ipv4InCidr(addr, "192.168.0.0", 16)) push(issues, `${prefixTag} IPv4 is private (192.168.0.0/16).`);
          else if (ipv4InCidr(addr, "127.0.0.0", 8)) push(issues, `${prefixTag} IPv4 is loopback (127.0.0.0/8).`);
          else if (ipv4InCidr(addr, "169.254.0.0", 16)) push(issues, `${prefixTag} IPv4 is link-local (169.254.0.0/16).`);
          else if (ipv4InCidr(addr, "100.64.0.0", 10)) push(issues, `${prefixTag} IPv4 is CGNAT (100.64.0.0/10).`);
          else if (ipv4InCidr(addr, "192.0.2.0", 24)) push(issues, `${prefixTag} IPv4 is documentation (192.0.2.0/24).`);
          else if (ipv4InCidr(addr, "198.51.100.0", 24)) push(issues, `${prefixTag} IPv4 is documentation (198.51.100.0/24).`);
          else if (ipv4InCidr(addr, "203.0.113.0", 24)) push(issues, `${prefixTag} IPv4 is documentation (203.0.113.0/24).`);
          else if (ipv4InCidr(addr, "224.0.0.0", 4)) push(issues, `${prefixTag} IPv4 is multicast (224.0.0.0/4).`);
          else if (ipv4InCidr(addr, "240.0.0.0", 4)) push(issues, `${prefixTag} IPv4 is reserved (240.0.0.0/4).`);
        }
      } else if (fam === 2) {
        if (addr && !isValidIPv6(addr)) push(issues, `${prefixTag} IPv6 address is invalid.`);
        if (pre !== undefined && (pre < 0 || pre > 128))
          push(issues, `${prefixTag} IPv6 prefix must be 0–128.`);
        if (addr && isValidIPv6(addr)) {
          const c = addr.trim().toLowerCase();
          if (c === "::") push(issues, `${prefixTag} IPv6 is unspecified (::).`);
          else if (c === "::1") push(issues, `${prefixTag} IPv6 is loopback (::1).`);
          else if (ipv6InPrefix(c, "fc00::", 7)) push(issues, `${prefixTag} IPv6 is unique local (fc00::/7).`);
          else if (ipv6InPrefix(c, "fe80::", 10)) push(issues, `${prefixTag} IPv6 is link-local (fe80::/10).`);
          else if (ipv6InPrefix(c, "ff00::", 8)) push(issues, `${prefixTag} IPv6 is multicast (ff00::/8).`);
          else if (ipv6InPrefix(c, "2001:db8::", 32)) push(issues, `${prefixTag} IPv6 is documentation (2001:db8::/32).`);
          else if (ipv6InPrefix(c, "2002::", 16)) push(issues, `${prefixTag} IPv6 is 6to4 transition (2002::/16).`);
          else if (ipv6InPrefix(c, "64:ff9b::", 96)) push(issues, `${prefixTag} IPv6 is NAT64 well-known prefix (64:ff9b::/96).`);
        }
      } else if (fam !== undefined) {
        if (pre !== undefined && (pre < 0 || pre > 255))
          push(issues, `${prefixTag} prefix length looks unusual.`);
      }
    }

    const canonical = composeApl(entries);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical)
      push(issues, "APL: content differs from builder settings (Apply canonical to normalize).");

    const name = (record.name ?? "").trim();
    if (!name) push(nameIssues, "APL: name is typically a host label (e.g., @).");

    return { canonical, issues, nameIssues };
  }, [entries, record.content, record.name, record.type]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "APL") {
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

  if (record.type !== "APL") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            APL builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>[!]family:address/prefix ...</code>
          </div>
        </div>

        <div className="mt-2 space-y-3">
          {entries.length === 0 && (
            <div className="text-xs text-muted-foreground">
              No entries yet. Add an IPv4 or IPv6 prefix below.
            </div>
          )}

          {entries.map((e, idx) => (
            <div
              key={e.id}
              className="rounded-lg border border-border/50 bg-background/10 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-muted-foreground">
                  Entry {idx + 1}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = entries.filter((x) => x.id !== e.id);
                    setEntries(next);
                    onRecordChange({ ...record, content: composeApl(next) });
                  }}
                >
                  Remove
                </Button>
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-12">
                <div className="flex items-center gap-2 sm:col-span-2">
                    <Switch
                      checked={e.negated}
                      onCheckedChange={(checked: boolean) => {
                      const next: AplEntry[] = entries.map((x) =>
                        x.id === e.id ? { ...x, negated: checked } : x,
                      );
                      setEntries(next);
                      onRecordChange({ ...record, content: composeApl(next) });
                    }}
                  />
                  <div className="text-xs text-muted-foreground">Negate</div>
                </div>

                <div className="space-y-1 sm:col-span-3">
                  <Label className="text-xs">Family</Label>
                  <Select
                    value={
                      e.familyMode === "custom"
                        ? "custom"
                        : String(e.family ?? "")
                    }
                    onValueChange={(value: string) => {
                      if (value === "custom") {
                        const next: AplEntry[] = entries.map((x) =>
                          x.id === e.id
                            ? { ...x, familyMode: "custom" }
                            : x,
                        );
                        setEntries(next);
                        return;
                      }
                      const n = Number.parseInt(value, 10);
                      const fam = Number.isNaN(n) ? undefined : n;
                      const next: AplEntry[] = entries.map((x) =>
                        x.id === e.id
                          ? {
                              ...x,
                              family: fam,
                              familyMode:
                                fam === 1 || fam === 2 ? "preset" : "custom",
                            }
                          : x,
                      );
                      setEntries(next);
                      onRecordChange({ ...record, content: composeApl(next) });
                    }}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 (IPv4)</SelectItem>
                      <SelectItem value="2">2 (IPv6)</SelectItem>
                      <SelectItem value="custom">Custom…</SelectItem>
                    </SelectContent>
                  </Select>
                  {e.familyMode === "custom" && (
                    <Input
                      className="mt-2"
                      type="number"
                      placeholder="e.g., 1"
                      value={e.family ?? ""}
                      onChange={(ev) => {
                        const n = Number.parseInt(ev.target.value, 10);
                        const fam = Number.isNaN(n) ? undefined : n;
                        const next: AplEntry[] = entries.map((x) =>
                          x.id === e.id ? { ...x, family: fam } : x,
                        );
                        setEntries(next);
                        onRecordChange({ ...record, content: composeApl(next) });
                      }}
                    />
                  )}
                </div>

                <div className="space-y-1 sm:col-span-5">
                  <Label className="text-xs">Address</Label>
                  <Input
                    placeholder={e.family === 2 ? "e.g., 2001:db8::" : "e.g., 192.0.2.0"}
                    value={e.address}
                    onChange={(ev) => {
                      const next: AplEntry[] = entries.map((x) =>
                        x.id === e.id ? { ...x, address: ev.target.value } : x,
                      );
                      setEntries(next);
                      onRecordChange({ ...record, content: composeApl(next) });
                    }}
                  />
                </div>

                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Prefix</Label>
                  <Input
                    type="number"
                    placeholder={e.family === 2 ? "128" : "32"}
                    value={e.prefix ?? ""}
                    onChange={(ev) => {
                      const n = Number.parseInt(ev.target.value, 10);
                      const pre = Number.isNaN(n) ? undefined : n;
                      const next: AplEntry[] = entries.map((x) =>
                        x.id === e.id ? { ...x, prefix: pre } : x,
                      );
                      setEntries(next);
                      onRecordChange({ ...record, content: composeApl(next) });
                    }}
                  />
                </div>
              </div>
            </div>
          ))}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next: AplEntry[] = [
                  ...entries,
                  {
                    id: newId(),
                    negated: false,
                    familyMode: "preset",
                    family: 1,
                    address: "",
                    prefix: 24,
                  },
                ];
                setEntries(next);
                onRecordChange({ ...record, content: composeApl(next) });
              }}
            >
              Add IPv4 entry
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next: AplEntry[] = [
                  ...entries,
                  {
                    id: newId(),
                    negated: false,
                    familyMode: "preset",
                    family: 2,
                    address: "",
                    prefix: 64,
                  },
                ];
                setEntries(next);
                onRecordChange({ ...record, content: composeApl(next) });
              }}
            >
              Add IPv6 entry
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEntries(parseAplContent(record.content))}
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
            <li>Use APL for lists of permitted/denied network prefixes.</li>
            <li>Prefix length is required; use /32 for single IPv4, /128 for single IPv6.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">APL warnings</div>
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
