/**
 * UI helper utilities
 *
 * Small helpers used by the application for class name merging and generating
 * UUIDs used across the client.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine class names in a way that's compatible with Tailwind CSS
 * - Uses `clsx` to concatenate class names
 * - Uses `tailwind-merge` to collapse duplicate/conflicting classes
 *
 * @param inputs - one or more values supported by `clsx`
 * @returns a merged class name string
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Generate a v4 UUID.
 *
 * If crypto.randomUUID is available use it, otherwise construct a UUID from
 * secure random bytes.
 *
 * @returns RFC4122-compliant v4 UUID string
 */
export function generateUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
