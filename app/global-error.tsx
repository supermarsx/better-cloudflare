"use client";

import { useEffect, useMemo, useState } from "react";
import { RuntimeCrashRecovery } from "@/components/layout/RuntimeCrashRecovery";
import { RuntimeErrorListener } from "@/components/layout/RuntimeErrorListener";
import {
  createRuntimeDiagnostic,
  reportRuntimeError,
} from "@/lib/errors/runtime-reporting";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const initialDiagnostic = useMemo(
    () =>
      createRuntimeDiagnostic(error, {
        source: "next-global",
        label: "root-layout",
      }),
    [error],
  );
  const [diagnostic, setDiagnostic] = useState(initialDiagnostic);

  useEffect(() => {
    setDiagnostic(
      reportRuntimeError(error, {
        source: "next-global",
        label: "root-layout",
      }).diagnostic,
    );
  }, [error]);

  return (
    <html lang="en">
      <body>
        <RuntimeErrorListener />
        <RuntimeCrashRecovery
          diagnostic={diagnostic}
          source="next-global"
          label="root-layout"
          title="Better Cloudflare entered recovery mode"
          description="A root rendering failure was contained. Your stored data has not been deleted."
          onReset={reset}
          resetLabel="Retry application"
        />
      </body>
    </html>
  );
}
