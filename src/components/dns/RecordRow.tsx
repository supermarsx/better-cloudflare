/**
 * UI component rendering a single DNS record row and optional inline
 * editor allowing update and deletion of the record.
 */
import { useState, useEffect, useCallback } from "react";
import type { ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { RecordType, DNSRecord, TTLValue } from "@/types/dns";
import { parseSPF, composeSPF, validateSPF } from "@/lib/spf";
import { RECORD_TYPES, getTTLPresets, getRecordTypeLabel } from "@/types/dns";
import { Edit2, Trash2, Save, X } from "lucide-react";

/**
 * Properties for the `RecordRow` UI component which renders and optionally
 * edits a DNS record.
 */
export interface RecordRowProps {
  /** The DNS record to display or edit */
  record: DNSRecord;
  /** Whether the row is currently in edit mode */
  isEditing: boolean;
  /** Callback invoked to transition into edit mode */
  onEdit: () => void;
  /** Save callback after editing; receives the updated record. May return a promise. */
  onSave: (record: DNSRecord) => void | Promise<void>;
  /** Cancel editing and revert changes */
  onCancel: () => void;
  /** Remove the record. May return a promise. */
  onDelete: () => void | Promise<void>;
}

/**
 * Render a single DNS record row. When `isEditing` is true the row
 * renders in edit mode with inputs for each editable field; otherwise it
 * displays the record details.
 */
export function RecordRow({
  record,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
}: RecordRowProps) {
  const [editedRecord, setEditedRecord] = useState(record);
  const parseSRV = (content?: string) => {
    if (!content)
      return {
        priority: undefined,
        weight: undefined,
        port: undefined,
        target: "",
      };
    const parts = String(content).trim().split(/\s+/);
    if (parts.length < 4)
      return {
        priority: undefined,
        weight: undefined,
        port: undefined,
        target: content,
      };
    const [priority, weight, port, ...rest] = parts;
    return {
      priority: Number(priority),
      weight: Number(weight),
      port: Number(port),
      target: rest.join(" "),
    };
  };
  const composeSRV = (p?: number, w?: number, prt?: number, t?: string) =>
    `${p ?? 0} ${w ?? 0} ${prt ?? 0} ${t ?? ""}`;
  const [srvPriority, setSrvPriority] = useState<number | undefined>(
    parseSRV(record.content).priority,
  );
  const [srvWeight, setSrvWeight] = useState<number | undefined>(
    parseSRV(record.content).weight,
  );
  const [srvPort, setSrvPort] = useState<number | undefined>(
    parseSRV(record.content).port,
  );
  const [srvTarget, setSrvTarget] = useState<string>(
    parseSRV(record.content).target ?? "",
  );
  const parseTLSA = (content?: string) => {
    if (!content)
      return {
        usage: undefined,
        selector: undefined,
        matchingType: undefined,
        data: "",
      };
    const parts = String(content).trim().split(/\s+/);
    if (parts.length < 4)
      return {
        usage: undefined,
        selector: undefined,
        matchingType: undefined,
        data: content,
      };
    const [usage, selector, matchingType, ...rest] = parts;
    return {
      usage: Number(usage),
      selector: Number(selector),
      matchingType: Number(matchingType),
      data: rest.join(" "),
    };
  };
  const composeTLSA = (u?: number, s?: number, m?: number, d?: string) =>
    `${u ?? 0} ${s ?? 0} ${m ?? 0} ${d ?? ""}`;
  const [tlsaUsage, setTlsaUsage] = useState<number | undefined>(
    parseTLSA(record.content).usage,
  );
  const [tlsaSelector, setTlsaSelector] = useState<number | undefined>(
    parseTLSA(record.content).selector,
  );
  const [tlsaMatchingType, setTlsaMatchingType] = useState<number | undefined>(
    parseTLSA(record.content).matchingType,
  );
  const [tlsaData, setTlsaData] = useState<string>(
    parseTLSA(record.content).data ?? "",
  );
  const parseSSHFP = (content?: string) => {
    if (!content)
      return { algorithm: undefined, fptype: undefined, fingerprint: "" };
    const parts = String(content).trim().split(/\s+/);
    if (parts.length < 3)
      return { algorithm: undefined, fptype: undefined, fingerprint: content };
    const [algorithm, fptype, ...rest] = parts;
    return {
      algorithm: Number(algorithm),
      fptype: Number(fptype),
      fingerprint: rest.join(" "),
    };
  };
  const composeSSHFP = (a?: number, f?: number, fp?: string) =>
    `${a ?? 0} ${f ?? 0} ${fp ?? ""}`;
  const [sshfpAlgorithm, setSshfpAlgorithm] = useState<number | undefined>(
    parseSSHFP(record.content).algorithm,
  );
  const [sshfpFptype, setSshfpFptype] = useState<number | undefined>(
    parseSSHFP(record.content).fptype,
  );
  const [sshfpFingerprint, setSshfpFingerprint] = useState<string>(
    parseSSHFP(record.content).fingerprint ?? "",
  );
  const splitNaptrTokens = useCallback((s: string) => {
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
  }, [] as const);

  const parseNAPTR = useCallback(
    (content?: string) => {
      if (!content)
        return {
          order: undefined,
          preference: undefined,
          flags: "",
          service: "",
          regexp: "",
          replacement: "",
        };
      const tokens = splitNaptrTokens(String(content).trim());
      const [order, preference, flags, service, regexp, replacement] = tokens;
      return {
        order: Number(order),
        preference: Number(preference),
        flags: flags?.replace(/^"|"$/g, ""),
        service,
        regexp: regexp?.replace(/^"|"$/g, ""),
        replacement,
      };
    },
    [splitNaptrTokens],
  );
  const quoteIfNeeded = (s?: string) => {
    if (!s) return "";
    if (/\s/.test(s) || /"/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
  };
  const composeNAPTR = (
    o?: number,
    p?: number,
    f?: string,
    s?: string,
    r?: string,
    rep?: string,
  ) =>
    `${o ?? 0} ${p ?? 0} ${f ?? ""} ${s ?? ""} ${quoteIfNeeded(r)} ${rep ?? ""}`;
  const [naptrOrder, setNaptrOrder] = useState<number | undefined>(
    parseNAPTR(record.content).order,
  );
  const [naptrPref, setNaptrPref] = useState<number | undefined>(
    parseNAPTR(record.content).preference,
  );
  const [naptrFlags, setNaptrFlags] = useState<string>(
    parseNAPTR(record.content).flags ?? "",
  );
  const [naptrService, setNaptrService] = useState<string>(
    parseNAPTR(record.content).service ?? "",
  );
  const [naptrRegexp, setNaptrRegexp] = useState<string>(
    parseNAPTR(record.content).regexp ?? "",
  );
  const [naptrReplacement, setNaptrReplacement] = useState<string>(
    parseNAPTR(record.content).replacement ?? "",
  );

  useEffect(() => {
    setEditedRecord(record);
    if (record.type === "SRV") {
      const parsed = parseSRV(record.content);
      setSrvPriority(parsed.priority);
      setSrvWeight(parsed.weight);
      setSrvPort(parsed.port);
      setSrvTarget(parsed.target ?? "");
    }
    if (record.type === "TLSA") {
      const parsed = parseTLSA(record.content);
      setTlsaUsage(parsed.usage);
      setTlsaSelector(parsed.selector);
      setTlsaMatchingType(parsed.matchingType);
      setTlsaData(parsed.data ?? "");
    }
    if (record.type === "SSHFP") {
      const parsed = parseSSHFP(record.content);
      setSshfpAlgorithm(parsed.algorithm);
      setSshfpFptype(parsed.fptype);
      setSshfpFingerprint(parsed.fingerprint ?? "");
    }
    if (record.type === "NAPTR") {
      const parsed = parseNAPTR(record.content);
      setNaptrOrder(parsed.order);
      setNaptrPref(parsed.preference);
      setNaptrFlags(parsed.flags ?? "");
      setNaptrService(parsed.service ?? "");
      setNaptrRegexp(parsed.regexp ?? "");
      setNaptrReplacement(parsed.replacement ?? "");
    }
  }, [record, parseNAPTR]);

  const ttlValue = editedRecord.ttl === 1 ? "auto" : editedRecord.ttl;
  const isCustomTTL = !getTTLPresets().includes(ttlValue as TTLValue);

  if (isEditing) {
    return (
      <div className="p-4 border rounded-lg bg-muted/50">
        <div className="grid grid-cols-12 gap-4 items-center">
          <div className="col-span-2">
            <Select
              value={editedRecord.type}
              onValueChange={(value: RecordType) =>
                setEditedRecord({
                  ...editedRecord,
                  type: value,
                })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECORD_TYPES.map((type) => (
                  <SelectItem
                    key={type}
                    value={type}
                    title={getRecordTypeLabel(type)}
                  >
                    {getRecordTypeLabel(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-3">
            <Input
              value={editedRecord.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setEditedRecord({
                  ...editedRecord,
                  name: e.target.value,
                })
              }
              className="h-8"
            />
          </div>
          <div className="col-span-4">
            {editedRecord.type === "SRV" ? (
              <div className="grid grid-cols-4 gap-2">
                <Input
                  type="number"
                  placeholder="priority"
                  value={srvPriority ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSrvPriority(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(val, srvWeight, srvPort, srvTarget),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder="weight"
                  value={srvWeight ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSrvWeight(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(srvPriority, val, srvPort, srvTarget),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder="port"
                  value={srvPort ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSrvPort(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(
                        srvPriority,
                        srvWeight,
                        val,
                        srvTarget,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="target"
                  value={srvTarget}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setSrvTarget(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSRV(
                        srvPriority,
                        srvWeight,
                        srvPort,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "TLSA" ? (
              <div className="grid grid-cols-4 gap-2">
                <Input
                  type="number"
                  placeholder="usage"
                  value={tlsaUsage ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setTlsaUsage(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        val,
                        tlsaSelector,
                        tlsaMatchingType,
                        tlsaData,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder="selector"
                  value={tlsaSelector ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setTlsaSelector(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        tlsaUsage,
                        val,
                        tlsaMatchingType,
                        tlsaData,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder="matching type"
                  value={tlsaMatchingType ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setTlsaMatchingType(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        tlsaUsage,
                        tlsaSelector,
                        val,
                        tlsaData,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="data"
                  value={tlsaData}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setTlsaData(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeTLSA(
                        tlsaUsage,
                        tlsaSelector,
                        tlsaMatchingType,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "SSHFP" ? (
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  placeholder="algorithm"
                  value={sshfpAlgorithm ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSshfpAlgorithm(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSSHFP(val, sshfpFptype, sshfpFingerprint),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder="fptype"
                  value={sshfpFptype ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setSshfpFptype(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSSHFP(
                        sshfpAlgorithm,
                        val,
                        sshfpFingerprint,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="fingerprint"
                  value={sshfpFingerprint}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setSshfpFingerprint(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeSSHFP(
                        sshfpAlgorithm,
                        sshfpFptype,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "NAPTR" ? (
              <div className="grid grid-cols-6 gap-2">
                <Input
                  type="number"
                  placeholder="order"
                  value={naptrOrder ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setNaptrOrder(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        val,
                        naptrPref,
                        naptrFlags,
                        naptrService,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  type="number"
                  placeholder="preference"
                  value={naptrPref ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    const val = Number.isNaN(n) ? undefined : n;
                    setNaptrPref(val);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        val,
                        naptrFlags,
                        naptrService,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="flags"
                  value={naptrFlags}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrFlags(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        e.target.value,
                        naptrService,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="service"
                  value={naptrService}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrService(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        naptrFlags,
                        e.target.value,
                        naptrRegexp,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="regexp"
                  value={naptrRegexp}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrRegexp(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        naptrFlags,
                        naptrService,
                        e.target.value,
                        naptrReplacement,
                      ),
                    });
                  }}
                  className="h-8"
                />
                <Input
                  placeholder="replacement"
                  value={naptrReplacement}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setNaptrReplacement(e.target.value);
                    setEditedRecord({
                      ...editedRecord,
                      content: composeNAPTR(
                        naptrOrder,
                        naptrPref,
                        naptrFlags,
                        naptrService,
                        naptrRegexp,
                        e.target.value,
                      ),
                    });
                  }}
                  className="h-8"
                />
              </div>
            ) : editedRecord.type === "SPF" ? (
              <div className="space-y-2">
                <Input
                  value={editedRecord.content}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setEditedRecord({
                      ...editedRecord,
                      content: e.target.value,
                    })
                  }
                  className="h-8"
                />
                <div className="flex space-x-2">
                  <select
                    className="h-8 p-2"
                    value={""}
                    onChange={() => {
                      /* small builder not implemented yet */
                    }}
                  >
                    <option value="">+</option>
                  </select>
                  <span className="text-sm">
                    Preview:{" "}
                    {composeSPF(
                      parseSPF(editedRecord.content) ?? {
                        version: "v=spf1",
                        mechanisms: [],
                      },
                    )}
                  </span>
                </div>
                {!validateSPF(editedRecord.content).ok && (
                  <div className="text-red-600">
                    SPF validation issues:{" "}
                    {validateSPF(editedRecord.content).problems.join(", ")}
                  </div>
                )}
              </div>
            ) : (
              <Input
                value={editedRecord.content}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setEditedRecord({
                    ...editedRecord,
                    content: e.target.value,
                  })
                }
                className="h-8"
              />
            )}
          </div>
          <div className="col-span-1 space-y-1">
            <Select
              value={isCustomTTL ? "custom" : String(ttlValue)}
              onValueChange={(value: string) => {
                if (value === "custom") {
                  setEditedRecord({ ...editedRecord, ttl: 300 });
                } else {
                  setEditedRecord({
                    ...editedRecord,
                    ttl: value === "auto" ? "auto" : Number(value),
                  });
                }
              }}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getTTLPresets().map((ttl) => (
                  <SelectItem key={ttl} value={String(ttl)}>
                    {ttl === "auto" ? "Auto" : ttl}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            {isCustomTTL && (
              <Input
                type="number"
                value={
                  typeof editedRecord.ttl === "number" ? editedRecord.ttl : ""
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setEditedRecord({
                    ...editedRecord,
                    ttl: Number.isNaN(n) ? 300 : n,
                  });
                }}
                className="h-8"
              />
            )}
            {editedRecord.type === "MX" && (
              <Input
                type="number"
                value={editedRecord.priority ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setEditedRecord({
                    ...editedRecord,
                    priority: Number.isNaN(n) ? undefined : n,
                  });
                }}
                className="h-8"
              />
            )}
          </div>
          <div className="col-span-1">
            {(editedRecord.type === "A" ||
              editedRecord.type === "AAAA" ||
              editedRecord.type === "CNAME") && (
              <Switch
                checked={editedRecord.proxied || false}
                onCheckedChange={(checked: boolean) =>
                  setEditedRecord({
                    ...editedRecord,
                    proxied: checked,
                  })
                }
              />
            )}
          </div>
          <div className="col-span-1 flex gap-1">
            <Button
              size="sm"
              onClick={() => onSave(editedRecord)}
              className="h-8 w-8 p-0"
            >
              <Save className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCancel}
              className="h-8 w-8 p-0"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 border rounded-lg hover:bg-muted/50 transition-colors">
      <div className="grid grid-cols-12 gap-4 items-center">
        <div className="col-span-2">
          <span
            title={getRecordTypeLabel(record.type as RecordType)}
            className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary"
          >
            {record.type}
          </span>
        </div>
        <div className="col-span-3">
          <span className="font-mono text-sm">{record.name}</span>
        </div>
        <div className="col-span-4">
          <span className="font-mono text-sm break-all">{record.content}</span>
        </div>
        <div className="col-span-1">
          <span className="text-sm text-muted-foreground">
            {record.ttl === 1 ? "Auto" : record.ttl}
          </span>
        </div>
        <div className="col-span-1">
          {record.proxied && (
            <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
              Proxied
            </span>
          )}
        </div>
        <div className="col-span-1 flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            className="h-8 w-8 p-0"
          >
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
