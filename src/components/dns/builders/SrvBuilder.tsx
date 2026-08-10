import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KNOWN_TLDS } from "@/lib/dns/tlds";
import { composeSRV, parseSRV } from "@/lib/dns/dns-parsers";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import { joinList } from "./describe-utils";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

type SrvProto = "tcp" | "udp" | "tls" | "other";

function normalizeDnsName(value: string) {
  return value.trim().replace(/\.$/, "");
}

function parseSrvName(value: string | undefined): {
  service: string;
  proto: "tcp" | "udp" | "tls" | "other";
  protoOther: string;
  host: string;
} {
  const raw = (value ?? "").trim();
  if (!raw) {
    return { service: "", proto: "tcp", protoOther: "", host: "" };
  }
  const v = normalizeDnsName(raw);
  const parts = v.split(".").filter(Boolean);
  const first = parts[0] ?? "";
  const second = parts[1] ?? "";
  const service = first.startsWith("_") ? first.slice(1) : "";
  const protoLabel = second.startsWith("_")
    ? second.slice(1).toLowerCase()
    : "";
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

export type SrvFields = {
  service: string;
  proto: SrvProto;
  protoOther: string;
  host: string;
  priority: number | undefined;
  weight: number | undefined;
  port: number | undefined;
  target: string;
};

/** The protocol label that will be published as `_<proto>` in the name. */
function srvProtoLabel(fields: Pick<SrvFields, "proto" | "protoOther">) {
  const raw = fields.proto === "other" ? fields.protoOther : fields.proto;
  return raw.trim().replace(/^_+/, "").toLowerCase();
}

/**
 * Plain-English description of the SRV record the builder is assembling.
 *
 * The semantics come from RFC 2782: priority is tried lowest-first and a client
 * only falls back once every host at the lower priority is unreachable; weight
 * only distributes load between targets that share a priority; and a target of
 * "." positively asserts that the service is not available at this domain.
 */
export function describeSRV(fields: SrvFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const service = fields.service.trim().replace(/^_+/, "");
  const proto = srvProtoLabel(fields);
  const target = fields.target.trim();
  const port = fields.port;
  const priority = fields.priority;
  const weight = fields.weight;
  const name = composeSrvName(fields);

  const clients = service
    ? `clients looking up the ${service} service`
    : "clients looking up this service";
  const over = proto ? ` over ${proto}` : "";

  let headline: string;
  if (target === ".") {
    headline = `Tells ${clients}${over} that this domain deliberately does not offer the service, so they should stop looking rather than fall back to a default host.`;
  } else if (!target || port === undefined) {
    const missing = [
      target ? "" : "a target host",
      port === undefined ? "a port" : "",
    ].filter(Boolean);
    headline = `Will send ${clients}${over} to a specific host and port; ${joinList(
      missing,
    )} still ${missing.length === 1 ? "needs" : "need"} filling in.`;
  } else {
    headline = `Sends ${clients}${over} to ${target} on port ${port}.`;
  }

  details.push(
    `The record is published at ${name}, so only clients that know to query that exact name find it; nothing else on the domain is affected.`,
  );

  if (target === ".") {
    details.push(
      'A target of "." is an explicit "not available" answer, and RFC 2782 expects it to be the only SRV record at this name. Priority, weight and port carry no meaning alongside it.',
    );
    return { headline, details, unknowns };
  }

  if (priority === undefined) {
    details.push(
      "Priority is not set yet. It fixes the order clients try targets in, lowest number first.",
    );
  } else {
    details.push(
      `Priority ${priority} is tried before any target at this name with a higher priority number; clients move on to a higher number only when every host at ${priority} is unreachable.`,
    );
  }

  if (weight === undefined) {
    details.push(
      "Weight is not set yet. It splits traffic between the targets that share a priority.",
    );
  } else if (weight === 0) {
    details.push(
      "Weight 0 gives this target only a very small chance of being picked whenever another target at the same priority has a non-zero weight; it is the conventional value when there is no load to balance.",
    );
  } else {
    details.push(
      `Weight ${weight} is this target's share of connections among the targets that share its priority — clients choose between them in proportion to their weights, so weight matters only if such records exist.`,
    );
  }

  if (port === 0) {
    details.push(
      "Port 0 is not a usable TCP or UDP port, so a client cannot connect with this record as written.",
    );
  } else if (port !== undefined) {
    details.push(
      `SRV has no default port, so clients connect to exactly port ${port} on the target rather than to the service's usual port.`,
    );
  }

  if (target) {
    details.push(
      `${target} must have its own A or AAAA records: an SRV record carries no address, and RFC 2782 requires the target to be a real hostname rather than an alias.`,
    );
  }

  unknowns.push(
    `Any other SRV records published at ${name} take part in the same priority and weight comparison, so which target a client actually picks cannot be determined from this form.`,
  );

  if (proto && proto !== "tcp" && proto !== "udp") {
    unknowns.push(
      `_${proto} is not one of the transports RFC 2782 defines, so the transport clients will use is defined by whatever registered that label and cannot be determined here.`,
    );
  }

  return { headline, details, unknowns };
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
  const [srvProto, setSrvProto] = useState<"tcp" | "udp" | "tls" | "other">(
    "tcp",
  );
  const [srvProtoOther, setSrvProtoOther] = useState<string>("");
  const [srvHost, setSrvHost] = useState<string>("");
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "priority",
    "weight",
    "port",
    "target",
    "service",
    "proto",
    "protoOther",
    "host",
  ] as const);

  useEffect(() => {
    if (record.type !== "SRV") return;
    const parsed = parseSRV(record.content);
    setSrvPriority(parsed.priority);
    setSrvWeight(parsed.weight);
    setSrvPort(parsed.port);
    setSrvTarget(parsed.target ?? "");
  }, [record.type, record.content]);

  useEffect(() => {
    if (record.type !== "SRV") return;
    const parsed = parseSrvName(record.name);
    setSrvService(parsed.service);
    setSrvProto(parsed.proto);
    setSrvProtoOther(parsed.protoOther);
    setSrvHost(parsed.host);
  }, [record.type, record.name]);

  const diagnostics = useMemo(() => {
    if (record.type !== "SRV") {
      return {
        canonical: "",
        issues: [] as string[],
        nameIssues: [] as string[],
      };
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
    else if (pr < 0 || pr > 65535)
      push(issues, "SRV: priority should be 0–65535.");
    if (wt === undefined) push(issues, "SRV: weight is missing.");
    else if (wt < 0 || wt > 65535)
      push(issues, "SRV: weight should be 0–65535.");
    if (port === undefined) push(issues, "SRV: port is missing.");
    else if (port < 0 || port > 65535)
      push(issues, "SRV: port should be 0–65535.");
    if (!target) push(issues, "SRV: target is missing.");
    if (target) {
      if (/\s/.test(target)) push(issues, "SRV: target contains whitespace.");
      if (target.includes("://"))
        push(issues, "SRV: target looks like a URL; it should be a hostname.");
      if (target.includes("/"))
        push(
          issues,
          "SRV: target contains '/', which is unusual for hostnames.",
        );
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

  const summary = useMemo(
    () =>
      describeSRV({
        service: srvService,
        proto: srvProto,
        protoOther: srvProtoOther,
        host: srvHost,
        priority: srvPriority,
        weight: srvWeight,
        port: srvPort,
        target: srvTarget,
      }),
    [
      srvHost,
      srvPort,
      srvPriority,
      srvProto,
      srvProtoOther,
      srvService,
      srvTarget,
      srvWeight,
    ],
  );

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
  }, [
    diagnostics.canonical,
    diagnostics.issues,
    diagnostics.nameIssues,
    onWarningsChange,
    record.type,
  ]);

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            SRV builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>priority weight port target</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-1">
            <BuilderFieldLabel
              controlId={fieldIds.priority}
              descriptionId={helpIds.priority}
              label="Priority"
              help="Which targets clients try first, from 0 to 65535, lowest first. Clients fall back to a higher priority only when every host at the lower one is unreachable. 10 is a common starting value."
            />
            <Input
              id={fieldIds.priority}
              aria-describedby={helpIds.priority}
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
            <div className="text-[11px] text-muted-foreground">
              Lower is preferred.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-1">
            <BuilderFieldLabel
              controlId={fieldIds.weight}
              descriptionId={helpIds.weight}
              label="Weight"
              help="This target's relative share of traffic among the targets that share its priority, from 0 to 65535; clients pick between them in proportion. Use 0 when there is nothing to balance, and equal weights such as 5 to split traffic evenly."
            />
            <Input
              id={fieldIds.weight}
              aria-describedby={helpIds.weight}
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
            <div className="text-[11px] text-muted-foreground">
              Load-balancing.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-1">
            <BuilderFieldLabel
              controlId={fieldIds.port}
              descriptionId={helpIds.port}
              label="Port"
              help="The TCP or UDP port the service listens on at the target, from 1 to 65535. SRV has no default port, so clients use exactly this number; use the service's registered port, such as 5060 for SIP."
            />
            <Input
              id={fieldIds.port}
              aria-describedby={helpIds.port}
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
            <div className="text-[11px] text-muted-foreground">
              Service port.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-3">
            <BuilderFieldLabel
              controlId={fieldIds.target}
              descriptionId={helpIds.target}
              label="Target"
              help="The hostname running the service, which must have its own A or AAAA records and must not be an alias. A single dot means the service is deliberately not available at this domain."
            />
            <Input
              id={fieldIds.target}
              aria-describedby={helpIds.target}
              placeholder="e.g., sipserver.example.com"
              value={srvTarget}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setSrvTarget(e.target.value);
                onRecordChange({
                  ...record,
                  content: composeSRV(
                    srvPriority,
                    srvWeight,
                    srvPort,
                    e.target.value,
                  ),
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
            <BuilderFieldLabel
              controlId={fieldIds.service}
              descriptionId={helpIds.service}
              label="Service"
              help="The symbolic service name clients look up, written without its leading underscore, such as sip or xmpp-client. It must match the name the client is coded to query, so use the registered name for the protocol."
            />
            <Input
              id={fieldIds.service}
              aria-describedby={helpIds.service}
              value={srvService}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setSrvService(e.target.value)
              }
              placeholder="e.g., sip"
            />
            <div className="text-[11px] text-muted-foreground">
              Becomes <code>_&lt;service&gt;</code> in the name.
            </div>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.proto}
              descriptionId={helpIds.proto}
              label="Protocol"
              help="The transport label published as _proto in the name. RFC 2782 defines tcp and udp; other labels are used by specific services and mean whatever those services define. Pick the transport the client will actually connect over."
            />
            <Select
              value={srvProto}
              onValueChange={(value: string) =>
                setSrvProto(value as typeof srvProto)
              }
            >
              <SelectTrigger
                id={fieldIds.proto}
                aria-describedby={helpIds.proto}
                className="h-9"
              >
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
              <div className="mt-2 space-y-1">
                <BuilderFieldLabel
                  controlId={fieldIds.protoOther}
                  descriptionId={helpIds.protoOther}
                  label="Custom protocol"
                  help="The protocol label to publish instead of tcp or udp, written without its leading underscore, such as sctp. Use this only when the service you are publishing defines its own label."
                />
                <Input
                  id={fieldIds.protoOther}
                  aria-describedby={helpIds.protoOther}
                  value={srvProtoOther}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setSrvProtoOther(e.target.value)
                  }
                  placeholder="e.g., sctp"
                />
              </div>
            )}
          </div>
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.host}
              descriptionId={helpIds.host}
              label="Host (optional)"
              help="An extra name placed after _service._proto, so the record covers a subdomain rather than the zone apex. Leave it empty for the apex, which is what most services expect."
            />
            <Input
              id={fieldIds.host}
              aria-describedby={helpIds.host}
              value={srvHost}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setSrvHost(e.target.value)
              }
              placeholder="@ or subdomain"
            />
            <div className="text-[11px] text-muted-foreground">
              Leave empty for zone apex.
            </div>
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
              Keep the name as <code>_service._proto</code> (and add a host
              suffix only if needed).
            </li>
            <li>Target should be a hostname (not an IP and not a URL).</li>
            <li>
              Use weight to distribute traffic among same-priority targets.
            </li>
            <li>Prefer explicit ports; avoid 0.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
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
