"use client";

import { RuntimeCrashRecovery } from "@/components/layout/RuntimeCrashRecovery";

export default function NotFound() {
  return (
    <RuntimeCrashRecovery
      error={new Error("The requested page does not exist.")}
      source="runtime"
      label="not-found"
      title="Page not found"
      description="The requested location is not part of this application."
      homeHref="./"
    />
  );
}
