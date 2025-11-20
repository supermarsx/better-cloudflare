import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Login / Key selection UI used to open a session by decrypting a stored
 * API key and verifying it with the server.
 */
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { storageManager } from '@/lib/storage';
import { useCloudflareAPI } from '@/hooks/use-cloudflare-api';
import { useToast } from '@/hooks/use-toast';
import { Key, Trash2, Pencil } from 'lucide-react';
import { cryptoManager } from '@/lib/crypto';
import { AddKeyDialog } from './AddKeyDialog';
import { EncryptionSettingsDialog } from './EncryptionSettingsDialog';
import { EditKeyDialog } from './EditKeyDialog';
/**
 * Login form component responsible for decrypting stored API keys and
 * verifying them with the server. On success the decrypted key is passed
 * via `onLogin` for the parent to use.
 */
export function LoginForm({ onLogin }) {
    const [selectedKeyId, setSelectedKeyId] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [showAddKey, setShowAddKey] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [newKeyLabel, setNewKeyLabel] = useState('');
    const [newApiKey, setNewApiKey] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [showEditKey, setShowEditKey] = useState(false);
    const [editingKeyId, setEditingKeyId] = useState('');
    const [editLabel, setEditLabel] = useState('');
    const [editEmail, setEditEmail] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [editPassword, setEditPassword] = useState('');
    const [encryptionSettings, setEncryptionSettings] = useState(cryptoManager.getConfig());
    const [benchmarkResult, setBenchmarkResult] = useState(null);
    const { toast } = useToast();
    const { verifyToken } = useCloudflareAPI();
    const [apiKeys, setApiKeys] = useState(storageManager.getApiKeys());
    useEffect(() => {
        cryptoManager.reloadConfig();
        setEncryptionSettings(cryptoManager.getConfig());
    }, []);
    const handleLogin = async () => {
        if (!selectedKeyId || !password) {
            toast({
                title: "Error",
                description: "Please select an API key and enter your password",
                variant: "destructive"
            });
            return;
        }
        setIsLoading(true);
        try {
            const decrypted = await storageManager.getDecryptedApiKey(selectedKeyId, password);
            const decryptedKey = decrypted?.key;
            const email = decrypted?.email;
            if (!decryptedKey) {
                toast({
                    title: "Error",
                    description: "Invalid password or corrupted key",
                    variant: "destructive"
                });
                return;
            }
            // Verify the API key works
            try {
                await verifyToken(decryptedKey, email);
            }
            catch (err) {
                toast({
                    title: "Error",
                    description: err.message,
                    variant: "destructive"
                });
                return;
            }
            storageManager.setCurrentSession(selectedKeyId);
            onLogin(decryptedKey);
            toast({
                title: "Success",
                description: "Logged in successfully"
            });
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to login: " + error.message,
                variant: "destructive"
            });
        }
        finally {
            setIsLoading(false);
        }
    };
    const handleAddKey = async () => {
        if (!newKeyLabel || !newApiKey || !newPassword) {
            toast({
                title: "Error",
                description: "Please fill in all fields",
                variant: "destructive"
            });
            return;
        }
        try {
            // Test the API key first
            try {
                await verifyToken(newApiKey, newEmail || undefined);
            }
            catch (err) {
                toast({
                    title: "Error",
                    description: err.message,
                    variant: "destructive"
                });
                return;
            }
            await storageManager.addApiKey(newKeyLabel, newApiKey, newPassword, newEmail || undefined);
            setApiKeys(storageManager.getApiKeys());
            setNewKeyLabel('');
            setNewApiKey('');
            setNewEmail('');
            setNewPassword('');
            setShowAddKey(false);
            toast({
                title: "Success",
                description: "API key added successfully"
            });
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Failed to add API key: " + error.message,
                variant: "destructive"
            });
        }
    };
    const handleEditKeyInit = (key) => {
        setEditingKeyId(key.id);
        setEditLabel(key.label);
        setEditEmail(key.email || '');
        setCurrentPassword('');
        setEditPassword('');
        setShowEditKey(true);
    };
    const handleUpdateKey = async () => {
        if (!editingKeyId)
            return;
        try {
            await storageManager.updateApiKey(editingKeyId, {
                label: editLabel,
                email: editEmail || undefined,
                currentPassword: currentPassword || undefined,
                newPassword: editPassword || undefined,
            });
            setApiKeys(storageManager.getApiKeys());
            setShowEditKey(false);
            toast({
                title: 'Success',
                description: 'API key updated successfully',
            });
        }
        catch (error) {
            toast({
                title: 'Error',
                description: 'Failed to update API key: ' + error.message,
                variant: 'destructive',
            });
        }
    };
    const handleDeleteKey = (keyId) => {
        storageManager.removeApiKey(keyId);
        setApiKeys(storageManager.getApiKeys());
        if (selectedKeyId === keyId) {
            setSelectedKeyId('');
        }
        toast({
            title: "Success",
            description: "API key deleted"
        });
    };
    const handleBenchmark = async () => {
        try {
            const { benchmark } = await import('@/lib/crypto-benchmark.ts');
            const result = await benchmark(encryptionSettings.iterations);
            setBenchmarkResult(result);
            toast({
                title: "Benchmark Complete",
                description: `Encryption took ${result.toFixed(2)}ms`
            });
        }
        catch (error) {
            toast({
                title: "Error",
                description: "Benchmark failed: " + error.message,
                variant: "destructive"
            });
        }
    };
    const handleUpdateSettings = () => {
        cryptoManager.updateConfig(encryptionSettings);
        toast({
            title: "Success",
            description: "Encryption settings updated"
        });
        setShowSettings(false);
    };
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-background p-4", children: _jsxs(Card, { className: "w-full max-w-md", children: [_jsxs(CardHeader, { className: "text-center", children: [_jsx("div", { className: "flex justify-center mb-4", children: _jsx("div", { className: "p-3 bg-primary/10 rounded-full", children: _jsx(Key, { className: "h-8 w-8 text-primary" }) }) }), _jsx(CardTitle, { className: "text-2xl", children: "Cloudflare DNS Manager" }), _jsx(CardDescription, { children: "Select your API key and enter your password to continue" })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "api-key", children: "API Key" }), _jsxs(Select, { value: selectedKeyId, onValueChange: setSelectedKeyId, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Select an API key" }) }), _jsx(SelectContent, { children: apiKeys.map((key) => (_jsx(SelectItem, { value: key.id, children: _jsxs("div", { className: "flex items-center justify-between w-full", children: [_jsx("span", { children: key.label }), _jsxs("div", { className: "flex", children: [_jsx(Button, { variant: "ghost", size: "sm", onClick: (e) => {
                                                                        e.stopPropagation();
                                                                        handleEditKeyInit(key);
                                                                    }, className: "h-6 w-6 p-0 ml-2", children: _jsx(Pencil, { className: "h-3 w-3" }) }), _jsx(Button, { variant: "ghost", size: "sm", onClick: (e) => {
                                                                        e.stopPropagation();
                                                                        handleDeleteKey(key.id);
                                                                    }, className: "h-6 w-6 p-0 ml-2", children: _jsx(Trash2, { className: "h-3 w-3" }) })] })] }) }, key.id))) })] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "password", children: "Password" }), _jsx(Input, { id: "password", type: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "Enter your password", onKeyDown: (e) => e.key === 'Enter' && handleLogin() })] }), _jsx(Button, { onClick: handleLogin, className: "w-full", disabled: isLoading || !selectedKeyId || !password, children: isLoading ? 'Logging in...' : 'Login' }), _jsxs("div", { className: "flex gap-2", children: [_jsx(AddKeyDialog, { open: showAddKey, onOpenChange: setShowAddKey, label: newKeyLabel, onLabelChange: setNewKeyLabel, apiKey: newApiKey, onApiKeyChange: setNewApiKey, email: newEmail, onEmailChange: setNewEmail, password: newPassword, onPasswordChange: setNewPassword, onAdd: handleAddKey }), _jsx(EncryptionSettingsDialog, { open: showSettings, onOpenChange: setShowSettings, settings: encryptionSettings, onSettingsChange: setEncryptionSettings, onBenchmark: handleBenchmark, onUpdate: handleUpdateSettings, benchmarkResult: benchmarkResult })] }), _jsx(EditKeyDialog, { open: showEditKey, onOpenChange: setShowEditKey, label: editLabel, onLabelChange: setEditLabel, email: editEmail, onEmailChange: setEditEmail, currentPassword: currentPassword, onCurrentPasswordChange: setCurrentPassword, newPassword: editPassword, onNewPasswordChange: setEditPassword, onSave: handleUpdateKey })] })] }) }));
}
