import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ServerClient } from "@/lib/server-client";
import { Fingerprint, Smartphone, Monitor, Shield, Trash2, Edit2, Check, X } from "lucide-react";

interface PasskeyManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string; // key id for which we list passkeys
  apiKey: string; // decrypted key token
  email?: string;
}

type PasskeyItem = { id: string; counter?: number; label?: string };

export function PasskeyManagerDialog({
  open,
  onOpenChange,
  id,
  apiKey,
  email,
}: PasskeyManagerDialogProps) {
  const [items, setItems] = useState<PasskeyItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    const sc = new ServerClient(apiKey, undefined, email);
    (async () => {
      try {
        const list = await sc.listPasskeys(id);
        setItems(list ?? []);
      } catch (err) {
        toast({
          title: "Error",
          description: "Failed to list passkeys: " + (err as Error).message,
          variant: "destructive",
        });
      }
    })();
  }, [open, id, apiKey, email, toast]);

  const handleRevoke = async (cid: string) => {
    const sc = new ServerClient(apiKey, undefined, email);
    try {
      await sc.deletePasskey(id, cid);
      setItems(items.filter((i) => i.id !== cid));
      toast({ title: "Success", description: "Passkey revoked" });
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to revoke passkey: " + (err as Error).message,
        variant: "destructive",
      });
    }
  };

  const getDeviceIcon = (label?: string) => {
    const lowerLabel = (label || "").toLowerCase();
    if (lowerLabel.includes("phone") || lowerLabel.includes("mobile")) {
      return <Smartphone className="h-4 w-4" />;
    }
    if (lowerLabel.includes("computer") || lowerLabel.includes("desktop") || lowerLabel.includes("laptop")) {
      return <Monitor className="h-4 w-4" />;
    }
    if (lowerLabel.includes("key") || lowerLabel.includes("yubikey") || lowerLabel.includes("security")) {
      return <Shield className="h-4 w-4" />;
    }
    return <Fingerprint className="h-4 w-4" />;
  };

  const handleStartEdit = (item: PasskeyItem) => {
    setEditingId(item.id);
    setEditLabel(item.label || "");
  };

  const handleSaveLabel = (itemId: string) => {
    // For now, store in local state. In a full implementation, this would save to server
    setItems(items.map(it => it.id === itemId ? { ...it, label: editLabel } : it));
    setEditingId(null);
    setEditLabel("");
    toast({ title: "Success", description: "Device name updated" });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditLabel("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
        <Shield className="h-5 w-5 text-primary" />
            Manage Passkeys
          </DialogTitle>
          <DialogDescription>
            View and manage registered passkey devices for this API key. Each passkey provides secure, passwordless authentication.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-base">Registered Devices</Label>
            <div className="space-y-3 mt-3">
              {!items || items.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
                  <Fingerprint className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-medium">No passkeys registered</p>
                  <p className="text-xs mt-1">Register a passkey to enable passwordless login</p>
                </div>
              ) : (
                items.map((it) => (
                  <div
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                    key={it.id}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="p-2 rounded-full bg-primary/10 text-primary">
                        {getDeviceIcon(it.label)}
                      </div>
                      <div className="flex-1 min-w-0">
                        {editingId === it.id ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              placeholder="e.g., iPhone, YubiKey"
                              className="h-8 text-sm"
                              autoFocus
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleSaveLabel(it.id)}
                              className="h-8 w-8 p-0"
                            >
                              <Check className="h-4 w-4 text-green-500" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={handleCancelEdit}
                              className="h-8 w-8 p-0"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <div className="font-medium text-sm">
                                {it.label || "Unnamed Device"}
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleStartEdit(it)}
                                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <Edit2 className="h-3 w-3" />
                              </Button>
                            </div>
                            <div className="font-mono text-xs text-muted-foreground truncate">
                              ID: {it.id.substring(0, 32)}...
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              Used {it.counter ?? 0} time{it.counter !== 1 ? 's' : ''}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleRevoke(it.id)}
                      className="ml-4"
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Revoke
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
          {items.length > 0 && (
            <div className="pt-3 border-t">
              <p className="text-xs text-muted-foreground">
                <Shield className="h-3 w-3 inline mr-1" />
                Passkeys use biometric or security key authentication for enhanced security.
                Revoking a passkey will prevent it from being used for login.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PasskeyManagerDialog;
