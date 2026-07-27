/**
 * Runtime environment helpers for web vs. Tauri desktop.
 */
interface TauriWindowHints {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  isTauri?: unknown;
}

function hasTauriWindowBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const tauriWindow = window as Window & TauriWindowHints;
  return (
    "__TAURI_INTERNALS__" in tauriWindow ||
    "__TAURI__" in tauriWindow ||
    tauriWindow.isTauri === true
  );
}

export function isDesktop(): boolean {
  return hasTauriWindowBridge();
}

export function isWeb(): boolean {
  return !isDesktop();
}
