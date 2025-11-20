import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Upload } from 'lucide-react';
/**
 * Component rendering an Import dialog that accepts JSON payload for DNS
 * records and invokes `onImport` when the user accepts.
 */
export function ImportRecordsDialog({ open, onOpenChange, data, onDataChange, onImport }) {
    return (_jsxs(Dialog, { open: open, onOpenChange: onOpenChange, children: [_jsx(DialogTrigger, { asChild: true, children: _jsxs(Button, { variant: "outline", size: "sm", children: [_jsx(Upload, { className: "h-4 w-4 mr-2" }), "Import"] }) }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Import DNS Records" }), _jsx(DialogDescription, { children: "Import DNS records from JSON format" })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "JSON Data" }), _jsx("textarea", { className: "w-full h-32 p-2 border rounded-md bg-background", value: data, onChange: (e) => onDataChange(e.target.value), placeholder: "Paste your JSON data here..." })] }), _jsx(Button, { onClick: onImport, className: "w-full", children: "Import Records" })] })] })] }));
}
