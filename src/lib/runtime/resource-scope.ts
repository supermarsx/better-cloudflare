export type RuntimeResourceHost = Pick<
  Window,
  | "setTimeout"
  | "clearTimeout"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
>;

export interface RuntimeResourceSnapshot {
  timeouts: number;
  animationFrames: number;
}

export interface TrackedRuntimeResources {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timeoutId: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(frameId: number): void;
  dispose(): void;
  snapshot(): RuntimeResourceSnapshot;
}

/**
 * Tracks short-lived browser scheduling resources so completed handles are
 * forgotten and outstanding work can be cancelled idempotently on unmount.
 * The scope remains reusable after dispose, which keeps it safe under React's
 * development StrictMode effect setup/cleanup cycle.
 */
export function createTrackedRuntimeResources(
  host: RuntimeResourceHost,
): TrackedRuntimeResources {
  const timeouts = new Set<number>();
  const animationFrames = new Set<number>();

  const clearTrackedTimeout = (timeoutId: number) => {
    if (!timeouts.delete(timeoutId)) return;
    host.clearTimeout(timeoutId);
  };

  const cancelTrackedAnimationFrame = (frameId: number) => {
    if (!animationFrames.delete(frameId)) return;
    host.cancelAnimationFrame(frameId);
  };

  return {
    setTimeout(callback, delayMs) {
      let timeoutId = 0;
      timeoutId = host.setTimeout(() => {
        timeouts.delete(timeoutId);
        callback();
      }, delayMs);
      timeouts.add(timeoutId);
      return timeoutId;
    },
    clearTimeout: clearTrackedTimeout,
    requestAnimationFrame(callback) {
      let frameId = 0;
      frameId = host.requestAnimationFrame((timestamp) => {
        animationFrames.delete(frameId);
        callback(timestamp);
      });
      animationFrames.add(frameId);
      return frameId;
    },
    cancelAnimationFrame: cancelTrackedAnimationFrame,
    dispose() {
      for (const timeoutId of [...timeouts]) {
        clearTrackedTimeout(timeoutId);
      }
      for (const frameId of [...animationFrames]) {
        cancelTrackedAnimationFrame(frameId);
      }
    },
    snapshot() {
      return {
        timeouts: timeouts.size,
        animationFrames: animationFrames.size,
      };
    },
  };
}

type ObjectUrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

/**
 * Gives a synchronous consumer an object URL and guarantees revocation even
 * when DOM interaction throws.
 */
export function withObjectUrl<T>(
  blob: Blob,
  consume: (url: string) => T,
  urlApi: ObjectUrlApi = URL,
): T {
  const url = urlApi.createObjectURL(blob);
  try {
    return consume(url);
  } finally {
    urlApi.revokeObjectURL(url);
  }
}
