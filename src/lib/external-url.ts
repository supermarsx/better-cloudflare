import { isDesktop } from "@/lib/environment";

function containsControlOrWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface ExternalUrlAdapter {
  isDesktop: () => boolean;
  openDesktop: (url: string) => void | Promise<void>;
  openWeb: (url: string) => void | Promise<void>;
}

export function normalizeExternalHttpUrl(candidate: string): string | null {
  if (!candidate || containsControlOrWhitespace(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export const defaultExternalUrlAdapter: ExternalUrlAdapter = {
  isDesktop,
  openDesktop: async (url) => {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  },
  openWeb: (url) => {
    if (typeof window === "undefined") {
      throw new Error("Cannot open an external URL without a browser window");
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },
};

export async function openExternalUrl(
  candidate: string,
  adapter: ExternalUrlAdapter = defaultExternalUrlAdapter,
): Promise<boolean> {
  const url = normalizeExternalHttpUrl(candidate);
  if (!url) return false;

  if (adapter.isDesktop()) await adapter.openDesktop(url);
  else await adapter.openWeb(url);
  return true;
}
