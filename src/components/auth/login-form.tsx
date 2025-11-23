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
import { storageBackend } from '@/lib/storage-util';
import { useTranslation } from 'react-i18next';
import { Key, Trash2, Pencil } from 'lucide-react';
import { cryptoManager } from '@/lib/crypto';
import { AddKeyDialog } from './AddKeyDialog';
import PasskeyManagerDialog from './PasskeyManagerDialog';
import { ServerClient } from '@/lib/server-client';
import { EncryptionSettingsDialog } from './EncryptionSettingsDialog';
import { EditKeyDialog } from './EditKeyDialog';
import type { ApiKey } from '@/types/dns';

/**
 * Props for the login form used on the main page to select and decrypt
 * an API key and authenticate the user.
 */
interface LoginFormProps {
  /** Callback invoked on successful login with the decrypted apiKey */
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
  const [passkeyRegisterLoading, setPasskeyRegisterLoading] = useState(false);
  const [passkeyAuthLoading, setPasskeyAuthLoading] = useState(false);
  const [showManagePasskeys, setShowManagePasskeys] = useState(false);
  const [passkeyViewKey, setPasskeyViewKey] = useState('');
  const [passkeyViewEmail, setPasskeyViewEmail] = useState<string | undefined>(undefined);
  
  const { toast } = useToast();
  const { verifyToken } = useCloudflareAPI();
  const [apiKeys, setApiKeys] = useState(storageManager.getApiKeys());
  const backend = storageBackend();
  const { t } = useTranslation();
  useEffect(() => {
    if (backend !== 'indexeddb') {
      toast({
        title: t('Note'),
        description: `Using ${backend} storage. IndexedDB not available or in use. Some features may be limited.`,
      });
    }
  }, [backend, toast, t]);

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

  const handleRegisterPasskey = async () => {
    if (!selectedKeyId) {
      toast({ title: 'Error', description: 'Select a key before registering a passkey', variant: 'destructive' });
      return;
    }

    if (!password) {
      toast({ title: 'Error', description: 'Enter your password to decrypt the key for registration', variant: 'destructive' });
      return;
    }

    setPasskeyRegisterLoading(true);
    try {
      const decrypted = await storageManager.getDecryptedApiKey(selectedKeyId, password);
      if (!decrypted?.key) {
        toast({ title: 'Error', description: 'Invalid password or corrupted key', variant: 'destructive' });
        return;
      }

      try {
        const sc = new ServerClient(decrypted.key, undefined, decrypted.email);
        await sc.storeVaultSecret(selectedKeyId, decrypted.key);
      } catch (err) {
        toast({ title: 'Warning', description: 'Failed to store key to OS vault: ' + (err as Error).message });
      }
      const sc2 = new ServerClient(decrypted.key, undefined, decrypted.email);
      const options = await sc2.getPasskeyRegistrationOptions(selectedKeyId);
      const challenge = Uint8Array.from(atob(options.challenge), c => c.charCodeAt(0));
      const publicKey = {
        challenge,
        rp: { name: 'Better Cloudflare' },
        user: { id: Uint8Array.from(new TextEncoder().encode(selectedKeyId)), name: selectedKeyId, displayName: selectedKeyId },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      } as PublicKeyCredentialCreationOptions;
      const credential = await navigator.credentials.create({ publicKey });
      if (credential) {
        const att = credential as PublicKeyCredential;
        const attObj = {
          id: att.id,
          rawId: Array.from(new Uint8Array(att.rawId)),
          response: {
            clientDataJSON: Array.from(new Uint8Array(att.response.clientDataJSON)),
            attestationObject: Array.from(new Uint8Array((att.response as AuthenticatorAttestationResponse).attestationObject || new ArrayBuffer(0))),
          },
        };
        await sc2.registerPasskey(selectedKeyId, attObj);
        toast({ title: 'Success', description: 'Passkey registered to this key' });
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Passkey registration failed: ' + (error as Error).message, variant: 'destructive' });
    } finally {
      setPasskeyRegisterLoading(false);
    }
  };

  const handleUsePasskey = async () => {
    if (!selectedKeyId) {
      toast({ title: 'Error', description: 'Select a key to authenticate', variant: 'destructive' });
      return;
    }
    setPasskeyAuthLoading(true);
    try {
      const scx = new ServerClient('', undefined);
      const opts = await scx.getPasskeyAuthOptions(selectedKeyId);
      const challenge = Uint8Array.from(atob(opts.challenge), c => c.charCodeAt(0));
      const publicKey = {
        challenge,
        allowCredentials: [],
      } as PublicKeyCredentialRequestOptions;
      const assertion = await navigator.credentials.get({ publicKey });
      if (assertion) {
        const a = assertion as PublicKeyCredential;
        const auth = {
          id: a.id,
          rawId: Array.from(new Uint8Array(a.rawId)),
          response: {
            clientDataJSON: Array.from(new Uint8Array(a.response.clientDataJSON)),
            authenticatorData: Array.from(new Uint8Array((a.response as AuthenticatorAssertionResponse).authenticatorData || new ArrayBuffer(0))),
            signature: Array.from(new Uint8Array((a.response as AuthenticatorAssertionResponse).signature || new ArrayBuffer(0))),
            userHandle: (a.response as AuthenticatorAssertionResponse).userHandle ? Array.from(new Uint8Array((a.response as AuthenticatorAssertionResponse).userHandle)) : null,
          },
        };
        const serverResp = await scx.authenticatePasskey(selectedKeyId, auth);
        if ((serverResp as unknown as { success?: boolean }).success) {
          const secret = await scx.getVaultSecret(selectedKeyId);
          if (secret) {
            storageManager.setCurrentSession(selectedKeyId);
            onLogin(secret);
            toast({ title: 'Success', description: 'Logged in using passkey' });
          } else {
            toast({ title: 'Error', description: 'No secret in vault for this key', variant: 'destructive' });
          }
        } else {
          toast({ title: 'Error', description: 'Passkey authentication failed', variant: 'destructive' });
        }
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Passkey auth failed: ' + (error as Error).message, variant: 'destructive' });
    } finally {
      setPasskeyAuthLoading(false);
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
      const { benchmark } = await import('@/lib/crypto-benchmark');
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

  const [vaultEnabled, setVaultEnabled] = useState(storageManager.getVaultEnabled());

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-primary/10 rounded-full">
              <Key className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">{t('Cloudflare DNS Manager')}</CardTitle>
          <CardDescription>
            {t('Select your API key and enter your password to continue')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api-key">{t('API Key')}</Label>
            <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
              <SelectTrigger>
              <SelectValue placeholder={t('Select an API key')} />
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
              <Label htmlFor="password">{t('Password')}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('Enter your password')}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            />
          </div>

          <Button 
            onClick={handleLogin} 
            className="w-full" 
            disabled={isLoading || !selectedKeyId || !password}
          >
            {isLoading ? t('Logging in...') : t('Login')}
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
              vaultEnabled={vaultEnabled}
              onVaultEnabledChange={(enabled: boolean) => {
                setVaultEnabled(enabled);
                storageManager.setVaultEnabled(enabled);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegisterPasskey}
              disabled={!selectedKeyId || !password || passkeyRegisterLoading}
            >
              {passkeyRegisterLoading ? 'Registering...' : 'Register Passkey'}
            </Button>
            <PasskeyManagerDialog
              open={showManagePasskeys}
              onOpenChange={(open: boolean) => {
                if (!open) {
                  setShowManagePasskeys(false);
                  setPasskeyViewKey('');
                  setPasskeyViewEmail(undefined);
                } else {
                  setShowManagePasskeys(true);
                }
              }}
              id={selectedKeyId}
              apiKey={passkeyViewKey}
              email={passkeyViewEmail}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!selectedKeyId || !password) return;
                try {
                  const decrypted = await storageManager.getDecryptedApiKey(selectedKeyId, password);
                  if (!decrypted?.key) {
                    toast({ title: 'Error', description: 'Invalid password', variant: 'destructive' });
                    return;
                  }
                  setPasskeyViewKey(decrypted.key);
                  setPasskeyViewEmail(decrypted.email);
                  setShowManagePasskeys(true);
                } catch (err) {
                  toast({ title: 'Error', description: 'Failed to decrypt key: ' + (err as Error).message, variant: 'destructive' });
                }
              }}
              disabled={!selectedKeyId || !password}
            >
              Manage Passkeys
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleUsePasskey}
              disabled={!selectedKeyId || passkeyAuthLoading}
            >
              {passkeyAuthLoading ? 'Authenticating...' : 'Use Passkey'}
            </Button>
            {vaultEnabled && (
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  if (!selectedKeyId || !password) {
                    toast({ title: t('Error'), description: t('Select key and enter password to delete vault secret'), variant: 'destructive' });
                    return;
                  }
                  try {
                    const dec = await storageManager.getDecryptedApiKey(selectedKeyId, password);
                    if (!dec?.key) {
                      toast({ title: t('Error'), description: t('Invalid password'), variant: 'destructive' });
                      return;
                    }
                    const sc = new ServerClient(dec.key, undefined, dec.email);
                    await sc.deleteVaultSecret(selectedKeyId);
                    toast({ title: t('Success'), description: t('Vault secret removed') });
                  } catch (err) {
                    toast({ title: t('Error'), description: t('Failed to remove vault secret: ') + (err as Error).message, variant: 'destructive' });
                  }
                }}
              >
                Remove Vault Secret
              </Button>
            )}
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
