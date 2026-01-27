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

function uniquePush(list: string[], msg: string) {
  if (!list.includes(msg)) list.push(msg);
}

function validateDKIM(value: string) {
  const problems: string[] = [];
  const content = value.trim();
  if (!content) return { ok: true, problems };
  if (!/^v=DKIM1\b/i.test(content)) {
    problems.push("Missing v=DKIM1.");
    return { ok: false, problems };
  }
  if (/-----BEGIN\b/i.test(content)) {
    problems.push("p= looks like it includes a PEM header/footer (use base64 only).");
  }
  const tags = content
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const map = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const tag of tags) {
    const [kRaw, ...rest] = tag.split("=");
    const k = (kRaw ?? "").trim().toLowerCase();
    if (!k) continue;
    const v = rest.join("=").trim();
    seen.set(k, (seen.get(k) ?? 0) + 1);
    map.set(k, v);
  }
  for (const [k, count] of seen) {
    if (count > 1) problems.push(`Duplicate DKIM tag: ${k}=`);
  }
  const allowedTags = new Set(["v", "k", "p", "t", "n", "s", "h", "g"]);
  for (const k of map.keys()) {
    if (!allowedTags.has(k)) problems.push(`Unknown DKIM tag: ${k}=`);
  }
  const p = map.get("p");
  if (p === undefined) {
    problems.push("Missing p= (public key).");
  } else {
    const pk = p.replace(/\s+/g, "");
    if (pk.length > 0 && !/^[A-Za-z0-9+/=]+$/.test(pk))
      problems.push("p= contains non-base64 characters.");
    if (pk.length > 0 && pk.length % 4 !== 0)
      problems.push("p= base64 length is unusual (not a multiple of 4).");
    if (pk.length === 0) problems.push("p= is empty (revoked key). This may be intentional.");
    if (pk.length > 255)
      problems.push("p= is longer than 255 chars; some providers require splitting TXT strings.");
  }
  const k = map.get("k");
  if (!k) problems.push("Missing k= (defaults to rsa, but most providers publish it).");
  else if (!["rsa", "ed25519"].includes(k.toLowerCase()))
    problems.push("k= is usually rsa or ed25519.");
  const v = map.get("v");
  if (v && v.toUpperCase() !== "DKIM1") problems.push("v= should be DKIM1.");
  const t = map.get("t");
  if (t) {
    const flags = t.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const allowed = new Set(["y", "s"]);
    for (const f of flags) if (!allowed.has(f)) problems.push(`Unknown t= flag: ${f}`);
  }
  const s = map.get("s");
  if (s && !["*", "email"].includes(s.trim().toLowerCase()))
    problems.push("s= is usually '*' or 'email'.");
  const h = map.get("h");
  if (h) {
    const parts = h.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const allowed = new Set(["sha1", "sha256"]);
    for (const alg of parts) if (!allowed.has(alg)) problems.push(`Unknown h= algorithm: ${alg}`);
  }
  const g = map.get("g");
  if (g) {
    if (/\s/.test(g)) problems.push("g= contains whitespace.");
    if (g.includes("@")) problems.push("g= should be a local-part pattern (no @domain).");
  }
  return { ok: problems.length === 0, problems };
}

function parseDKIM(value: string | undefined) {
  const content = (value ?? "").trim();
  if (!content.toLowerCase().startsWith("v=dkim1")) {
    return {
      keyType: "rsa" as const,
      publicKey: "",
      testMode: false,
      strictMode: false,
      serviceType: "",
      hashAlgs: "",
      granularity: "",
      notes: "",
    };
  }
  const parts = content
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const tags = new Map<string, string>();
  for (const part of parts) {
    const [kRaw, ...rest] = part.split("=");
    const k = (kRaw ?? "").trim().toLowerCase();
    if (!k) continue;
    const v = rest.join("=").trim();
    tags.set(k, v);
  }
  const keyType = (tags.get("k")?.toLowerCase() === "ed25519" ? "ed25519" : "rsa") as
    | "rsa"
    | "ed25519";
  const publicKey = tags.get("p") ?? "";
  const t = tags.get("t") ?? "";
  const flags = t.split(":").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const testMode = flags.includes("y");
  const strictMode = flags.includes("s");
  const notes = tags.get("n") ?? "";
  const serviceType = tags.get("s") ?? "";
  const hashAlgs = tags.get("h") ?? "";
  const granularity = tags.get("g") ?? "";
  return { keyType, publicKey, testMode, strictMode, serviceType, hashAlgs, granularity, notes };
}

function buildDKIM(fields: {
  keyType: "rsa" | "ed25519";
  publicKey: string;
  testMode: boolean;
  strictMode: boolean;
  serviceType: string;
  hashAlgs: string;
  granularity: string;
  notes: string;
}) {
  const tags: string[] = ["v=DKIM1"];
  if (fields.keyType) tags.push(`k=${fields.keyType}`);
  tags.push(`p=${fields.publicKey.trim().replace(/\s+/g, "")}`);
  const tFlags: string[] = [];
  if (fields.testMode) tFlags.push("y");
  if (fields.strictMode) tFlags.push("s");
  if (tFlags.length) tags.push(`t=${tFlags.join(":")}`);
  if (fields.serviceType.trim()) tags.push(`s=${fields.serviceType.trim()}`);
  if (fields.hashAlgs.trim()) tags.push(`h=${fields.hashAlgs.trim()}`);
  if (fields.granularity.trim()) tags.push(`g=${fields.granularity.trim()}`);
  if (fields.notes.trim()) tags.push(`n=${fields.notes.trim()}`);
  return tags.join("; ") + ";";
}

export function DkimBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [keyType, setKeyType] = useState<"rsa" | "ed25519">("rsa");
  const [selector, setSelector] = useState<string>("");
  const [publicKey, setPublicKey] = useState<string>("");
  const [testMode, setTestMode] = useState(false);
  const [strictMode, setStrictMode] = useState(false);
  const [serviceType, setServiceType] = useState<string>("");
  const [hashAlgs, setHashAlgs] = useState<string>("");
  const [granularity, setGranularity] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    if (record.type !== "TXT") return;
    const parsed = parseDKIM(record.content);
    setKeyType(parsed.keyType);
    setPublicKey(parsed.publicKey);
    setTestMode(parsed.testMode);
    setStrictMode(parsed.strictMode);
    setServiceType(parsed.serviceType);
    setHashAlgs(parsed.hashAlgs);
    setGranularity(parsed.granularity);
    setNotes(parsed.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  useEffect(() => {
    if (record.type !== "TXT") return;
    if (selector.trim()) return;
    const name = (record.name ?? "").trim();
    const m = /^(.+)\._domainkey$/i.exec(name);
    if (m?.[1]) setSelector(m[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.name]);

  const hashPreset = useMemo(() => {
    const normalized = hashAlgs.trim().toLowerCase();
    if (!normalized) return "omit";
    if (normalized === "sha256") return "sha256";
    if (normalized === "sha1") return "sha1";
    if (normalized === "sha1:sha256") return "sha1:sha256";
    if (normalized === "sha256:sha1") return "sha256:sha1";
    return "custom";
  }, [hashAlgs]);

  const diagnostics = useMemo(() => {
    const issues: string[] = [];
    const nameIssues: string[] = [];

    const content = (record.content ?? "").trim();
    if (!content) {
      uniquePush(issues, "DKIM: content is empty.");
    } else {
      const v = validateDKIM(content);
      for (const p of v.problems) uniquePush(issues, `DKIM: ${p}`);
      if (!content.endsWith(";"))
        uniquePush(issues, "DKIM: consider ending tags with ';' for readability.");
    }

    const selectorTrim = selector.trim();
    const name = (record.name ?? "").trim();
    if (!selectorTrim) {
      uniquePush(nameIssues, "DKIM: selector is missing.");
    } else {
      const expected = `${selectorTrim}._domainkey`;
      if (name && name !== expected)
        uniquePush(
          nameIssues,
          `DKIM: name is usually "${expected}" for selector "${selectorTrim}".`,
        );
      if (!/^[A-Za-z0-9-_]+$/.test(selectorTrim))
        uniquePush(nameIssues, "DKIM: selector contains unusual characters.");
    }

    const pk = publicKey.trim().replace(/\s+/g, "");
    if (keyType === "ed25519" && pk) {
      if (pk.length < 40 || pk.length > 64)
        uniquePush(issues, "DKIM: ed25519 p= length looks unusual (expected ~44 base64 chars).");
    }
    if (keyType === "rsa" && pk) {
      if (pk.length < 200) uniquePush(issues, "DKIM: rsa p= looks unusually short.");
    }

    const canonical = buildDKIM({
      keyType,
      publicKey,
      testMode,
      strictMode,
      serviceType,
      hashAlgs,
      granularity,
      notes,
    });

    if (content && content !== canonical)
      uniquePush(
        issues,
        "DKIM: content differs from the builder settings (use Build DKIM TXT to normalize).",
      );

    return { canonical, issues, nameIssues };
  }, [
    granularity,
    hashAlgs,
    keyType,
    notes,
    publicKey,
    record.content,
    record.name,
    selector,
    serviceType,
    strictMode,
    testMode,
  ]);

  useEffect(() => {
    if (!onWarningsChange) return;
    onWarningsChange({
      issues: diagnostics.issues,
      nameIssues: diagnostics.nameIssues,
      canonical: diagnostics.canonical,
    });
  }, [diagnostics.canonical, diagnostics.issues, diagnostics.nameIssues, onWarningsChange]);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="text-xs font-semibold text-muted-foreground">DKIM builder</div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Key type</Label>
          <Select value={keyType} onValueChange={(value: string) => setKeyType(value as any)}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rsa">rsa</SelectItem>
              <SelectItem value="ed25519">ed25519</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Selector</Label>
          <Input
            value={selector}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSelector(e.target.value)}
            placeholder="e.g., default"
          />
          <div className="text-[11px] text-muted-foreground">
            Published at <code>&lt;selector&gt;._domainkey</code>.
          </div>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Mode</Label>
          <Select
            value={
              testMode && strictMode ? "test+strict" : testMode ? "test" : strictMode ? "strict" : "prod"
            }
            onValueChange={(value: string) => {
              if (value === "prod") {
                setTestMode(false);
                setStrictMode(false);
              } else if (value === "test") {
                setTestMode(true);
                setStrictMode(false);
              } else if (value === "strict") {
                setTestMode(false);
                setStrictMode(true);
              } else {
                setTestMode(true);
                setStrictMode(true);
              }
            }}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prod">Production</SelectItem>
              <SelectItem value="test">Test (t=y)</SelectItem>
              <SelectItem value="strict">Strict (t=s)</SelectItem>
              <SelectItem value="test+strict">Test + strict</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-6">
          <Label className="text-xs">Public key (p=)</Label>
          <Input
            value={publicKey}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPublicKey(e.target.value)}
            placeholder="base64 public key (no PEM header/footer)"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">h= (hash algorithms)</Label>
          <Select
            value={hashPreset}
            onValueChange={(value: string) => {
              if (value === "omit") setHashAlgs("");
              else if (value === "custom") setHashAlgs(hashAlgs);
              else setHashAlgs(value);
            }}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="omit">Omit (default)</SelectItem>
              <SelectItem value="sha256">sha256</SelectItem>
              <SelectItem value="sha1">sha1</SelectItem>
              <SelectItem value="sha1:sha256">sha1:sha256</SelectItem>
              <SelectItem value="sha256:sha1">sha256:sha1</SelectItem>
              <SelectItem value="custom">Custom…</SelectItem>
            </SelectContent>
          </Select>
          {hashPreset === "custom" && (
            <Input
              className="mt-2"
              value={hashAlgs}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setHashAlgs(e.target.value)}
              placeholder="e.g., sha256"
            />
          )}
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">s= (service type)</Label>
          <Input value={serviceType} onChange={(e: ChangeEvent<HTMLInputElement>) => setServiceType(e.target.value)} placeholder="e.g., * or email" />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">g= (granularity)</Label>
          <Input value={granularity} onChange={(e: ChangeEvent<HTMLInputElement>) => setGranularity(e.target.value)} placeholder="optional" />
        </div>

        <div className="space-y-1 sm:col-span-6">
          <Label className="text-xs">n= (notes)</Label>
          <Input value={notes} onChange={(e: ChangeEvent<HTMLInputElement>) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const s = selector.trim();
            if (!s) return;
            onRecordChange({ ...record, name: `${s}._domainkey` });
          }}
          disabled={!selector.trim()}
        >
          Use DKIM name
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const parsed = parseDKIM(record.content);
            setKeyType(parsed.keyType);
            setPublicKey(parsed.publicKey);
            setTestMode(parsed.testMode);
            setStrictMode(parsed.strictMode);
            setServiceType(parsed.serviceType);
            setHashAlgs(parsed.hashAlgs);
            setGranularity(parsed.granularity);
            setNotes(parsed.notes);
          }}
        >
          Load from content
        </Button>
        <Button size="sm" onClick={() => onRecordChange({ ...record, content: diagnostics.canonical })}>
          Build DKIM TXT
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
            Keep TXT value as a single line; some providers require splitting long <code>p=</code> into multiple strings.
          </li>
          <li>
            Start with production mode; use <code>t=y</code> only for testing.
          </li>
          <li>Selector should be stable and match your sending service.</li>
        </ul>
      </div>

      {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="text-sm font-semibold">DKIM warnings</div>
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
  );
}

