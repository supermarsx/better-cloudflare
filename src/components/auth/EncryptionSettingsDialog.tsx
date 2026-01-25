/**
 * UI dialog allowing the user to configure encryption parameters used by the
 * `CryptoManager` and to run a performance benchmark of the configured
 * PBKDF2 iteration count.
 */
import type { ChangeEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ENCRYPTION_ALGORITHMS,
  type EncryptionConfig,
  type EncryptionAlgorithm,
} from "../../types/dns";
import { Switch } from "@/components/ui/switch";

/**
 * Props for the EncryptionSettingsDialog, which allows users to configure
 * PBKDF2 iterations, key length and algorithm for encrypting API keys.
 */
export interface EncryptionSettingsDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback invoked when the open state changes */
  onOpenChange: (open: boolean) => void;
  /** Current encryption settings */
  settings: EncryptionConfig;
  /** Update callback to modify the settings object */
  onSettingsChange: (settings: EncryptionConfig) => void;
  /** Run a CPU benchmark with the settings */
  onBenchmark: () => void;
  /** Apply the updated settings */
  onUpdate: () => void;
  /** Latest benchmark result in ms, or null when none has been run */
  benchmarkResult: number | null;
  /** If OS Vault is enabled */
  vaultEnabled: boolean;
  /** Toggle OS Vault enable state */
  onVaultEnabledChange: (enabled: boolean) => void;
}

/**
 * Dialog to configure encryption settings and run a benchmark to estimate
 * the PBKDF2 cost for the currently selected iteration count.
 */
export function EncryptionSettingsDialog({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
  onBenchmark,
  onUpdate,
  benchmarkResult,
  vaultEnabled,
  onVaultEnabledChange,
}: EncryptionSettingsDialogProps) {
  const [useVault, setUseVault] = useState(vaultEnabled);
  const safeIterations =
    typeof settings.iterations === "number" ? settings.iterations : 100000;
  const safeKeyLength =
    typeof settings.keyLength === "number" ? settings.keyLength : 256;
  const safeAlgorithm = settings.algorithm ?? "AES-GCM";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Encryption Settings</DialogTitle>
          <DialogDescription>
            Configure encryption parameters for security and performance
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="iterations">PBKDF2 Iterations</Label>
            <Input
              id="iterations"
              type="number"
              value={safeIterations}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                onSettingsChange({
                  ...settings,
                  iterations: Number.isNaN(n) ? 100000 : n,
                });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-length">Key Length (bits)</Label>
            <Select
              value={safeKeyLength.toString()}
              onValueChange={(value) =>
                onSettingsChange({ ...settings, keyLength: parseInt(value) })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="128">128</SelectItem>
                <SelectItem value="192">192</SelectItem>
                <SelectItem value="256">256</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="algorithm">Algorithm</Label>
            <Select
              value={safeAlgorithm}
              onValueChange={(value) =>
                onSettingsChange({
                  ...settings,
                  algorithm: value as EncryptionAlgorithm,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCRYPTION_ALGORITHMS.map((alg) => (
                  <SelectItem key={alg} value={alg}>
                    {alg}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button onClick={onBenchmark} variant="outline" className="flex-1">
              Benchmark
            </Button>
            <Button onClick={onUpdate} className="flex-1">
              Update
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <div className="space-y-0.5">
              <Label>Enable OS Vault</Label>
              <p className="text-xs text-muted-foreground">
                Store decrypted keys in the system vault for passkey login.
              </p>
            </div>
            <Switch
              className="data-[state=unchecked]:bg-white/15 data-[state=checked]:bg-orange-500/70"
              checked={useVault}
              onCheckedChange={(v: boolean) => {
                setUseVault(v);
                onVaultEnabledChange(v);
              }}
            />
          </div>
          {benchmarkResult !== null && (
            <p className="text-sm text-muted-foreground">
              Last benchmark: {benchmarkResult.toFixed(2)}ms
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
