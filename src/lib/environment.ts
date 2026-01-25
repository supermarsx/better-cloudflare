/**
 * Runtime environment helpers for web vs. Tauri desktop.
 */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

export function isWeb(): boolean {
  return !isDesktop();
}
