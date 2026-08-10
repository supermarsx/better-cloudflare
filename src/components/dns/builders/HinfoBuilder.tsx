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
import {
  CHARACTER_STRING_MAX_BYTES,
  characterStringByteLength,
  hasUnbalancedQuotes,
  parseCharacterStringTokens,
  quoteCharacterString,
} from "@/lib/dns/character-string";

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

const HINFO_CPU_PRESETS: Array<{ value: string; label: string; desc: string }> =
  [
    { value: "x86_64", label: "x86_64", desc: "64-bit x86 (AMD64/Intel 64)." },
    { value: "arm64", label: "arm64", desc: "64-bit ARM (AArch64)." },
    { value: "i686", label: "i686", desc: "32-bit x86 (common legacy Linux)." },
    {
      value: "ppc64le",
      label: "ppc64le",
      desc: "PowerPC 64-bit little-endian.",
    },
    { value: "riscv64", label: "riscv64", desc: "64-bit RISC-V." },
  ];

const HINFO_OS_PRESETS: Array<{ value: string; label: string; desc: string }> =
  [
    { value: "Linux", label: "Linux", desc: "GNU/Linux." },
    { value: "Windows", label: "Windows", desc: "Microsoft Windows." },
    { value: "macOS", label: "macOS", desc: "Apple macOS." },
    { value: "FreeBSD", label: "FreeBSD", desc: "FreeBSD." },
    { value: "OpenBSD", label: "OpenBSD", desc: "OpenBSD." },
    { value: "NetBSD", label: "NetBSD", desc: "NetBSD." },
    {
      value: "Solaris",
      label: "Solaris",
      desc: "Oracle Solaris / illumos family.",
    },
  ];

/**
 * Split HINFO content into its two `<character-string>` fields. Quoted, bare
 * and half-quoted tokens are all accepted; unmatched quotes are reported so the
 * builder can warn while still recovering the fields.
 */
function parseHinfoContent(value?: string) {
  const raw = (value ?? "").trim();
  if (!raw) return { cpu: "", os: "", extra: "", hasUnbalancedQuotes: false };

  const tokens = parseCharacterStringTokens(raw);
  return {
    cpu: tokens[0] ?? "",
    os: tokens[1] ?? "",
    extra: tokens.slice(2).join(" "),
    hasUnbalancedQuotes: hasUnbalancedQuotes(raw),
  };
}

export type HinfoFields = {
  cpu: string;
  os: string;
};

/**
 * Plain-English description of what an HINFO record publishes.
 *
 * Both fields are free-form `<character-string>`s (RFC 1035 §3.3.2) with no
 * registry behind them, so the summary is careful not to imply that anything
 * interprets the values.
 */
export function describeHINFO(fields: HinfoFields): BuilderSummary {
  const details: string[] = [];
  const unknowns: string[] = [];

  const cpu = fields.cpu.trim();
  const os = fields.os.trim();

  let headline: string;
  if (cpu && os) {
    headline = `Tells anyone who queries this name that the host runs ${os} on ${cpu} hardware.`;
  } else if (cpu) {
    headline = `Tells anyone who queries this name that the host runs on ${cpu} hardware, once an operating system is filled in too.`;
  } else if (os) {
    headline = `Tells anyone who queries this name that the host runs ${os}, once a CPU is filled in too.`;
  } else {
    headline =
      "Publishes this host's hardware type and operating system as plain text that anyone querying the name can read.";
  }

  details.push(
    "Both values are free-form DNS character-strings of up to 255 bytes each; nothing validates them and no software changes its behaviour based on what they say.",
  );
  details.push(
    "HINFO dates from the original DNS specification and is almost never published today, so treat it as documentation rather than something clients consume.",
  );
  details.push(
    "Naming the hardware and operating system narrows down which exploits are worth trying against the host, which is the usual reason not to publish it.",
  );

  unknowns.push(
    "Some resolvers answer ANY queries with a synthetic HINFO record (RFC 8482); that is unrelated to this record and cannot be controlled from here.",
  );

  return { headline, details, unknowns };
}

export function HinfoBuilder({
  record,
  onRecordChange,
  onWarningsChange,
}: {
  record: RecordDraft;
  onRecordChange: (draft: RecordDraft) => void;
  onWarningsChange?: BuilderWarningsChange;
}) {
  const [cpu, setCpu] = useState("");
  const [os, setOs] = useState("");
  const { fieldIds, helpIds } = useBuilderFieldIds([
    "cpuPreset",
    "cpu",
    "osPreset",
    "os",
  ] as const);

  const summary = useMemo(() => describeHINFO({ cpu, os }), [cpu, os]);

  const cpuSelectValue = useMemo(() => {
    const v = cpu.trim();
    if (!v) return "custom";
    return HINFO_CPU_PRESETS.some(
      (p) => p.value.toLowerCase() === v.toLowerCase(),
    )
      ? (HINFO_CPU_PRESETS.find(
          (p) => p.value.toLowerCase() === v.toLowerCase(),
        )?.value ?? "custom")
      : "custom";
  }, [cpu]);

  const osSelectValue = useMemo(() => {
    const v = os.trim();
    if (!v) return "custom";
    return HINFO_OS_PRESETS.some(
      (p) => p.value.toLowerCase() === v.toLowerCase(),
    )
      ? (HINFO_OS_PRESETS.find((p) => p.value.toLowerCase() === v.toLowerCase())
          ?.value ?? "custom")
      : "custom";
  }, [os]);

  const cpuDescriptor = useMemo(() => {
    const v = cpu.trim();
    if (!v) return null;
    return (
      HINFO_CPU_PRESETS.find((p) => p.value.toLowerCase() === v.toLowerCase())
        ?.desc ?? null
    );
  }, [cpu]);

  const osDescriptor = useMemo(() => {
    const v = os.trim();
    if (!v) return null;
    return (
      HINFO_OS_PRESETS.find((p) => p.value.toLowerCase() === v.toLowerCase())
        ?.desc ?? null
    );
  }, [os]);

  useEffect(() => {
    if (record.type !== "HINFO") return;
    const parsed = parseHinfoContent(record.content);
    setCpu(parsed.cpu);
    setOs(parsed.os);
  }, [record.type, record.content]);

  const diagnostics = useMemo(() => {
    if (record.type !== "HINFO") {
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

    const parsed = parseHinfoContent(record.content);

    const cpuTrim = cpu.trim();
    const osTrim = os.trim();

    if (parsed.hasUnbalancedQuotes)
      push(issues, "HINFO: content has unbalanced quotes.");

    if (!cpuTrim) push(issues, "HINFO: CPU is required (character-string).");
    if (!osTrim) push(issues, "HINFO: OS is required (character-string).");

    // Equivalent to /[\u0000-\u001F\u007F]/ but written without a regex literal so this
    // deliberate control-character check does not trip `no-control-regex`.
    const isPrintable = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return false;
      }
      return true;
    };
    if (cpuTrim && !isPrintable(cpuTrim))
      push(issues, "HINFO: CPU contains control characters (unusual).");
    if (osTrim && !isPrintable(osTrim))
      push(issues, "HINFO: OS contains control characters (unusual).");

    // DNS <character-string> is up to 255 octets; warn if clearly beyond.
    if (characterStringByteLength(cpuTrim) > CHARACTER_STRING_MAX_BYTES)
      push(
        issues,
        "HINFO: CPU is longer than 255 bytes (exceeds the DNS character-string limit).",
      );
    if (characterStringByteLength(osTrim) > CHARACTER_STRING_MAX_BYTES)
      push(
        issues,
        "HINFO: OS is longer than 255 bytes (exceeds the DNS character-string limit).",
      );

    if (parsed.extra)
      push(issues, "HINFO: extra trailing tokens found in content.");

    const canonical = `${quoteCharacterString(cpuTrim)} ${quoteCharacterString(osTrim)}`;
    const content = (record.content ?? "").trim();
    if (content && canonical && content !== canonical) {
      push(
        issues,
        "HINFO: content differs from builder settings (Apply canonical to normalize).",
      );
    }

    const name = (record.name ?? "").trim();
    if (!name)
      push(
        nameIssues,
        "HINFO: name is typically a host label (e.g., host or @).",
      );

    return { canonical, issues, nameIssues };
  }, [cpu, os, record.content, record.name, record.type]);

  useEffect(() => {
    if (!onWarningsChange) return;
    if (record.type !== "HINFO") {
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

  if (record.type !== "HINFO") return null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground">
            HINFO builder
          </div>
          <div className="text-[11px] text-muted-foreground">
            Format: <code>"CPU" "OS"</code>
          </div>
        </div>

        <RecordSummary summary={summary} className="mt-2" />

        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-6">
          <div className="space-y-1 sm:col-span-3">
            <BuilderFieldLabel
              controlId={fieldIds.cpuPreset}
              descriptionId={helpIds.cpuPreset}
              label="CPU preset"
              help="Fills the CPU field with a common architecture name. There is no registry of accepted values, so a preset is only a convenient spelling."
            />
            <Select
              value={cpuSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") return;
                setCpu(value);
                onRecordChange({
                  ...record,
                  content: `${quoteCharacterString(value.trim())} ${quoteCharacterString(os.trim())}`,
                });
              }}
            >
              <SelectTrigger
                id={fieldIds.cpuPreset}
                aria-describedby={helpIds.cpuPreset}
                className="h-9"
              >
                <SelectValue placeholder="Custom…" />
              </SelectTrigger>
              <SelectContent>
                {HINFO_CPU_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            <BuilderFieldLabel
              controlId={fieldIds.cpu}
              descriptionId={helpIds.cpu}
              label="CPU"
              help="Free text describing the host's hardware, up to 255 bytes. Anything is accepted; short architecture names such as x86_64 or arm64 are the convention."
            />
            <Input
              id={fieldIds.cpu}
              aria-describedby={helpIds.cpu}
              placeholder='e.g., "Intel" or "ARM64"'
              value={cpu}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setCpu(e.target.value);
                onRecordChange({
                  ...record,
                  content: `${quoteCharacterString(e.target.value.trim())} ${quoteCharacterString(os.trim())}`,
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              {cpuDescriptor ??
                "A short description of the host CPU (character-string)."}
            </div>
          </div>

          <div className="space-y-1 sm:col-span-3">
            <BuilderFieldLabel
              controlId={fieldIds.osPreset}
              descriptionId={helpIds.osPreset}
              label="OS preset"
              help="Fills the OS field with a common operating system name. There is no registry of accepted values, so a preset is only a convenient spelling."
            />
            <Select
              value={osSelectValue}
              onValueChange={(value: string) => {
                if (value === "custom") return;
                setOs(value);
                onRecordChange({
                  ...record,
                  content: `${quoteCharacterString(cpu.trim())} ${quoteCharacterString(value.trim())}`,
                });
              }}
            >
              <SelectTrigger
                id={fieldIds.osPreset}
                aria-describedby={helpIds.osPreset}
                className="h-9"
              >
                <SelectValue placeholder="Custom…" />
              </SelectTrigger>
              <SelectContent>
                {HINFO_OS_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            <BuilderFieldLabel
              controlId={fieldIds.os}
              descriptionId={helpIds.os}
              label="OS"
              help="Free text describing the host's operating system, up to 255 bytes. Keep it generic — a version number tells an attacker which patches are missing."
            />
            <Input
              id={fieldIds.os}
              aria-describedby={helpIds.os}
              placeholder='e.g., "Linux" or "Windows"'
              value={os}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setOs(e.target.value);
                onRecordChange({
                  ...record,
                  content: `${quoteCharacterString(cpu.trim())} ${quoteCharacterString(e.target.value.trim())}`,
                });
              }}
            />
            <div className="text-[11px] text-muted-foreground">
              {osDescriptor ??
                "A short description of the operating system (character-string)."}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const parsed = parseHinfoContent(record.content);
              setCpu(parsed.cpu);
              setOs(parsed.os);
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
            <li>Keep values short; HINFO is rarely used today.</li>
            <li>Use quotes if values contain spaces.</li>
            <li>
              Consider privacy implications of publishing detailed host info.
            </li>
          </ul>
        </div>

        {(diagnostics.nameIssues.length > 0 ||
          diagnostics.issues.length > 0) && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="text-sm font-semibold">HINFO warnings</div>
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
