/**
 * Retrieve environment variable. First checks Node `process.env`, then
 * falls back to Vite's `import.meta.env` values if available. A
 * `defaultValue` can be provided in case the value is not set.
 *
 * @param name - name in Node `process.env`
 * @param browserKey - key name available via `import.meta.env` in the browser
 * @param defaultValue - fallback value if not set
 */
export function getEnv(
  name: string,
  browserKey: string,
  defaultValue?: string,
): string | undefined {
  if (typeof process !== 'undefined' && process.env?.[name] !== undefined) {
    return process.env[name];
  }
  if (typeof import.meta !== 'undefined') {
    const val = import.meta.env?.[browserKey];
    if (val !== undefined) return val;
  }
  return defaultValue;
}

/**
 * Convenience helper to read boolean-like environment flags from the
 * environment. Accepts values: `1`, `true`, `yes`, `on` (case-insensitive)
 * and falls back to the provided default value if unset.
 */
export function getEnvBool(
  name: string,
  browserKey: string,
  defaultValue = false,
): boolean {
  const val = getEnv(name, browserKey);
  if (val === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(val.toLowerCase());
}

/**
 * Helper to read numeric environment variables. Returns `defaultValue` if
 * parsing fails or if the value is not present.
 */
export function getEnvNumber(
  name: string,
  browserKey: string,
  defaultValue: number,
): number {
  const val = getEnv(name, browserKey);
  if (val === undefined) return defaultValue;
  const parsed = Number(val);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Rate limiting configuration (defaults: 60s window, 100 requests)
 */
export const RATE_LIMIT_WINDOW = getEnvNumber(
  'RATE_LIMIT_WINDOW',
  'VITE_RATE_LIMIT_WINDOW',
  60_000,
);

export const RATE_LIMIT_MAX = getEnvNumber(
  'RATE_LIMIT_MAX',
  'VITE_RATE_LIMIT_MAX',
  100,
);
