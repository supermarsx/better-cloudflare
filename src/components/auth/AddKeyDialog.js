import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
/**
 * Render a dialog to add a new API key. The dialog collects a label, the
 * API key, (optionally) an associated email and an encryption password.
 */
export function AddKeyDialog({ open, onOpenChange, label, onLabelChange, apiKey, onApiKeyChange, email, onEmailChange, password, onPasswordChange, onAdd }) {
    return (_jsxs(Dialog, { open: open, onOpenChange: onOpenChange, children: [_jsx(DialogTrigger, { asChild: true, children: _jsxs(Button, { variant: "outline", className: "flex-1", children: [_jsx(Plus, { className: "h-4 w-4 mr-2" }), "Add Key"] }) }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add New API Key" }), _jsx(DialogDescription, { children: "Add a new Cloudflare API key with a custom label" })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "new-label", children: "Label" }), _jsx(Input, { id: "new-label", value: label, onChange: (e) => onLabelChange(e.target.value), placeholder: "e.g., Personal Account" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "new-api-key", children: "API Key" }), _jsx(Input, { id: "new-api-key", type: "password", value: apiKey, onChange: (e) => onApiKeyChange(e.target.value), placeholder: "Your Cloudflare API key" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "new-email", children: "Account Email (optional for global keys)" }), _jsx(Input, { id: "new-email", type: "email", value: email, onChange: (e) => onEmailChange(e.target.value), placeholder: "you@example.com" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "new-password", children: "Encryption Password" }), _jsx(Input, { id: "new-password", type: "password", value: password, onChange: (e) => onPasswordChange(e.target.value), placeholder: "Password to encrypt this key" })] }), _jsx(Button, { onClick: onAdd, className: "w-full", children: "Add API Key" })] })] })] }));
}
