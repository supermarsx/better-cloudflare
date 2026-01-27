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
import { KNOWN_TLDS } from "@/lib/tlds";
import { composeSRV, parseSRV } from "@/lib/dns-parsers";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function parseSrvName(
  value: string | undefined,
): { service: string; proto: "tcp" | "udp" | "tls" | "other"; protoOther: string; host: string } {
  const raw = (value ?? "").trim();
  if (!raw) {
    return { service: "", proto: "tcp", protoOther: "", host: "" };
  }
  const v = normalizeDnsName(raw);
  const parts = v.split(".").filter(Boolean);
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  const service = first.startsWith("_") ? first.slice(1) : "";
  const protoLabel = second.startsWith("_") ? second.slice(1).toLowerCase() : "";
  const host = parts.slice(2).join(".");
  if (protoLabel === "tcp" || protoLabel === "udp" || protoLabel === "tls") {
    return { service, proto: protoLabel, protoOther: "", host };
  }
  if (protoLabel) {
    return { service, proto: "other", protoOther: protoLabel, host };
  }
  return { service, proto: "tcp", protoOther: "", host };
}

function composeSrvName(fields: {
  service: string;
  proto: "tcp" | "udp" | "tls" | "other";
  protoOther: string;
  host: string;
}) {
  const service = fields.service.trim().replace(/^_+/, "");
  const proto =
    fields.proto === "other"
      ? fields.protoOther.trim().replace(/^_+/, "")
      : fields.proto;
  const host = normalizeDnsName(fields.host.trim().replace(/^@$/, ""));
  const parts = [`_${service || "service"}`, `_${proto || "tcp"}`];
  if (host) parts.push(host);
  return parts.join(".");
}

export function SrvBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [srvPriority, setSrvPriority] = useState<number | undefined>(undefined);
  const [srvWeight, setSrvWeight] = useState<number | undefined>(undefined);
  const [srvPort, setSrvPort] = useState<number | undefined>(undefined);
  const [srvTarget, setSrvTarget] = useState<string>("");

  const [srvService, setSrvService] = useState<string>("");
  const [srvProto, setSrvProto] = useState<"tcp" | "udp" | "tls" | "other">("tcp");
  const [srvProtoOther, setSrvProtoOther] = useState<string>("");
  const [srvHost, setSrvHost] = useState<string>("");

  useEffect(() => {
    if (record.type !== "SRV") return;
    const parsed = parseSRV(record.content);
    setSrvPriority(parsed.priority);
    setSrvWeight(parsed.weight);
    setSrvPort(parsed.port);
    setSrvTarget(parsed.target ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  useEffect(() => {
    if (record.type !== "SRV") return;
    const parsed = parseSrvName(record.name);
    setSrvService(parsed.service);
    setSrvProto(parsed.proto);
    setSrvProtoOther(parsed.protoOther);
    setSrvHost(parsed.host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.name]);

  const diagnostics = useMemo(() => {
    if (record.type !== "SRV") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }
    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const pr = srvPriority;
    const wt = srvWeight;
    const port = srvPort;
    const target = (srvTarget ?? "").trim();

    if (pr === undefined) push(issues, "SRV: priority is missing.");
    else if (pr < 0 || pr > 65535) push(issues, "SRV: priority should be 0–65535.");
    if (wt === undefined) push(issues, "SRV: weight is missing.");
    else if (wt < 0 || wt > 65535) push(issues, "SRV: weight should be 0–65535.");
    if (port === undefined) push(issues, "SRV: port is missing.");
    else if (port < 0 || port > 65535) push(issues, "SRV: port should be 0–65535.");
    if (!target) push(issues, "SRV: target is missing.");
    if (target) {
      if (/\s/.test(target)) push(issues, "SRV: target contains whitespace.");
      if (target.includes("://"))
        push(issues, "SRV: target looks like a URL; it should be a hostname.");
      if (target.includes("/"))
        push(issues, "SRV: target contains '/', which is unusual for hostnames.");
      const normalized = normalizeDnsName(target);
      const tld = normalized.split(".").pop()?.toLowerCase();
      if (tld && normalized.includes(".") && /^[a-z0-9-]{2,63}$/.test(tld)) {
        if (!KNOWN_TLDS.has(tld))
          push(issues, `SRV: target has unknown/invalid TLD “.${tld}”.`);
      }
    }

    const expectedName = composeSrvName({
      service: srvService,
      proto: srvProto,
      protoOther: srvProtoOther,
      host: srvHost,
    });
    const name = (record.name ?? "").trim();
    if (!name) {
      push(nameIssues, `SRV: name is usually "${expectedName}".`);
    } else if (!name.startsWith("_")) {
      push(nameIssues, "SRV: name usually starts with _service._proto.");
    } else if (name !== expectedName) {
      push(nameIssues, `SRV: name differs from builder: "${expectedName}".`);
    }
    if (!srvService.trim())
      push(nameIssues, "SRV: service is missing (e.g., sip, xmpp-client).");
    if (srvProto === "other" && !srvProtoOther.trim())
      push(nameIssues, "SRV: protocol is set to Other but is empty.");

    const canonical = composeSRV(pr, wt, port, target);
    return { canonical, issues, nameIssues };
  }, [
    record.type,
    record.name,
    srvHost,
    srvPort,
    srvPriority,
    srvProto,
    srvProtoOther,
    srvService,
    srvTarget,
    srvWeight,
  ]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "SRV") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange, record.type]);

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">SRV builder</div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>priority weight port target</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Priority</Label>
            <Input
              type="number"
              placeholder="10"
              value={srvPriority ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setSrvPriority(val);
                onRecordChange({
                  ...record,
                  content: composeSRV(val, srvWeight, srvPort, srvTarget),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">Lower is preferred.</div>
          </div>
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Weight</Label>
            <Input
              type="number"
              placeholder="5"
              value={srvWeight ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setSrvWeight(val);
                onRecordChange({
                  ...record,
                  content: composeSRV(srvPriority, val, srvPort, srvTarget),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">Load-balancing.</div>
          </div>
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Port</Label>
            <Input
              type="number"
              placeholder="5060"
              value={srvPort ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                const val = Number.isNaN(n) ? undefined : n;
                setSrvPort(val);
                onRecordChange({
                  ...record,
                  content: composeSRV(srvPriority, srvWeight, val, srvTarget),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">Service port.</div>
          </div>
          <div className="space-y-1 sm:col-span-3">
            <Label className="text-xs">Target</Label>
            <Input
              placeholder="e.g., sipserver.example.com"
              value={srvTarget}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setSrvTarget(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeSRV(srvPriority, srvWeight, srvPort, e.target.value),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Hostname only (no scheme, no path).
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Service</Label>
            <Input
              value={srvService}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSrvService(e.target.value)}
              placeholder="e.g., sip"
            />
            <div className="text-[11px] text-muted-foreground">
              Becomes <code>_&lt;service&gt;</code> in the name.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Protocol</Label>
            <Select
              value={srvProto}
              onValueChange={(value: string) => setSrvProto(value as typeof srvProto)}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">tcp</SelectItem>
                <SelectItem value="udp">udp</SelectItem>
                <SelectItem value="tls">tls</SelectItem>
                <SelectItem value="other">other…</SelectItem>
              </SelectContent>
            </Select>
            {srvProto === "other" && (
              <Input
                className="mt-2"
                value={srvProtoOther}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setSrvProtoOther(e.target.value)
                }
                placeholder="e.g., sctp"
              />
            )}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Host (optional)</Label>
            <Input
              value={srvHost}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSrvHost(e.target.value)}
              placeholder="@ or subdomain"
            />
            <div className="text-[11px] text-muted-foreground">Leave empty for zone apex.</div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseSrvName(record.name);
              setSrvService(parsed.service);
              setSrvProto(parsed.proto);
              setSrvProtoOther(parsed.protoOther);
              setSrvHost(parsed.host);
            }}
          >
            Load from name
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseSRV(record.content);
              setSrvPriority(parsed.priority);
              setSrvWeight(parsed.weight);
              setSrvPort(parsed.port);
              setSrvTarget(parsed.target ?? "");
            }}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onRecordChange({
                ...record,
                name: composeSrvName({
                  service: srvService,
                  proto: srvProto,
                  protoOther: srvProtoOther,
                  host: srvHost,
                }),
              });
            }}
          >
            Apply name
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onRecordChange({ ...record, content: diagnostics.canonical });
            }}
          >
            Apply canonical to content
          </Button>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
          <div className="text-xs font-semibold text-muted-foreground">Preview (canonical)</div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{diagnostics.canonical}</pre>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">Recommendations</div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>
              Keep the name as <code>_service._proto</code> (and add a host suffix only
              if needed).
            </li>
            <li>Target should be a hostname (not an IP and not a URL).</li>
            <li>Use weight to distribute traffic among same-priority targets.</li>
            <li>Prefer explicit ports; avoid 0.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">SRV warnings</div>
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

