/**
 * Cloud sync, reached from the login screen.
 *
 * # Why this exists at all
 *
 * The sync panel's natural home is the Session settings screen, but
 * `src/App.tsx` renders `DNSManager` — and therefore every settings screen in
 * it — only once `isAuthenticated`. That is fine for every other setting and
 * fatal for this one, because **a fresh machine has no API keys**: the user
 * would land on the login form, find no way to configure a provider, and so
 * have no way to pull the keys that would let them sign in. The restore path
 * would be unreachable at precisely the moment it is the only thing that
 * matters.
 *
 * So the panel is hosted twice. `src/lib/sync/types.ts` calls this tier-one
 * configuration — global, and reachable with no key present — and this dialog
 * is that tier's surface. It sits beside `EncryptionSettingsDialog` and
 * `PasskeyManagerDialog`, which are pre-key global concerns for the same
 * reason.
 *
 * # Push is withheld here, and that is the whole point of `allowPush`
 *
 * A push seals *whatever key list this device currently has* and uploads it as
 * a new generation. From this screen that list is empty, so a push would
 * upload nothing over the user's only remaining copy — the one failure in this
 * feature with no recovery. `allowPush={false}` replaces the button with a
 * sentence saying why, and gates "keep this device's copy" on a conflict with
 * it, because keeping the local side archives the provider's copy in favour of
 * keys this screen cannot see. That is a push in different words.
 *
 * Everything else works: Provider, Encryption and Pull need no key. The
 * passphrase in particular is not derived from any API key, so setting it
 * before any keys exist is exactly the case someone restoring is in.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SyncSettings } from "@/components/dns/SyncSettings";
import { useI18n } from "@/hooks/use-i18n";

export interface CloudSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CloudSyncDialog({ open, onOpenChange }: CloudSyncDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-var(--app-top-inset)-2rem)] max-w-3xl flex-col overflow-hidden"
        data-testid="login-cloud-sync-dialog"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("Cloud sync", "Cloud sync")}</DialogTitle>
          <DialogDescription>
            {t(
              "Set up a provider and pull the keys you have already sealed elsewhere. Uploading needs the keys this device holds, so it waits until you have signed in.",
              "Set up a provider and pull the keys you have already sealed elsewhere. Uploading needs the keys this device holds, so it waits until you have signed in.",
            )}
          </DialogDescription>
        </DialogHeader>
        {/* The panel takes no required props by design, so that this host and
            the settings-tab host mount the same component rather than two
            arrangements of it that can drift. `allowPush` is the only
            difference between them, and it is the one that matters. */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-themed pr-1">
          <SyncSettings allowPush={false} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default CloudSyncDialog;
