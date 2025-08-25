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

export function getEnvBool(
  name: string,
  browserKey: string,
  defaultValue = false,
): boolean {
  const val = getEnv(name, browserKey);
  if (val === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(val.toLowerCase());
}

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
