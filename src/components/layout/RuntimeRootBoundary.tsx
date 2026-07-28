"use client";

import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { RuntimeCrashRecovery } from "./RuntimeCrashRecovery";
import { RuntimeErrorListener } from "./RuntimeErrorListener";

interface RuntimeRootBoundaryProps {
  children: ReactNode;
}

export function RuntimeRootBoundary({ children }: RuntimeRootBoundaryProps) {
  return (
    <>
      <RuntimeErrorListener />
      <ErrorBoundary
        label="application-root"
        fallback={({ diagnostic, reset }) => (
          <RuntimeCrashRecovery
            diagnostic={diagnostic}
            source="react-boundary"
            label="application-root"
            onReset={reset}
            resetLabel="Return to login"
          />
        )}
      >
        {children}
      </ErrorBoundary>
    </>
  );
}
