import { promises as fs } from "fs";
import path from "path";

type VaultStore = Record<string, string>;

const vaultFile = path.resolve(process.cwd(), "data", "vault.json");

async function loadVault(): Promise<VaultStore> {
  try {
    const raw = await fs.readFile(vaultFile, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? (parsed as VaultStore) : {};
  } catch {
    return {};
  }
}

async function saveVault(data: VaultStore) {
  await fs.mkdir(path.dirname(vaultFile), { recursive: true });
  await fs.writeFile(vaultFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export const vaultManager = {
  async getSecret(key: string) {
    const data = await loadVault();
    return data[key] ?? null;
  },
  async setSecret(key: string, value: string) {
    const data = await loadVault();
    data[key] = value;
    await saveVault(data);
  },
  async deleteSecret(key: string) {
    const data = await loadVault();
    if (!(key in data)) return;
    delete data[key];
    await saveVault(data);
  },
};
