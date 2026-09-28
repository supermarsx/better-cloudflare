import { useEffect, useState } from "react";

import { ServerClient } from "@/lib/api/server-client";
import {
  createTrackedRuntimeResources,
  type RuntimeResourceHost,
} from "@/lib/runtime/resource-scope";

/**
 * How long one round trip may take before it still counts as "good". The
 * numbers describe a full authenticated Cloudflare API call as this app makes
 * it -- TLS session reuse, Cloudflare's own processing and (on the desktop)
 * one IPC hop included -- not an ICMP ping, which is an order of magnitude
 * faster. A healthy connection lands well inside the first bucket.
 */
export const CLOUDFLARE_LATENCY_GOOD_MAX_MS = 300;
/** Above this a round trip is reported as poor. */
export const CLOUDFLARE_LATENCY_FAIR_MAX_MS = 800;
/** Gap between probes. One cheap read per minute is invisible next to Cloudflare's 1200-per-5-minute budget. */
export const CLOUDFLARE_LATENCY_POLL_INTERVAL_MS = 60_000;
/** A probe that has not come back by now is treated as no reading at all. */
export const CLOUDFLARE_LATENCY_TIMEOUT_MS = 8_000;

export type CloudflareLatencyGrade = "good" | "fair" | "poor";

export type CloudflareLatencyStatus =
  /** No credentials, or measuring was switched off: there is nothing to show. */
  | "disabled"
  /** A probe is in flight and nothing has been measured yet. */
  | "measuring"
  /** `latencyMs` holds a real round trip. */
  | "ready"
  /** The device reports no network, so nothing was even attempted. */
  | "offline"
  /** The probe failed or timed out. A statement about the link, not an app error. */
  | "unavailable";

export interface CloudflareLatencyState {
  status: CloudflareLatencyStatus;
  /** Round-trip milliseconds of the last successful probe, `null` otherwise. */
  latencyMs: number | null;
  /** Grade of `latencyMs`, `null` whenever there is no measurement. */
  grade: CloudflareLatencyGrade | null;
}

export interface CloudflareLatencyProbeInput {
  apiKey: string;
  email?: string;
  signal: AbortSignal;
}

export interface UseCloudflareLatencyOptions {
  /** Credential the probe authenticates with. Without one the hook stays disabled. */
  apiKey?: string;
  email?: string;
  /** `false` disables measuring entirely (e.g. no session). */
  enabled?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  /** Seam for tests: one round trip through the app's own Cloudflare path. */
  probe?: (input: CloudflareLatencyProbeInput) => Promise<unknown>;
  /** Seam for tests: monotonic clock used to time the round trip. */
  now?: () => number;
  /** Seam for tests: timer host, defaulting to `window`. */
  host?: RuntimeResourceHost;
}

const DISABLED_STATE: CloudflareLatencyState = {
  status: "disabled",
  latencyMs: null,
  grade: null,
};
const MEASURING_STATE: CloudflareLatencyState = {
  status: "measuring",
  latencyMs: null,
  grade: null,
};
const OFFLINE_STATE: CloudflareLatencyState = {
  status: "offline",
  latencyMs: null,
  grade: null,
};
const UNAVAILABLE_STATE: CloudflareLatencyState = {
  status: "unavailable",
  latencyMs: null,
  grade: null,
};

/** Bucket a measured round trip. Pure, so the thresholds stay testable. */
export function classifyCloudflareLatency(
  latencyMs: number,
): CloudflareLatencyGrade {
  if (latencyMs <= CLOUDFLARE_LATENCY_GOOD_MAX_MS) return "good";
  if (latencyMs <= CLOUDFLARE_LATENCY_FAIR_MAX_MS) return "fair";
  return "poor";
}

function readClock(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * `navigator.onLine` where the platform exposes it, `undefined` where it does
 * not. Only a real boolean counts as evidence, the same reading
 * `normalizeRequestError` applies: guessing "offline" from a missing flag
 * would hide a perfectly good connection.
 */
function readNavigatorOnline(): boolean | undefined {
  if (typeof navigator === "undefined") return undefined;
  return typeof navigator.onLine === "boolean" ? navigator.onLine : undefined;
}

function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * One authenticated round trip along the path the app really uses.
 *
 * `ServerClient.getZones` is the cheapest authenticated read the app already
 * performs, and unlike `verifyToken` the desktop backend writes no audit entry
 * for it -- a probe running every minute must not bury the user's own actions
 * in the audit log.
 *
 * On the desktop this is renderer -> Tauri IPC -> native HTTPS request to
 * `api.cloudflare.com` and back; on the web it is browser -> this app's API
 * server -> Cloudflare and back. Both include hops the app itself owns, which
 * is why nothing here claims to be a ping.
 */
async function measureCloudflareRoundTrip({
  apiKey,
  email,
  signal,
}: CloudflareLatencyProbeInput): Promise<unknown> {
  const client = new ServerClient(apiKey, undefined, email);
  return client.getZones(signal);
}

/**
 * Live round-trip time to the Cloudflare API, measured by timing the app's own
 * lightweight authenticated read.
 *
 * The loop is a single self-rescheduling timeout rather than an interval, so
 * two probes can never overlap and a slow network stretches the gap instead of
 * queueing work. It stays idle without credentials, while the device reports
 * itself offline, and while the window is hidden; `online` and
 * `visibilitychange` wake it up again. Every timer is tracked and every
 * in-flight request is aborted on unmount.
 */
export function useCloudflareLatency(
  options: UseCloudflareLatencyOptions = {},
): CloudflareLatencyState {
  const {
    apiKey,
    email,
    enabled = true,
    intervalMs = CLOUDFLARE_LATENCY_POLL_INTERVAL_MS,
    timeoutMs = CLOUDFLARE_LATENCY_TIMEOUT_MS,
    probe = measureCloudflareRoundTrip,
    now = readClock,
  } = options;
  const [state, setState] = useState<CloudflareLatencyState>(DISABLED_STATE);
  const timerHost =
    options.host ?? (typeof window === "undefined" ? undefined : window);
  const credential =
    enabled && typeof apiKey === "string" && apiKey.length > 0
      ? apiKey
      : undefined;

  useEffect(() => {
    if (credential === undefined || timerHost === undefined) {
      setState(DISABLED_STATE);
      return;
    }

    const resources = createTrackedRuntimeResources(timerHost);
    let disposed = false;
    let pollTimerId: number | null = null;
    let inFlight: AbortController | null = null;
    // The online/offline events only notify of what `navigator.onLine` already
    // says, so the flag wins wherever it exists. This remembers the last event
    // for the platforms that leave it undefined.
    let lastEventSaidOffline = false;

    const isOffline = (): boolean => {
      const online = readNavigatorOnline();
      return online === undefined ? lastEventSaidOffline : !online;
    };

    const publish = (next: CloudflareLatencyState) => {
      if (disposed) return;
      setState((previous) =>
        previous.status === next.status &&
        previous.latencyMs === next.latencyMs &&
        previous.grade === next.grade
          ? previous
          : next,
      );
    };

    // Only the very first probe shows "measuring": later ones keep the last
    // reading on screen so the bar does not flicker once a minute.
    const markMeasuring = () => {
      if (disposed) return;
      setState((previous) =>
        previous.status === "ready" ? previous : MEASURING_STATE,
      );
    };

    const clearPollTimer = () => {
      if (pollTimerId === null) return;
      resources.clearTimeout(pollTimerId);
      pollTimerId = null;
    };

    const schedule = (delayMs: number) => {
      if (disposed || pollTimerId !== null) return;
      pollTimerId = resources.setTimeout(() => {
        pollTimerId = null;
        void measure();
      }, delayMs);
    };

    const measure = async (): Promise<void> => {
      if (disposed || inFlight !== null) return;
      if (isOffline()) {
        publish(OFFLINE_STATE);
        // The `online` event normally wakes the loop; this timer is only the
        // fallback for a browser that never fires one.
        schedule(intervalMs);
        return;
      }
      if (isDocumentHidden()) {
        // Nobody is looking, so spend nothing on the network. Keep the last
        // reading and look again after the usual gap.
        schedule(intervalMs);
        return;
      }

      const controller = new AbortController();
      inFlight = controller;
      const deadlineTimerId = resources.setTimeout(
        () => controller.abort(),
        timeoutMs,
      );
      markMeasuring();
      const startedAt = now();
      try {
        await probe({ apiKey: credential, email, signal: controller.signal });
        const latencyMs = Math.max(0, Math.round(now() - startedAt));
        publish({
          status: "ready",
          latencyMs,
          grade: classifyCloudflareLatency(latencyMs),
        });
      } catch {
        // A failed or aborted probe describes the connection, not a fault in
        // the app: it stays silent, reports no reading, and tries again later.
        publish(isOffline() ? OFFLINE_STATE : UNAVAILABLE_STATE);
      } finally {
        resources.clearTimeout(deadlineTimerId);
        if (inFlight === controller) inFlight = null;
        schedule(intervalMs);
      }
    };

    const restart = () => {
      clearPollTimer();
      void measure();
    };

    const handleOnline = () => {
      lastEventSaidOffline = false;
      restart();
    };

    const handleOffline = () => {
      lastEventSaidOffline = true;
      clearPollTimer();
      inFlight?.abort();
      publish(OFFLINE_STATE);
      schedule(intervalMs);
    };

    const handleVisibilityChange = () => {
      if (isDocumentHidden()) return;
      restart();
    };

    const eventTarget = typeof window === "undefined" ? undefined : window;
    const documentTarget =
      typeof document === "undefined" ? undefined : document;
    eventTarget?.addEventListener("online", handleOnline);
    eventTarget?.addEventListener("offline", handleOffline);
    documentTarget?.addEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );

    void measure();

    return () => {
      disposed = true;
      eventTarget?.removeEventListener("online", handleOnline);
      eventTarget?.removeEventListener("offline", handleOffline);
      documentTarget?.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
      inFlight?.abort();
      inFlight = null;
      pollTimerId = null;
      resources.dispose();
    };
  }, [credential, email, intervalMs, now, probe, timerHost, timeoutMs]);

  return state;
}
