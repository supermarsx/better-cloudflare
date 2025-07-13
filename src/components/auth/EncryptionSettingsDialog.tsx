import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { EncryptionConfig } from '@/types/dns';
import { Settings } from 'lucide-react';

export interface EncryptionSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: EncryptionConfig;
  onSettingsChange: (settings: EncryptionConfig) => void;
  onBenchmark: () => void;
  onUpdate: () => void;
  benchmarkResult: number | null;
}

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
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onSettingsChange({ ...settings, iterations: parseInt(e.target.value) || 100000 })
              }
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
