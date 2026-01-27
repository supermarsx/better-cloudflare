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

type HemisphereNS = "N" | "S";
type HemisphereEW = "E" | "W";

function parseMetersToken(token?: string) {
  const raw = (token ?? "").trim();
  if (!raw) return undefined;
  const stripped = raw.replace(/m$/i, "");
  const n = Number.parseFloat(stripped);
  return Number.isFinite(n) ? n : undefined;
}

function formatSeconds(value: number) {
  return value.toFixed(3).replace(/\.?0+$/, (m) => (m === "." ? "" : m));
}

function clampToNumber(value: string) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseLocContent(content?: string) {
  const raw = (content ?? "").trim();
  if (!raw) {
    return {
      latDeg: undefined as number | undefined,
      latMin: undefined as number | undefined,
      latSec: undefined as number | undefined,
      latHem: "N" as HemisphereNS,
      lonDeg: undefined as number | undefined,
      lonMin: undefined as number | undefined,
      lonSec: undefined as number | undefined,
      lonHem: "E" as HemisphereEW,
      altitudeM: undefined as number | undefined,
      sizeM: undefined as number | undefined,
      horizPrecM: undefined as number | undefined,
      vertPrecM: undefined as number | undefined,
      extra: "",
    };
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  const latDeg = clampToNumber(parts[0] ?? "");
  const latMin = clampToNumber(parts[1] ?? "");
  const latSec = clampToNumber(parts[2] ?? "");
  const latHemRaw = (parts[3] ?? "").toUpperCase();
  const latHem: HemisphereNS =
    latHemRaw === "S" ? "S" : ("N" as HemisphereNS);

  const lonDeg = clampToNumber(parts[4] ?? "");
  const lonMin = clampToNumber(parts[5] ?? "");
  const lonSec = clampToNumber(parts[6] ?? "");
  const lonHemRaw = (parts[7] ?? "").toUpperCase();
  const lonHem: HemisphereEW =
    lonHemRaw === "W" ? "W" : ("E" as HemisphereEW);

  const altitudeM = parseMetersToken(parts[8]);
  const sizeM = parseMetersToken(parts[9]);
  const horizPrecM = parseMetersToken(parts[10]);
  const vertPrecM = parseMetersToken(parts[11]);
  const extra = parts.slice(12).join(" ");

  return {
    latDeg,
    latMin,
    latSec,
    latHem,
    lonDeg,
    lonMin,
    lonSec,
    lonHem,
    altitudeM,
    sizeM,
    horizPrecM,
    vertPrecM,
    extra,
  };
}

function composeLoc(
  latDeg?: number,
  latMin?: number,
  latSec?: number,
  latHem?: HemisphereNS,
  lonDeg?: number,
  lonMin?: number,
  lonSec?: number,
  lonHem?: HemisphereEW,
  altitudeM?: number,
  sizeM?: number,
  horizPrecM?: number,
  vertPrecM?: number,
) {
  const secLat = latSec ?? 0;
  const secLon = lonSec ?? 0;
  const alt = altitudeM ?? 0;
  const base = [
    Math.trunc(latDeg ?? 0),
    Math.trunc(latMin ?? 0),
    formatSeconds(secLat),
    latHem ?? "N",
    Math.trunc(lonDeg ?? 0),
    Math.trunc(lonMin ?? 0),
    formatSeconds(secLon),
    lonHem ?? "E",
    `${alt}m`,
  ].join(" ");

  const extras: string[] = [];
  if (sizeM !== undefined) extras.push(`${sizeM}m`);
  if (horizPrecM !== undefined) extras.push(`${horizPrecM}m`);
  if (vertPrecM !== undefined) extras.push(`${vertPrecM}m`);
  return extras.length ? `${base} ${extras.join(" ")}` : base;
}

export function LocBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [latDeg, setLatDeg] = useState<number | undefined>(undefined);
  const [latMin, setLatMin] = useState<number | undefined>(undefined);
  const [latSec, setLatSec] = useState<number | undefined>(undefined);
  const [latHem, setLatHem] = useState<HemisphereNS>("N");

  const [lonDeg, setLonDeg] = useState<number | undefined>(undefined);
  const [lonMin, setLonMin] = useState<number | undefined>(undefined);
  const [lonSec, setLonSec] = useState<number | undefined>(undefined);
  const [lonHem, setLonHem] = useState<HemisphereEW>("E");

  const [altitudeM, setAltitudeM] = useState<number | undefined>(undefined);
  const [sizeM, setSizeM] = useState<number | undefined>(undefined);
  const [horizPrecM, setHorizPrecM] = useState<number | undefined>(undefined);
  const [vertPrecM, setVertPrecM] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (record.type !== "LOC") return;
    const parsed = parseLocContent(record.content);
    setLatDeg(parsed.latDeg);
    setLatMin(parsed.latMin);
    setLatSec(parsed.latSec);
    setLatHem(parsed.latHem);
    setLonDeg(parsed.lonDeg);
    setLonMin(parsed.lonMin);
    setLonSec(parsed.lonSec);
    setLonHem(parsed.lonHem);
    setAltitudeM(parsed.altitudeM);
    setSizeM(parsed.sizeM);
    setHorizPrecM(parsed.horizPrecM);
    setVertPrecM(parsed.vertPrecM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "LOC") {
      return { canonical: "", issues: [] as string[], nameIssues: [] as string[] };
    }

    const issues: string[] = [];
    const nameIssues: string[] = [];
    const push = (list: string[], msg: string) => {
      if (!list.includes(msg)) list.push(msg);
    };

    const hasAllLat =
      latDeg !== undefined &&
      latMin !== undefined &&
      latSec !== undefined &&
      !!latHem;
    const hasAllLon =
      lonDeg !== undefined &&
      lonMin !== undefined &&
      lonSec !== undefined &&
      !!lonHem;

    if (!hasAllLat) push(issues, "LOC: latitude is incomplete.");
    if (!hasAllLon) push(issues, "LOC: longitude is incomplete.");
    if (altitudeM === undefined) push(issues, "LOC: altitude is required.");

    if (latDeg !== undefined && (latDeg < 0 || latDeg > 90))
      push(issues, "LOC: latitude degrees should be 0–90.");
    if (lonDeg !== undefined && (lonDeg < 0 || lonDeg > 180))
      push(issues, "LOC: longitude degrees should be 0–180.");
    if (latMin !== undefined && (latMin < 0 || latMin >= 60))
      push(issues, "LOC: latitude minutes should be 0–59.");
    if (lonMin !== undefined && (lonMin < 0 || lonMin >= 60))
      push(issues, "LOC: longitude minutes should be 0–59.");
    if (latSec !== undefined && (latSec < 0 || latSec >= 60))
      push(issues, "LOC: latitude seconds should be 0–<60.");
    if (lonSec !== undefined && (lonSec < 0 || lonSec >= 60))
      push(issues, "LOC: longitude seconds should be 0–<60.");

    if (altitudeM !== undefined) {
      if (altitudeM < -10000) push(issues, "LOC: altitude is very low (below -10km).");
      if (altitudeM > 100000) push(issues, "LOC: altitude is very high (above 100km).");
    }

    const positiveOptional = (v: number | undefined, label: string) => {
      if (v === undefined) return;
      if (v <= 0) push(issues, `LOC: ${label} should be > 0m.`);
      if (v > 1000000) push(issues, `LOC: ${label} is unusually large.`);
    };
    positiveOptional(sizeM, "size");
    positiveOptional(horizPrecM, "horizontal precision");
    positiveOptional(vertPrecM, "vertical precision");

    const parsed = parseLocContent(record.content);
    if (parsed.extra)
      push(issues, "LOC: extra trailing tokens found in content.");

    const canonical = composeLoc(
      latDeg,
      latMin,
      latSec,
      latHem,
      lonDeg,
      lonMin,
      lonSec,
      lonHem,
      altitudeM,
      sizeM,
      horizPrecM,
      vertPrecM,
    );
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(issues, "LOC: content differs from builder settings (Apply canonical to normalize).");
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(nameIssues, "LOC: name is typically a host label (e.g., office or @).");

    return { canonical, issues, nameIssues };
  }, [
    altitudeM,
    horizPrecM,
    latDeg,
    latHem,
    latMin,
    latSec,
    lonDeg,
    lonHem,
    lonMin,
    lonSec,
    record.content,
    record.name,
    record.type,
    sizeM,
    vertPrecM,
  ]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "LOC") {
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

  if (record.type !== "LOC") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            LOC builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>lat N/S lon E/W altitude [size hp vp]</code>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-12">
          <div className="space-y-1 sm:col-span-6">
            <div className="text-xs font-semibold text-muted-foreground">
              Latitude
            </div>
            <div className="grid grid-cols-4 gap-2">
              <Input
                type="number"
                placeholder="deg"
                value={latDeg ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = clampToNumber(e.target.value);
                  setLatDeg(val);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      val,
                      latMin,
                      latSec,
                      latHem,
                      lonDeg,
                      lonMin,
                      lonSec,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              />
              <Input
                type="number"
                placeholder="min"
                value={latMin ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = clampToNumber(e.target.value);
                  setLatMin(val);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      val,
                      latSec,
                      latHem,
                      lonDeg,
                      lonMin,
                      lonSec,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              />
              <Input
                type="number"
                placeholder="sec"
                value={latSec ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = clampToNumber(e.target.value);
                  setLatSec(val);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      latMin,
                      val,
                      latHem,
                      lonDeg,
                      lonMin,
                      lonSec,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              />
              <Select
                value={latHem}
                onValueChange={(value: string) => {
                  const hem = value === "S" ? "S" : "N";
                  setLatHem(hem);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      latMin,
                      latSec,
                      hem,
                      lonDeg,
                      lonMin,
                      lonSec,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="N">N</SelectItem>
                  <SelectItem value="S">S</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Degrees/minutes/seconds. Seconds can be fractional.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-6">
            <div className="text-xs font-semibold text-muted-foreground">
              Longitude
            </div>
            <div className="grid grid-cols-4 gap-2">
              <Input
                type="number"
                placeholder="deg"
                value={lonDeg ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = clampToNumber(e.target.value);
                  setLonDeg(val);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      latMin,
                      latSec,
                      latHem,
                      val,
                      lonMin,
                      lonSec,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              />
              <Input
                type="number"
                placeholder="min"
                value={lonMin ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = clampToNumber(e.target.value);
                  setLonMin(val);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      latMin,
                      latSec,
                      latHem,
                      lonDeg,
                      val,
                      lonSec,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              />
              <Input
                type="number"
                placeholder="sec"
                value={lonSec ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = clampToNumber(e.target.value);
                  setLonSec(val);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      latMin,
                      latSec,
                      latHem,
                      lonDeg,
                      lonMin,
                      val,
                      lonHem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              />
              <Select
                value={lonHem}
                onValueChange={(value: string) => {
                  const hem = value === "W" ? "W" : "E";
                  setLonHem(hem);
                  onRecordChange({
                    ...record,
                    content: composeLoc(
                      latDeg,
                      latMin,
                      latSec,
                      latHem,
                      lonDeg,
                      lonMin,
                      lonSec,
                      hem,
                      altitudeM,
                      sizeM,
                      horizPrecM,
                      vertPrecM,
                    ),
                  });
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="E">E</SelectItem>
                  <SelectItem value="W">W</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Degrees/minutes/seconds. Seconds can be fractional.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-4">
            <Label className="text-xs">Altitude (m)</Label>
            <Input
              type="number"
              placeholder="10"
              value={altitudeM ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const val = clampToNumber(e.target.value);
                setAltitudeM(val);
                onRecordChange({
                  ...record,
                  content: composeLoc(
                    latDeg,
                    latMin,
                    latSec,
                    latHem,
                    lonDeg,
                    lonMin,
                    lonSec,
                    lonHem,
                    val,
                    sizeM,
                    horizPrecM,
                    vertPrecM,
                  ),
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              Meters above mean sea level.
            </div>
          </div>

          <div className="space-y-1 sm:col-span-8">
            <div className="text-xs font-semibold text-muted-foreground">
              Optional (meters)
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Size</Label>
                <Input
                  type="number"
                  placeholder="1"
                  value={sizeM ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const val = clampToNumber(e.target.value);
                    setSizeM(val);
                    onRecordChange({
                      ...record,
                      content: composeLoc(
                        latDeg,
                        latMin,
                        latSec,
                        latHem,
                        lonDeg,
                        lonMin,
                        lonSec,
                        lonHem,
                        altitudeM,
                        val,
                        horizPrecM,
                        vertPrecM,
                      ),
                    });
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Horiz precision</Label>
                <Input
                  type="number"
                  placeholder="100"
                  value={horizPrecM ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const val = clampToNumber(e.target.value);
                    setHorizPrecM(val);
                    onRecordChange({
                      ...record,
                      content: composeLoc(
                        latDeg,
                        latMin,
                        latSec,
                        latHem,
                        lonDeg,
                        lonMin,
                        lonSec,
                        lonHem,
                        altitudeM,
                        sizeM,
                        val,
                        vertPrecM,
                      ),
                    });
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Vert precision</Label>
                <Input
                  type="number"
                  placeholder="10"
                  value={vertPrecM ?? ""}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const val = clampToNumber(e.target.value);
                    setVertPrecM(val);
                    onRecordChange({
                      ...record,
                      content: composeLoc(
                        latDeg,
                        latMin,
                        latSec,
                        latHem,
                        lonDeg,
                        lonMin,
                        lonSec,
                        lonHem,
                        altitudeM,
                        sizeM,
                        horizPrecM,
                        val,
                      ),
                    });
                  }}
                />
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Common defaults: size=1m, horiz=100m, vert=10m.
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseLocContent(record.content);
              setLatDeg(parsed.latDeg);
              setLatMin(parsed.latMin);
              setLatSec(parsed.latSec);
              setLatHem(parsed.latHem);
              setLonDeg(parsed.lonDeg);
              setLonMin(parsed.lonMin);
              setLonSec(parsed.lonSec);
              setLonHem(parsed.lonHem);
              setAltitudeM(parsed.altitudeM);
              setSizeM(parsed.sizeM);
              setHorizPrecM(parsed.horizPrecM);
              setVertPrecM(parsed.vertPrecM);
            }}
          >
            Load from content
          </Button>
          <Button
            size="sm"
            onClick={() => onRecordChange({ ...record, content: diagnostics.canonical })}
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
            <li>Use DMS coordinates; seconds can be fractional.</li>
            <li>
              Include size/precision values if accuracy matters; otherwise leave them blank.
            </li>
            <li>LOC records can reveal sensitive location information.</li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 || diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">LOC warnings</div>
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

