import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

import { DkimBuilder } from "./DkimBuilder";
import { DmarcBuilder } from "./DmarcBuilder";
import { SpfBuilder } from "./SpfBuilder";
import type { BuilderWarningsChange, RecordDraft } from "./types";

export type TxtHelperMode = "auto" | "generic" | "spf" | "dkim" | "dmarc";

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

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "TXT" || effectiveMode === "generic") {
      onWarningsChange({ issues: [], nameIssues: [] });
    }
  }, [effectiveMode, onWarningsChange, record.type]);

  if (record.type !== "TXT") return null;

  return (
    <div className="space-y-2">
      <Textarea
        aria-label="TXT content"
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
          <Label className="text-xs">TXT helper</Label>
          <Select
            value={txtHelperMode}
            onValueChange={(value: string) =>
              setTxtHelperMode(value as TxtHelperMode)
            }
          >
            <SelectTrigger className="h-9">
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
