/**
 * Optional OS vault wrapper using `keytar` when available, falling back to
 * an in-memory map when not. This keeps the server from persisting secrets
 * to disk unless `keytar` is available and configured.
 */
import os from 'os';

type Secret = string;

interface VaultProvider {
  setSecret(key: string, secret: Secret): Promise<void>;
  getSecret(key: string): Promise<Secret | null>;
  deleteSecret(key: string): Promise<void>;
}

class MemoryVault implements VaultProvider {
  private map = new Map<string, Secret>();
  async setSecret(key: string, secret: Secret) {
    this.map.set(key, secret);
  }
  async getSecret(key: string) {
    return this.map.get(key) ?? null;
  }
  async deleteSecret(key: string) {
    this.map.delete(key);
  }
}

let vault: VaultProvider;

try {
  // Dynamically require to avoid issues when keytar is missing in some dev
  // environments. Use keytar when available for OS-provided keychain.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const keytar = process.env.KEYTAR_ENABLED ? require('keytar') : null;
  if (keytar && typeof keytar.setPassword === 'function') {
    vault = {
      async setSecret(key: string, secret: Secret) {
        await keytar.setPassword('better-cloudflare', String(key), secret);
      },
      async getSecret(key: string) {
        return (await keytar.getPassword('better-cloudflare', String(key))) ?? null;
      },
      async deleteSecret(key: string) {
        await keytar.deletePassword('better-cloudflare', String(key));
      },
    };
  } else {
    vault = new MemoryVault();
  }
} catch (err) {
  vault = new MemoryVault();
}

/**
 * Vault manager wrapper exposing the subset of operations we need.
 *
 * Implementation details:
 * - Uses `keytar` when available and enabled via `KEYTAR_ENABLED`
 * - Falls back to an in-memory Map if keytar is not present
 */
export const vaultManager = {
  /** Store a secret under the given key (overwrites existing) */
  setSecret: (k: string, v: string) => vault.setSecret(k, v),
  /** Retrieve a secret or null if it does not exist */
  getSecret: (k: string) => vault.getSecret(k),
  /** Delete a secret from the vault */
  deleteSecret: (k: string) => vault.deleteSecret(k),
};

export default vaultManager;
