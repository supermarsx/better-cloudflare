import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { BuilderWarningsChange, RecordDraft } from "./types";

function escapeDnsQuotedString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function parseURIContent(value: string | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) return { priority: undefined, weight: undefined, target: "" };
  let remaining = raw;
  let priority: number | undefined;
  let weight: number | undefined;

  const readToken = () => {
    remaining = remaining.replace(/^\s+/, "");
    const m = remaining.match(/^(\S+)(\s+|$)/);
    if (!m) return null;
    remaining = remaining.slice(m[1].length).replace(/^\s+/, "");
    return m[1];
  };

  // If the string starts with a quote, treat it as target-only.
  if (!remaining.startsWith("\"")) {
    const t1 = readToken();
    const n1 = t1 ? Number.parseInt(t1, 10) : Number.NaN;
    if (t1 && !Number.isNaN(n1) && /^\d+$/.test(t1)) priority = n1;
    else if (t1) remaining = `${t1} ${remaining}`.trim();

    if (!remaining.startsWith("\"")) {
      const t2 = readToken();
      const n2 = t2 ? Number.parseInt(t2, 10) : Number.NaN;
      if (t2 && !Number.isNaN(n2) && /^\d+$/.test(t2)) weight = n2;
      else if (t2) remaining = `${t2} ${remaining}`.trim();
    }
  }

  let target = remaining.trim();
  if (target.startsWith("\"") && target.endsWith("\"") && target.length >= 2) {
    target = target.slice(1, -1);
  }
  target = target.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  return {
    priority,
    weight,
    target,
  };
}

function composeURI(fields: {
  priority: number | undefined;
  weight: number | undefined;
  target: string;
}) {
  const pr =
    fields.priority === undefined || Number.isNaN(Number(fields.priority))
      ? undefined
      : fields.priority;
  const wt =
    fields.weight === undefined || Number.isNaN(Number(fields.weight))
      ? undefined
      : fields.weight;
  const tg = (fields.target ?? "").trim();
  const parts: string[] = [];
  if (pr !== undefined) parts.push(String(pr));
  if (wt !== undefined) parts.push(String(wt));
  if (tg.length > 0) parts.push(`"${escapeDnsQuotedString(tg)}"`);
  return parts.join(" ").trim();
}

export function UriBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [priority, setPriority] = useState<number | undefined>(undefined);
  const [weight, setWeight] = useState<number | undefined>(undefined);
  const [target, setTarget] = useState<string>("");
  const [spaceConvertedWarning, setSpaceConvertedWarning] = useState(false);

  useEffect(() => {
    if (record.type !== "URI") return;
    const parsed = parseURIContent(record.content);
    setPriority(parsed.priority);
    setWeight(parsed.weight);
    setTarget(parsed.target);
    setSpaceConvertedWarning(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  useEffect(() => {
    if (!spaceConvertedWarning) return;
    if (!target.includes("%20")) setSpaceConvertedWarning(false);
  }, [spaceConvertedWarning, target]);

  const validation = useMemo(() => {
    const issues: string[] = [];
    const fieldIssues: Record<"priority" | "weight" | "target", string[]> = {
      priority: [],
      weight: [],
      target: [],
    };
    const pushUnique = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const validateU16 = (value: number | undefined, label: "priority" | "weight") => {
      if (value === undefined) {
        pushUnique(fieldIssues[label], `${label} is required.`);
        return;
      }
      if (!Number.isFinite(value)) {
        pushUnique(fieldIssues[label], `${label} must be a number.`);
        return;
      }
      if (value < 0 || value > 65535)
        pushUnique(fieldIssues[label], `${label} must be between 0 and 65535.`);
    };
    validateU16(priority, "priority");
    validateU16(weight, "weight");

    const t = (target ?? "").trim();
    if (!t) {
      pushUnique(fieldIssues.target, "target is required.");
    } else {
      if (spaceConvertedWarning)
        pushUnique(fieldIssues.target, "Spaces were converted to %20.");
      if (/\s/.test(t))
        pushUnique(fieldIssues.target, "URI should not contain spaces (use %20).");
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t))
        pushUnique(
          fieldIssues.target,
          "URI should include a scheme (e.g., https:, sip:, mailto:).",
        );
      try {
        // eslint-disable-next-line no-new
        new URL(t);
      } catch {
        pushUnique(fieldIssues.target, "target does not parse as a valid URI.");
      }
      if (t.length > 2048)
        pushUnique(
          fieldIssues.target,
          "target is very long; some resolvers may reject it.",
        );
    }

    for (const msgs of Object.values(fieldIssues)) {
      for (const msg of msgs) pushUnique(issues, `URI: ${msg}`);
    }

    const canonical = composeURI({ priority, weight, target });
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      pushUnique(
        issues,
        "URI: content differs from builder settings (Apply canonical to normalize).",
      );
    }
    return { issues, fieldIssues, canonical };
  }, [priority, record.content, spaceConvertedWarning, target, weight]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "URI") {
      onWarningsChange({ issues: [], nameIssues: [], canonical: "" });
      return;
    }
    onWarningsChange({
      issues: validation.issues,
      nameIssues: [],
      canonical: validation.canonical,
    });
  }, [onWarningsChange, record.type, validation.canonical, validation.issues]);

  if (record.type !== "URI") return null;

  const apply = (next: { priority?: number; weight?: number; target?: string }) => {
    const has = (k: "priority" | "weight" | "target") =>
      Object.prototype.hasOwnProperty.call(next, k);
    const pr = has("priority") ? next.priority : priority;
    const wt = has("weight") ? next.weight : weight;
    const tg = has("target") ? next.target ?? "" : target;
    onRecordChange({
      ...record,
      content: composeURI({ priority: pr, weight: wt, target: tg }),
    });
  };

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            URI builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>priority weight "target"</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Priority</Label>
            <Input
              type="number"
              value={priority ?? ""}
              placeholder="10"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value;
                const val = raw === "" ? undefined : Number.parseInt(raw, 10);
                const next = Number.isNaN(Number(val)) ? undefined : val;
                setPriority(next);
                apply({ priority: next });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Lower wins; same priority enables weighting.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-1">
            <Label className="text-xs">Weight</Label>
            <Input
              type="number"
              value={weight ?? ""}
              placeholder="1"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value;
                const val = raw === "" ? undefined : Number.parseInt(raw, 10);
                const next = Number.isNaN(Number(val)) ? undefined : val;
                setWeight(next);
                apply({ weight: next });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Used only among records with same priority.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-4">
            <Label className="text-xs">Target URI</Label>
            <Input
              value={target}
              placeholder="e.g., https://example.com/path"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value;
                const converted = raw.includes(" ")
                  ? raw.replace(/ /g, "%20")
                  : raw;
                if (converted !== raw) setSpaceConvertedWarning(true);
                setTarget(converted);
                apply({ target: converted });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Stored as a quoted string. Include a scheme; avoid spaces (use %20).
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseURIContent(record.content);
              setPriority(parsed.priority);
              setWeight(parsed.weight);
              setTarget(parsed.target);
              setSpaceConvertedWarning(false);
            }}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            onClick={() => onRecordChange({ ...record, content: validation.canonical })}
          >
            Apply canonical to content
          </Button>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/20 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Preview (canonical)
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
            {validation.canonical}
          </pre>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPriority(10);
                setWeight(1);
                setTarget("https://example.com/");
                setSpaceConvertedWarning(false);
                apply({ priority: 10, weight: 1, target: "https://example.com/" });
              }}
            >
              Example https
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPriority(10);
                setWeight(1);
                setTarget("mailto:admin@example.com");
                setSpaceConvertedWarning(false);
                apply({
                  priority: 10,
                  weight: 1,
                  target: "mailto:admin@example.com",
                });
              }}
            >
              Example mailto
            </Button>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border/60 bg-background/15 p-3">
          <div className="text-xs font-semibold text-muted-foreground">
            Recommendations
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-muted-foreground">
            <li>Keep target under ~2KB for broad resolver compatibility.</li>
            <li>Prefer percent-encoding over spaces (builder converts spaces to %20).</li>
            <li>Use multiple records with same priority and different weights for balancing.</li>
          </ul>
        </div>

        {validation.issues.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">URI warnings</div>
            <div className="scrollbar-themed mt-2 max-h-40 overflow-auto pr-2">
              <ul className="list-disc pl-5 text-xs text-foreground/85">
                {validation.issues.map((w) => (
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
