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
import { unquoteCharacterString } from "@/lib/dns/character-string";

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

function uniquePush(list: string[], msg: string) {
  if (!list.includes(msg)) list.push(msg);
}

export type DkimKeyType = "rsa" | "ed25519";

export type DkimFields = {
  keyType: DkimKeyType;
  selector: string;
  publicKey: string;
  testMode: boolean;
  strictMode: boolean;
  serviceType: string;
  hashAlgs: string;
  granularity: string;
  notes: string;
};

const DKIM_KEY_TYPE_LABEL: Record<DkimKeyType, string> = {
  rsa: "RSA",
  ed25519: "Ed25519",
};

/** Split a colon-separated DKIM list tag (`t=`, `h=`) into its lowercase parts. */
function splitDkimList(value: string) {
  return value
    .split(":")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Plain-English description of the DKIM key record being assembled.
 *
 * `hasDkimContent` distinguishes the two meanings of an empty `p=`: on a blank
 * form it is simply unfinished, but in a record that already reads `v=DKIM1`
 * it is a deliberate revocation (RFC 6376 §3.6.1).
 */
export function describeDKIM(
  fields: DkimFields,
  options?: { hasDkimContent?: boolean },
): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const selector = fields.selector.trim();
  const selectorClause = selector ? ` made with selector ${selector}` : "";
  const key = fields.publicKey.trim().replace(/\s+/g, "");

  let headline: string;
  if (!key && !options?.hasDkimContent) {
    headline = `Will publish the public key that receiving mail servers use to verify DKIM signatures${selectorClause} for this domain. Paste in the base64 key your sending service issued.`;
  } else if (!key) {
    headline = `Revokes the DKIM key for ${selector ? `selector ${selector}` : "this selector"}: p= is empty, so receivers must treat every signature made with it as failing.`;
    details.push(
      "Mail already in flight that was signed with this selector stops verifying as soon as receivers pick the change up.",
    );
  } else {
    headline = `Publishes the ${DKIM_KEY_TYPE_LABEL[fields.keyType]} public key that receiving mail servers use to verify DKIM signatures${selectorClause} for this domain.`;
    details.push(
      "Only verification is published here; the matching private key has to be installed at whatever service sends the mail.",
    );
  }

  if (!selector) {
    details.push(
      "No selector is set yet, so the name this record has to be published at, <selector>._domainkey, is still undecided.",
    );
  }

  if (fields.keyType === "ed25519" && key) {
    details.push(
      "Ed25519 signatures (RFC 8463) are only checked by receivers that support them, so an RSA selector is usually published alongside.",
    );
  }

  if (fields.testMode) {
    details.push(
      "Testing mode is on (t=y): receivers must not treat mail that fails this key any differently from unsigned mail, so the key protects nothing until testing mode is switched off.",
    );
  }
  if (fields.strictMode) {
    details.push(
      "Strict mode is on (t=s): a signature's i= identity must be this exact domain, so signatures claiming a subdomain of it are not accepted.",
    );
  }

  // Tags left at their default only deserve a mention while there is a key for
  // them to qualify; on a revoked selector they describe nothing.
  const serviceType = fields.serviceType.trim().toLowerCase();
  if (!serviceType || serviceType === "*") {
    if (key) {
      details.push(
        "Every service type may use this key, which is the s= default.",
      );
    }
  } else if (serviceType === "email") {
    details.push("This key may only be used to sign email (s=email).");
  } else {
    unknowns.push(
      `s=${fields.serviceType.trim()} restricts the key to a service type RFC 6376 does not define; what it permits is decided by whatever specification introduced that name.`,
    );
  }

  const hashes = splitDkimList(fields.hashAlgs);
  if (!hashes.length) {
    if (key) {
      details.push(
        "Signatures may use any hash algorithm the receiver supports, because h= is omitted.",
      );
    }
  } else {
    details.push(
      `Signatures must use ${joinList(hashes, "or")}; a signature using any other hash is rejected.`,
    );
    if (hashes.includes("sha1")) {
      details.push(
        "sha1 is listed as acceptable, and RFC 8301 deprecates SHA-1 for DKIM, so many receivers will not verify those signatures anyway.",
      );
    }
    const unrecognised = hashes.filter(
      (hash) => hash !== "sha1" && hash !== "sha256",
    );
    if (unrecognised.length) {
      details.push(
        `Receivers ignore the ${joinList(unrecognised)} ${unrecognised.length === 1 ? "entry" : "entries"}, because unrecognized h= algorithms must be skipped rather than rejected.`,
      );
    }
  }

  if (fields.granularity.trim()) {
    details.push(
      "g= was removed in RFC 6376 and current verifiers ignore it; only older RFC 4871 implementations still use it to restrict which local-part may sign.",
    );
  }
  if (fields.notes.trim()) {
    details.push(
      "n= is a note for whoever reads this record; verifiers must not base any decision on it.",
    );
  }

  if (key) {
    unknowns.push(
      "The key material is opaque base64 here, so its strength — for RSA, the modulus size — cannot be determined from this form.",
    );
  }

  return { headline, details, unknowns };
}

/**
 * Validate DKIM TXT content. Quoted and multi-string content is accepted and
 * validated as its concatenated logical value.
 */
export function validateDKIM(value: string) {
  const problems: string[] = [];
  const content = unquoteCharacterString(value).trim();
  if (!content) return { ok: true, problems };
  if (!/^v=DKIM1\b/i.test(content)) {
    problems.push("Missing v=DKIM1.");
    return { ok: false, problems };
  }
  if (/-----BEGIN\b/i.test(content)) {
    problems.push(
      "p= looks like it includes a PEM header/footer (use base64 only).",
    );
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
    if (pk.length === 0)
      problems.push("p= is empty (revoked key). This may be intentional.");
    if (pk.length > 255)
      problems.push(
        "p= is longer than 255 chars; some providers require splitting TXT strings.",
      );
  }
  const k = map.get("k");
  if (!k)
    problems.push(
      "Missing k= (defaults to rsa, but most providers publish it).",
    );
  else if (!["rsa", "ed25519"].includes(k.toLowerCase()))
    problems.push("k= is usually rsa or ed25519.");
  const v = map.get("v");
  if (v && v.toUpperCase() !== "DKIM1") problems.push("v= should be DKIM1.");
  const t = map.get("t");
  if (t) {
    const flags = t
      .split(":")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const allowed = new Set(["y", "s"]);
    for (const f of flags)
      if (!allowed.has(f)) problems.push(`Unknown t= flag: ${f}`);
  }
  const s = map.get("s");
  if (s && !["*", "email"].includes(s.trim().toLowerCase()))
    problems.push("s= is usually '*' or 'email'.");
  const h = map.get("h");
  if (h) {
    const parts = h
      .split(":")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const allowed = new Set(["sha1", "sha256"]);
    for (const alg of parts)
      if (!allowed.has(alg)) problems.push(`Unknown h= algorithm: ${alg}`);
  }
  const g = map.get("g");
  if (g) {
    if (/\s/.test(g)) problems.push("g= contains whitespace.");
    if (g.includes("@"))
      problems.push("g= should be a local-part pattern (no @domain).");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Parse DKIM TXT content into builder fields. Quoted and multi-string content
 * is unwrapped before the tags are read.
 */
export function parseDKIM(value: string | undefined) {
  const content = unquoteCharacterString(value).trim();
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
  const keyType = (
    tags.get("k")?.toLowerCase() === "ed25519" ? "ed25519" : "rsa"
  ) as "rsa" | "ed25519";
  const publicKey = tags.get("p") ?? "";
  const t = tags.get("t") ?? "";
  const flags = t
    .split(":")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const testMode = flags.includes("y");
  const strictMode = flags.includes("s");
  const notes = tags.get("n") ?? "";
  const serviceType = tags.get("s") ?? "";
  const hashAlgs = tags.get("h") ?? "";
  const granularity = tags.get("g") ?? "";
  return {
    keyType,
    publicKey,
    testMode,
    strictMode,
    serviceType,
    hashAlgs,
    granularity,
    notes,
  };
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
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "keyType",
    "selector",
    "mode",
    "publicKey",
    "hashAlgs",
    "hashAlgsCustom",
    "serviceType",
    "granularity",
    "notes",
  ] as const);

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

    const content = unquoteCharacterString(record.content).trim();
    if (!content) {
      uniquePush(issues, "DKIM: content is empty.");
    } else {
      const v = validateDKIM(content);
      for (const p of v.problems) uniquePush(issues, `DKIM: ${p}`);
      if (!content.endsWith(";"))
        uniquePush(
          issues,
          "DKIM: consider ending tags with ';' for readability.",
        );
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
        uniquePush(
          issues,
          "DKIM: ed25519 p= length looks unusual (expected ~44 base64 chars).",
        );
    }
    if (keyType === "rsa" && pk) {
      if (pk.length < 200)
        uniquePush(issues, "DKIM: rsa p= looks unusually short.");
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

  const summary = useMemo(
    () =>
      describeDKIM(
        {
          keyType,
          selector,
          publicKey,
          testMode,
          strictMode,
          serviceType,
          hashAlgs,
          granularity,
          notes,
        },
        {
          hasDkimContent: unquoteCharacterString(record.content)
            .trim()
            .toLowerCase()
            .startsWith("v=dkim1"),
        },
      ),
    [
      granularity,
      hashAlgs,
      keyType,
      notes,
      publicKey,
      record.content,
      selector,
      serviceType,
      strictMode,
      testMode,
    ],
  );

  useEffect(() => {
    if (!onWarningsChange) return;
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
  ]);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="text-xs font-semibold text-muted-foreground">
        DKIM builder
      </div>

      <RecordSummary summary={summary} className="mt-2" />

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.keyType}
            descriptionId={helpIds.keyType}
            label="Key type"
            help="Algorithm of the key in p=, published as k=. RSA is the default and every receiver verifies it; Ed25519 (RFC 8463) keys are much shorter but only newer receivers check them."
          />
          <Select
            value={keyType}
            onValueChange={(value: string) =>
              setKeyType(value as "rsa" | "ed25519")
            }
          >
            <SelectTrigger
              id={fieldIds.keyType}
              aria-describedby={helpIds.keyType}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rsa">rsa</SelectItem>
              <SelectItem value="ed25519">ed25519</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.selector}
            descriptionId={helpIds.selector}
            label="Selector"
            help="Names this key so one domain can publish several. It becomes part of the record name and must match the selector the sending service signs with; letters, digits, hyphens and underscores only."
          />
          <Input
            id={fieldIds.selector}
            aria-describedby={helpIds.selector}
            value={selector}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setSelector(e.target.value)
            }
            placeholder="e.g., default"
          />
          <div className="text-[11px] text-muted-foreground">
            Published at <code>&lt;selector&gt;._domainkey</code>.
          </div>
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.mode}
            descriptionId={helpIds.mode}
            label="Mode"
            help="Sets the t= flags. Test (t=y) tells receivers to treat failures from this key exactly like unsigned mail, and strict (t=s) forbids a signature identity that is a subdomain of this domain. Production omits t= and is the normal choice."
          />
          <Select
            value={
              testMode && strictMode
                ? "test+strict"
                : testMode
                  ? "test"
                  : strictMode
                    ? "strict"
                    : "prod"
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
            <SelectTrigger
              id={fieldIds.mode}
              aria-describedby={helpIds.mode}
              className="h-9"
            >
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
          <BuilderFieldLabel
            controlId={fieldIds.publicKey}
            descriptionId={helpIds.publicKey}
            label="Public key (p=)"
            help="The base64 public key your sending service issued, with the PEM header, footer and line breaks stripped out. Leaving it empty publishes a revocation, telling receivers that signatures made with this selector are no longer valid."
          />
          <Input
            id={fieldIds.publicKey}
            aria-describedby={helpIds.publicKey}
            value={publicKey}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setPublicKey(e.target.value)
            }
            placeholder="base64 public key (no PEM header/footer)"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.hashAlgs}
            descriptionId={helpIds.hashAlgs}
            label="h= (hash algorithms)"
            help="Restricts which hash algorithms a signature made with this key may use. Omitting it accepts every algorithm the receiver supports; sha256 is the modern choice and RFC 8301 deprecates sha1."
          />
          <Select
            value={hashPreset}
            onValueChange={(value: string) => {
              if (value === "omit") setHashAlgs("");
              else if (value === "custom") setHashAlgs(hashAlgs);
              else setHashAlgs(value);
            }}
          >
            <SelectTrigger
              id={fieldIds.hashAlgs}
              aria-describedby={helpIds.hashAlgs}
              className="h-9"
            >
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
            <div className="mt-2 space-y-1">
              <BuilderFieldLabel
                controlId={fieldIds.hashAlgsCustom}
                descriptionId={helpIds.hashAlgsCustom}
                label="h= (custom list)"
                help="Colon-separated list of the hash algorithms to accept, for example sha256 or sha1:sha256. Receivers ignore any entry they do not recognize rather than failing the signature."
              />
              <Input
                id={fieldIds.hashAlgsCustom}
                aria-describedby={helpIds.hashAlgsCustom}
                value={hashAlgs}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setHashAlgs(e.target.value)
                }
                placeholder="e.g., sha256"
              />
            </div>
          )}
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.serviceType}
            descriptionId={helpIds.serviceType}
            label="s= (service type)"
            help="Restricts which service types may use this key. The defined values are * (every service, and the default when omitted) and email; leave it empty unless your provider asks for it."
          />
          <Input
            id={fieldIds.serviceType}
            aria-describedby={helpIds.serviceType}
            value={serviceType}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setServiceType(e.target.value)
            }
            placeholder="e.g., * or email"
          />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <BuilderFieldLabel
            controlId={fieldIds.granularity}
            descriptionId={helpIds.granularity}
            label="g= (granularity)"
            help="A local-part pattern from the older DKIM spec that limited which address could sign. RFC 6376 removed the tag and current verifiers ignore it, so leave it empty."
          />
          <Input
            id={fieldIds.granularity}
            aria-describedby={helpIds.granularity}
            value={granularity}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setGranularity(e.target.value)
            }
            placeholder="optional"
          />
        </div>

        <div className="space-y-1 sm:col-span-6">
          <BuilderFieldLabel
            controlId={fieldIds.notes}
            descriptionId={helpIds.notes}
            label="n= (notes)"
            help="Free text for whoever reads this record, such as which service the key belongs to. Verifiers must ignore it, so it changes nothing about how mail is handled."
          />
          <Input
            id={fieldIds.notes}
            aria-describedby={helpIds.notes}
            value={notes}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setNotes(e.target.value)
            }
          />
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
        <Button
          size="sm"
          onClick={() =>
            onRecordChange({ ...record, content: diagnostics.canonical })
          }
        >
          Build DKIM TXT
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
            Keep TXT value as a single line; some providers require splitting
            long <code>p=</code> into multiple strings.
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
