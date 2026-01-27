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
  const parts = raw.split(/\s+/);
  const pr = Number.parseInt(parts[0] ?? "", 10);
  const wt = Number.parseInt(parts[1] ?? "", 10);
  const rest = raw.replace(/^\s*\S+\s+\S+\s+/, "");
  const trimmed = rest.trim();
  let target = trimmed;
  if (target.startsWith("\"") && target.endsWith("\"") && target.length >= 2) {
    target = target.slice(1, -1);
  }
  target = target.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  return {
    priority: Number.isNaN(pr) ? undefined : pr,
    weight: Number.isNaN(wt) ? undefined : wt,
    target,
  };
}

function composeURI(fields: {
  priority: number | undefined;
  weight: number | undefined;
  target: string;
}) {
  const pr = fields.priority ?? "";
  const wt = fields.weight ?? "";
  const target = `"${escapeDnsQuotedString(fields.target ?? "")}"`;
  return `${pr} ${wt} ${target}`.replace(/\s+/g, " ").trim();
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
    return { issues, fieldIssues, canonical };
  }, [priority, spaceConvertedWarning, target, weight]);

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
    const pr = next.priority ?? priority;
    const wt = next.weight ?? weight;
    const tg = next.target ?? target;
    onRecordChange({
      ...record,
      content: composeURI({ priority: pr, weight: wt, target: tg }),
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">Priority</Label>
          <Input
            type="number"
            value={priority ?? ""}
            placeholder="10"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              const val = Number.isNaN(n) ? undefined : n;
              setPriority(val);
              apply({ priority: val });
            }}
          />
          <div className="text-xs text-muted-foreground">
            Lower wins. Use the same value across multiple targets to enable
            weighting.
          </div>
          {validation.fieldIssues.priority.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.priority.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Weight</Label>
          <Input
            type="number"
            value={weight ?? ""}
            placeholder="1"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const n = Number.parseInt(e.target.value, 10);
              const val = Number.isNaN(n) ? undefined : n;
              setWeight(val);
              apply({ weight: val });
            }}
          />
          <div className="text-xs text-muted-foreground">
            Used only among records with the same priority. 0 is allowed.
          </div>
          {validation.fieldIssues.weight.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.weight.join(" ")}
            </div>
          )}
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Target URI</Label>
          <Input
            value={target}
            placeholder="e.g., https://example.com/path"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const raw = e.target.value;
              const converted = raw.includes(" ") ? raw.replace(/ /g, "%20") : raw;
              if (converted !== raw) setSpaceConvertedWarning(true);
              setTarget(converted);
              apply({ target: converted });
            }}
          />
          <div className="text-xs text-muted-foreground">
            Must be an absolute URI (include a scheme). Avoid spaces (use %20).
            Stored as a quoted string.
          </div>
          {validation.fieldIssues.target.length > 0 && (
            <div className="text-xs text-red-600">
              {validation.fieldIssues.target.join(" ")}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="text-xs font-semibold text-muted-foreground">
          Preview (content)
        </div>
        <pre className="mt-1 whitespace-pre-wrap text-xs">{validation.canonical}</pre>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setPriority(10);
              setWeight(1);
              setTarget("https://example.com/");
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

      <div className="text-xs text-muted-foreground">
        Lower priority wins; weight is used for load balancing among same-priority
        records. Target should be an absolute URI.
      </div>
    </div>
  );
}

