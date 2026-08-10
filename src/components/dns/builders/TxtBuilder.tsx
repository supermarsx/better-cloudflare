import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CHARACTER_STRING_MAX_BYTES,
  characterStringByteLength,
  isNormalizedCharacterString,
  normalizeCharacterString,
  splitCharacterString,
  unquoteCharacterString,
} from "@/lib/dns/character-string";
import type { SPFGraph } from "@/lib/dns/spf";

import {
  BuilderFieldLabel,
  RecordSummary,
  useBuilderFieldIds,
} from "./BuilderField";
import { pluralize } from "./describe-utils";
import { DkimBuilder } from "./DkimBuilder";
import { DmarcBuilder } from "./DmarcBuilder";
import { SpfBuilder } from "./SpfBuilder";
import type {
  BuilderSummary,
  BuilderWarningsChange,
  RecordDraft,
} from "./types";

export type TxtHelperMode = "auto" | "generic" | "spf" | "dkim" | "dmarc";

/**
 * Plain-English description of a plain TXT record.
 *
 * Only the encoding is knowable here: a TXT record publishes bytes, and what
 * they mean belongs to whichever service reads them, so that stays an unknown.
 */
export function describeTxt(content: string | undefined): BuilderSummary {
  const value = unquoteCharacterString(content);
  if (!value.trim()) {
    return {
      headline:
        "Will publish free-form text at this name for whatever service reads it, most often a verification token. Paste in the exact value that service asked for.",
    };
  }

  const bytes = characterStringByteLength(value);
  const chunks = splitCharacterString(value).length;
  const details: string[] = [];

  if (chunks > 1) {
    details.push(
      `A single DNS string holds at most ${CHARACTER_STRING_MAX_BYTES} bytes, so this is stored as ${pluralize(chunks, "adjacent string")}; a reader joins them back together with nothing in between, recovering the value exactly.`,
    );
  } else {
    details.push(
      "It is stored as one quoted DNS string. The quotes and any backslash escapes are presentation only and are not part of the text a reader receives.",
    );
  }
  if (value !== value.trim()) {
    details.push(
      "Leading or trailing spaces are inside the quoted string, so they are part of the published value.",
    );
  }

  return {
    headline: `Publishes ${pluralize(bytes, "byte")} of text at this name, handed back verbatim to anything that looks up TXT records here.`,
    details,
    unknowns: [
      "What this text means is defined entirely by whatever service reads it; publishing it here only makes the bytes available.",
    ],
  };
}

export function TxtBuilder({
  record,
  onRecordChange,
  zoneName,
  simulateSPF,
  getSPFGraph,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  zoneName?: string;
  simulateSPF?: (
    domain: string,
    ip: string,
  ) => Promise<{
    result: string;
    reasons: string[];
    lookups: number;
  }>;
  getSPFGraph?: (domain: string) => Promise<SPFGraph>;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [txtHelperMode, setTxtHelperMode] = useState<TxtHelperMode>("auto");
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "content",
    "helper",
  ] as const);

  // Auto-detection reads the logical value so quoted and multi-string content
  // ("v=spf1 …" " ~all") is recognised just like bare content.
  const effectiveMode = useMemo(() => {
    if (record.type !== "TXT") return "generic" as const;
    if (txtHelperMode !== "auto") return txtHelperMode;
    const content = unquoteCharacterString(record.content).trim().toLowerCase();
    if (content.startsWith("v=spf1")) return "spf" as const;
    if (content.startsWith("v=dmarc1")) return "dmarc" as const;
    if (content.startsWith("v=dkim1")) return "dkim" as const;
    return "generic" as const;
  }, [record.type, record.content, txtHelperMode]);

  const quoting = useMemo(() => {
    const content = record.content ?? "";
    const value = unquoteCharacterString(content);
    const bytes = characterStringByteLength(value);
    return {
      bytes,
      chunks: splitCharacterString(value).length,
      normalized: normalizeCharacterString(content),
      isNormalized: !content.trim() || isNormalizedCharacterString(content),
      needsSplit: bytes > CHARACTER_STRING_MAX_BYTES,
    };
  }, [record.content]);

  const applyQuoteNormalization = () => {
    const content = record.content ?? "";
    if (!content.trim()) return;
    if (quoting.normalized === content) return;
    onRecordChange({ ...record, content: quoting.normalized });
  };

  const placeholder = useMemo(() => {
    switch (effectiveMode) {
      case "spf":
        return "v=spf1 include:_spf.example.com ~all";
      case "dkim":
        return "v=DKIM1; k=rsa; p=BASE64…;";
      case "dmarc":
        return `v=DMARC1; p=none; rua=mailto:dmarc@${zoneName ?? "example.com"};`;
      case "generic":
      default:
        return 'e.g., "hello world"';
    }
  }, [effectiveMode, zoneName]);

  // Only the generic mode describes itself here: the SPF, DKIM and DMARC
  // sub-builders each render their own summary.
  const summary = useMemo(() => describeTxt(record.content), [record.content]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "TXT" || effectiveMode === "generic") {
      onWarningsChange({ issues: [], nameIssues: [] });
    }
  }, [effectiveMode, onWarningsChange, record.type]);

  if (record.type !== "TXT") return null;

  return (
    <div className="space-y-2">
      {effectiveMode === "generic" && <RecordSummary summary={summary} />}

      <div className="space-y-1">
        <BuilderFieldLabel
          controlId={fieldIds.content}
          descriptionId={helpIds.content}
          label="TXT content"
          help="The text this record publishes, entered as its logical value. It is saved as quoted DNS character-strings, and anything longer than 255 bytes is split into adjacent strings that a reader joins back together."
        />
        <Textarea
          id={fieldIds.content}
          aria-describedby={helpIds.content}
          className="min-h-24 resize-y"
          value={record.content ?? ""}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            onRecordChange({
              ...record,
              content: e.target.value,
            })
          }
          onBlur={applyQuoteNormalization}
          placeholder={placeholder}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          Saved as quoted character-strings: quotes are balanced and escaped
          automatically
          {quoting.needsSplit
            ? `, and ${quoting.bytes} bytes are split into ${quoting.chunks} strings.`
            : "."}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={applyQuoteNormalization}
          disabled={quoting.isNormalized}
        >
          Normalize quotes
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <BuilderFieldLabel
            controlId={fieldIds.helper}
            descriptionId={helpIds.helper}
            label="TXT helper"
            help="Chooses which guided builder opens below the content box. Auto-detect picks one from the v= tag the content starts with, and Generic edits the text directly without a builder."
          />
          <Select
            value={txtHelperMode}
            onValueChange={(value: string) =>
              setTxtHelperMode(value as TxtHelperMode)
            }
          >
            <SelectTrigger
              id={fieldIds.helper}
              aria-describedby={helpIds.helper}
              className="h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              <SelectItem value="generic">Generic</SelectItem>
              <SelectItem value="spf">SPF</SelectItem>
              <SelectItem value="dkim">DKIM</SelectItem>
              <SelectItem value="dmarc">DMARC</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {effectiveMode === "spf" && (
        <SpfBuilder
          record={record}
          onRecordChange={onRecordChange}
          zoneName={zoneName}
          simulateSPF={simulateSPF}
          getSPFGraph={getSPFGraph}
          onWarningsChange={onWarningsChange}
        />
      )}
      {effectiveMode === "dkim" && (
        <DkimBuilder
          record={record}
          onRecordChange={onRecordChange}
          onWarningsChange={onWarningsChange}
        />
      )}
      {effectiveMode === "dmarc" && (
        <DmarcBuilder
          record={record}
          onRecordChange={onRecordChange}
          zoneName={zoneName}
          onWarningsChange={onWarningsChange}
        />
      )}
    </div>
  );
}
