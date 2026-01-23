/**
 * Login / Key selection UI used to open a session by decrypting a stored
 * API key and verifying it with the server.
 */
import { Card, CardContent } from "@/components/ui/Card";
import { LoginHeader } from "./login-form/LoginHeader";
import { LoginKeySelector } from "./login-form/LoginKeySelector";
import { LoginActionButtons } from "./login-form/LoginActionButtons";
import { LoginPasskeySection } from "./login-form/LoginPasskeySection";
import { LoginVaultSection } from "./login-form/LoginVaultSection";
import { LoginDialogs } from "./login-form/LoginDialogs";
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      {/* Background effects are handled in index.html, but we add a local glow here */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(255,80,0,0.08),transparent_70%)]" />
      
      <Card className="w-full max-w-md relative z-10 border-white/10 shadow-[0_0_15px_rgba(255,255,255,0.1)] bg-black/30 backdrop-blur-xl">
        <LoginHeader />
        <CardContent className="space-y-6 pt-4">
          <LoginKeySelector
            apiKeys={apiKeys}
            selectedKeyId={selectedKeyId}
            onSelectKey={setSelectedKeyId}
            onEditKey={handleEditKeyInit}
            onDeleteKey={handleDeleteKey}
            password={password}
            onPasswordChange={setPassword}
            onLogin={handleLogin}
            isLoading={isLoading}
          />

          <LoginActionButtons
            onAddKey={() => setShowAddKey(true)}
            onSettings={() => setShowSettings(true)}
            hasKeys={apiKeys.length > 0}
          />

          <LoginPasskeySection
            onRegister={handleRegisterPasskey}
            onUsePasskey={handleUsePasskey}
            onManagePasskeys={handleManagePasskeys}
            selectedKeyId={selectedKeyId}
            password={password}
            registerLoading={passkeyRegisterLoading}
            authLoading={passkeyAuthLoading}
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
      </Card>
    </div>
  );
}
