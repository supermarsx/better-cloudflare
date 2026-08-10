import { useEffect, useState } from "react";

/**
 * `true` when the viewer asked for reduced motion. Falls back to `false`
 * wherever the preference cannot be read (server rendering, or a runtime
 * without `matchMedia`), so motion stays enabled unless it is explicitly
 * opted out of.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }
    return undefined;
  }, []);

  return reduced;
}
