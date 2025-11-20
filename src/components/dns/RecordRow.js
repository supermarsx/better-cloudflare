import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * UI component rendering a single DNS record row and optional inline
 * editor allowing update and deletion of the record.
 */
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { RECORD_TYPES, TTL_PRESETS } from '@/types/dns';
import { Edit2, Trash2, Save, X } from 'lucide-react';
/**
 * Render a single DNS record row. When `isEditing` is true the row
 * renders in edit mode with inputs for each editable field; otherwise it
 * displays the record details.
 */
export function RecordRow({ record, isEditing, onEdit, onSave, onCancel, onDelete }) {
    const [editedRecord, setEditedRecord] = useState(record);
    useEffect(() => {
        setEditedRecord(record);
    }, [record]);
    const ttlValue = editedRecord.ttl === 1 ? 'auto' : editedRecord.ttl;
    const isCustomTTL = !TTL_PRESETS.includes(ttlValue);
    if (isEditing) {
        return (_jsx("div", { className: "p-4 border rounded-lg bg-muted/50", children: _jsxs("div", { className: "grid grid-cols-12 gap-4 items-center", children: [_jsx("div", { className: "col-span-2", children: _jsxs(Select, { value: editedRecord.type, onValueChange: (value) => setEditedRecord({
                                ...editedRecord,
                                type: value
                            }), children: [_jsx(SelectTrigger, { className: "h-8", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: RECORD_TYPES.map((type) => (_jsx(SelectItem, { value: type, children: type }, type))) })] }) }), _jsx("div", { className: "col-span-3", children: _jsx(Input, { value: editedRecord.name, onChange: (e) => setEditedRecord({
                                ...editedRecord,
                                name: e.target.value
                            }), className: "h-8" }) }), _jsx("div", { className: "col-span-4", children: _jsx(Input, { value: editedRecord.content, onChange: (e) => setEditedRecord({
                                ...editedRecord,
                                content: e.target.value
                            }), className: "h-8" }) }), _jsxs("div", { className: "col-span-1 space-y-1", children: [_jsxs(Select, { value: isCustomTTL ? 'custom' : String(ttlValue), onValueChange: (value) => {
                                    if (value === 'custom') {
                                        setEditedRecord({ ...editedRecord, ttl: 300 });
                                    }
                                    else {
                                        setEditedRecord({
                                            ...editedRecord,
                                            ttl: value === 'auto' ? 'auto' : Number(value),
                                        });
                                    }
                                }, children: [_jsx(SelectTrigger, { className: "h-8", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [TTL_PRESETS.map((ttl) => (_jsx(SelectItem, { value: String(ttl), children: ttl === 'auto' ? 'Auto' : ttl }, ttl))), _jsx(SelectItem, { value: "custom", children: "Custom" })] })] }), isCustomTTL && (_jsx(Input, { type: "number", value: typeof editedRecord.ttl === 'number' ? editedRecord.ttl : '', onChange: (e) => {
                                    const n = Number.parseInt(e.target.value, 10);
                                    setEditedRecord({
                                        ...editedRecord,
                                        ttl: Number.isNaN(n) ? 300 : n,
                                    });
                                }, className: "h-8" })), editedRecord.type === 'MX' && (_jsx(Input, { type: "number", value: editedRecord.priority ?? '', onChange: (e) => {
                                    const n = Number.parseInt(e.target.value, 10);
                                    setEditedRecord({
                                        ...editedRecord,
                                        priority: Number.isNaN(n) ? undefined : n,
                                    });
                                }, className: "h-8" }))] }), _jsx("div", { className: "col-span-1", children: (editedRecord.type === 'A' || editedRecord.type === 'AAAA' || editedRecord.type === 'CNAME') && (_jsx(Switch, { checked: editedRecord.proxied || false, onCheckedChange: (checked) => setEditedRecord({
                                ...editedRecord,
                                proxied: checked
                            }) })) }), _jsxs("div", { className: "col-span-1 flex gap-1", children: [_jsx(Button, { size: "sm", onClick: () => onSave(editedRecord), className: "h-8 w-8 p-0", children: _jsx(Save, { className: "h-3 w-3" }) }), _jsx(Button, { size: "sm", variant: "outline", onClick: onCancel, className: "h-8 w-8 p-0", children: _jsx(X, { className: "h-3 w-3" }) })] })] }) }));
    }
    return (_jsx("div", { className: "p-4 border rounded-lg hover:bg-muted/50 transition-colors", children: _jsxs("div", { className: "grid grid-cols-12 gap-4 items-center", children: [_jsx("div", { className: "col-span-2", children: _jsx("span", { className: "inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary", children: record.type }) }), _jsx("div", { className: "col-span-3", children: _jsx("span", { className: "font-mono text-sm", children: record.name }) }), _jsx("div", { className: "col-span-4", children: _jsx("span", { className: "font-mono text-sm break-all", children: record.content }) }), _jsx("div", { className: "col-span-1", children: _jsx("span", { className: "text-sm text-muted-foreground", children: record.ttl === 1 ? 'Auto' : record.ttl }) }), _jsx("div", { className: "col-span-1", children: record.proxied && (_jsx("span", { className: "inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200", children: "Proxied" })) }), _jsxs("div", { className: "col-span-1 flex gap-1", children: [_jsx(Button, { size: "sm", variant: "ghost", onClick: onEdit, className: "h-8 w-8 p-0", children: _jsx(Edit2, { className: "h-3 w-3" }) }), _jsx(Button, { size: "sm", variant: "ghost", onClick: onDelete, className: "h-8 w-8 p-0 text-destructive hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] })] }) }));
}
