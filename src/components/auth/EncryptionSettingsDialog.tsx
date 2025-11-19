import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  ENCRYPTION_ALGORITHMS,
  type EncryptionConfig,
  type EncryptionAlgorithm,
} from '../../types/dns';
import { Settings } from 'lucide-react';

/**
 * Props for the EncryptionSettingsDialog, which allows users to configure
 * PBKDF2 iterations, key length and algorithm for encrypting API keys.
 */
export interface EncryptionSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: EncryptionConfig;
  onSettingsChange: (settings: EncryptionConfig) => void;
  onBenchmark: () => void;
  onUpdate: () => void;
  benchmarkResult: number | null;
}

/**
 * Dialog to configure encryption settings and run a benchmark to estimate
 * the PBKDF2 cost for the currently selected iteration count.
 */
export function EncryptionSettingsDialog({ open, onOpenChange, settings, onSettingsChange, onBenchmark, onUpdate, benchmarkResult }: EncryptionSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
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
              value={settings.iterations}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const n = Number.parseInt(e.target.value, 10);
                onSettingsChange({
                  ...settings,
                  iterations: Number.isNaN(n) ? 100000 : n
                });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-length">Key Length (bits)</Label>
            <Select
              value={settings.keyLength.toString()}
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
              value={settings.algorithm}
              onValueChange={(value) =>
                onSettingsChange({ ...settings, algorithm: value as EncryptionAlgorithm })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCRYPTION_ALGORITHMS.map((alg) => (
                  <SelectItem key={alg} value={alg}>{alg}</SelectItem>
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
