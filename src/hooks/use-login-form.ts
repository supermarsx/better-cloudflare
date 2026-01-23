import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { storageManager } from "@/lib/storage";
import { useCloudflareAPI } from "@/hooks/use-cloudflare-api";
import { storageBackend } from "@/lib/storage-util";
import { useTranslation } from "react-i18next";
import { cryptoManager } from "@/lib/crypto";
import { ServerClient } from "@/lib/server-client";
import type { ApiKey } from "@/types/dns";

export function useLoginForm(
  onLogin: (apiKey: string, email?: string) => void | Promise<void>,
) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { verifyToken } = useCloudflareAPI();
  const [apiKeys, setApiKeys] = useState(storageManager.getApiKeys());
  const backend = storageBackend();

  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showAddKey, setShowAddKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showEditKey, setShowEditKey] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [encryptionSettings, setEncryptionSettings] = useState(
    cryptoManager.getConfig(),
  );
  const [benchmarkResult, setBenchmarkResult] = useState<number | null>(null);
  const [passkeyRegisterLoading, setPasskeyRegisterLoading] = useState(false);
  const [passkeyAuthLoading, setPasskeyAuthLoading] = useState(false);
  const [showManagePasskeys, setShowManagePasskeys] = useState(false);
  const [passkeyViewKey, setPasskeyViewKey] = useState("");
  const [passkeyViewEmail, setPasskeyViewEmail] = useState<string | undefined>(
    undefined,
  );
  const [vaultEnabled, setVaultEnabled] = useState(
    storageManager.getVaultEnabled(),
  );

  useEffect(() => {
    if (backend !== "indexeddb") {
      toast({
        title: t("Note"),
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
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const decrypted = await storageManager.getDecryptedApiKey(
        selectedKeyId,
        password,
      );
      const decryptedKey = decrypted?.key;
      const email = decrypted?.email;
      if (!decryptedKey) {
        toast({
          title: "Error",
          description: "Invalid password or corrupted key",
          variant: "destructive",
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
          variant: "destructive",
        });
        return;
      }

      storageManager.setCurrentSession(selectedKeyId);
      onLogin(decryptedKey, email);

      toast({
        title: "Success",
        description: "Logged in successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to login: " + (error as Error).message,
        variant: "destructive",
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
        variant: "destructive",
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
          variant: "destructive",
        });
        return;
      }

      await storageManager.addApiKey(
        newKeyLabel,
        newApiKey,
        newPassword,
        newEmail || undefined,
      );
      setApiKeys(storageManager.getApiKeys());
      setNewKeyLabel("");
      setNewApiKey("");
      setNewEmail("");
      setNewPassword("");
      setShowAddKey(false);

      toast({
        title: "Success",
        description: "API key added successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to add API key: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleRegisterPasskey = async () => {
    if (!selectedKeyId) {
      toast({
        title: "Error",
        description: "Select a key before registering a passkey",
        variant: "destructive",
      });
      return;
    }

    if (!password) {
      toast({
        title: "Error",
        description: "Enter your password to decrypt the key for registration",
        variant: "destructive",
      });
      return;
    }

    setPasskeyRegisterLoading(true);
    try {
      const decrypted = await storageManager.getDecryptedApiKey(
        selectedKeyId,
        password,
      );
      if (!decrypted?.key) {
        toast({
          title: "Error",
          description: "Invalid password or corrupted key",
          variant: "destructive",
        });
        return;
      }

      try {
        const sc = new ServerClient(decrypted.key, undefined, decrypted.email);
        await sc.storeVaultSecret(selectedKeyId, decrypted.key);
      } catch (err) {
        toast({
          title: "Warning",
          description:
            "Failed to store key to OS vault: " + (err as Error).message,
        });
      }
      const sc2 = new ServerClient(decrypted.key, undefined, decrypted.email);
      const options = await sc2.getPasskeyRegistrationOptions(selectedKeyId);
      const challenge = Uint8Array.from(atob(options.challenge), (c) =>
        c.charCodeAt(0),
      );
      const publicKey = {
        challenge,
        rp: { name: "Better Cloudflare" },
        user: {
          id: Uint8Array.from(new TextEncoder().encode(selectedKeyId)),
          name: selectedKeyId,
          displayName: selectedKeyId,
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      } as PublicKeyCredentialCreationOptions;
      const credential = await navigator.credentials.create({ publicKey });
      if (credential) {
        const att = credential as PublicKeyCredential;
        const attObj = {
          id: att.id,
          rawId: Array.from(new Uint8Array(att.rawId)),
          response: {
            clientDataJSON: Array.from(
              new Uint8Array(att.response.clientDataJSON),
            ),
            attestationObject: Array.from(
              new Uint8Array(
                (att.response as AuthenticatorAttestationResponse)
                  .attestationObject || new ArrayBuffer(0),
              ),
            ),
          },
        };
        await sc2.registerPasskey(selectedKeyId, attObj);
        toast({
          title: "Success",
          description: "Passkey registered to this key",
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Passkey registration failed: " + (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setPasskeyRegisterLoading(false);
    }
  };

  const handleUsePasskey = async () => {
    if (!selectedKeyId) {
      toast({
        title: "Error",
        description: "Select a key to authenticate",
        variant: "destructive",
      });
      return;
    }
    setPasskeyAuthLoading(true);
    try {
      const scx = new ServerClient("", undefined);
      const opts = await scx.getPasskeyAuthOptions(selectedKeyId);
      const challenge = Uint8Array.from(atob(opts.challenge), (c) =>
        c.charCodeAt(0),
      );
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
            clientDataJSON: Array.from(
              new Uint8Array(a.response.clientDataJSON),
            ),
            authenticatorData: Array.from(
              new Uint8Array(
                (a.response as AuthenticatorAssertionResponse)
                  .authenticatorData || new ArrayBuffer(0),
              ),
            ),
            signature: Array.from(
              new Uint8Array(
                (a.response as AuthenticatorAssertionResponse).signature ||
                  new ArrayBuffer(0),
              ),
            ),
            userHandle: (a.response as AuthenticatorAssertionResponse)
              .userHandle
              ? Array.from(
                  new Uint8Array(
                    (a.response as AuthenticatorAssertionResponse).userHandle as ArrayBuffer,
                  ),
                )
              : null,
          },
        };
        const serverResp = await scx.authenticatePasskey(selectedKeyId, auth);
        if (serverResp?.success) {
          const secret = await scx.getVaultSecret(
            selectedKeyId,
            serverResp.token,
          );
          if (secret) {
            storageManager.setCurrentSession(selectedKeyId);
            onLogin(secret);
            toast({ title: "Success", description: "Logged in using passkey" });
          } else {
            toast({
              title: "Error",
              description: "No secret in vault for this key",
              variant: "destructive",
              });
          }
        } else {
          toast({
            title: "Error",
            description: "Passkey authentication failed",
            variant: "destructive",
          });
        }
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Passkey auth failed: " + (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setPasskeyAuthLoading(false);
    }
  };

  const handleEditKeyInit = (key: ApiKey) => {
    setEditingKeyId(key.id);
    setEditLabel(key.label);
    setEditEmail(key.email || "");
    setCurrentPassword("");
    setEditPassword("");
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
        title: "Success",
        description: "API key updated successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update API key: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleDeleteKey = (keyId: string) => {
    storageManager.removeApiKey(keyId);
    setApiKeys(storageManager.getApiKeys());
    if (selectedKeyId === keyId) {
      setSelectedKeyId("");
    }
    toast({
      title: "Success",
      description: "API key deleted",
    });
  };

  const handleBenchmark = async () => {
    try {
      const { benchmark } = await import("@/lib/crypto-benchmark");
      const result = await benchmark(encryptionSettings.iterations);
      setBenchmarkResult(result);
      toast({
        title: "Benchmark Complete",
        description: `Encryption took ${result.toFixed(2)}ms`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Benchmark failed: " + (error as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleUpdateSettings = () => {
    cryptoManager.updateConfig(encryptionSettings);
    toast({
      title: "Success",
      description: "Encryption settings updated",
    });
    setShowSettings(false);
  };

  const handleManagePasskeys = async () => {
    if (!selectedKeyId || !password) return;
    try {
      const decrypted = await storageManager.getDecryptedApiKey(
        selectedKeyId,
        password,
      );
      if (!decrypted?.key) {
        toast({
          title: "Error",
          description: "Invalid password",
          variant: "destructive",
        });
        return;
      }
      setPasskeyViewKey(decrypted.key);
      setPasskeyViewEmail(decrypted.email);
      setShowManagePasskeys(true);
    } catch (err) {
      toast({
        title: "Error",
        description:
          "Failed to decrypt key: " + (err as Error).message,
        variant: "destructive",
      });
    }
  };

  const handleRemoveVaultSecret = async () => {
    if (!selectedKeyId || !password) {
      toast({
        title: t("Error"),
        description: t(
          "Select key and enter password to delete vault secret",
        ),
        variant: "destructive",
      });
      return;
    }
    try {
      const dec = await storageManager.getDecryptedApiKey(
        selectedKeyId,
        password,
      );
      if (!dec?.key) {
        toast({
          title: t("Error"),
          description: t("Invalid password"),
          variant: "destructive",
        });
        return;
      }
      const sc = new ServerClient(dec.key, undefined, dec.email);
      await sc.deleteVaultSecret(selectedKeyId);
      toast({
        title: t("Success"),
        description: t("Vault secret removed"),
      });
    } catch (err) {
      toast({
        title: t("Error"),
        description:
          t("Failed to remove vault secret: ") +
          (err as Error).message,
        variant: "destructive",
      });
    }
  };

  return {
    apiKeys,
    selectedKeyId,
    setSelectedKeyId,
    password,
    setPassword,
    isLoading,
    showAddKey,
    setShowAddKey,
    showSettings,
    setShowSettings,
    newKeyLabel,
    setNewKeyLabel,
    newApiKey,
    setNewApiKey,
    newEmail,
    setNewEmail,
    newPassword,
    setNewPassword,
    showEditKey,
    setShowEditKey,
    editLabel,
    setEditLabel,
    editEmail,
    setEditEmail,
    currentPassword,
    setCurrentPassword,
    editPassword,
    setEditPassword,
    encryptionSettings,
    setEncryptionSettings,
    benchmarkResult,
    passkeyRegisterLoading,
    passkeyAuthLoading,
    showManagePasskeys,
    setShowManagePasskeys,
    passkeyViewKey,
    setPasskeyViewKey,
    passkeyViewEmail,
    setPasskeyViewEmail,
    vaultEnabled,
    setVaultEnabled: (enabled: boolean) => {
        setVaultEnabled(enabled);
        storageManager.setVaultEnabled(enabled);
    },
    handleLogin,
    handleAddKey,
    handleRegisterPasskey,
    handleUsePasskey,
    handleEditKeyInit,
    handleUpdateKey,
    handleDeleteKey,
    handleBenchmark,
    handleUpdateSettings,
    handleManagePasskeys,
    handleRemoveVaultSecret,
  };
}
