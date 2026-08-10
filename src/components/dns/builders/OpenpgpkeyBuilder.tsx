import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

function isBase64Like(value: string) {
  if (!value) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  return true;
}

function canonicalizeBase64(value: string) {
  return (value ?? "").trim().replace(/\s+/g, "");
}

/** Decoded size of a base64 string, used only for rough "how big is this" prose. */
function approximateDecodedBytes(base64: string) {
  const padding = /=*$/.exec(base64)?.[0].length ?? 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export type OpenpgpkeyFields = {
  keyData: string;
};

/**
 * Plain-English description of the OPENPGPKEY record the builder is assembling.
 *
 * RFC 7929: the RDATA is a binary OpenPGP Transferable Public Key (shown here
 * in base64) published under a hash of the mailbox local-part, so a
 * correspondent can find the key for one address without using a keyserver.
 * The record only carries authority when the zone is DNSSEC-signed.
 */
export function describeOPENPGPKEY(fields: OpenpgpkeyFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const key = canonicalizeBase64(fields.keyData);

  const headline = key
    ? "Lets mail software that supports OpenPGP key discovery fetch the public key for the single email address this record is published under, instead of looking it up on a keyserver."
    : "Publishes the OpenPGP public key for a single email address so correspondents can find it in DNS instead of on a keyserver.";

  if (!key) {
    details.push(
      "No key data has been entered yet, so the record is incomplete.",
    );
  } else {
    details.push(
      "The record holds an OpenPGP Transferable Public Key: binary data in DNS, written as base64 here.",
    );
    const bytes = approximateDecodedBytes(key);
    if (isBase64Like(key) && bytes > 1000) {
      details.push(
        `The key decodes to roughly ${bytes} bytes, which is larger than a typical UDP DNS answer, so resolvers may need EDNS or a TCP retry to fetch it.`,
      );
    }
  }

  details.push(
    "The key is only trustworthy if the zone is signed with DNSSEC and the client validates the answer; without DNSSEC anyone able to spoof DNS can substitute their own key.",
  );
  details.push(
    "Only mail software that implements RFC 7929 discovery looks for this record, and many clients do not.",
  );

  unknowns.push(
    "The owner name is a truncated SHA-256 hash of the mailbox local-part, so whether this record covers the intended email address cannot be verified from here.",
  );
  if (key) {
    unknowns.push(
      "The key material is opaque in this form: which key it is, and which user IDs or expiry it carries, cannot be read here.",
    );
  }

  return { headline, details, unknowns };
}

export function OpenpgpkeyBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [keyData, setKeyData] = useState("");
  const { fieldIds, helpIds } = useBuilderFieldIds(["keyData"] as const);

  const summary = useMemo(() => describeOPENPGPKEY({ keyData }), [keyData]);

  useEffect(() => {
    if (record.type !== "OPENPGPKEY") return;
    setKeyData(record.content ?? "");
  }, [record.content, record.type]);

  const diagnostics = useMemo(() => {
    if (record.type !== "OPENPGPKEY") {
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

    const b64 = canonicalizeBase64(keyData);
    if (!b64) push(issues, "OPENPGPKEY: key data is required (base64).");
    if (keyData.trim() && /\s/.test(keyData.trim()))
      push(
        issues,
        "OPENPGPKEY: key data contains whitespace (canonical removes it).",
      );
    if (b64) {
      if (!isBase64Like(b64))
        push(issues, "OPENPGPKEY: key data does not look like base64.");
      if (isBase64Like(b64) && b64.length % 4 !== 0)
        push(
          issues,
          "OPENPGPKEY: base64 length is not a multiple of 4 (unusual).",
        );
      if (b64.length < 100)
        push(issues, "OPENPGPKEY: key data looks very short for a public key.");
      if (b64.length > 20000)
        push(
          issues,
          "OPENPGPKEY: key data is very large for a single DNS record.",
        );
    }

    const canonical = b64;
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(
        issues,
        "OPENPGPKEY: content differs from builder settings (Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "OPENPGPKEY: name should include the user hash label and _openpgpkey (e.g., <hash>._openpgpkey).",
      );
    if (name && !name.toLowerCase().includes("._openpgpkey"))
      push(nameIssues, "OPENPGPKEY: name usually includes “._openpgpkey”.");

    return { canonical, issues, nameIssues };
  }, [keyData, record.content, record.name, record.type]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "OPENPGPKEY") {
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

  if (record.type !== "OPENPGPKEY") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            OPENPGPKEY builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>base64 key data</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.keyData}
            descriptionId={helpIds.keyData}
            label="Public key (base64)"
            help="The OpenPGP Transferable Public Key for this mailbox, base64-encoded. Export the public key in binary form (for example gpg --export) and base64 it; do not paste the ASCII-armoured block with its BEGIN and END lines."
          />
          <Input
            id={fieldIds.keyData}
            aria-describedby={helpIds.keyData}
            placeholder="base64…"
            value={keyData}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setKeyData(e.target.value);
              onRecordChange({
                ...record,
                content: canonicalizeBase64(e.target.value),
              });
            }}
          />
          <div className="text-[11px] text-muted-foreground">
            Paste base64; whitespace is removed in the canonical preview.
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setKeyData(record.content ?? "")}
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

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">OPENPGPKEY warnings</div>
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
