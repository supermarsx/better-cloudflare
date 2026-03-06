/**
 * Dialog for adding a new registrar credential.
 *
 * The dialog collects provider selection, label, API key / secret, and
 * optional fields (username, email, extra params) and delegates the
 * actual storage to the backend via the hook callback.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/hooks/use-i18n";
import {
  REGISTRAR_LABELS,
  type RegistrarProvider,
} from "@/types/registrar";

interface AddRegistrarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (params: {
    provider: RegistrarProvider;
    label: string;
    apiKey: string;
    apiSecret?: string;
    username?: string;
    email?: string;
    extra?: Record<string, string>;
  }) => Promise<string>;
}

/** Fields that vary by provider. */
const PROVIDER_FIELDS: Record<
  RegistrarProvider,
  { needsSecret: boolean; needsUsername: boolean; extraFields: string[] }
> = {
  cloudflare: { needsSecret: false, needsUsername: false, extraFields: ["account_id"] },
  porkbun: { needsSecret: true, needsUsername: false, extraFields: [] },
  namecheap: { needsSecret: false, needsUsername: true, extraFields: ["client_ip"] },
  godaddy: { needsSecret: true, needsUsername: false, extraFields: [] },
  google: { needsSecret: false, needsUsername: false, extraFields: ["project", "location"] },
  namecom: { needsSecret: false, needsUsername: true, extraFields: [] },
};

export function AddRegistrarDialog({
  open,
  onOpenChange,
  onAdd,
}: AddRegistrarDialogProps) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<RegistrarProvider>("cloudflare");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = PROVIDER_FIELDS[provider];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !apiKey.trim()) {
      setError(t("Please fill in all fields", "Please fill in all fields"));
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onAdd({
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        apiSecret: fields.needsSecret ? apiSecret.trim() || undefined : undefined,
        username: fields.needsUsername ? username.trim() || undefined : undefined,
        email: email.trim() || undefined,
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      });
      // Reset
      setLabel("");
      setApiKey("");
      setApiSecret("");
      setUsername("");
      setEmail("");
      setExtra({});
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t("Add Registrar", "Add Registrar")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Connect a domain registrar to monitor your domains",
              "Connect a domain registrar to monitor your domains",
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Provider */}
          <div className="space-y-2">
            <Label>{t("Registrar", "Registrar")}</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v as RegistrarProvider);
                setExtra({});
              }}
            >
              <SelectTrigger className="bg-card/70 border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover/70 text-foreground">
                {(Object.keys(REGISTRAR_LABELS) as RegistrarProvider[]).map(
                  (p) => (
                    <SelectItem key={p} value={p}>
                      {REGISTRAR_LABELS[p]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Label */}
          <div className="space-y-2">
            <Label>{t("Label", "Label")}</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`My ${REGISTRAR_LABELS[provider]} account`}
              className="bg-card/70 border-border"
            />
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label>{t("API Key", "API Key")}</Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="Enter API key or token"
              className="bg-card/70 border-border"
            />
          </div>

          {/* API Secret (Porkbun, GoDaddy) */}
          {fields.needsSecret && (
            <div className="space-y-2">
              <Label>
                {t("API Secret", "API Secret")}
              </Label>
              <Input
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                type="password"
                placeholder="Enter API secret"
                className="bg-card/70 border-border"
              />
            </div>
          )}

          {/* Username (Namecheap, Name.com) */}
          {fields.needsUsername && (
            <div className="space-y-2">
              <Label>
                {t("Username", "Username")}
              </Label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                className="bg-card/70 border-border"
              />
            </div>
          )}

          {/* Email (optional, mostly Cloudflare global key) */}
          <div className="space-y-2">
            <Label>
              {t(
                "Account Email (optional for global keys)",
                "Account Email (optional for global keys)",
              )}
            </Label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="email@example.com"
              className="bg-card/70 border-border"
            />
          </div>

          {/* Extra fields */}
          {fields.extraFields.map((field) => (
            <div key={field} className="space-y-2">
              <Label className="capitalize">
                {field.replace(/_/g, " ")}
              </Label>
              <Input
                value={extra[field] ?? ""}
                onChange={(e) =>
                  setExtra((prev) => ({ ...prev, [field]: e.target.value }))
                }
                placeholder={`Enter ${field.replace(/_/g, " ")}`}
                className="bg-card/70 border-border"
              />
            </div>
          ))}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("Cancel", "Cancel")}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? t("Saving...", "Saving...")
                : t("Add Registrar", "Add Registrar")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
