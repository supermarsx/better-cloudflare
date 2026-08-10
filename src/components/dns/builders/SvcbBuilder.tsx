import type { ChangeEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import { joinList, pluralize } from "./describe-utils";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

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
  const right =
    hasDouble && parts[1] ? parts[1].split(":").filter(Boolean) : [];
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
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
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
    (((parts[0] << 24) >>> 0) |
      ((parts[1] << 16) >>> 0) |
      ((parts[2] << 8) >>> 0) |
      (parts[3] >>> 0)) >>>
    0
  );
}

function ipv4InCidr(value: string, base: string, prefix: number) {
  const v = ipv4ToInt(value);
  const b = ipv4ToInt(base);
  if (v === null || b === null) return false;
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1) >>> 0) >>> 0;
  return (v & mask) >>> 0 === (b & mask) >>> 0;
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
  const priority =
    priorityStr && /^\d+$/.test(priorityStr)
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

const KNOWN_SVC_PARAMS = new Set([
  "alpn",
  "no-default-alpn",
  "port",
  "ipv4hint",
  "ipv6hint",
  "ech",
  "dohpath",
  "mandatory",
]);

/** Application protocols an `alpn` token can name, for readable prose. */
const ALPN_PROTOCOL_NAMES: Record<string, string> = {
  h3: "HTTP/3",
  h2: "HTTP/2",
  "http/1.1": "HTTP/1.1",
  "http/1.0": "HTTP/1.0",
  dot: "DNS over TLS",
  doq: "DNS over QUIC",
};

export type SvcbFields = {
  kind: "SVCB" | "HTTPS";
  priority: number | undefined;
  target: string;
  params: SvcParam[];
};

/** Per-parameter help, so the value box explains the value it wants. */
export function svcbParamHelp(key: string) {
  switch (key.trim().toLowerCase()) {
    case "alpn":
      return "Comma-separated application protocols the endpoint speaks, such as h2,h3. Clients use it to choose a protocol before connecting instead of negotiating one.";
    case "no-default-alpn":
      return "Withdraws the protocol a client would otherwise assume by default, leaving only the protocols named in alpn. It takes no value, and it needs an alpn parameter alongside it.";
    case "port":
      return "The TCP or UDP port clients should connect to, from 1 to 65535. Omit it to use the default port for the service, which is 443 for HTTPS.";
    case "ipv4hint":
      return "Comma-separated IPv4 addresses a client may start connecting to before its A lookup finishes. These are hints only and are never authoritative, so keep them in step with the target's A records.";
    case "ipv6hint":
      return "Comma-separated IPv6 addresses a client may start connecting to before its AAAA lookup finishes. These are hints only and are never authoritative, so keep them in step with the target's AAAA records.";
    case "ech":
      return "The base64 Encrypted ClientHello configuration list published by the server. It lets clients encrypt the server name during the TLS handshake, and it must match what the server is actually configured with.";
    case "dohpath":
      return "The URI template for DNS-over-HTTPS queries to this resolver, such as /dns-query{?dns}. It starts with a slash and is relative to the target name.";
    case "mandatory":
      return "Comma-separated parameter keys a client must understand. A client that does not support every key listed here has to ignore the whole record, so list only what is genuinely essential.";
    default:
      return "The value for this parameter. Anything outside the registered keys is passed through as written, so its meaning is defined by whatever consumes the record.";
  }
}

function alpnProtocolNames(value: string) {
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => ALPN_PROTOCOL_NAMES[token.toLowerCase()] ?? token);
}

/**
 * Plain-English description of the SVCB or HTTPS record being assembled.
 *
 * The split that matters is RFC 9460's two modes: SvcPriority 0 is AliasMode,
 * which delegates the name and ignores every parameter, while any higher value
 * is ServiceMode, where the parameters apply and lower numbers are preferred.
 */
export function describeSVCB(fields: SvcbFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const kind = fields.kind;
  const priority = fields.priority;
  const target = fields.target.trim();
  const params = fields.params.filter((p) => (p.key ?? "").trim().length > 0);
  const service = kind === "HTTPS" ? "this website" : "this service";

  const valueOf = (key: string) => {
    const match = params.find(
      (p) => p.key.trim().toLowerCase() === key && p.mode === "keyValue",
    );
    const value = match?.value.trim();
    return value ? value : undefined;
  };
  const hasFlag = (key: string) =>
    params.some((p) => p.key.trim().toLowerCase() === key && p.mode === "flag");

  if (priority === undefined) {
    return {
      headline: `Will tell clients how to reach ${service}: a priority of 0 hands the name off to another one, and a priority of 1 or more publishes the connection parameters here.`,
      details: [
        "Priority 0 is alias mode: the target name supplies the whole configuration and any parameters here are ignored.",
        "A priority above 0 is service mode: the parameters below apply, and clients prefer the lowest-numbered record at this name.",
      ],
    };
  }

  if (priority === 0) {
    let headline: string;
    if (target === ".") {
      headline = `Alias mode with a target of ".", which states that ${service} is not available at all rather than pointing anywhere.`;
    } else if (!target) {
      headline = `Alias mode: will hand this name off to another name that supplies the configuration for ${service}, once a target name is filled in.`;
    } else {
      headline = `Alias mode: sends clients on to ${target} to find out how to reach ${service}, so everything about the connection comes from the records published there.`;
    }

    if (target && target !== ".") {
      details.push(
        `Alias mode carries no connection parameters of its own: a client resolves ${kind} records at ${target} and uses whatever it finds.`,
      );
      details.push(
        `Unlike a CNAME this delegation covers only ${kind} lookups, so it is legal at the zone apex and leaves the other record types at this name alone.`,
      );
      details.push(
        "The address a client finally connects to still comes from A and AAAA records, not from this record.",
      );
      unknowns.push(
        `What clients end up doing depends on the ${kind} and address records published at ${target}, which this form cannot see.`,
      );
    }

    if (params.length) {
      details.push(
        `Alias mode ignores service parameters, so the ${pluralize(
          params.length,
          "parameter",
        )} listed here ${params.length === 1 ? "has" : "have"} no effect.`,
      );
    }

    return { headline, details, unknowns };
  }

  const targetText = target === "." ? "this same name" : target;
  const port = valueOf("port");
  const alpn = valueOf("alpn");
  const alpnNames = alpn ? alpnProtocolNames(alpn) : [];

  let headline: string;
  if (!target) {
    headline = `Service mode: will publish how clients should connect to ${service}, once a target name is filled in — use "." to mean this same name.`;
  } else {
    const portClause = port ? ` on port ${port}` : "";
    const alpnClause = alpnNames.length
      ? `, speaking ${joinList(alpnNames, "or")}`
      : "";
    headline = `Service mode: tells clients they can reach ${service} at ${targetText}${portClause}${alpnClause}.`;
  }

  details.push(
    `Priority ${priority} ranks this record against the other service-mode records at this name; clients try the lowest number first.`,
  );

  if (target === ".") {
    details.push(
      'In service mode a target of "." means the owner name itself, so clients keep using this name and simply apply the parameters below.',
    );
  }

  if (alpn) {
    details.push(
      `alpn advertises ${joinList(
        alpnNames,
      )}, so a client can pick a protocol before it connects instead of discovering one during the handshake.`,
    );
  }

  if (hasFlag("no-default-alpn")) {
    details.push(
      alpn
        ? "no-default-alpn withdraws the protocol clients would otherwise assume, so only the protocols listed in alpn may be used."
        : "no-default-alpn withdraws the protocol clients would otherwise assume, but no alpn list is present, which leaves a client with no protocol it is allowed to use.",
    );
  }

  if (port) {
    details.push(
      `port sends clients to port ${port} instead of the default port for ${
        kind === "HTTPS" ? "HTTPS" : "this service"
      }.`,
    );
  }

  const hints = [
    valueOf("ipv4hint") ? "ipv4hint" : "",
    valueOf("ipv6hint") ? "ipv6hint" : "",
  ].filter(Boolean);
  if (hints.length) {
    details.push(
      `${joinList(hints)} ${
        hints.length === 1 ? "is a performance hint" : "are performance hints"
      } only: a client may start connecting sooner, but the addresses are not authoritative and it still resolves the target's A and AAAA records.`,
    );
  }

  if (valueOf("ech")) {
    details.push(
      "ech publishes an Encrypted ClientHello configuration, which lets clients encrypt the server name in the TLS handshake instead of sending it in the clear.",
    );
    unknowns.push(
      "Whether this ech value still matches the configuration the server is running cannot be checked from here, and a stale value makes clients retry the handshake.",
    );
  }

  if (valueOf("dohpath")) {
    details.push(
      "dohpath gives the URI template clients use to send DNS-over-HTTPS queries to this endpoint.",
    );
  }

  const mandatory = valueOf("mandatory");
  if (mandatory) {
    const keys = mandatory
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length) {
      details.push(
        `mandatory marks ${joinList(keys)} as required: a client that does not understand ${
          keys.length === 1 ? "it" : "all of them"
        } must ignore this record entirely rather than connect without ${
          keys.length === 1 ? "it" : "them"
        }.`,
      );
    }
  }

  for (const param of params) {
    const key = param.key.trim().toLowerCase();
    if (KNOWN_SVC_PARAMS.has(key)) continue;
    unknowns.push(
      `Parameter "${param.key.trim()}" is not one of the keys defined in RFC 9460, so what a client does with it is defined by whatever consumes the record.`,
    );
  }

  unknowns.push(
    `Any other ${kind} records at this name compete on priority, so which one a client uses cannot be determined from this form.`,
  );

  return { headline, details, unknowns };
}

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
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "priority",
    "target",
    "addParam",
  ] as const);
  // Parameter rows come and go, so their ids are derived per row rather than
  // from the fixed key list above.
  const paramPrefix = useId();
  const paramFieldId = (id: string, part: "key" | "value" | "mode") =>
    `${paramPrefix}-${id}-${part}`;
  const paramHelpId = (id: string, part: "key" | "value" | "mode") =>
    `${paramPrefix}-${id}-${part}-help`;

  const kind = record.type === "HTTPS" ? "HTTPS" : "SVCB";

  useEffect(() => {
    if (record.type !== "SVCB" && record.type !== "HTTPS") return;
    const parsed = parseSvcbContent(record.content);
    setPriority(parsed.priority);
    setTarget(parsed.target);
    setParams(parsed.params);
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "SVCB" && record.type !== "HTTPS") {
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

    const p = priority;
    const t = (target ?? "").trim();
    if (p === undefined) push(issues, `${kind}: priority is required.`);
    else if (p < 0 || p > 65535)
      push(issues, `${kind}: priority must be 0–65535.`);

    if (!t)
      push(
        issues,
        `${kind}: target name is required (use "." for alias mode).`,
      );
    if (t && t !== "." && !looksLikeHostname(t))
      push(
        issues,
        `${kind}: target name does not look like a hostname (or ".").`,
      );

    if (p === 0 && params.length > 0)
      push(
        issues,
        `${kind}: priority 0 is alias mode; svcparams are usually not allowed.`,
      );

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

    const mandatory = params.find(
      (x) => x.key === "mandatory" && x.mode === "keyValue",
    );
    if (mandatory) {
      const raw = (mandatory.value ?? "").trim();
      const keys = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const k of keys) {
        if (!keyCounts.has(k))
          push(
            issues,
            `${kind}: mandatory includes "${k}" but that parameter is missing.`,
          );
      }
      if (keys.length === 0) push(issues, `${kind}: mandatory value is empty.`);
    }

    const alpn = params.find((x) => x.key === "alpn" && x.mode === "keyValue");
    const noDefault = params.some(
      (x) => x.key === "no-default-alpn" && x.mode === "flag",
    );
    if (noDefault && !alpn)
      push(issues, `${kind}: no-default-alpn is set but alpn is missing.`);
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
      if (port.value.trim() === "")
        push(issues, `${kind}: port value is empty.`);
      else if (Number.isNaN(n) || n < 1 || n > 65535)
        push(issues, `${kind}: port should be 1–65535.`);
    }

    const ipv4hint = params.filter(
      (x) => x.key === "ipv4hint" && x.mode === "keyValue",
    );
    for (const h of ipv4hint) {
      const ips = h.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ips.length === 0) push(issues, `${kind}: ipv4hint is empty.`);
      for (const ip of ips) {
        if (!isValidIPv4(ip))
          push(issues, `${kind}: ipv4hint contains invalid IPv4 "${ip}".`);
        else {
          if (ipv4InCidr(ip, "10.0.0.0", 8))
            push(
              issues,
              `${kind}: ipv4hint includes private IPv4 (10.0.0.0/8).`,
            );
          else if (ipv4InCidr(ip, "172.16.0.0", 12))
            push(
              issues,
              `${kind}: ipv4hint includes private IPv4 (172.16.0.0/12).`,
            );
          else if (ipv4InCidr(ip, "192.168.0.0", 16))
            push(
              issues,
              `${kind}: ipv4hint includes private IPv4 (192.168.0.0/16).`,
            );
          else if (ipv4InCidr(ip, "127.0.0.0", 8))
            push(
              issues,
              `${kind}: ipv4hint includes loopback IPv4 (127.0.0.0/8).`,
            );
          else if (ipv4InCidr(ip, "169.254.0.0", 16))
            push(
              issues,
              `${kind}: ipv4hint includes link-local IPv4 (169.254.0.0/16).`,
            );
        }
      }
    }

    const ipv6hint = params.filter(
      (x) => x.key === "ipv6hint" && x.mode === "keyValue",
    );
    for (const h of ipv6hint) {
      const ips = h.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ips.length === 0) push(issues, `${kind}: ipv6hint is empty.`);
      for (const ip of ips) {
        if (!isValidIPv6(ip))
          push(issues, `${kind}: ipv6hint contains invalid IPv6 "${ip}".`);
        else {
          const c = ip.toLowerCase();
          if (c === "::")
            push(issues, `${kind}: ipv6hint includes unspecified IPv6 (::).`);
          else if (c === "::1")
            push(issues, `${kind}: ipv6hint includes loopback IPv6 (::1).`);
          else if (ipv6InPrefix(c, "fc00::", 7))
            push(
              issues,
              `${kind}: ipv6hint includes unique local IPv6 (fc00::/7).`,
            );
          else if (ipv6InPrefix(c, "fe80::", 10))
            push(
              issues,
              `${kind}: ipv6hint includes link-local IPv6 (fe80::/10).`,
            );
          else if (ipv6InPrefix(c, "2001:db8::", 32))
            push(
              issues,
              `${kind}: ipv6hint includes documentation IPv6 (2001:db8::/32).`,
            );
        }
      }
    }

    const ech = params.find((x) => x.key === "ech" && x.mode === "keyValue");
    if (ech) {
      const b64 = ech.value.trim();
      if (!b64) push(issues, `${kind}: ech value is empty.`);
      else if (!isBase64Like(b64))
        push(issues, `${kind}: ech does not look like base64.`);
      else if (b64.length % 4 !== 0)
        push(issues, `${kind}: ech base64 length is unusual.`);
    }

    const dohpath = params.find(
      (x) => x.key === "dohpath" && x.mode === "keyValue",
    );
    if (dohpath) {
      const v = dohpath.value.trim();
      if (!v) push(issues, `${kind}: dohpath is empty.`);
      if (v && !v.startsWith("/"))
        push(
          issues,
          `${kind}: dohpath usually starts with "/" (e.g., "/dns-query{?dns}").`,
        );
      if (v && /\s/.test(v)) push(issues, `${kind}: dohpath contains spaces.`);
    }

    // Warn about unknown keys that look suspicious
    for (const param of params) {
      const key = (param.key ?? "").trim();
      if (!key) push(issues, `${kind}: parameter key is empty.`);
      if (key && !/^[a-z0-9-]+$/.test(key))
        push(
          issues,
          `${kind}: parameter key "${key}" contains unusual characters.`,
        );
      if (param.mode === "keyValue") {
        const v = (param.value ?? "").trim();
        if (key && v === "" && key !== "mandatory")
          push(issues, `${kind}: parameter "${key}" has an empty value.`);
      }
    }

    const canonical = composeSvcb(priority, target, params);
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical)
      push(
        issues,
        `${kind}: content differs from builder settings (Apply canonical to normalize).`,
      );

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        `${kind}: name is typically @ (apex) or a service label.`,
      );

    return { canonical, issues, nameIssues };
  }, [
    kind,
    params,
    priority,
    record.content,
    record.name,
    record.type,
    target,
  ]);

  const summary = useMemo(
    () => describeSVCB({ kind, priority, target, params }),
    [kind, params, priority, target],
  );

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
    const ps = has("params") ? (next.params ?? []) : params;
    onRecordChange({
      ...record,
      content: composeSvcb(pr, tg, ps),
    });
  };

  const addParam = (key: string, mode: SvcParam["mode"]) => {
    const next: SvcParam[] = [...params, { id: newId(), key, value: "", mode }];
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

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-2">
            <BuilderFieldLabel
              controlId={fieldIds.priority}
              descriptionId={helpIds.priority}
              label="Priority"
              help="0 selects alias mode, which delegates the whole name to the target and ignores every parameter. Any value from 1 to 65535 selects service mode, where the parameters apply and clients prefer the lowest number. Use 1 for a single service-mode record."
            />
            <Input
              id={fieldIds.priority}
              aria-describedby={helpIds.priority}
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
            <BuilderFieldLabel
              controlId={fieldIds.target}
              descriptionId={helpIds.target}
              label="Target name"
              help="The hostname clients should connect to, with no scheme or path. In service mode a single dot means this same name; in alias mode a single dot instead states that the service does not exist."
            />
            <Input
              id={fieldIds.target}
              aria-describedby={helpIds.target}
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
            <div className="flex items-center gap-2">
              <BuilderFieldLabel
                controlId={fieldIds.addParam}
                descriptionId={helpIds.addParam}
                label="Add parameter"
                help="Adds one service parameter row. Parameters describe how to connect and apply only in service mode, so a record with priority 0 ignores every one of them."
              />
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
                <SelectTrigger
                  id={fieldIds.addParam}
                  aria-describedby={helpIds.addParam}
                  className="h-9 w-48"
                >
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
          </div>

          {params.length === 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              No parameters. Add common params like <code>alpn</code>,{" "}
              <code>port</code>, <code>ipv4hint</code>, <code>ipv6hint</code>,{" "}
              <code>ech</code>.
            </div>
          )}

          <div className="mt-2 space-y-2">
            {params.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-1 gap-2 sm:grid-cols-12"
              >
                <div className="space-y-1 sm:col-span-3">
                  <BuilderFieldLabel
                    controlId={paramFieldId(p.id, "key")}
                    descriptionId={paramHelpId(p.id, "key")}
                    label="Parameter key"
                    help="The name of the service parameter, such as alpn, port, ipv4hint, ipv6hint, ech or mandatory. Keys outside that registered set are published as written and mean whatever the consuming client defines."
                  />
                  <Input
                    id={paramFieldId(p.id, "key")}
                    aria-describedby={paramHelpId(p.id, "key")}
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

                <div className="space-y-1 sm:col-span-7">
                  {p.mode === "flag" ? (
                    <div className="flex h-9 items-center text-[11px] text-muted-foreground">
                      Flag parameter (no value).
                    </div>
                  ) : (
                    <>
                      <BuilderFieldLabel
                        controlId={paramFieldId(p.id, "value")}
                        descriptionId={paramHelpId(p.id, "value")}
                        label={
                          p.key.trim()
                            ? `${p.key.trim()} value`
                            : "Parameter value"
                        }
                        help={svcbParamHelp(p.key)}
                      />
                      <Input
                        id={paramFieldId(p.id, "value")}
                        aria-describedby={paramHelpId(p.id, "value")}
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
                    </>
                  )}
                </div>

                <div className="sm:col-span-2 flex items-end justify-end gap-2">
                  <div className="space-y-1">
                    <BuilderFieldLabel
                      controlId={paramFieldId(p.id, "mode")}
                      descriptionId={paramHelpId(p.id, "mode")}
                      label="Format"
                      help="key=value parameters carry a value, while flag parameters such as no-default-alpn are simply present or absent and take none. Switching to flag drops any value already typed."
                    />
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
                      <SelectTrigger
                        id={paramFieldId(p.id, "mode")}
                        aria-describedby={paramHelpId(p.id, "mode")}
                        className="h-9 w-24"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="keyValue">key=value</SelectItem>
                        <SelectItem value="flag">flag</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
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
            onClick={() =>
              onRecordChange({ ...record, content: diagnostics.canonical })
            }
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
              Use <code>port=443</code> if the service is not on the default
              port.
            </li>
            <li>
              Use <code>ipv4hint</code>/<code>ipv6hint</code> to speed up
              connection setup.
            </li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
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
