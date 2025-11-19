import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Props for the EditKeyDialog allowing label/email changes and password
 * rotations for an API key.
 */
export interface EditKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onLabelChange: (val: string) => void;
  email: string;
  onEmailChange: (val: string) => void;
  currentPassword: string;
  onCurrentPasswordChange: (val: string) => void;
  newPassword: string;
  onNewPasswordChange: (val: string) => void;
  onSave: () => void;
}

/**
 * Dialog used to update key metadata and optionally rotate its encryption
 * password (requires current password to perform rotation).
 */
export function EditKeyDialog({ open, onOpenChange, label, onLabelChange, email, onEmailChange, currentPassword, onCurrentPasswordChange, newPassword, onNewPasswordChange, onSave }: EditKeyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit API Key</DialogTitle>
          <DialogDescription>
            Update key details or change its encryption password
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-label">Label</Label>
            <Input
              id="edit-label"
              value={label}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onLabelChange(e.target.value)}
              placeholder="e.g., Personal Account"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-email">Account Email (optional)</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onEmailChange(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onCurrentPasswordChange(e.target.value)}
              placeholder="Required to change password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password (optional)</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onNewPasswordChange(e.target.value)}
              placeholder="Leave blank to keep current"
            />
          </div>
          <Button onClick={onSave} className="w-full">
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
