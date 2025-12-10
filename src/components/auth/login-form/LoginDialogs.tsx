import { AddKeyDialog } from "../AddKeyDialog";
import { EncryptionSettingsDialog } from "../EncryptionSettingsDialog";
import PasskeyManagerDialog from "../PasskeyManagerDialog";
import { EditKeyDialog } from "../EditKeyDialog";
import type { EncryptionSettings } from "@/lib/crypto";

interface LoginDialogsProps {
  showAddKey: boolean;
  setShowAddKey: (open: boolean) => void;
  newKeyLabel: string;
  setNewKeyLabel: (val: string) => void;
  newApiKey: string;
  setNewApiKey: (val: string) => void;
  newEmail: string;
  setNewEmail: (val: string) => void;
  newPassword: string;
  setNewPassword: (val: string) => void;
  handleAddKey: () => void;

  showSettings: boolean;
  setShowSettings: (open: boolean) => void;
  encryptionSettings: EncryptionSettings;
  setEncryptionSettings: (settings: EncryptionSettings) => void;
  handleBenchmark: () => void;
  handleUpdateSettings: () => void;
  benchmarkResult: number | null;
  vaultEnabled: boolean;
  setVaultEnabled: (enabled: boolean) => void;

  showManagePasskeys: boolean;
  setShowManagePasskeys: (open: boolean) => void;
  selectedKeyId: string;
  passkeyViewKey: string;
  passkeyViewEmail: string | undefined;
  setPasskeyViewKey: (val: string) => void;
  setPasskeyViewEmail: (val: string | undefined) => void;

  showEditKey: boolean;
  setShowEditKey: (open: boolean) => void;
  editLabel: string;
  setEditLabel: (val: string) => void;
  editEmail: string;
  setEditEmail: (val: string) => void;
  currentPassword: string;
  setCurrentPassword: (val: string) => void;
  editPassword: string;
  setEditPassword: (val: string) => void;
  handleUpdateKey: () => void;
}

export function LoginDialogs({
  showAddKey,
  setShowAddKey,
  newKeyLabel,
  setNewKeyLabel,
  newApiKey,
  setNewApiKey,
  newEmail,
  setNewEmail,
  newPassword,
  setNewPassword,
  handleAddKey,

  showSettings,
  setShowSettings,
  encryptionSettings,
  setEncryptionSettings,
  handleBenchmark,
  handleUpdateSettings,
  benchmarkResult,
  vaultEnabled,
  setVaultEnabled,

  showManagePasskeys,
  setShowManagePasskeys,
  selectedKeyId,
  passkeyViewKey,
  passkeyViewEmail,
  setPasskeyViewKey,
  setPasskeyViewEmail,

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
  handleUpdateKey,
}: LoginDialogsProps) {
  return (
    <>
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
        onVaultEnabledChange={setVaultEnabled}
      />

      <PasskeyManagerDialog
        open={showManagePasskeys}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setShowManagePasskeys(false);
            setPasskeyViewKey("");
            setPasskeyViewEmail(undefined);
          } else {
            setShowManagePasskeys(true);
          }
        }}
        id={selectedKeyId}
        apiKey={passkeyViewKey}
        email={passkeyViewEmail}
      />

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
    </>
  );
}
