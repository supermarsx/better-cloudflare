"use client";

import { useEffect, useMemo, useState } from "react";
import { RuntimeCrashRecovery } from "@/components/layout/RuntimeCrashRecovery";
import { RuntimeErrorListener } from "@/components/layout/RuntimeErrorListener";
import {
  createRuntimeDiagnostic,
  reportRuntimeError,
} from "@/lib/errors/runtime-reporting";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const initialDiagnostic = useMemo(
    () =>
      createRuntimeDiagnostic(error, {
        source: "next-route",
        label: "app-route",
      }),
    [error],
  );
  const [diagnostic, setDiagnostic] = useState(initialDiagnostic);

  useEffect(() => {
    setDiagnostic(
      reportRuntimeError(error, {
        source: "next-route",
        label: "app-route",
      }).diagnostic,
    );
  }, [error]);

  return (
    <>
      <RuntimeErrorListener />
      <RuntimeCrashRecovery
        diagnostic={diagnostic}
        source="next-route"
        label="app-route"
        title="The current view could not be loaded"
        description="The route failed safely. Retry it, return to a fresh login state, or reload the application."
        onReset={reset}
        resetLabel="Retry view"
      />
    </>
  );
}
