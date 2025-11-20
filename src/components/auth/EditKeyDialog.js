import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
/**
 * Dialog used to update key metadata and optionally rotate its encryption
 * password (requires current password to perform rotation).
 */
export function EditKeyDialog({ open, onOpenChange, label, onLabelChange, email, onEmailChange, currentPassword, onCurrentPasswordChange, newPassword, onNewPasswordChange, onSave }) {
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Edit API Key" }), _jsx(DialogDescription, { children: "Update key details or change its encryption password" })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "edit-label", children: "Label" }), _jsx(Input, { id: "edit-label", value: label, onChange: (e) => onLabelChange(e.target.value), placeholder: "e.g., Personal Account" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "edit-email", children: "Account Email (optional)" }), _jsx(Input, { id: "edit-email", type: "email", value: email, onChange: (e) => onEmailChange(e.target.value), placeholder: "you@example.com" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "current-password", children: "Current Password" }), _jsx(Input, { id: "current-password", type: "password", value: currentPassword, onChange: (e) => onCurrentPasswordChange(e.target.value), placeholder: "Required to change password" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "new-password", children: "New Password (optional)" }), _jsx(Input, { id: "new-password", type: "password", value: newPassword, onChange: (e) => onNewPasswordChange(e.target.value), placeholder: "Leave blank to keep current" })] }), _jsx(Button, { onClick: onSave, className: "w-full", children: "Save Changes" })] })] }) }));
}
