/**
 * Modal dialog for adding and saving a new API key into encrypted storage.
 */
import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

/**
 * Props for the AddKeyDialog which collects an API key and encryption
 * password to store an encrypted key in local storage.
 */
export interface AddKeyDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback invoked when the dialog open state changes */
  onOpenChange: (open: boolean) => void;
  /** Label to show for the new key */
  label: string;
  /** Callback invoked when the label changes */
  onLabelChange: (val: string) => void;
  /** The API key (token) string */
  apiKey: string;
  /** Callback invoked when the API key field changes */
  onApiKeyChange: (val: string) => void;
  /** Account email associated with the key (optional) */
  email: string;
  /** Callback invoked when the email field changes */
  onEmailChange: (val: string) => void;
  /** Password used to encrypt the API key */
  password: string;
  /** Callback invoked when the password field changes */
  onPasswordChange: (val: string) => void;
  /** Callback to add the provided API key */
  onAdd: () => void;
}

/**
 * Render a dialog to add a new API key. The dialog collects a label, the
 * API key, (optionally) an associated email and an encryption password.
 */
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
