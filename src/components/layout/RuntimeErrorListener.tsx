"use client";

import { useEffect } from "react";
import { toast } from "@/hooks/use-toast";
import {
  installGlobalRuntimeReporting,
  subscribeRuntimeReports,
} from "@/lib/errors/runtime-reporting";

export function RuntimeErrorListener() {
  useEffect(() => {
    const unsubscribe = subscribeRuntimeReports((diagnostic) => {
      toast({
        title: "A runtime problem was contained",
        description: diagnostic.message,
        variant: "destructive",
        diagnostic,
        persistent: true,
      });
    });
    const uninstall =
      typeof window !== "undefined"
        ? installGlobalRuntimeReporting(window)
        : () => {};

    return () => {
      uninstall();
      unsubscribe();
    };
  }, []);

  return null;
}
