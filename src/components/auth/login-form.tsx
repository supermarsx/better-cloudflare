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
import type { ApiKey } from '@/types/dns';

/**
 * Props for the login form used on the main page to select and decrypt
 * an API key and authenticate the user.
 */
interface LoginFormProps {
  onLogin: (apiKey: string) => void;
}

/**
 * Login form component responsible for decrypting stored API keys and
 * verifying them with the server. On success the decrypted key is passed
 * via `onLogin` for the parent to use.
 */
export function LoginForm({ onLogin }: LoginFormProps) {
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
  const [benchmarkResult, setBenchmarkResult] = useState<number | null>(null);
  
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
      } catch (err) {
        toast({
          title: "Error",
          description: (err as Error).message,
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
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to login: " + (error as Error).message,
        variant: "destructive"
      });
    } finally {
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
      } catch (err) {
        toast({
          title: "Error",
          description: (err as Error).message,
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
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to add API key: " + (error as Error).message,
        variant: "destructive"
      });
    }
  };

  const handleEditKeyInit = (key: ApiKey) => {
    setEditingKeyId(key.id);
    setEditLabel(key.label);
    setEditEmail(key.email || '');
    setCurrentPassword('');
    setEditPassword('');
    setShowEditKey(true);
  };

  const handleUpdateKey = async () => {
    if (!editingKeyId) return;
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
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to update API key: ' + (error as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleDeleteKey = (keyId: string) => {
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
    } catch (error) {
      toast({
        title: "Error",
        description: "Benchmark failed: " + (error as Error).message,
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-primary/10 rounded-full">
              <Key className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">Cloudflare DNS Manager</CardTitle>
          <CardDescription>
            Select your API key and enter your password to continue
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api-key">API Key</Label>
            <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an API key" />
              </SelectTrigger>
              <SelectContent>
                {apiKeys.map((key) => (
                  <SelectItem key={key.id} value={key.id}>
                    <div className="flex items-center justify-between w-full">
                      <span>{key.label}</span>
                      <div className="flex">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditKeyInit(key);
                          }}
                          className="h-6 w-6 p-0 ml-2"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteKey(key.id);
                          }}
                          className="h-6 w-6 p-0 ml-2"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            />
          </div>

          <Button 
            onClick={handleLogin} 
            className="w-full" 
            disabled={isLoading || !selectedKeyId || !password}
          >
            {isLoading ? 'Logging in...' : 'Login'}
          </Button>

          <div className="flex gap-2">
          <AddKeyDialog
            open={showAddKey}
            onOpenChange={setShowAddKey}
            label={newKeyLabel}
            onLabelChange={setNewKeyLabel}
            apiKey={newApiKey}
            onApiKeyChange={setNewApiKey}
            email={newEmail}
            onEmailChange={setNewEmail}
            password={newPassword}
            onPasswordChange={setNewPassword}
            onAdd={handleAddKey}
          />

            <EncryptionSettingsDialog
              open={showSettings}
              onOpenChange={setShowSettings}
              settings={encryptionSettings}
              onSettingsChange={setEncryptionSettings}
              onBenchmark={handleBenchmark}
              onUpdate={handleUpdateSettings}
              benchmarkResult={benchmarkResult}
            />
          </div>
          <EditKeyDialog
            open={showEditKey}
            onOpenChange={setShowEditKey}
            label={editLabel}
            onLabelChange={setEditLabel}
            email={editEmail}
            onEmailChange={setEditEmail}
            currentPassword={currentPassword}
            onCurrentPasswordChange={setCurrentPassword}
            newPassword={editPassword}
            onNewPasswordChange={setEditPassword}
            onSave={handleUpdateKey}
          />
        </CardContent>
      </Card>
    </div>
  );
}
