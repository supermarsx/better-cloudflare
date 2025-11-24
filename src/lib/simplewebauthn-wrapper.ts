// Lazy-load @simplewebauthn/server so tests and environments that don't
// have the optional dependency won't throw at import time.
import { createRequire } from 'module';

export type VerifyRegistrationResult = {
  verified?: boolean;
  registrationInfo?: { credentialID?: string; id?: string; credentialPublicKey?: string; publicKey?: string; counter?: number } | null;
  attestationType?: string | null;
};

export type VerifyAuthenticationResult = {
  verified?: boolean;
  authenticationInfo?: { newCounter?: number } | null;
};

type SwauthMod = {
  verifyRegistrationResponse?: (...args: unknown[]) => Promise<VerifyRegistrationResult>;
  verifyAuthenticationResponse?: (...args: unknown[]) => Promise<VerifyAuthenticationResult>;
  generateRegistrationOptions?: (opts?: Record<string, unknown>) => Record<string, unknown>;
  generateAuthenticationOptions?: (opts?: Record<string, unknown>) => Record<string, unknown>;
};

let swauth: SwauthMod | null = null;

function loadSwauthSync(): SwauthMod | null {
  if (swauth) return swauth;
  try {
    // attempt to synchronously require the module if it exists; keep the
    // dependency optional so tests and environments without the package
    // don't blow up at import time.
    const req = createRequire(import.meta.url);
    swauth = req('@simplewebauthn/server') as SwauthMod;
    return swauth;
  } catch {
    swauth = null;
    return null;
  }
}

export const verifyRegistrationResponse = async (...args: unknown[]): Promise<VerifyRegistrationResult> => {
  const mod = loadSwauthSync();
  // runtime check: if the module or method isn't available throw
  if (!mod || !mod.verifyRegistrationResponse) throw new Error('@simplewebauthn/server not available');
  return mod.verifyRegistrationResponse(...args) as Promise<VerifyRegistrationResult>;
};

export const verifyAuthenticationResponse = async (...args: unknown[]): Promise<VerifyAuthenticationResult> => {
  const mod = loadSwauthSync();
  if (!mod || !mod.verifyAuthenticationResponse) throw new Error('@simplewebauthn/server not available');
  return mod.verifyAuthenticationResponse(...args) as Promise<VerifyAuthenticationResult>;
};

// Provide synchronous fallbacks for registration/auth option generation so the
// server code can generate options in environments that do not have the
// upstream package installed (e.g. unit tests).
export const generateRegistrationOptions = (opts: Record<string, unknown> = {}): Record<string, unknown> => {
  const mod = loadSwauthSync();
  if (mod && mod.generateRegistrationOptions) return mod.generateRegistrationOptions(opts);

  // Minimal fallback: include a generated base64 challenge and echo back
  // other inputs. This mirrors the shape expected by our tests.
  const globalCrypto = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const challenge = globalCrypto.crypto?.randomUUID
    ? Buffer.from(globalCrypto.crypto.randomUUID()).toString('base64')
    : Buffer.from(String(Date.now())).toString('base64');
  const rpName = (opts as Record<string, unknown>)['rpName'] as string | undefined;
  return { challenge, ...opts, rp: { name: rpName ?? 'Better Cloudflare' } };
};

export const generateAuthenticationOptions = (opts: Record<string, unknown> = {}): Record<string, unknown> => {
  const mod = loadSwauthSync();
  if (mod && mod.generateAuthenticationOptions) return mod.generateAuthenticationOptions(opts);
  const globalCrypto = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const challenge = globalCrypto.crypto?.randomUUID
    ? Buffer.from(globalCrypto.crypto.randomUUID()).toString('base64')
    : Buffer.from(String(Date.now())).toString('base64');
  const allowCredentials = (opts as Record<string, unknown>)['allowCredentials'] ?? [];
  const rpId = (opts as Record<string, unknown>)['rpID'] ?? (opts as Record<string, unknown>)['rpId'];
  return { challenge, allowCredentials, rpId };
};

export default {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  generateRegistrationOptions,
  generateAuthenticationOptions,
};
