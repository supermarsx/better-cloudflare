import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { ServerClient } from '@/lib/server-client';
import type { ApiKey } from '@/types/dns';

interface PasskeyManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string; // key id for which we list passkeys
  apiKey: string; // decrypted key token
  email?: string;
}

export function PasskeyManagerDialog({ open, onOpenChange, id, apiKey, email }: PasskeyManagerDialogProps) {
  const [items, setItems] = useState<{ id: string; counter?: number }[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    const sc = new ServerClient(apiKey, undefined, email);
    (async () => {
      try {
        const list = await sc.listPasskeys(id);
        setItems(list ?? []);
      } catch (err) {
        toast({ title: 'Error', description: 'Failed to list passkeys: ' + (err as Error).message, variant: 'destructive' });
      }
    })();
  }, [open, id, apiKey, email, toast]);

  const handleRevoke = async (cid: string) => {
    const sc = new ServerClient(apiKey, undefined, email);
    try {
      await sc.deletePasskey(id, cid);
      setItems(items.filter((i) => i.id !== cid));
      toast({ title: 'Success', description: 'Passkey revoked' });
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to revoke passkey: ' + (err as Error).message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">Manage Passkeys</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage Passkeys</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Registered Passkeys</Label>
            <div className="space-y-2 mt-2">
              {items.length === 0 ? (
                <div className="text-sm text-muted-foreground">No passkeys found</div>
              ) : (
                items.map((it) => (
                  <div className="flex justify-between items-center p-2 border rounded" key={it.id}>
                    <div>
                      <div className="font-mono text-sm break-all">{it.id}</div>
                      <div className="text-xs text-muted-foreground">Counter: {it.counter ?? 0}</div>
                    </div>
                    <div>
                      <Button variant="destructive" size="sm" onClick={() => handleRevoke(it.id)}>Revoke</Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default PasskeyManagerDialog;
