"use client";

import { useState, useEffect } from "react";
import App from "../src/App";
import { RuntimeRootBoundary } from "@/components/layout/RuntimeRootBoundary";

export default function Page() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <RuntimeRootBoundary>
      <App />
    </RuntimeRootBoundary>
  );
}
