export function getEnv(name: string, browserKey: string, defaultValue?: string): string | undefined {
  if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
    return process.env[name];
  }
  if (typeof import.meta !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (import.meta as any).env?.[browserKey];
    if (val !== undefined) return val;
  }
  return defaultValue;
}
