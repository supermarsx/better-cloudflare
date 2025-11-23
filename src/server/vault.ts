/**
 * Optional OS vault wrapper using `keytar` when available, falling back to
 * an in-memory map when not. This keeps the server from persisting secrets
 * to disk unless `keytar` is available and configured.
 */
// OS import removed; not used in this file

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

let vault: VaultProvider = new MemoryVault();

// If keytar is enabled we attempt to load it asynchronously and replace
// the in-memory vault with an OS-backed implementation. This keeps the
// module synchronous for consumers while still enabling runtime feature
// detection on platforms where `keytar` is present.
if (process.env.KEYTAR_ENABLED) {
  (async () => {
    try {
      const kt = await import('keytar').catch(() => null);
      const keytar = (kt as unknown) as {
        setPassword?: (service: string, account: string, password: string) => Promise<void>;
        getPassword?: (service: string, account: string) => Promise<string | null>;
        deletePassword?: (service: string, account: string) => Promise<boolean>;
      } | null;
      if (keytar && typeof keytar.setPassword === 'function') {
        vault = {
          async setSecret(key: string, secret: Secret) {
            if (keytar.setPassword) await keytar.setPassword('better-cloudflare', String(key), secret);
          },
          async getSecret(key: string) {
            if (!keytar.getPassword) return null;
            return (await keytar.getPassword('better-cloudflare', String(key))) ?? null;
          },
          async deleteSecret(key: string) {
            if (keytar.deletePassword) await keytar.deletePassword('better-cloudflare', String(key));
          },
        };
      }
    } catch {
      // ignore failures and keep the default in-memory vault
    }
  })();
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
