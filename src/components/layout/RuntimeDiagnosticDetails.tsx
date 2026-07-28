"use client";

import { useState } from "react";
import {
  copyRuntimeDiagnostic,
  formatRuntimeDiagnostic,
  type RuntimeDiagnostic,
} from "@/lib/errors/runtime-reporting";

interface RuntimeDiagnosticDetailsProps {
  diagnostic: RuntimeDiagnostic;
  defaultOpen?: boolean;
  compact?: boolean;
}

export function RuntimeDiagnosticDetails({
  diagnostic,
  defaultOpen = false,
  compact = false,
}: RuntimeDiagnosticDetailsProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );

  const copy = async () => {
    const copied = await copyRuntimeDiagnostic(diagnostic);
    setCopyState(copied ? "copied" : "unavailable");
  };

  return (
    <details
      className={
        compact
          ? "mt-2 rounded-md border border-border/60 bg-background/30 p-2 text-left text-xs"
          : "w-full rounded-lg border border-border/60 bg-background/40 p-3 text-left text-xs"
      }
      open={defaultOpen || undefined}
    >
      <summary className="cursor-pointer select-none font-medium">
        Technical details · {diagnostic.id}
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px] text-muted-foreground">
        {formatRuntimeDiagnostic(diagnostic)}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="ui-focus mt-2 rounded-md border border-border/60 bg-background/50 px-2 py-1 text-xs hover:bg-accent/50"
      >
        {copyState === "copied"
          ? "Copied"
          : copyState === "unavailable"
            ? "Copy unavailable"
            : "Copy diagnostics"}
      </button>
    </details>
  );
}
