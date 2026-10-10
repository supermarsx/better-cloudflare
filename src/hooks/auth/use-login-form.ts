import { useState, useEffect, useMemo, useRef } from "react";
import { toast } from "@/hooks/use-toast";
import { storageManager } from "@/lib/storage/storage";
import { storageBackend } from "@/lib/storage/storage-util";
import i18next from "i18next";
import { cryptoManager } from "@/lib/auth/crypto";
import { ServerClient } from "@/lib/api/server-client";
import type { PasskeyAuthenticationResult } from "@/lib/api/server-client";
import {
  formatRequestError,
  normalizeRequestError,
  RequestError,
} from "@/lib/api/request-error";
import type { ApiKey } from "@/types/dns";
import { TauriClient } from "@/lib/api/tauri-client";
import { webauthnCeremonyMessage } from "@/lib/auth/passkey-error";
import {
  failedPasskeyStatus,
  passkeyStatusState,
  type PasskeyStatusState,
} from "@/lib/auth/passkey-status";
import {
  createPasskeyCredential,
  getPasskeyCredential,
  probeWebauthnClient,
  serializeAuthenticationCredential,
  serializeRegistrationCredential,
  toCredentialCreationOptions,
  toCredentialRequestOptions,
  unwrapCeremonyOptions,
  WebauthnCeremonyTimeoutError,
} from "@/lib/auth/webauthn";

export function useLoginForm(
  onLogin: (apiKey: string, email?: string) => void | Promise<void>,
  desktop: boolean,
) {
  // Bound once, not per render. `bind` delegates to the live i18next
  // instance, so a stable identity still resolves against whatever language
  // is active at the moment a handler fires — this hook only ever passes
  // `t(...)` straight into a `toast()`, never into returned state, so it has
  // no need to re-render when the locale changes.
  //
  // It was `i18next.t.bind(i18next)` on every render, which handed `t` a new
  // identity each time and so re-ran every effect listing it as a dependency
  // on every render. The effect below now needs `t` too, which is what made
  // that worth fixing rather than working around.
  const t = useMemo(() => i18next.t.bind(i18next), []);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const backend = storageBackend();
  const verifyToken = async (
    key: string,
    email?: string,
    signal?: AbortSignal,
  ) => {
    if (!key) {
      throw new Error("API key not provided");
    }
    if (desktop) {
      const ok = await TauriClient.verifyToken(key, email);
      if (!ok) {
        throw new RequestError(
          "http",
          "Cloudflare rejected the supplied credentials. Check the token or key, required permissions, and email for global-key authentication.",
          {
            source: "cloudflare",
            operation: "verify credentials",
            command: "verify_token",
            retryable: false,
          },
        );
      }
      return;
    }
    const client = new ServerClient(key, undefined, email);
    await client.verifyToken(signal);
  };
  const formatError = formatRequestError;
  const loginInFlight = useRef(false);
  const showLoginFailure = (error: unknown) => {
    const normalized = normalizeRequestError(error, {
      operation: "login",
      ...(desktop ? { command: "verify_token" } : {}),
    });
    toast({
      title: t("Login could not be completed"),
      description: formatError(normalized),
      variant: "destructive",
      persistent: true,
    });
  };
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

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
  const [passkeyStatus, setPasskeyStatus] = useState<PasskeyStatusState | null>(
    null,
  );
  // Whether the backend runs the ceremony itself. Read from the same status
  // call the UI is built from, so the two can never disagree about which
  // client is about to run.
  const [passkeyNative, setPasskeyNative] = useState(false);
  const [showManagePasskeys, setShowManagePasskeys] = useState(false);
  const [passkeyViewKey, setPasskeyViewKey] = useState("");
  const [passkeyViewEmail, setPasskeyViewEmail] = useState<string | undefined>(
    undefined,
  );
  const [vaultEnabled, setVaultEnabled] = useState(
    storageManager.getVaultEnabled(),
  );

  // ── Biometric state ───────────────────────────────────────────────────────
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState("Biometric");
  const [biometricEnrolled, setBiometricEnrolled] = useState(false);
  const [biometricLoading, setBiometricLoading] = useState(false);

  useEffect(() => {
    if (backend === "memory") {
      toast({
        title: t("Persistent storage unavailable"),
        description: t(
          "This session is using temporary memory storage. Changes will not survive an app restart.",
        ),
        variant: "destructive",
      });
    }
  }, [backend, t]);

  useEffect(() => {
    if (desktop) {
      TauriClient.getEncryptionSettings()
        .then((settings) => {
          if (settings && typeof settings === "object") {
            setEncryptionSettings(settings as typeof encryptionSettings);
          }
        })
        .catch((error) => {
          toast({
            title: t("Encryption settings unavailable"),
            description: formatError(error),
            variant: "destructive",
            persistent: true,
          });
        });
      TauriClient.getPreferences()
        .then((prefs) => {
          const prefObj = prefs as { vault_enabled?: boolean };
          if (typeof prefObj.vault_enabled === "boolean") {
            setVaultEnabled(prefObj.vault_enabled);
          }
        })
        .catch((error) => {
          toast({
            title: t("Preferences unavailable"),
            description: formatError(error),
            variant: "destructive",
            persistent: true,
          });
        });
      return;
    }
    cryptoManager.reloadConfig();
    setEncryptionSettings(cryptoManager.getConfig());
  }, [desktop, formatError, t]);

  useEffect(() => {
    let current = true;
    if (!desktop) {
      setPasskeyStatus(null);
      setPasskeyNative(false);
      return () => {
        current = false;
      };
    }

    // The backend reports what the relying party can do; only the frontend can
    // answer whether this webview has a working WebAuthn client. Both halves
    // are needed before the UI can say anything specific, so ask for them
    // together. `probeWebauthnClient` never rejects.
    Promise.all([TauriClient.getPasskeyStatus(), probeWebauthnClient()])
      .then(([status, client]) => {
        if (!current) return;
        setPasskeyNative(status.nativeCeremony === true);
        setPasskeyStatus(passkeyStatusState(status, client));
      })
      .catch((error) => {
        if (current) {
          console.error("Failed to load passkey capabilities:", error);
          setPasskeyNative(false);
          setPasskeyStatus(failedPasskeyStatus(error));
        }
      });

    return () => {
      current = false;
    };
  }, [desktop]);

  useEffect(() => {
    let current = true;

    const loadKeys = async () => {
      if (desktop) {
        const config = cryptoManager.getConfig();
        const keys = await TauriClient.getApiKeys();
        if (!current) return;
        const mapped = (Array.isArray(keys) ? keys : []).map((k) => {
          const item = k as {
            id?: string;
            label?: string;
            email?: string | null;
            encrypted_key?: string;
            iterations?: number;
            key_length?: number;
            algorithm?: string;
          };
          return {
            id: String(item.id ?? ""),
            label: String(item.label ?? item.id ?? ""),
            encryptedKey: item.encrypted_key ?? "",
            salt: "",
            iv: "",
            iterations: item.iterations ?? config.iterations,
            keyLength: item.key_length ?? config.keyLength,
            algorithm: item.algorithm ?? config.algorithm,
            createdAt: new Date().toISOString(),
            email: item.email ?? undefined,
          } as ApiKey;
        });
        setApiKeys(mapped);
        return;
      }
      const keys = await Promise.resolve(storageManager.getApiKeys());
      if (current) {
        setApiKeys(keys);
      }
    };
    loadKeys().catch((err) => {
      if (!current) return;
      console.error("Failed to load API keys:", err);
      setApiKeys([]);
    });

    return () => {
      current = false;
    };
  }, [desktop]);

  // Check biometric hardware availability on mount
  useEffect(() => {
    if (!desktop) return;
    ServerClient.biometricStatus()
      .then((status) => {
        setBiometricAvailable(status.available);
        const labels: Record<string, string> = {
          touchId: "Touch ID",
          faceId: "Face ID",
          windowsHello: "Windows Hello",
          fingerprint: "Fingerprint",
        };
        setBiometricLabel(labels[status.biometricType] ?? "Biometric");
      })
      .catch(() => setBiometricAvailable(false));
  }, [desktop]);

  // Check whether the selected key has a biometric enrolment
  useEffect(() => {
    if (!desktop || !biometricAvailable || !selectedKeyId) {
      setBiometricEnrolled(false);
      return;
    }
    ServerClient.biometricHasSecret(selectedKeyId)
      .then((has) => setBiometricEnrolled(has))
      .catch(() => setBiometricEnrolled(false));
  }, [desktop, biometricAvailable, selectedKeyId]);

  const handleLogin = async () => {
    if (loginInFlight.current) return;
    if (!selectedKeyId || !password) {
      toast({
        title: t("Error"),
        description: t("Please select an API key and enter your password"),
        variant: "destructive",
      });
      return;
    }

    loginInFlight.current = true;
    let succeeded = false;
    setIsLoading(true);
    try {
      const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
      const decrypted = desktop
        ? await TauriClient.decryptApiKey(selectedKeyId, password)
        : await storageManager.getDecryptedApiKey(selectedKeyId, password);
      const decryptedKey =
        typeof decrypted === "string" ? decrypted : decrypted?.key;
      const email =
        typeof decrypted === "string" ? selectedKey?.email : decrypted?.email;
      if (!decryptedKey) {
        showLoginFailure(
          new RequestError(
            "validation",
            "Invalid password or corrupted key. Re-enter the password; if it still fails, restore or replace the saved credential.",
            {
              source: "client",
              operation: "decrypt saved credential",
              retryable: false,
            },
          ),
        );
        return;
      }

      // Verify the API key works
      try {
        await verifyToken(decryptedKey, email);
      } catch (err) {
        showLoginFailure(err);
        return;
      }

      storageManager.setCurrentSession(selectedKeyId);
      await onLogin(decryptedKey, email);
      succeeded = true;

      toast({
        title: t("Success"),
        description: t("Logged in successfully"),
      });
    } catch (error) {
      showLoginFailure(error);
    } finally {
      if (!succeeded) {
        await delay(1000);
      }
      loginInFlight.current = false;
      setIsLoading(false);
    }
  };

  const handleAddKey = async () => {
    if (!newKeyLabel || !newApiKey || !newPassword) {
      toast({
        title: t("Error"),
        description: t("Please fill in all fields"),
        variant: "destructive",
      });
      return;
    }

    try {
      // Test the API key first
      try {
        await verifyToken(newApiKey, newEmail || undefined);
      } catch (err) {
        showLoginFailure(err);
        return;
      }

      if (desktop) {
        await TauriClient.addApiKey(
          newKeyLabel,
          newApiKey,
          newEmail || undefined,
          newPassword,
        );
        const keys = await TauriClient.getApiKeys();
        const config = cryptoManager.getConfig();
        setApiKeys(
          (Array.isArray(keys) ? keys : []).map((k) => {
            const item = k as {
              id?: string;
              label?: string;
              email?: string | null;
              encrypted_key?: string;
              iterations?: number;
              key_length?: number;
              algorithm?: string;
            };
            return {
              id: String(item.id ?? ""),
              label: String(item.label ?? item.id ?? ""),
              encryptedKey: item.encrypted_key ?? "",
              salt: "",
              iv: "",
              iterations: item.iterations ?? config.iterations,
              keyLength: item.key_length ?? config.keyLength,
              algorithm: item.algorithm ?? config.algorithm,
              createdAt: new Date().toISOString(),
              email: item.email ?? undefined,
            } as ApiKey;
          }),
        );
      } else {
        await storageManager.addApiKey(
          newKeyLabel,
          newApiKey,
          newPassword,
          newEmail || undefined,
        );
        setApiKeys(storageManager.getApiKeys());
      }
      setNewKeyLabel("");
      setNewApiKey("");
      setNewEmail("");
      setNewPassword("");
      setShowAddKey(false);

      toast({
        title: t("Success"),
        description: t("API key added successfully"),
      });
    } catch (error) {
      toast({
        title: t("Error"),
        description: t("Failed to add API key: ") + formatError(error),
        variant: "destructive",
      });
    }
  };

  const handleRegisterPasskey = async () => {
    if (!selectedKeyId) {
      toast({
        title: t("Error"),
        description: t("Select a key before registering a passkey"),
        variant: "destructive",
      });
      return;
    }

    if (!password) {
      toast({
        title: t("Error"),
        description: t(
          "Enter your password to decrypt the key for registration",
        ),
        variant: "destructive",
      });
      return;
    }

    // Passkey login works only by reading this key back out of the OS vault.
    // Registering while the vault is off would write the very secret the user
    // asked us not to keep, and produce a passkey that cannot log in.
    if (!vaultEnabled) {
      toast({
        title: t("Passkey login needs the OS vault"),
        description: t(
          "Passkey login stores this API key in the OS vault, which is disabled in Encryption Settings. Turn the OS vault on before registering a passkey.",
        ),
        variant: "destructive",
        persistent: true,
      });
      return;
    }

    setPasskeyRegisterLoading(true);

    // Show initial guidance toast
    toast({
      title: t("Passkey Registration"),
      description: passkeyNative
        ? t(
            "Your system will ask how you want to save this passkey — Windows Hello, a security key, or your phone.",
          )
        : t("Follow the prompts from your device to register a new passkey..."),
    });

    try {
      const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
      const decrypted = desktop
        ? await TauriClient.decryptApiKey(selectedKeyId, password)
        : await storageManager.getDecryptedApiKey(selectedKeyId, password);
      const decryptedKey =
        typeof decrypted === "string" ? decrypted : decrypted?.key;
      const decryptedEmail =
        typeof decrypted === "string" ? selectedKey?.email : decrypted?.email;
      if (!decryptedKey) {
        toast({
          title: t("Error"),
          description: t("Invalid password or corrupted key"),
          variant: "destructive",
        });
        return;
      }

      try {
        const sc = new ServerClient(decryptedKey, undefined, decryptedEmail);
        await sc.storeVaultSecret(selectedKeyId, decryptedKey);
      } catch (err) {
        toast({
          title: t("OS vault storage unavailable"),
          description:
            t(
              "Passkey registration can continue, but vault-based recovery was not saved. ",
            ) + formatError(err),
          variant: "destructive",
          persistent: true,
        });
      }

      // The native path is one call: the challenge is built, the OS runs the
      // ceremony, and the result is verified without any of it crossing into
      // the webview. There is nothing here to serialise or unwrap.
      if (passkeyNative) {
        await TauriClient.registerPasskeyNative(selectedKeyId);
        toast({
          title: t("✓ Passkey Registered"),
          description: t("You can now use this passkey for passwordless login"),
        });
        return;
      }

      const sc2 = new ServerClient(decryptedKey, undefined, decryptedEmail);
      const options = await sc2.getPasskeyRegistrationOptions(selectedKeyId);
      const publicKey = toCredentialCreationOptions(
        unwrapCeremonyOptions(options) as unknown as Parameters<
          typeof toCredentialCreationOptions
        >[0],
      );

      const credential = await createPasskeyCredential(publicKey);
      if (credential) {
        const att = credential as PublicKeyCredential;
        await sc2.registerPasskey(
          selectedKeyId,
          serializeRegistrationCredential(att),
        );
        toast({
          title: t("✓ Passkey Registered"),
          description: t("You can now use this passkey for passwordless login"),
        });
      } else {
        toast({
          title: t("Registration Cancelled"),
          description: t("Passkey registration was not completed"),
          variant: "destructive",
        });
      }
    } catch (error) {
      // Our own deadline is checked first: it aborts the ceremony, and the
      // browser reports that as an AbortError indistinguishable from the user
      // dismissing the prompt.
      const userMessage =
        error instanceof WebauthnCeremonyTimeoutError
          ? error.message
          : (webauthnCeremonyMessage(error, "register") ?? formatError(error));

      toast({
        title: t("Passkey Registration Failed"),
        description: userMessage,
        variant: "destructive",
      });
    } finally {
      setPasskeyRegisterLoading(false);
    }
  };

  const handleUsePasskey = async () => {
    if (!selectedKeyId) {
      toast({
        title: t("Error"),
        description: t("Select a key to authenticate"),
        variant: "destructive",
      });
      return;
    }

    // The stored secret must stay untouched while the vault is off, so refuse
    // before any vault read rather than after the device prompt.
    if (!vaultEnabled) {
      toast({
        title: t("Passkey login needs the OS vault"),
        description: t(
          "Passkey login reads this API key from the OS vault, which is disabled in Encryption Settings. Turn the OS vault on, or sign in with your password.",
        ),
        variant: "destructive",
        persistent: true,
      });
      return;
    }

    setPasskeyAuthLoading(true);

    // Show guidance toast
    toast({
      title: t("Passkey Authentication"),
      description: passkeyNative
        ? t(
            "Your system will ask you to confirm — with Windows Hello, a security key, or your phone.",
          )
        : t("Use your device's biometric or security key to authenticate..."),
    });

    try {
      const scx = new ServerClient("", undefined);

      // Both paths end with the same envelope — success flag and unlock token
      // — because the backend mints it the same way whichever client ran the
      // ceremony. Only the way it is obtained differs: one call, or three.
      let serverResp: PasskeyAuthenticationResult | null;
      if (passkeyNative) {
        serverResp = (await TauriClient.authenticatePasskeyNative(
          selectedKeyId,
        )) as PasskeyAuthenticationResult;
      } else {
        const opts = await scx.getPasskeyAuthOptions(selectedKeyId);
        const publicKey = toCredentialRequestOptions(
          unwrapCeremonyOptions(opts) as unknown as Parameters<
            typeof toCredentialRequestOptions
          >[0],
        );

        const assertion = await getPasskeyCredential(publicKey);
        // A null credential is the webview client's way of saying the user
        // dismissed the prompt. The native path throws instead, and lands in
        // the catch below with the reason the OS gave.
        serverResp = assertion
          ? await scx.authenticatePasskey(
              selectedKeyId,
              serializeAuthenticationCredential(
                assertion as PublicKeyCredential,
              ),
            )
          : null;
      }

      if (!serverResp) {
        toast({
          title: t("Authentication Cancelled"),
          description: t("Passkey authentication was not completed"),
          variant: "destructive",
        });
      } else if (serverResp.success) {
        const secret = await scx.getVaultSecret(
          selectedKeyId,
          serverResp.token,
        );
        if (secret) {
          const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
          storageManager.setCurrentSession(selectedKeyId);
          await onLogin(secret, selectedKey?.email);
          toast({
            title: t("✓ Login Successful"),
            description: t("Authenticated using passkey"),
          });
        } else {
          toast({
            title: t("Error"),
            description: t(
              "No API key found in vault. Please register a passkey first.",
            ),
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: t("Authentication Failed"),
          description: t("Passkey verification failed. Please try again."),
          variant: "destructive",
        });
      }
    } catch (error) {
      const errorMsg = formatError(error);
      // The client-side DOMException names are matched first. The vault miss
      // below is matched on text because it arrives over IPC as a string, and
      // text is all there is to match on.
      let userMessage =
        error instanceof WebauthnCeremonyTimeoutError
          ? error.message
          : (webauthnCeremonyMessage(error, "authenticate") ?? errorMsg);

      if (
        userMessage === errorMsg &&
        (errorMsg.includes("No secret") || errorMsg.includes("not found"))
      ) {
        userMessage =
          "No passkey registered for this API key. Please register one first.";
      }

      toast({
        title: t("Authentication Failed"),
        description: userMessage,
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
      if (desktop) {
        await TauriClient.updateApiKey(
          editingKeyId,
          editLabel,
          editEmail || undefined,
          currentPassword || undefined,
          editPassword || undefined,
        );
        const keys = await TauriClient.getApiKeys();
        const config = cryptoManager.getConfig();
        setApiKeys(
          (Array.isArray(keys) ? keys : []).map((k) => {
            const item = k as {
              id?: string;
              label?: string;
              email?: string | null;
              encrypted_key?: string;
              iterations?: number;
              key_length?: number;
              algorithm?: string;
            };
            return {
              id: String(item.id ?? ""),
              label: String(item.label ?? item.id ?? ""),
              encryptedKey: item.encrypted_key ?? "",
              salt: "",
              iv: "",
              iterations: item.iterations ?? config.iterations,
              keyLength: item.key_length ?? config.keyLength,
              algorithm: item.algorithm ?? config.algorithm,
              createdAt: new Date().toISOString(),
              email: item.email ?? undefined,
            } as ApiKey;
          }),
        );
      } else {
        await storageManager.updateApiKey(editingKeyId, {
          label: editLabel,
          email: editEmail || undefined,
          currentPassword: currentPassword || undefined,
          newPassword: editPassword || undefined,
        });
        setApiKeys(storageManager.getApiKeys());
      }
      setShowEditKey(false);
      toast({
        title: t("Success"),
        description: t("API key updated successfully"),
      });
    } catch (error) {
      toast({
        title: t("Error"),
        description: t("Failed to update API key: ") + formatError(error),
        variant: "destructive",
        persistent: true,
      });
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    if (desktop) {
      await TauriClient.deleteApiKey(keyId);
      const keys = await TauriClient.getApiKeys();
      const config = cryptoManager.getConfig();
      setApiKeys(
        (Array.isArray(keys) ? keys : []).map((k) => {
          const item = k as {
            id?: string;
            label?: string;
            email?: string | null;
            encrypted_key?: string;
            iterations?: number;
            key_length?: number;
            algorithm?: string;
          };
          return {
            id: String(item.id ?? ""),
            label: String(item.label ?? item.id ?? ""),
            encryptedKey: item.encrypted_key ?? "",
            salt: "",
            iv: "",
            iterations: item.iterations ?? config.iterations,
            keyLength: item.key_length ?? config.keyLength,
            algorithm: item.algorithm ?? config.algorithm,
            createdAt: new Date().toISOString(),
            email: item.email ?? undefined,
          } as ApiKey;
        }),
      );
    } else {
      storageManager.removeApiKey(keyId);
      setApiKeys(storageManager.getApiKeys());
    }
    if (selectedKeyId === keyId) {
      setSelectedKeyId("");
    }
    toast({
      title: t("Success"),
      description: t("API key deleted"),
    });
  };

  const handleBenchmark = async () => {
    try {
      const result = desktop
        ? await TauriClient.benchmarkEncryption(encryptionSettings.iterations)
        : await (
            await import("@/lib/auth/crypto-benchmark")
          ).benchmark(encryptionSettings.iterations);
      setBenchmarkResult(result);
      toast({
        title: t("Benchmark Complete"),
        description: t("Encryption took {{duration}}ms", {
          duration: result.toFixed(2),
          defaultValue: `Encryption took ${result.toFixed(2)}ms`,
        }),
      });
    } catch (error) {
      toast({
        title: t("Error"),
        description: t("Benchmark failed: ") + formatError(error),
        variant: "destructive",
      });
    }
  };

  const handleUpdateSettings = async () => {
    try {
      if (desktop) {
        await TauriClient.updateEncryptionSettings(encryptionSettings);
      } else {
        cryptoManager.updateConfig(encryptionSettings);
      }
      toast({
        title: t("Success"),
        description: t("Encryption settings updated"),
      });
      setShowSettings(false);
    } catch (error) {
      toast({
        title: t("Encryption settings were not saved"),
        description: formatError(error),
        variant: "destructive",
        persistent: true,
      });
    }
  };

  const handleManagePasskeys = async () => {
    if (!selectedKeyId || !password) return;
    try {
      const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
      const decrypted = desktop
        ? await TauriClient.decryptApiKey(selectedKeyId, password)
        : await storageManager.getDecryptedApiKey(selectedKeyId, password);
      const decryptedKey =
        typeof decrypted === "string" ? decrypted : decrypted?.key;
      const decryptedEmail =
        typeof decrypted === "string" ? selectedKey?.email : decrypted?.email;
      if (!decryptedKey) {
        toast({
          title: t("Error"),
          description: t("Invalid password"),
          variant: "destructive",
        });
        return;
      }
      setPasskeyViewKey(decryptedKey);
      setPasskeyViewEmail(decryptedEmail);
      setShowManagePasskeys(true);
    } catch (err) {
      toast({
        title: t("Error"),
        description: t("Failed to decrypt key: ") + formatError(err),
        variant: "destructive",
        persistent: true,
      });
    }
  };

  // ── Biometric handlers ──────────────────────────────────────────────────

  /** Login using biometric-protected secret (Touch ID / Windows Hello). */
  const handleBiometricLogin = async () => {
    if (!selectedKeyId) return;
    setBiometricLoading(true);
    try {
      const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
      const decryptedKey = await ServerClient.biometricGetSecret(
        selectedKeyId,
        `Unlock ${selectedKey?.label ?? "API key"} with ${biometricLabel}`,
      );
      if (!decryptedKey) {
        toast({
          title: t("Error"),
          description: t("No key returned from keychain"),
          variant: "destructive",
        });
        return;
      }

      // Verify the key still works
      try {
        await verifyToken(decryptedKey, selectedKey?.email);
      } catch (err) {
        toast({
          title: t("Error"),
          description: formatError(err),
          variant: "destructive",
        });
        return;
      }

      storageManager.setCurrentSession(selectedKeyId);
      await onLogin(decryptedKey, selectedKey?.email);
      toast({
        title: t("Success"),
        description: t("Logged in with {{label}}", {
          label: biometricLabel,
          defaultValue: `Logged in with ${biometricLabel}`,
        }),
      });
    } catch (err) {
      const msg = formatError(err);
      if (msg.toLowerCase().includes("cancel")) {
        // User cancelled biometric prompt — no toast needed
        return;
      }
      toast({
        title: t("Error"),
        description: t("{{label}} login failed: {{reason}}", {
          label: biometricLabel,
          reason: msg,
          defaultValue: `${biometricLabel} login failed: ${msg}`,
        }),
        variant: "destructive",
      });
    } finally {
      setBiometricLoading(false);
    }
  };

  /** Enrol the currently selected key for biometric unlock. Requires password. */
  const handleBiometricEnroll = async () => {
    if (!selectedKeyId || !password) {
      toast({
        title: t("Error"),
        description: t("Select a key and enter your password first"),
        variant: "destructive",
      });
      return;
    }
    setBiometricLoading(true);
    try {
      const decrypted = desktop
        ? await TauriClient.decryptApiKey(selectedKeyId, password)
        : await storageManager.getDecryptedApiKey(selectedKeyId, password);
      const decryptedKey =
        typeof decrypted === "string" ? decrypted : decrypted?.key;
      if (!decryptedKey) {
        toast({
          title: t("Error"),
          description: t("Invalid password or corrupted key"),
          variant: "destructive",
        });
        return;
      }

      await ServerClient.biometricStoreSecret(selectedKeyId, decryptedKey);
      setBiometricEnrolled(true);
      toast({
        title: t("Success"),
        description: t("{{label}} unlock enabled", {
          label: biometricLabel,
          defaultValue: `${biometricLabel} unlock enabled`,
        }),
      });
    } catch (err) {
      toast({
        title: t("Error"),
        description: t("Failed to enable {{label}}: {{reason}}", {
          label: biometricLabel,
          reason: formatError(err),
          defaultValue: `Failed to enable ${biometricLabel}: ${formatError(err)}`,
        }),
        variant: "destructive",
      });
    } finally {
      setBiometricLoading(false);
    }
  };

  /** Remove biometric enrolment for the currently selected key. */
  const handleBiometricRemove = async () => {
    if (!selectedKeyId) return;
    setBiometricLoading(true);
    try {
      await ServerClient.biometricDeleteSecret(selectedKeyId);
      setBiometricEnrolled(false);
      toast({
        title: t("Success"),
        description: t("{{label}} unlock removed", {
          label: biometricLabel,
          defaultValue: `${biometricLabel} unlock removed`,
        }),
      });
    } catch (err) {
      toast({
        title: t("Error"),
        description: t("Failed to remove {{label}}: {{reason}}", {
          label: biometricLabel,
          reason: formatError(err),
          defaultValue: `Failed to remove ${biometricLabel}: ${formatError(err)}`,
        }),
        variant: "destructive",
      });
    } finally {
      setBiometricLoading(false);
    }
  };

  const handleRemoveVaultSecret = async () => {
    if (!selectedKeyId || !password) {
      toast({
        title: t("Error"),
        description: t("Select key and enter password to delete vault secret"),
        variant: "destructive",
      });
      return;
    }
    try {
      const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
      const dec = desktop
        ? await TauriClient.decryptApiKey(selectedKeyId, password)
        : await storageManager.getDecryptedApiKey(selectedKeyId, password);
      const decryptedKey = typeof dec === "string" ? dec : dec?.key;
      const decryptedEmail =
        typeof dec === "string" ? selectedKey?.email : dec?.email;
      if (!decryptedKey) {
        toast({
          title: t("Error"),
          description: t("Invalid password"),
          variant: "destructive",
        });
        return;
      }
      const sc = new ServerClient(decryptedKey, undefined, decryptedEmail);
      await sc.deleteVaultSecret(selectedKeyId);
      toast({
        title: t("Success"),
        description: t("Vault secret removed"),
      });
    } catch (err) {
      toast({
        title: t("Error"),
        description: t("Failed to remove vault secret: ") + formatError(err),
        variant: "destructive",
        persistent: true,
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
    passkeyStatus,
    showManagePasskeys,
    setShowManagePasskeys,
    passkeyViewKey,
    setPasskeyViewKey,
    passkeyViewEmail,
    setPasskeyViewEmail,
    vaultEnabled,
    setVaultEnabled: async (enabled: boolean) => {
      try {
        if (desktop) {
          await TauriClient.updatePreferenceFields({
            vault_enabled: enabled,
          });
        } else {
          storageManager.setVaultEnabled(enabled);
        }
        setVaultEnabled(enabled);
        if (!enabled) {
          // Turning the vault off stops this app using it. It does not erase
          // what is already in the OS keychain, and no command reports whether
          // a secret is there, so say so plainly instead of implying it is gone.
          //
          // This title is a *confirmation*: the user turned the vault off and
          // it worked. The passkey handlers above report the *blocked* case,
          // and their title is "Passkey login needs the OS vault" rather than
          // a second phrasing of this one. Both were "OS vault is turned off"
          // and "OS vault turned off" — one word apart, which no translator
          // working from a key list could tell apart, and which the
          // reworded-values gate cannot see either. If the two ever converge
          // again, a success toast and a blocked-action toast read identically.
          toast({
            title: t("OS vault turned off"),
            // `prettier-ignore`, and the escaped quotes, are both load-bearing.
            // This string quotes a control name, so it contains double quotes
            // and no apostrophes — and Prettier picks whichever quote needs
            // fewer escapes, so left alone it rewrites this into a
            // single-quoted literal. `readQuoted` in
            // `scripts/i18n-coverage.mjs` only reads double-quoted strings, so
            // the single-quoted form is invisible to the scanner: the key would
            // never be catalogued and would ship in English in every locale
            // while the coverage report stayed clean. Verified both ways before
            // writing this. Do not "tidy" the escapes away.
            // prettier-ignore
            description: t("Passkey login is now disabled. Any API key already saved to the OS vault stays in the system keychain until you delete it with \"Remove Vault Secret\" below."),
            variant: "destructive",
            persistent: true,
          });
        }
      } catch (error) {
        toast({
          title: t("Vault preference was not saved"),
          description: formatError(error),
          variant: "destructive",
          persistent: true,
        });
      }
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
    // Biometric
    biometricAvailable,
    biometricLabel,
    biometricEnrolled,
    biometricLoading,
    desktop,
    handleBiometricLogin,
    handleBiometricEnroll,
    handleBiometricRemove,
  };
}
