import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ServerClient } from "@/lib/api/server-client";
import type { PasskeyStatusState } from "@/lib/auth/passkey-status";
import { passkeyErrorMessage } from "@/lib/auth/passkey-error";
import {
  Fingerprint,
  Smartphone,
  Monitor,
  Shield,
  Trash2,
  AlertTriangle,
} from "lucide-react";

interface PasskeyManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string; // key id for which we list passkeys
  apiKey: string; // decrypted key token
  email?: string;
  status: PasskeyStatusState | null;
}

type PasskeyItem = {
  id: string;
  counter?: number;
  label?: string;
  requiresReregistration?: boolean;
};

export function PasskeyManagerDialog({
  open,
  onOpenChange,
  id,
  apiKey,
  email,
  status,
}: PasskeyManagerDialogProps) {
  const [items, setItems] = useState<PasskeyItem[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [revokingIds, setRevokingIds] = useState<Set<string>>(() => new Set());
  const loadSequence = useRef(0);
  const revokeInFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const { toast } = useToast();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const sequence = ++loadSequence.current;
    const controller = new AbortController();

    if (!open) {
      setItems([]);
      setActionError(null);
      setIsLoading(false);
      return () => controller.abort();
    }

    const sc = new ServerClient(apiKey, undefined, email);
    setItems([]);
    setActionError(null);
    setIsLoading(true);

    (async () => {
      try {
        const list = await sc.listPasskeys(id, controller.signal);
        if (controller.signal.aborted || sequence !== loadSequence.current) {
          return;
        }
        setItems(list ?? []);
      } catch (err) {
        if (controller.signal.aborted || sequence !== loadSequence.current) {
          return;
        }
        const message =
          "Failed to list legacy passkeys: " + passkeyErrorMessage(err);
        setActionError(message);
        toast({
          title: "Error",
          description: message,
          variant: "destructive",
        });
      } finally {
        if (!controller.signal.aborted && sequence === loadSequence.current) {
          setIsLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [open, id, apiKey, email, toast]);

  const handleRevoke = async (cid: string) => {
    if (revokeInFlight.current.has(cid)) return;

    revokeInFlight.current.add(cid);
    setRevokingIds((current) => {
      const next = new Set(current);
      next.add(cid);
      return next;
    });

    const sequence = loadSequence.current;
    const sc = new ServerClient(apiKey, undefined, email);
    try {
      await sc.deletePasskey(id, cid);
      if (sequence !== loadSequence.current) return;
      setItems((current) => current.filter((item) => item.id !== cid));
      setActionError(null);
      toast({ title: "Success", description: "Legacy passkey removed" });
    } catch (err) {
      if (sequence !== loadSequence.current) return;
      const message =
        "Failed to remove legacy passkey: " + passkeyErrorMessage(err);
      setActionError(message);
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      revokeInFlight.current.delete(cid);
      if (mounted.current) {
        setRevokingIds((current) => {
          const next = new Set(current);
          next.delete(cid);
          return next;
        });
      }
    }
  };

  const getDeviceIcon = (label?: string) => {
    const lowerLabel = (label || "").toLowerCase();
    if (lowerLabel.includes("phone") || lowerLabel.includes("mobile")) {
      return <Smartphone className="h-4 w-4" />;
    }
    if (
      lowerLabel.includes("computer") ||
      lowerLabel.includes("desktop") ||
      lowerLabel.includes("laptop")
    ) {
      return <Monitor className="h-4 w-4" />;
    }
    if (
      lowerLabel.includes("key") ||
      lowerLabel.includes("yubikey") ||
      lowerLabel.includes("security")
    ) {
      return <Shield className="h-4 w-4" />;
    }
    return <Fingerprint className="h-4 w-4" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Legacy passkey recovery
          </DialogTitle>
          <DialogDescription>
            Legacy credentials can only be reviewed and removed. They cannot
            authenticate and must be re-enrolled when verified registration is
            available.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div
            className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm text-foreground"
            role="alert"
          >
            <div className="flex items-center gap-2 font-semibold text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Passkeys temporarily unavailable
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {status?.reason ??
                "Existing credentials require removal and future re-enrollment."}
            </p>
          </div>
          {actionError && (
            <p className="text-sm text-destructive" role="alert">
              {actionError}
            </p>
          )}
          <div>
            <Label className="text-base">Legacy credentials</Label>
            <div className="space-y-3 mt-3" aria-busy={isLoading}>
              {isLoading ? (
                <div
                  className="py-8 text-center text-sm text-muted-foreground"
                  role="status"
                >
                  Loading legacy passkeys…
                </div>
              ) : !items || items.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
                  <Fingerprint className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p className="text-sm font-medium">
                    No legacy passkeys found
                  </p>
                  <p className="text-xs mt-1">
                    Future passkey enrollment requires verified registration
                  </p>
                </div>
              ) : (
                items.map((it) => {
                  const isRevoking = revokingIds.has(it.id);
                  return (
                    <div
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                      key={it.id}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="p-2 rounded-full bg-primary/10 text-primary">
                          {getDeviceIcon(it.label)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">
                            {it.label || "Legacy credential"}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground truncate">
                            ID: {it.id.substring(0, 32)}...
                          </div>
                          <div className="text-xs text-destructive mt-1">
                            {it.requiresReregistration !== false
                              ? "Re-enrollment required"
                              : "Cannot authenticate"}
                          </div>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRevoke(it.id)}
                        className="ml-4"
                        disabled={isRevoking}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        {isRevoking ? "Removing…" : "Remove"}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {items.length > 0 && (
            <div className="pt-3 border-t">
              <p className="text-xs text-muted-foreground">
                <Shield className="h-3 w-3 inline mr-1" />
                Removing a legacy credential is permanent. Re-enroll only after
                verified passkey registration is available.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PasskeyManagerDialog;
