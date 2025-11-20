import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { RECORD_TYPES, TTL_PRESETS } from '@/types/dns';
import { Plus } from 'lucide-react';
/**
 * Dialog that collects fields to create a DNS record and forwards the
 * create action via `onAdd`.
 */
export function AddRecordDialog({ open, onOpenChange, record, onRecordChange, onAdd, zoneName }) {
    const ttlValue = record.ttl === 1 ? 'auto' : record.ttl;
    const isCustomTTL = ttlValue !== undefined && !TTL_PRESETS.includes(ttlValue);
    return (_jsxs(Dialog, { open: open, onOpenChange: onOpenChange, children: [_jsx(DialogTrigger, { asChild: true, children: _jsxs(Button, { children: [_jsx(Plus, { className: "h-4 w-4 mr-2" }), "Add Record"] }) }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add DNS Record" }), _jsxs(DialogDescription, { children: ["Create a new DNS record for ", zoneName] })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Type" }), _jsxs(Select, { value: record.type, onValueChange: (value) => onRecordChange({
                                                    ...record,
                                                    type: value,
                                                    priority: value === 'MX' ? record.priority : undefined
                                                }), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: RECORD_TYPES.map((type) => (_jsx(SelectItem, { value: type, children: type }, type))) })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "TTL" }), _jsxs(Select, { value: isCustomTTL ? 'custom' : String(ttlValue), onValueChange: (value) => {
                                                    if (value === 'custom') {
                                                        onRecordChange({ ...record, ttl: 300 });
                                                    }
                                                    else {
                                                        onRecordChange({
                                                            ...record,
                                                            ttl: value === 'auto' ? 'auto' : Number(value)
                                                        });
                                                    }
                                                }, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [TTL_PRESETS.map((ttl) => (_jsx(SelectItem, { value: String(ttl), children: ttl === 'auto' ? 'Auto' : ttl }, ttl))), _jsx(SelectItem, { value: "custom", children: "Custom" })] })] }), isCustomTTL && (_jsx(Input, { type: "number", value: typeof record.ttl === 'number' ? record.ttl : '', onChange: (e) => {
                                                    const n = Number.parseInt(e.target.value, 10);
                                                    onRecordChange({
                                                        ...record,
                                                        ttl: Number.isNaN(n) ? 300 : n
                                                    });
                                                } }))] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { value: record.name, onChange: (e) => onRecordChange({
                                            ...record,
                                            name: e.target.value
                                        }), placeholder: "e.g., www or @ for root" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Content" }), _jsx(Input, { value: record.content, onChange: (e) => onRecordChange({
                                            ...record,
                                            content: e.target.value
                                        }), placeholder: "e.g., 192.168.1.1" })] }), record.type === 'MX' && (_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { children: "Priority" }), _jsx(Input, { type: "number", value: record.priority || '', onChange: (e) => {
                                            const n = Number.parseInt(e.target.value, 10);
                                            onRecordChange({
                                                ...record,
                                                priority: Number.isNaN(n) ? undefined : n
                                            });
                                        } })] })), (record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME') && (_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Switch, { checked: record.proxied || false, onCheckedChange: (checked) => onRecordChange({
                                            ...record,
                                            proxied: checked
                                        }) }), _jsx(Label, { children: "Proxied through Cloudflare" })] })), _jsx(Button, { onClick: onAdd, className: "w-full", children: "Create Record" })] })] })] }));
}
