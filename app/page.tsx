"use client";

import { useState, useEffect } from "react";
import App from "../src/App";
import { RuntimeRootBoundary } from "@/components/layout/RuntimeRootBoundary";
import { storageManager } from "@/lib/storage/storage";

export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [storageError, setStorageError] = useState<string>();

  useEffect(() => {
    let active = true;
    void storageManager.ready().then(
      () => {
        if (active) setMounted(true);
      },
      (error: unknown) => {
        if (!active) return;
        setStorageError(
          error instanceof Error
            ? error.message
            : "Persistent browser storage could not be prepared.",
        );
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (storageError) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div
          role="alert"
          className="max-w-lg rounded-xl border border-destructive/50 bg-destructive/5 p-6"
        >
          <h1 className="font-semibold text-destructive">
            Local data could not be opened safely
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{storageError}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Existing data was not overwritten. Check browser storage access,
            then reload the app.
          </p>
          <button
            type="button"
            className="mt-4 rounded-md border px-3 py-2 text-sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </main>
    );
  }
  if (!mounted) return null;

  return (
    <RuntimeRootBoundary>
      <App />
    </RuntimeRootBoundary>
  );
}
