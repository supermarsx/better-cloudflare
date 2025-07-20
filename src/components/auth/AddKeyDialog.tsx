import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

export interface AddKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onLabelChange: (val: string) => void;
  apiKey: string;
  onApiKeyChange: (val: string) => void;
  email: string;
  onEmailChange: (val: string) => void;
  password: string;
  onPasswordChange: (val: string) => void;
  onAdd: () => void;
}

export function AddKeyDialog({ open, onOpenChange, label, onLabelChange, apiKey, onApiKeyChange, email, onEmailChange, password, onPasswordChange, onAdd }: AddKeyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="flex-1">
          <Plus className="h-4 w-4 mr-2" />
          Add Key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New API Key</DialogTitle>
          <DialogDescription>
            Add a new Cloudflare API key with a custom label
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-label">Label</Label>
            <Input
              id="new-label"
              value={label}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onLabelChange(e.target.value)}
              placeholder="e.g., Personal Account"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-api-key">API Key</Label>
            <Input
              id="new-api-key"
              type="password"
              value={apiKey}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onApiKeyChange(e.target.value)}
              placeholder="Your Cloudflare API key"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-email">Account Email (optional for global keys)</Label>
            <Input
              id="new-email"
              type="email"
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onEmailChange(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">Encryption Password</Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onPasswordChange(e.target.value)}
              placeholder="Password to encrypt this key"
            />
          </div>
          <Button onClick={onAdd} className="w-full">
            Add API Key
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
