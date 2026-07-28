"use client";

import { useMemo } from "react";
import { isDesktop } from "@/lib/environment";
import {
  createRuntimeDiagnostic,
  reportRuntimeError,
  type RuntimeDiagnostic,
  type RuntimeErrorSource,
} from "@/lib/errors/runtime-reporting";
import { RuntimeDiagnosticDetails } from "./RuntimeDiagnosticDetails";

interface RuntimeCrashRecoveryProps {
  error?: unknown;
  diagnostic?: RuntimeDiagnostic;
  source?: RuntimeErrorSource;
  label?: string;
  title?: string;
  description?: string;
  onReset?: () => void;
  resetLabel?: string;
  homeHref?: string;
}

function desktopRuntimeAvailable(): boolean {
  try {
    return isDesktop();
  } catch {
    return false;
  }
}

function RuntimeRecoveryTitlebar() {
  if (!desktopRuntimeAvailable()) return null;

  const runWindowAction = async (
    action: "minimize" | "toggleMaximize" | "close",
  ) => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      await appWindow[action]();
    } catch (error) {
      reportRuntimeError(error, {
        source: "runtime",
        label: `recovery-titlebar:${action}`,
      });
    }
  };

  return (
    <div
      className="flex h-9 w-full items-center justify-between border-b border-border/60 bg-background/90 pl-4 pr-2 text-foreground"
      data-tauri-drag-region
    >
      <span
        className="pointer-events-none text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        data-tauri-drag-region
      >
        Better Cloudflare · Recovery
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => void runWindowAction("minimize")}
          className="h-7 w-9 rounded border border-border/60 hover:bg-accent/50"
        >
          −
        </button>
        <button
          type="button"
          aria-label="Toggle maximize"
          onClick={() => void runWindowAction("toggleMaximize")}
          className="h-7 w-9 rounded border border-border/60 hover:bg-accent/50"
        >
          □
        </button>
        <button
          type="button"
          aria-label="Close window"
          onClick={() => void runWindowAction("close")}
          className="h-7 w-9 rounded bg-destructive text-destructive-foreground hover:brightness-110"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function RuntimeCrashRecovery({
  error,
  diagnostic,
  source = "runtime",
  label = "application",
  title = "Better Cloudflare recovered from a problem",
  description = "The failed view was stopped before it could take down the entire application.",
  onReset,
  resetLabel = "Return to login",
  homeHref,
}: RuntimeCrashRecoveryProps) {
  const fallbackDiagnostic = useMemo(
    () =>
      createRuntimeDiagnostic(
        error ?? new Error("Recovery surface requested without an error."),
        { source, label },
      ),
    [error, label, source],
  );
  const visibleDiagnostic = diagnostic ?? fallbackDiagnostic;

  const reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  return (
    <div
      className="flex min-h-screen w-full flex-col bg-background text-foreground"
      style={{
        minHeight: "100vh",
        width: "100%",
        background: "hsl(222 25% 8%)",
        color: "hsl(210 20% 96%)",
      }}
      data-testid="runtime-crash-recovery"
    >
      <RuntimeRecoveryTitlebar />
      <main
        className="flex flex-1 items-center justify-center p-4"
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: "1rem",
        }}
      >
        <section
          role="alert"
          className="w-full max-w-2xl rounded-xl border border-destructive/50 bg-card/90 p-6 shadow-2xl"
          style={{
            width: "100%",
            maxWidth: "42rem",
            border: "1px solid rgba(248, 113, 113, 0.55)",
            borderRadius: "0.75rem",
            background: "rgba(24, 28, 38, 0.96)",
            padding: "1.5rem",
          }}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-destructive">
            Runtime recovery
          </p>
          <h1 className="mt-2 text-xl font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm">
            {visibleDiagnostic.message}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {onReset ? (
              <button
                type="button"
                onClick={onReset}
                className="ui-focus rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
              >
                {resetLabel}
              </button>
            ) : null}
            {homeHref ? (
              <a
                href={homeHref}
                className="ui-focus rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110"
              >
                Return home
              </a>
            ) : null}
            <button
              type="button"
              onClick={reload}
              className="ui-focus rounded-md border border-border/60 bg-background/50 px-4 py-2 text-sm hover:bg-accent/50"
            >
              Reload application
            </button>
          </div>
          <div className="mt-4">
            <RuntimeDiagnosticDetails
              diagnostic={visibleDiagnostic}
              defaultOpen
            />
          </div>
        </section>
      </main>
    </div>
  );
}
