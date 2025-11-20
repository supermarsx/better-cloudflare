import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ENCRYPTION_ALGORITHMS, } from '../../types/dns';
import { Settings } from 'lucide-react';
/**
 * Dialog to configure encryption settings and run a benchmark to estimate
 * the PBKDF2 cost for the currently selected iteration count.
 */
export function EncryptionSettingsDialog({ open, onOpenChange, settings, onSettingsChange, onBenchmark, onUpdate, benchmarkResult }) {
    return (_jsxs(Dialog, { open: open, onOpenChange: onOpenChange, children: [_jsx(DialogTrigger, { asChild: true, children: _jsx(Button, { variant: "outline", size: "icon", children: _jsx(Settings, { className: "h-4 w-4" }) }) }), _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Encryption Settings" }), _jsx(DialogDescription, { children: "Configure encryption parameters for security and performance" })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "iterations", children: "PBKDF2 Iterations" }), _jsx(Input, { id: "iterations", type: "number", value: settings.iterations, onChange: (e) => {
                                            const n = Number.parseInt(e.target.value, 10);
                                            onSettingsChange({
                                                ...settings,
                                                iterations: Number.isNaN(n) ? 100000 : n
                                            });
                                        } })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "key-length", children: "Key Length (bits)" }), _jsxs(Select, { value: settings.keyLength.toString(), onValueChange: (value) => onSettingsChange({ ...settings, keyLength: parseInt(value) }), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "128", children: "128" }), _jsx(SelectItem, { value: "192", children: "192" }), _jsx(SelectItem, { value: "256", children: "256" })] })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "algorithm", children: "Algorithm" }), _jsxs(Select, { value: settings.algorithm, onValueChange: (value) => onSettingsChange({ ...settings, algorithm: value }), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: ENCRYPTION_ALGORITHMS.map((alg) => (_jsx(SelectItem, { value: alg, children: alg }, alg))) })] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: onBenchmark, variant: "outline", className: "flex-1", children: "Benchmark" }), _jsx(Button, { onClick: onUpdate, className: "flex-1", children: "Update" })] }), benchmarkResult !== null && (_jsxs("p", { className: "text-sm text-muted-foreground", children: ["Last benchmark: ", benchmarkResult.toFixed(2), "ms"] }))] })] })] }));
}
