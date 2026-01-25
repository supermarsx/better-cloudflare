/**
 * Login / Key selection UI used to open a session by decrypting a stored
 * API key and verifying it with the server.
 */
import { Card, CardContent } from "@/components/ui/card";
import { useState } from "react";
import { LoginHeader } from "./login-form/LoginHeader";
import { LoginKeySelector } from "./login-form/LoginKeySelector";
import { LoginActionButtons } from "./login-form/LoginActionButtons";
import { LoginPasskeySection } from "./login-form/LoginPasskeySection";
import { LoginVaultSection } from "./login-form/LoginVaultSection";
import { LoginDialogs } from "./login-form/LoginDialogs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLoginForm } from "@/hooks/use-login-form";

/**
 * Props for the login form used on the main page to select and decrypt
 * an API key and authenticate the user.
 */
interface LoginFormProps {
  /** Callback invoked on successful login with the decrypted apiKey. May return a promise. */
  onLogin: (apiKey: string, email?: string) => void | Promise<void>;
}

/**
 * Login form component responsible for decrypting stored API keys and
 * verifying them with the server. On success the decrypted key is passed
 * via `onLogin` for the parent to use.
 */
export function LoginForm({ onLogin }: LoginFormProps) {
  const {
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
    setVaultEnabled,
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
  } = useLoginForm(onLogin);
  const selectedKey = apiKeys.find((key) => key.id === selectedKeyId) ?? null;
  const [deleteTarget, setDeleteTarget] = useState<typeof selectedKey>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const requestDeleteKey = (id: string) => {
    const target = apiKeys.find((key) => key.id === id) ?? null;
    setDeleteTarget(target);
    setShowDeleteConfirm(true);
  };

  const confirmDeleteKey = async () => {
    if (!deleteTarget) return;
    await handleDeleteKey(deleteTarget.id);
    setShowDeleteConfirm(false);
    setDeleteTarget(null);
  };

  return (
    <div className="h-full w-full flex items-center justify-center bg-background p-4 relative overflow-hidden">
      {/* Background effects are handled in index.html, but we add a local glow here */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(255,80,0,0.08),transparent_70%)]" />
      
      <Card className="w-full max-w-md relative z-10 border-white/10 shadow-[0_0_15px_rgba(255,255,255,0.1)] bg-black/30 backdrop-blur-xl">
        <LoginHeader />
        <CardContent className="space-y-6 pt-4">
          <LoginKeySelector
            apiKeys={apiKeys}
            selectedKeyId={selectedKeyId}
            onSelectKey={setSelectedKeyId}
            password={password}
            onPasswordChange={setPassword}
            onLogin={handleLogin}
            isLoading={isLoading}
          />

          <LoginActionButtons
            onAddKey={() => setShowAddKey(true)}
            onSettings={() => setShowSettings(true)}
            hasKeys={apiKeys.length > 0}
            selectedKey={selectedKey}
            onEditKey={handleEditKeyInit}
            onDeleteKey={requestDeleteKey}
          />

          <LoginPasskeySection
            onRegister={handleRegisterPasskey}
            onUsePasskey={handleUsePasskey}
            onManagePasskeys={handleManagePasskeys}
            selectedKeyId={selectedKeyId}
            password={password}
            registerLoading={passkeyRegisterLoading}
            authLoading={passkeyAuthLoading}
            hasKeys={apiKeys.length > 0}
          />

          {vaultEnabled && (
            <LoginVaultSection onRemoveVaultSecret={handleRemoveVaultSecret} />
          )}

          <LoginDialogs
            showAddKey={showAddKey}
            setShowAddKey={setShowAddKey}
            newKeyLabel={newKeyLabel}
            setNewKeyLabel={setNewKeyLabel}
            newApiKey={newApiKey}
            setNewApiKey={setNewApiKey}
            newEmail={newEmail}
            setNewEmail={setNewEmail}
            newPassword={newPassword}
            setNewPassword={setNewPassword}
            handleAddKey={handleAddKey}

            showSettings={showSettings}
            setShowSettings={setShowSettings}
            encryptionSettings={encryptionSettings}
            setEncryptionSettings={setEncryptionSettings}
            handleBenchmark={handleBenchmark}
            handleUpdateSettings={handleUpdateSettings}
            benchmarkResult={benchmarkResult}
            vaultEnabled={vaultEnabled}
            setVaultEnabled={setVaultEnabled}

            showManagePasskeys={showManagePasskeys}
            setShowManagePasskeys={setShowManagePasskeys}
            selectedKeyId={selectedKeyId}
            passkeyViewKey={passkeyViewKey}
            passkeyViewEmail={passkeyViewEmail}
            setPasskeyViewKey={setPasskeyViewKey}
            setPasskeyViewEmail={setPasskeyViewEmail}

            showEditKey={showEditKey}
            setShowEditKey={setShowEditKey}
            editLabel={editLabel}
            setEditLabel={setEditLabel}
            editEmail={editEmail}
            setEditEmail={setEditEmail}
            currentPassword={currentPassword}
            setCurrentPassword={setCurrentPassword}
            editPassword={editPassword}
            setEditPassword={setEditPassword}
            handleUpdateKey={handleUpdateKey}
          />
        </CardContent>
        {isLoading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl bg-black/70 backdrop-blur-sm">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-orange-300/30 border-t-orange-400" />
            <div className="text-xs uppercase tracking-[0.3em] text-orange-100/80">
              Authenticating
            </div>
          </div>
        )}
      </Card>
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete API Key</DialogTitle>
            <DialogDescription>
              This removes the selected key from local storage. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-muted-foreground">
              {deleteTarget ? deleteTarget.label : "Selected key"}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button
                className="flex-1 bg-red-500/80 text-white hover:bg-red-500 hover:text-white shadow-[0_0_18px_rgba(255,80,80,0.25)] hover:shadow-[0_0_26px_rgba(255,90,90,0.45)] transition"
                variant="destructive"
                onClick={confirmDeleteKey}
              >
                Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
