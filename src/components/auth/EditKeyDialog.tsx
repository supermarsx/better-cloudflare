/**
 * Modal dialog to edit metadata for an existing encrypted API key and to
 * optionally rotate its encryption password.
 */
import type { ChangeEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";

/**
 * Props for the EditKeyDialog allowing label/email changes and password
 * rotations for an API key.
 */
export interface EditKeyDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Callback for open state changes */
  onOpenChange: (open: boolean) => void;
  /** Key label */
  label: string;
  /** Label change callback */
  onLabelChange: (val: string) => void;
  /** Optional account email */
  email: string;
  /** Email change callback */
  onEmailChange: (val: string) => void;
  /** Current password required to rotate encryption */
  currentPassword: string;
  /** Current password change callback */
  onCurrentPasswordChange: (val: string) => void;
  /** New password for rotation (optional) */
  newPassword: string;
  /** New password change callback */
  onNewPasswordChange: (val: string) => void;
  /** Callback invoked to save updates */
  onSave: () => void;
}

/**
 * Dialog used to update key metadata and optionally rotate its encryption
 * password (requires current password to perform rotation).
 */
export function EditKeyDialog({
  open,
  onOpenChange,
  label,
  onLabelChange,
  email,
  onEmailChange,
  currentPassword,
  onCurrentPasswordChange,
  newPassword,
  onNewPasswordChange,
  onSave,
}: EditKeyDialogProps) {
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
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onLabelChange(e.target.value)
              }
              placeholder="e.g., Personal Account"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-email">Account Email (optional)</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onEmailChange(e.target.value)
              }
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onCurrentPasswordChange(e.target.value)
              }
              placeholder="Required to change password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password (optional)</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onNewPasswordChange(e.target.value)
              }
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
