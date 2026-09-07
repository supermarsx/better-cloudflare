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
  ACTIVE_ENCRYPTION_ALGORITHMS,
  AES_256_KEY_LENGTH_BITS,
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  type EncryptionConfig,
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
  /** Delete this key's secret from the OS keychain. */
  onRemoveVaultSecret: () => void;
  /** Open the legacy passkey review dialog. */
  onManagePasskeys: () => void;
  /**
   * Whether any legacy credential recovery is on offer. False hides the
   * control rather than showing one that opens an empty list.
   */
  legacyRecoveryAvailable: boolean;
  /**
   * Whether a key is selected *and* its password has been typed. Both
   * controls below decrypt the selected key before they can do anything, so
   * without it they can only fail.
   */
  canUseSelectedKey: boolean;
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
  onRemoveVaultSecret,
  onManagePasskeys,
  legacyRecoveryAvailable,
  canUseSelectedKey,
}: EncryptionSettingsDialogProps) {
  const [useVault, setUseVault] = useState(vaultEnabled);
  const safeIterations =
    Number.isSafeInteger(settings.iterations) &&
    settings.iterations >= MIN_PBKDF2_ITERATIONS &&
    settings.iterations <= MAX_PBKDF2_ITERATIONS
      ? settings.iterations
      : MIN_PBKDF2_ITERATIONS;
  const safeAlgorithm = (
    ACTIVE_ENCRYPTION_ALGORITHMS as readonly string[]
  ).includes(settings.algorithm)
    ? settings.algorithm
    : "AES-GCM";
  const validSettings =
    safeIterations === settings.iterations &&
    settings.keyLength === AES_256_KEY_LENGTH_BITS &&
    safeAlgorithm === settings.algorithm;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-var(--app-top-inset)-2rem)] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Encryption Settings</DialogTitle>
          <DialogDescription>
            Configure encryption parameters for security and performance
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor="iterations">PBKDF2 Iterations</Label>
            <Input
              id="iterations"
              type="number"
              min={MIN_PBKDF2_ITERATIONS}
              max={MAX_PBKDF2_ITERATIONS}
              step={10_000}
              value={safeIterations}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const iterations = Number(e.target.value);
                if (
                  Number.isSafeInteger(iterations) &&
                  iterations >= MIN_PBKDF2_ITERATIONS &&
                  iterations <= MAX_PBKDF2_ITERATIONS
                ) {
                  onSettingsChange({ ...settings, iterations });
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Allowed range: {MIN_PBKDF2_ITERATIONS.toLocaleString()}–
              {MAX_PBKDF2_ITERATIONS.toLocaleString()} iterations.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-length">Key Length (bits)</Label>
            <Select value={AES_256_KEY_LENGTH_BITS.toString()} disabled>
              <SelectTrigger id="key-length">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AES_256_KEY_LENGTH_BITS.toString()}>
                  {AES_256_KEY_LENGTH_BITS}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="algorithm">Algorithm</Label>
            <Select value={safeAlgorithm} disabled>
              <SelectTrigger id="algorithm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIVE_ENCRYPTION_ALGORITHMS.map((alg) => (
                  <SelectItem key={alg} value={alg}>
                    {alg}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={onBenchmark}
              variant="outline"
              className="flex-1"
              disabled={!validSettings}
            >
              Benchmark
            </Button>
            <Button
              onClick={onUpdate}
              className="flex-1"
              disabled={!validSettings}
            >
              Update
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
            <div className="space-y-0.5">
              <Label>Enable OS Vault</Label>
              <p className="text-xs text-muted-foreground">
                Store decrypted keys in the system vault for passkey login.
              </p>
            </div>
            <Switch
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

          {/* Both of these decrypt the selected key, and both are rare,
              one-off maintenance actions. They sat on the login card, where
              they took permanent space and put a destructive button a stray
              click away from the password field. */}
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div className="space-y-0.5">
              <Label>Key maintenance</Label>
              <p className="text-xs text-muted-foreground">
                These act on the key selected on the login screen, and need its
                password.
              </p>
            </div>

            {!canUseSelectedKey && (
              <p className="text-xs text-muted-foreground/80">
                Select a key and enter its password to enable these.
              </p>
            )}

            {legacyRecoveryAvailable && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onManagePasskeys}
                disabled={!canUseSelectedKey}
                className="w-full"
              >
                Review legacy passkeys
              </Button>
            )}

            {!vaultEnabled && (
              <p
                data-testid="vault-disabled-notice"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-muted-foreground"
              >
                The OS vault is off, so passkey login is unavailable. An API key
                saved to the vault earlier remains in the system keychain until
                you remove it here.
              </p>
            )}

            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onRemoveVaultSecret}
              disabled={!canUseSelectedKey}
              className="w-full"
            >
              Remove Vault Secret
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
