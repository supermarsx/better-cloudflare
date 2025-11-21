/**
 * Dialog used to collect DNS record properties required to create a new
 * record via the API.
 */
import type { ChangeEvent } from 'react';
import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { DNSRecord, RecordType, TTLValue } from '@/types/dns';
import { parseSPF, composeSPF, validateSPF } from '@/lib/spf';
import type { SPFGraph, SPFMechanism } from '@/lib/spf';
import { useCloudflareAPI } from '@/hooks/use-cloudflare-api';
import { RECORD_TYPES, getTTLPresets, getRecordTypeLabel } from '@/types/dns';
import { Plus } from 'lucide-react';

/**
 * Props for the AddRecordDialog component which collects fields to create a
 * new DNS record (type, name, content, ttl, etc.).
 */
export interface AddRecordDialogProps {
  /** Whether the dialog is currently open */
  open: boolean;
  /** Callback invoked when open state changes (open/close) */
  onOpenChange: (open: boolean) => void;
  /** Working DNS record object for the form */
  record: Partial<DNSRecord>;
  /** Called when fields in the form change with the updated record */
  onRecordChange: (record: Partial<DNSRecord>) => void;
  /** Called to create the new record */
  onAdd: () => void;
  /** Optional name of the zone to display in the dialog */
  zoneName?: string;
  apiKey?: string;
  email?: string;
}

/**
 * Dialog that collects fields to create a DNS record and forwards the
 * create action via `onAdd`.
 */
export function AddRecordDialog({ open, onOpenChange, record, onRecordChange, onAdd, zoneName, apiKey, email }: AddRecordDialogProps) {
  const { simulateSPF, getSPFGraph } = useCloudflareAPI(apiKey, email);
  const ttlValue = record.ttl === 1 ? 'auto' : record.ttl;
  const isCustomTTL = ttlValue !== undefined && !getTTLPresets().includes(ttlValue as TTLValue);
  // SRV fields (priority weight port target) parsed from record.content
  const parseSRV = useCallback((content?: string) => {
    if (!content) return { priority: undefined, weight: undefined, port: undefined, target: '' };
    const parts = String(content).trim().split(/\s+/);
    if (parts.length < 4) return { priority: undefined, weight: undefined, port: undefined, target: content };
    const [priority, weight, port, ...rest] = parts;
    return { priority: Number(priority), weight: Number(weight), port: Number(port), target: rest.join(' ') };
  }, [] as const);
  const composeSRV = (p?: number, w?: number, prt?: number, t?: string) => `${p ?? 0} ${w ?? 0} ${prt ?? 0} ${t ?? ''}`;
  const [srvPriority, setSrvPriority] = useState<number | undefined>(parseSRV(record.content).priority);
  const [srvWeight, setSrvWeight] = useState<number | undefined>(parseSRV(record.content).weight);
  const [srvPort, setSrvPort] = useState<number | undefined>(parseSRV(record.content).port);
  const [srvTarget, setSrvTarget] = useState<string>(parseSRV(record.content).target ?? '');
  // TLSA fields (usage selector matchingType data)
  const parseTLSA = useCallback((content?: string) => {
    if (!content) return { usage: undefined, selector: undefined, matchingType: undefined, data: '' };
    const parts = String(content).trim().split(/\s+/);
    if (parts.length < 4) return { usage: undefined, selector: undefined, matchingType: undefined, data: content };
    const [usage, selector, matchingType, ...rest] = parts;
    return { usage: Number(usage), selector: Number(selector), matchingType: Number(matchingType), data: rest.join(' ') };
  }, [] as const);
  const composeTLSA = (u?: number, s?: number, m?: number, d?: string) => `${u ?? 0} ${s ?? 0} ${m ?? 0} ${d ?? ''}`;
  const [tlsaUsage, setTlsaUsage] = useState<number | undefined>(parseTLSA(record.content).usage);
  const [tlsaSelector, setTlsaSelector] = useState<number | undefined>(parseTLSA(record.content).selector);
  const [tlsaMatchingType, setTlsaMatchingType] = useState<number | undefined>(parseTLSA(record.content).matchingType);
  const [tlsaData, setTlsaData] = useState<string>(parseTLSA(record.content).data ?? '');
  // SSHFP fields (algorithm, fptype, fingerprint)
  const parseSSHFP = useCallback((content?: string) => {
    if (!content) return { algorithm: undefined, fptype: undefined, fingerprint: '' };
    const parts = String(content).trim().split(/\s+/);
    if (parts.length < 3) return { algorithm: undefined, fptype: undefined, fingerprint: content };
    const [algorithm, fptype, ...rest] = parts;
    return { algorithm: Number(algorithm), fptype: Number(fptype), fingerprint: rest.join(' ') };
  }, [] as const);
  const composeSSHFP = (a?: number, f?: number, fp?: string) => `${a ?? 0} ${f ?? 0} ${fp ?? ''}`;
  const [sshfpAlgorithm, setSshfpAlgorithm] = useState<number | undefined>(parseSSHFP(record.content).algorithm);
  const [sshfpFptype, setSshfpFptype] = useState<number | undefined>(parseSSHFP(record.content).fptype);
  const [sshfpFingerprint, setSshfpFingerprint] = useState<string>(parseSSHFP(record.content).fingerprint ?? '');
  const splitNaptrTokens = useCallback((s: string) => {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        inQuote = !inQuote;
        current += ch;
        continue;
      }
      if (ch === ' ' && !inQuote) {
        if (current.trim().length > 0) {
          tokens.push(current.trim());
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (current.trim().length > 0) tokens.push(current.trim());
    return tokens;
  }, [] as const);

  const parseNAPTR = useCallback((content?: string) => {
    if (!content) return { order: undefined, preference: undefined, flags: '', service: '', regexp: '', replacement: '' };
    const tokens = splitNaptrTokens(String(content).trim());
    const [order, preference, flags, service, regexp, replacement] = tokens;
    return { order: Number(order), preference: Number(preference), flags: flags?.replace(/^"|"$/g, ''), service, regexp: regexp?.replace(/^"|"$/g, ''), replacement };
  }, [splitNaptrTokens] as const);
  const quoteIfNeeded = (s?: string) => {
    if (!s) return '';
    if (/\s/.test(s) || /"/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
  };
  const composeNAPTR = (o?: number, p?: number, f?: string, s?: string, r?: string, rep?: string) => `${o ?? 0} ${p ?? 0} ${f ?? ''} ${s ?? ''} ${quoteIfNeeded(r)} ${rep ?? ''}`;
  const [naptrOrder, setNaptrOrder] = useState<number | undefined>(parseNAPTR(record.content).order);
  const [naptrPref, setNaptrPref] = useState<number | undefined>(parseNAPTR(record.content).preference);
  const [naptrFlags, setNaptrFlags] = useState<string>(parseNAPTR(record.content).flags ?? '');
  const [naptrService, setNaptrService] = useState<string>(parseNAPTR(record.content).service ?? '');
  const [naptrRegexp, setNaptrRegexp] = useState<string>(parseNAPTR(record.content).regexp ?? '');
  const [naptrReplacement, setNaptrReplacement] = useState<string>(parseNAPTR(record.content).replacement ?? '');

  useEffect(() => {
    if (record.type === 'SRV') {
      const parsed = parseSRV(record.content);
      setSrvPriority(parsed.priority);
      setSrvWeight(parsed.weight);
      setSrvPort(parsed.port);
      setSrvTarget(parsed.target ?? '');
    }
  }, [record.type, record.content, parseNAPTR, parseSSHFP, parseTLSA, parseSRV]);
  useEffect(() => {
    if (record.type === 'TLSA') {
      const parsed = parseTLSA(record.content);
      setTlsaUsage(parsed.usage);
      setTlsaSelector(parsed.selector);
      setTlsaMatchingType(parsed.matchingType);
      setTlsaData(parsed.data ?? '');
    }
    if (record.type === 'SSHFP') {
      const parsed = parseSSHFP(record.content);
      setSshfpAlgorithm(parsed.algorithm);
      setSshfpFptype(parsed.fptype);
      setSshfpFingerprint(parsed.fingerprint ?? '');
    }
    if (record.type === 'NAPTR') {
      const parsed = parseNAPTR(record.content);
      setNaptrOrder(parsed.order);
      setNaptrPref(parsed.preference);
      setNaptrFlags(parsed.flags ?? '');
      setNaptrService(parsed.service ?? '');
      setNaptrRegexp(parsed.regexp ?? '');
      setNaptrReplacement(parsed.replacement ?? '');
    }
    // SSHFP state managed similarly below
  }, [record.type, record.content]);

  // SPF state and builder
  const parsedSPF = parseSPF(record.content);
  const [newSPFQualifier, setNewSPFQualifier] = useState<string>('');
  const [newSPFMechanism, setNewSPFMechanism] = useState<string>('ip4');
  const [newSPFValue, setNewSPFValue] = useState<string>('');
  const [editingSPFIndex, setEditingSPFIndex] = useState<number | null>(null);
  const [spfSimIp, setSpfSimIp] = useState<string>('');
  const [spfSimResult, setSpfSimResult] = useState<{ result: string; reasons: string[]; lookups: number } | null>(null);
  const [spfGraph, setSpfGraph] = useState<SPFGraph | null>(null);
  const [spfGraphError, setSpfGraphError] = useState<string | null>(null);

  const addSPFMechanism = () => {
    const mechVal = newSPFValue?.trim();
    const newMech: SPFMechanism = { qualifier: newSPFQualifier || undefined, mechanism: newSPFMechanism as unknown as string, value: mechVal || undefined } as SPFMechanism;
    const parsed = parseSPF(record.content) ?? { version: 'v=spf1', mechanisms: [] };
    const mechs = [...parsed.mechanisms];
    if (editingSPFIndex !== null && editingSPFIndex >= 0 && editingSPFIndex < mechs.length) {
      mechs[editingSPFIndex] = newMech;
      setEditingSPFIndex(null);
    } else {
      mechs.push(newMech);
    }
    const updated = composeSPF({ version: parsed.version, mechanisms: mechs as SPFMechanism[] });
    onRecordChange({ ...record, content: updated });
    // reset form
    setNewSPFValue('');
    setNewSPFQualifier('');
    setNewSPFMechanism('ip4');
  };

  const removeSPFMechanism = (index: number) => {
    const parsed = parseSPF(record.content) ?? { version: 'v=spf1', mechanisms: [] };
    const mechs = [...parsed.mechanisms];
    mechs.splice(index, 1);
    const updated = composeSPF({ version: parsed.version, mechanisms: mechs as SPFMechanism[] });
    onRecordChange({ ...record, content: updated });
  };

  const editSPFMechanism = (index: number) => {
    const parsed = parseSPF(record.content) ?? { version: 'v=spf1', mechanisms: [] };
    const m = parsed.mechanisms[index];
    setNewSPFQualifier(m.qualifier || '');
    setNewSPFMechanism(m.mechanism || 'ip4');
    setNewSPFValue(m.value || '');
    setEditingSPFIndex(index);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Add Record
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add DNS Record</DialogTitle>
          <DialogDescription>
            Create a new DNS record for {zoneName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={record.type}
                onValueChange={(value: string) =>
                  onRecordChange({
                    ...record,
                    type: value as RecordType,
                    priority: value === 'MX' ? record.priority : undefined
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((type) => (
                    <SelectItem key={type} value={type} title={getRecordTypeLabel(type)}>
                      {getRecordTypeLabel(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>TTL</Label>
              <Select
                value={isCustomTTL ? 'custom' : String(ttlValue)}
                onValueChange={(value: string) => {
                  if (value === 'custom') {
                    onRecordChange({ ...record, ttl: 300 });
                  } else {
                    onRecordChange({
                      ...record,
                      ttl: value === 'auto' ? 'auto' : Number(value)
                    });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getTTLPresets().map((ttl) => (
                    <SelectItem key={ttl} value={String(ttl)}>
                      {ttl === 'auto' ? 'Auto' : ttl}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              {isCustomTTL && (
                <Input
                  type="number"
                  value={typeof record.ttl === 'number' ? record.ttl : ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    onRecordChange({
                      ...record,
                      ttl: Number.isNaN(n) ? 300 : n
                    });
                  }}
                />
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={record.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                ...record,
                name: e.target.value
              })}
              placeholder="e.g., www or @ for root"
            />
          </div>
          <div className="space-y-2">
            <Label>Content</Label>
            {(() => {
              switch (record.type) {
                case 'SRV':
                  return (
                    <div className="grid grid-cols-4 gap-2">
                      <Input
                        type="number"
                        placeholder="priority"
                        value={srvPriority ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setSrvPriority(Number.isNaN(n) ? undefined : n);
                          onRecordChange({ ...record, content: composeSRV(Number.isNaN(n) ? undefined : n, srvWeight, srvPort, srvTarget) });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="weight"
                        value={srvWeight ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setSrvWeight(Number.isNaN(n) ? undefined : n);
                          onRecordChange({ ...record, content: composeSRV(srvPriority, Number.isNaN(n) ? undefined : n, srvPort, srvTarget) });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="port"
                        value={srvPort ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          setSrvPort(Number.isNaN(n) ? undefined : n);
                          onRecordChange({ ...record, content: composeSRV(srvPriority, srvWeight, Number.isNaN(n) ? undefined : n, srvTarget) });
                        }}
                      />
                      <Input
                        placeholder="target"
                        value={srvTarget}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setSrvTarget(e.target.value);
                          onRecordChange({ ...record, content: composeSRV(srvPriority, srvWeight, srvPort, e.target.value) });
                        }}
                      />
                    </div>
                  );
                case 'TLSA':
                  return (
                    <div className="grid grid-cols-4 gap-2">
                      <Input
                        type="number"
                        placeholder="usage"
                        value={tlsaUsage ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setTlsaUsage(val);
                          onRecordChange({ ...record, content: composeTLSA(val, tlsaSelector, tlsaMatchingType, tlsaData) });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="selector"
                        value={tlsaSelector ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setTlsaSelector(val);
                          onRecordChange({ ...record, content: composeTLSA(tlsaUsage, val, tlsaMatchingType, tlsaData) });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="matching type"
                        value={tlsaMatchingType ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setTlsaMatchingType(val);
                          onRecordChange({ ...record, content: composeTLSA(tlsaUsage, tlsaSelector, val, tlsaData) });
                        }}
                      />
                      <Input
                        placeholder="data"
                        value={tlsaData}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setTlsaData(e.target.value);
                          onRecordChange({ ...record, content: composeTLSA(tlsaUsage, tlsaSelector, tlsaMatchingType, e.target.value) });
                        }}
                      />
                    </div>
                  );
                case 'SSHFP':
                  return (
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        type="number"
                        placeholder="algorithm"
                        value={sshfpAlgorithm ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setSshfpAlgorithm(val);
                          onRecordChange({ ...record, content: composeSSHFP(val, sshfpFptype, sshfpFingerprint) });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="fptype"
                        value={sshfpFptype ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setSshfpFptype(val);
                          onRecordChange({ ...record, content: composeSSHFP(sshfpAlgorithm, val, sshfpFingerprint) });
                        }}
                      />
                      <Input
                        placeholder="fingerprint"
                        value={sshfpFingerprint}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setSshfpFingerprint(e.target.value);
                          onRecordChange({ ...record, content: composeSSHFP(sshfpAlgorithm, sshfpFptype, e.target.value) });
                        }}
                      />
                    </div>
                  );
                case 'NAPTR':
                  return (
                    <div className="grid grid-cols-6 gap-2">
                      <Input
                        type="number"
                        placeholder="order"
                        value={naptrOrder ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setNaptrOrder(val);
                          onRecordChange({ ...record, content: composeNAPTR(val, naptrPref, naptrFlags, naptrService, naptrRegexp, naptrReplacement) });
                        }}
                      />
                      <Input
                        type="number"
                        placeholder="preference"
                        value={naptrPref ?? ''}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          const n = Number.parseInt(e.target.value, 10);
                          const val = Number.isNaN(n) ? undefined : n;
                          setNaptrPref(val);
                          onRecordChange({ ...record, content: composeNAPTR(naptrOrder, val, naptrFlags, naptrService, naptrRegexp, naptrReplacement) });
                        }}
                      />
                      <Input
                        placeholder="flags"
                        value={naptrFlags}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrFlags(e.target.value);
                          onRecordChange({ ...record, content: composeNAPTR(naptrOrder, naptrPref, e.target.value, naptrService, naptrRegexp, naptrReplacement) });
                        }}
                      />
                      <Input
                        placeholder="service"
                        value={naptrService}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrService(e.target.value);
                          onRecordChange({ ...record, content: composeNAPTR(naptrOrder, naptrPref, naptrFlags, e.target.value, naptrRegexp, naptrReplacement) });
                        }}
                      />
                      <Input
                        placeholder="regexp"
                        value={naptrRegexp}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrRegexp(e.target.value);
                          onRecordChange({ ...record, content: composeNAPTR(naptrOrder, naptrPref, naptrFlags, naptrService, e.target.value, naptrReplacement) });
                        }}
                      />
                      <Input
                        placeholder="replacement"
                        value={naptrReplacement}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setNaptrReplacement(e.target.value);
                          onRecordChange({ ...record, content: composeNAPTR(naptrOrder, naptrPref, naptrFlags, naptrService, naptrRegexp, e.target.value) });
                        }}
                      />
                    </div>
                  );
                case 'SPF':
                  return (
                    <div className="space-y-2">
                      <Input
                        value={record.content}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                          ...record,
                          content: e.target.value
                        })}
                        placeholder="v=spf1 ip4:... ~all"
                      />
                      <div className="flex space-x-2">
                        <select className="h-8 p-2" value={newSPFQualifier} onChange={(e) => setNewSPFQualifier(e.target.value)}>
                          <option value="">+</option>
                          <option value="-">-</option>
                          <option value="~">~</option>
                          <option value="?">?</option>
                        </select>
                        <select className="h-8 p-2" value={newSPFMechanism} onChange={(e) => setNewSPFMechanism(e.target.value)}>
                          <option value="ip4">ip4</option>
                          <option value="ip6">ip6</option>
                          <option value="a">a</option>
                          <option value="mx">mx</option>
                          <option value="include">include</option>
                          <option value="all">all</option>
                        </select>
                        <Input placeholder="value (optional)" value={newSPFValue} onChange={(e: ChangeEvent<HTMLInputElement>) => setNewSPFValue(e.target.value)} />
                        <Button onClick={addSPFMechanism}>{editingSPFIndex !== null ? 'Update' : 'Add'}</Button>
                      </div>
                      <div className="text-sm text-muted">
                        {parsedSPF?.mechanisms && parsedSPF.mechanisms.length > 0 && (
                          <div className="space-y-1 mb-2">
                            <div className="text-xs font-semibold">Mechanisms:</div>
                            {parsedSPF.mechanisms.map((m, i) => (
                              <div key={`${m.mechanism}:${i}`} className="flex items-center space-x-2">
                                <div className="text-xs">{`${m.qualifier ?? ''}${m.mechanism}${m.value ? `:${m.value}` : ''}`}{editingSPFIndex===i ? ' (editing)' : ''}</div>
                                <Button size="sm" onClick={() => editSPFMechanism(i)}>Edit</Button>
                                <Button size="sm" variant="destructive" onClick={() => removeSPFMechanism(i)}>Remove</Button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div>Preview:</div>
                        <pre className="whitespace-pre-wrap">{composeSPF(parsedSPF ?? { version: 'v=spf1', mechanisms: [] })}</pre>
                        {!validateSPF(record.content).ok && (
                          <div className="text-red-600">SPF validation issues: {validateSPF(record.content).problems.join(', ')}</div>
                        )}
                        <div className="flex space-x-2 mt-2">
                          <Input placeholder="simulate IP e.g., 1.2.3.4" value={spfSimIp} onChange={(e) => setSpfSimIp(e.target.value)} />
                          <Button onClick={async () => {
                            if (!zoneName) return;
                            const domain = (record.name === '@' || !record.name) ? zoneName : `${record.name}.${zoneName}`;
                            try {
                              const result = await simulateSPF(domain, spfSimIp);
                              setSpfSimResult(result);
                            } catch (err) {
                              setSpfSimResult({ result: 'temperror', reasons: [(err as Error).message], lookups: 0 });
                            }
                          }}>Simulate</Button>
                          <Button onClick={async () => {
                            if (!zoneName) return;
                            const domain = (record.name === '@' || !record.name) ? zoneName : `${record.name}.${zoneName}`;
                            try {
                              const graph = await getSPFGraph(domain);
                              setSpfGraph(graph);
                              setSpfGraphError(null);
                            } catch (err) {
                              setSpfGraph(null);
                              setSpfGraphError((err as Error).message);
                            }
                          }}>Graph</Button>
                        </div>
                        {spfSimResult && (
                          <div className="text-sm mt-2">Result: <strong>{spfSimResult.result}</strong> (lookups: {spfSimResult.lookups})<div className="text-xs text-muted">{spfSimResult.reasons.join(', ')}</div></div>
                        )}
                        {spfGraphError && (
                          <div className="text-sm text-red-600 mt-2">Error building graph: {spfGraphError}</div>
                        )}
                        {spfGraph && (
                          <div className="text-sm mt-2"><div>Graph:</div><pre className="whitespace-pre-wrap">{JSON.stringify(spfGraph, null, 2)}</pre></div>
                        )}
                      </div>
                    </div>
                  );
                default:
                  return (
                    <Input
                      value={record.content}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                        ...record,
                        content: e.target.value
                      })}
                      placeholder="e.g., 192.168.1.1"
                    />
                  );
              }
            })()}
          </div>
          {record.type === 'MX' && (
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={record.priority || ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  onRecordChange({
                    ...record,
                    priority: Number.isNaN(n) ? undefined : n
                  });
                }}
              />
            </div>
          )}
          {(record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME') && (
            <div className="flex items-center space-x-2">
              <Switch
                checked={record.proxied || false}
                onCheckedChange={(checked: boolean) =>
                  onRecordChange({
                    ...record,
                    proxied: checked
                  })
                }
              />
              <Label>Proxied through Cloudflare</Label>
            </div>
          )}
          <Button onClick={onAdd} className="w-full">
            Create Record
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
