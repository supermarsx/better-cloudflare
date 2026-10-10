/**
 * Sync settings: where the API key vault is copied to, what seals it, how
 * often, and what happened last time.
 *
 * Arranged like `NotificationsSettings` — a segmented nav over four sections,
 * with the rows in this file rather than in `DNSManager.tsx` — so that
 * `settings-search.ts` indexes *sections* and the registry test checks them
 * against {@link SYNC_SETTINGS_SECTIONS}. The pure rules are in
 * `./sync-view.ts`; what is here is markup, words and one hook call.
 *
 * # Why this screen saves on a button rather than per row
 *
 * The notification panel persists each row as it is toggled. This one cannot:
 * `SyncSettingsInput` is one object carrying two write-only secrets, so there
 * is no such thing as writing one row of it, and a credential persisted
 * keystroke by keystroke would put a dozen half-typed app passwords through
 * the OS keyring on the way to the real one. So the panel edits a draft and
 * `configure_sync` is called once, which also makes "nothing has been written
 * yet" a state the user can see and leave by discarding.
 *
 * # The three things this screen must not soften
 *
 * All three are in `@/lib/sync/types`' header with the reasoning. They are
 * repeated to the user here because here is where they matter:
 *
 * 1. **A folder has nothing to authenticate with, and that is not the same as
 *    being unconfigured.** `providerNeedsCredential` decides whether the credential
 *    field exists at all, so "nothing is stored" and "nothing is wanted" are
 *    two different screens rather than one empty box asking for a secret that
 *    would never be read. Neither provider is ranked over the other any more:
 *    the line that did was there because the old Drive engine's pasted token
 *    expired, and the honest difference left is that a folder has no
 *    credential to expire while Nextcloud needs nothing else running.
 * 2. **The passphrase is a second secret, and what it costs is bounded.**
 *    Losing it costs the ability to restore *from the provider*. It does not
 *    cost the keys on this device, which are in the OS keyring under their own
 *    passwords and are untouched by any of this. Saying only the first half
 *    reads as "you can lose your keys", which is false and frightening; saying
 *    only the second reads as "it does not matter", which is false and
 *    careless.
 * 3. **Divergence is refused, not merged.** A conflict is therefore a question
 *    and not an error: it gets both manifests, two explicit choices, and the
 *    fact that the discarded side is archived rather than deleted.
 *
 * # This panel is hosted twice, and holds nothing of either host
 *
 * It lives in the Session settings tab *and* — because of a deadlock worth
 * stating — on the login screen. `src/App.tsx` renders `DNSManager` only once
 * authenticated, and every settings panel lives inside `DNSManager`; so on a
 * fresh machine with no keys, a user who needs sync to *get* their keys would
 * find the only screen that configures it behind the sign-in it is meant to
 * make possible. The restore path has to be reachable before login.
 *
 * What that requires of this file: props in, callbacks out, and no dependency
 * on a session, an `apiKey`, a selected account or anything else from the
 * workspace shell. Everything it needs is {@link useSyncSettings} and `t()`.
 * `get_sync_status` is a no-network read of global preferences plus the
 * keyring and is valid with zero keys present, so the hook is not gated on a
 * session either. `test/SyncSettings.test.tsx` pins the import list against
 * this, because the dependency that breaks it will arrive as an innocuous
 * import rather than as a decision.
 *
 * Exactly one control is not safe from both hosts, and it is
 * {@link SyncSettingsProps.allowPush} — see its own note.
 *
 * # What the contract now carries, and why it has to
 *
 * Two things this screen could not honestly say were reported as contract
 * gaps and are now fields:
 *
 * - **The cadence range** is {@link SyncStatus.autoPushMinutesRange}, so the
 *   number field can advertise bounds without a second copy of
 *   `MIN_AUTO_PUSH_MINUTES` / `MAX_AUTO_PUSH_MINUTES` to drift. The clamp stays
 *   the backend's: the notice reports what was stored rather than predicting
 *   it.
 * - **The key count before a pull** is {@link SYNC_COMMANDS.previewPull},
 *   which opens the envelope and writes nothing. `pull_sync` downloads, opens
 *   *and* installs, so it could never have shown a preview of itself. The pull
 *   button is offered only once that preview has opened the envelope, which is
 *   also where a wrong passphrase is discovered — before anyone's keys have
 *   been touched.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import { useSyncSettings } from "@/hooks/dns/use-sync-settings";
import { fullTimestamp } from "@/lib/notifications/notifications-view";
import {
  providerNeedsCredential,
  type ConflictResolution,
  type SyncConflict,
  type SyncFailureCode,
  type SyncManifest,
  type SyncOutcome,
  type SyncPreviewOutcome,
  type SyncProvider,
  type SyncSettings as SyncSettingsValue,
} from "@/lib/sync/types";

import { SettingRow, SettingsSection } from "./NotificationsSettingsControls";
import {
  SYNC_SECRET_KEEP,
  syncCadenceAdjustment,
  syncCadenceRange,
  syncDraftFromSettings,
  syncPanelDirty,
  syncProviderIncomplete,
  syncSecretReplaces,
  syncSettingsInput,
  type SyncDraft,
  type SyncSecretDraft,
} from "./sync-view";

export type SyncSettingsSection =
  "provider" | "encryption" | "schedule" | "status";

/**
 * The sub-sections, in nav order.
 *
 * Exported for the same reason `NOTIFICATION_SETTINGS_SECTIONS` is: the rows
 * live in this file, where `test/settingsSearch.registry.test.ts` cannot see
 * them, so a section is the finest thing `settings-search.ts` can name and
 * these four are what that test checks the index against. Renaming one here
 * fails that test rather than quietly leaving search matching a word nobody
 * can see.
 *
 * The order is the order a setup goes in: choose a provider, give it something
 * to seal the bundle with, decide how often, and only then is there a status
 * worth reading.
 */
export const SYNC_SETTINGS_SECTIONS: readonly {
  id: SyncSettingsSection;
  /** English label; rendered through `t(label, label)`. */
  label: string;
}[] = [
  { id: "provider", label: "Provider" },
  { id: "encryption", label: "Encryption" },
  { id: "schedule", label: "Schedule" },
  { id: "status", label: "Sync status" },
];

export interface SyncSettingsProps {
  /** The open section, when the host owns it. See `NotificationsSettings`. */
  section?: SyncSettingsSection;
  onSectionChange?: (section: SyncSettingsSection) => void;
  initialSection?: SyncSettingsSection;
  /**
   * Whether this host may upload. Default `true`.
   *
   * The one control that is not safe everywhere this panel is hosted. A push
   * seals whatever key list this device currently has and uploads it as a new
   * generation — so from a host where that list is empty or locked, "push" is
   * an upload of nothing over everything, and the remote copy is the only copy
   * the user has left. Pull, Provider and Encryption have no such problem.
   *
   * Pass `false` and the button is replaced by a sentence saying why, rather
   * than silently vanishing: a control that is simply absent reads as a bug,
   * and this one's absence is the point.
   */
  allowPush?: boolean;
  /**
   * Test seam, defaulting to the hook's `preview_sync_pull`.
   *
   * Overridable for the same reason `UndoPreviewDialog.previewUndo` is: the
   * preview is the step this screen's safety rests on, and a test needs to
   * drive each of its three outcomes without a backend.
   */
  previewPull?: () => Promise<SyncPreviewOutcome>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A write-only secret, rendered as an intent rather than as a value.
 *
 * The backend never returns either secret, so there is nothing to put in a
 * password box. Pre-filling one with dots would tell the user their real
 * secret is in there, and a save would then either resend the dots or quietly
 * drop them — so instead the field reports what the keyring holds, and the
 * controls express the three things the user can mean: leave it, replace it,
 * remove it. `data-secret-mode` carries the current one, so the three are
 * distinguishable from the outside and not only in this component's state.
 *
 * # Every string literal below is shared by both instances
 *
 * This component is rendered twice — once for the provider credential, once
 * for the sync passphrase — so `"Nothing is stored"`, `"Type a replacement"`,
 * `"Keep the stored one"`, `"The stored secret will be removed when you save"`,
 * `"Cancel the removal"`, `"Replace"`, `"Remove"` and the empty-field note all
 * describe **whichever secret is in front of the user**, not a particular one. Only `label`, `description`,
 * `presentText` and `absentText` arrive per instance and may therefore name
 * their own field.
 *
 * That distinction is invisible from inside this file and it is load-bearing
 * for translation: a shared string cannot agree with a noun it does not know.
 *
 * `"Keep the stored one"` is the one string below that still has no subject,
 * and the shipped locales divide three ways on it. fr-FR and ru-RU name one
 * outright — `"Conserver le secret enregistré"`, `"Оставить сохранённое
 * значение"` — which is the repair. pt-PT and hi-IN sidestep agreement with a
 * relative construction, "keep what is stored". **es-ES agrees with a noun the
 * string cannot see**: `"Conservar la ya almacenada"` is feminine, and it is
 * correct only because `credencial` and `frase de contraseña` both happen to
 * be feminine. Add a third secret whose Spanish label is masculine and that
 * line becomes ungrammatical for it, with nothing to catch it, since the key,
 * the value and the placeholders would all be unchanged. Found by the es-ES
 * translator, against an earlier version of this comment that had the Spanish
 * backwards — it claimed a neuter dodge, and described the hazard as one the
 * locale had escaped rather than one it is in.
 *
 * The sibling string shows the fix working. `"Will be removed when you save"`
 * had the same defect and is now `"The stored secret will be removed when you
 * save"`; es-ES, pt-PT and hi-IN all render that subject explicitly, and none
 * of them has to guess a gender any more.
 *
 * So: a string added below must read correctly for any secret this component
 * could ever serve. If one genuinely cannot — if it has to agree with a
 * specific field — it belongs in a prop, the way `"A passphrase is set on this
 * device"` and `"A credential is stored on this device"` do. Those two also
 * show the other half of the fix: **name the subject.** They used to be the
 * participles `"Set on this device"` and `"Stored on this device"`, which no
 * gendered or case-marked language can render without knowing what they
 * describe — and which were only ever correct because exactly one provider
 * carries a credential. Add one whose credential label has a different gender
 * and every such string breaks at once, in every inflecting locale, with
 * nothing to catch it: same key, same value, same placeholders.
 *
 * That is also the repair if the constraint above is ever broken: split the
 * string per field, or give it a subject, rather than retranslate it — which
 * is what splitting `"Cancel the removal"` out of `"Keep the stored one"`
 * already did for a different reason.
 */
function SecretField({
  id,
  testId,
  label,
  description,
  present,
  presentText,
  absentText,
  draft,
  onChange,
  disabled,
}: {
  id: string;
  testId: string;
  label: string;
  description?: string;
  present: boolean;
  /** What "the keyring holds one" should say for this particular secret. */
  presentText: string;
  absentText: string;
  draft: SyncSecretDraft;
  onChange: (draft: SyncSecretDraft) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SettingRow
      htmlFor={draft.mode === "set" || !present ? id : undefined}
      label={label}
      description={description}
      className="items-start"
    >
      <div
        className="flex min-w-0 flex-col items-stretch gap-1.5"
        data-testid={testId}
        data-secret-mode={draft.mode}
        data-secret-present={present}
      >
        {draft.mode === "set" || !present ? (
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-64 text-sm"
              value={draft.mode === "set" ? draft.value : ""}
              disabled={disabled}
              placeholder={
                /* Two placeholders, because this branch has two causes. It
                   opens either because nothing is stored or because the user
                   pressed Replace on something that is — and the one
                   placeholder read "Nothing is stored" in both, so the replace
                   path showed it directly beside the "Keep the stored one"
                   button that only exists when something *is* stored: two
                   strings in one row contradicting each other. Found by the
                   hi-IN translator. `present` is the same condition that
                   renders that button, so the two cannot disagree again. */
                present
                  ? t("Type a replacement", "Type a replacement")
                  : t("Nothing is stored", "Nothing is stored")
              }
              onChange={(event) =>
                onChange({ mode: "set", value: event.target.value })
              }
            />
            {present ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs"
                disabled={disabled}
                onClick={() => onChange(SYNC_SECRET_KEEP)}
              >
                {t("Keep the stored one", "Keep the stored one")}
              </Button>
            ) : null}
          </div>
        ) : draft.mode === "clear" ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-destructive">
              {/* Shared, so the subject has to be one that fits any secret
                  this component serves: "the stored secret" rather than a
                  participle agreeing with a noun the string cannot see. */}
              {t(
                "The stored secret will be removed when you save",
                "The stored secret will be removed when you save",
              )}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs"
              disabled={disabled}
              onClick={() => onChange(SYNC_SECRET_KEEP)}
            >
              {/* Not "Keep the stored one": in this mode the secret is already
                  marked for removal, so the act is undoing that rather than
                  choosing between stored and typed. One label for both jobs
                  elided a difference that does not survive translation. */}
              {t("Cancel the removal", "Cancel the removal")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{presentText}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={disabled}
              onClick={() => onChange({ mode: "set", value: "" })}
            >
              {t("Replace", "Replace")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-xs text-destructive"
              disabled={disabled}
              onClick={() => onChange({ mode: "clear" })}
            >
              {t("Remove", "Remove")}
            </Button>
          </div>
        )}
        {!present ? (
          <p className="text-[11px] text-muted-foreground">{absentText}</p>
        ) : null}
        {draft.mode === "set" && draft.value === "" ? (
          <p className="text-[11px] text-muted-foreground">
            {t(
              "Leave this empty and the stored secret is left exactly as it is.",
              "Leave this empty and the stored secret is left exactly as it is.",
            )}
          </p>
        ) : null}
      </div>
    </SettingRow>
  );
}

/** One manifest, as the four facts a person can act on. */
function ManifestFacts({
  manifest,
  thisDeviceId,
  testId,
}: {
  manifest: SyncManifest;
  thisDeviceId: string;
  testId?: string;
}) {
  const { t, language } = useI18n();
  const mine = manifest.deviceId === thisDeviceId;
  return (
    <dl
      className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]"
      data-testid={testId}
    >
      <dt className="text-muted-foreground">{t("Generation", "Generation")}</dt>
      <dd className="font-mono">{manifest.generation}</dd>
      <dt className="text-muted-foreground">{t("Written", "Written")}</dt>
      <dd>{fullTimestamp(manifest.writtenAt, language)}</dd>
      <dt className="text-muted-foreground">{t("Written by", "Written by")}</dt>
      <dd className="break-all">
        {mine
          ? t("This device ({{label}})", {
              label: manifest.deviceLabel,
              defaultValue: `This device (${manifest.deviceLabel})`,
            })
          : t("Another device ({{label}}, {{id}})", {
              label: manifest.deviceLabel,
              id: manifest.deviceId,
              defaultValue: `Another device (${manifest.deviceLabel}, ${manifest.deviceId})`,
            })}
      </dd>
      <dt className="text-muted-foreground">{t("Size", "Size")}</dt>
      <dd>
        {t("{{count}} bytes sealed", {
          count: manifest.bytes,
          defaultValue: `${manifest.bytes} bytes sealed`,
        })}
      </dd>
    </dl>
  );
}

/**
 * A conflict, put as the question it is.
 *
 * `role="status"` rather than `role="alert"`: nothing has gone wrong and
 * nothing was written. Both sides are shown because the choice is
 * unanswerable without them — "keep mine" means nothing until you can see that
 * the other one is from your laptop, two generations ahead.
 */
function ConflictPanel({
  conflict,
  thisDeviceId,
  busy,
  allowKeepLocal,
  onResolve,
}: {
  conflict: SyncConflict;
  thisDeviceId: string;
  busy: boolean;
  /**
   * Whether "keep this device's copy" may be offered.
   *
   * The same question {@link SyncSettingsProps.allowPush} answers, because it
   * is the same act: `keep-local` promotes this device's copy and archives the
   * provider's, so from a host that cannot see this device's keys it is a push
   * of an empty bundle wearing different words. `keep-remote` is always safe
   * — it is the restore.
   */
  allowKeepLocal: boolean;
  onResolve: (resolution: ConflictResolution) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
      data-testid="sync-conflict"
      role="status"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t("Both copies have moved", "Both copies have moved")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "This device expected generation {{expected}} and the provider now holds generation {{remoteGeneration}}. Nothing was written.",
              {
                expected: conflict.expectedGeneration,
                remoteGeneration: conflict.remote.generation,
                defaultValue: `This device expected generation ${conflict.expectedGeneration} and the provider now holds generation ${conflict.remote.generation}. Nothing was written.`,
              },
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              "Divergence is refused rather than merged. This is a store of API keys sealed into one envelope, so there is no field-by-field reconciliation to do, and a bad merge of it loses keys more quietly than either copy alone would.",
              "Divergence is refused rather than merged. This is a store of API keys sealed into one envelope, so there is no field-by-field reconciliation to do, and a bad merge of it loses keys more quietly than either copy alone would.",
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 rounded-md border border-border/50 bg-card/50 p-2">
          <p className="text-xs font-medium">
            {t("This device's copy", "This device's copy")}
          </p>
          {conflict.local ? (
            <ManifestFacts
              manifest={conflict.local}
              thisDeviceId={thisDeviceId}
              testId="sync-conflict-local"
            />
          ) : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="sync-conflict-local"
            >
              {t(
                "This device has no copy of its own yet.",
                "This device has no copy of its own yet.",
              )}
            </p>
          )}
        </div>
        <div className="space-y-1 rounded-md border border-border/50 bg-card/50 p-2">
          <p className="text-xs font-medium">
            {t("The provider's copy", "The provider's copy")}
          </p>
          <ManifestFacts
            manifest={conflict.remote}
            thisDeviceId={thisDeviceId}
            testId="sync-conflict-remote"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {allowKeepLocal ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onResolve("keep-local")}
          >
            {t("Keep this device's copy", "Keep this device's copy")}
          </Button>
        ) : (
          <span
            className="max-w-xs text-xs text-muted-foreground"
            data-testid="sync-keep-local-unavailable"
          >
            {t(
              "Keeping this device's copy is not offered here: it would archive the provider's copy in favour of keys this screen cannot see. Sign in first to choose that side.",
              "Keeping this device's copy is not offered here: it would archive the provider's copy in favour of keys this screen cannot see. Sign in first to choose that side.",
            )}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onResolve("keep-remote")}
        >
          {t("Keep the provider's copy", "Keep the provider's copy")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Whichever copy you do not keep is stored beside the live one as a timestamped archive. It is not deleted, so picking wrong is not the end of anybody's keys.",
          "Whichever copy you do not keep is stored beside the live one as a timestamped archive. It is not deleted, so picking wrong is not the end of anybody's keys.",
        )}
      </p>
    </div>
  );
}

/**
 * What one `failed` outcome means, in words rather than in its code.
 *
 * Takes the provider because two of the codes cannot be worded once for both.
 * `unreachable` and `provider-error` are raised by the folder engine for a
 * directory on the user's own disk, so "the provider could not be reached"
 * and "the provider answered" name a party that does not exist and never
 * spoke — the same misattribution `ProviderMessage` fixes for the detail
 * line. Fixing only the detail line left a block reading "The provider
 * answered with something this app could not use. The filesystem said: …",
 * which fr-FR, hi-IN and ru-RU each reported independently.
 *
 * The provider comes from the **stored** settings, never the draft, for the
 * reason `OutcomeReport` documents: switching the radio without saving leaves
 * the backend probing the old provider, so a draft-worded failure would
 * describe something that did not happen.
 */
function useFailureText(
  provider: SyncProvider | null,
): (code: SyncFailureCode) => string {
  const { t } = useI18n();
  // Exhaustive with no `default`, like `UndoPreviewDialog.refusalText`: an
  // eleventh code must fail the build here rather than reach a user as a
  // hyphenated identifier in English.
  return useCallback(
    (code: SyncFailureCode): string => {
      switch (code) {
        case "not-configured":
          return t(
            "No provider has been set up on this device, or the one chosen is still missing something it needs: a URL, a username and an app password for Nextcloud, or a folder to write into.",
            "No provider has been set up on this device, or the one chosen is still missing something it needs: a URL, a username and an app password for Nextcloud, or a folder to write into.",
          );
        case "no-passphrase":
          return t(
            "No sync passphrase is set, so there is nothing to seal the bundle with.",
            "No sync passphrase is set, so there is nothing to seal the bundle with.",
          );
        case "unauthorised":
          return t(
            "Nextcloud rejected the credential. An app password that has been revoked, or a username that does not go with it, looks exactly like this.",
            "Nextcloud rejected the credential. An app password that has been revoked, or a username that does not go with it, looks exactly like this.",
          );
        case "unreachable":
          // "nothing was transferred either way" rather than "nothing left
          // this device": this code is reported for a failed pull, preview and
          // conflict resolution as well as a push, so a direction-specific
          // reassurance answers a question the user did not ask. hi-IN's find.
          //
          // The folder wording deliberately does **not** list "a sync client
          // that has not started" among the causes. id-ID traced why: the
          // reachability check is `fs::metadata` plus `is_dir`, and a Dropbox
          // or Syncthing folder stays exactly where it is when the client
          // quits — so a stopped client never produces this error, and naming
          // it here would claim a detection this app does not have.
          return provider === "folder"
            ? t(
                "The folder could not be reached, so nothing was transferred either way. It is not there, or it is not a folder — which usually means an unmounted share or an unplugged disk.",
                "The folder could not be reached, so nothing was transferred either way. It is not there, or it is not a folder — which usually means an unmounted share or an unplugged disk.",
              )
            : t(
                "Nextcloud could not be reached, so nothing was transferred either way.",
                "Nextcloud could not be reached, so nothing was transferred either way.",
              );
        case "provider-error":
          return provider === "folder"
            ? t(
                "The folder could not be used.",
                "The folder could not be used.",
              )
            : t(
                "Nextcloud answered with something this app could not use.",
                "Nextcloud answered with something this app could not use.",
              );
        case "no-remote-blob":
          return t(
            "Nothing has ever been pushed, so there is nothing to pull.",
            "Nothing has ever been pushed, so there is nothing to pull.",
          );
        case "payload-too-new":
          return t(
            "The stored copy was written by a newer version of this app. It was refused rather than read, because reading it wrongly would be worse.",
            "The stored copy was written by a newer version of this app. It was refused rather than read, because reading it wrongly would be worse.",
          );
        case "corrupt":
          return t(
            "The stored bytes do not match their checksum, so the download was refused rather than opened.",
            "The stored bytes do not match their checksum, so the download was refused rather than opened.",
          );
        case "wrong-passphrase":
          return t(
            "That passphrase did not open the envelope.",
            "That passphrase did not open the envelope.",
          );
        case "too-large":
          return t(
            "The sealed bundle is larger than this app will move in one piece. It is refused rather than split, because a partly restored key vault is worse than a refused one.",
            "The sealed bundle is larger than this app will move in one piece. It is refused rather than split, because a partly restored key vault is worse than a refused one.",
          );
      }
    },
    // `provider` is load-bearing, not incidental: two of the codes word
    // themselves from it, so omitting it would memoise the wording of
    // whichever provider was selected first and keep showing it after a
    // switch — the stale-capture version of the misattribution this function
    // was just changed to fix.
    [t, provider],
  );
}

/**
 * A failure's own words, framed by whatever actually produced them.
 *
 * The frame is load-bearing and it cannot be one string. Nextcloud's messages
 * are a server's words, which is why they are labelled as a quotation: an
 * English sentence inside a Japanese screen has to read as something someone
 * else said rather than as a gap in the translation. A folder has no provider
 * to quote — `folder.rs` wraps `std::io::Error` in `SyncError::Provider` at
 * every one of its failure sites, so every message on that path was produced
 * by this machine — and "The provider said: Access is denied." names a party
 * that does not exist.
 *
 * A component rather than a helper taking the text, because both call sites
 * need both literal `t()` calls where `scripts/i18n-coverage.mjs` can see
 * them: a one-argument wrapper would hide the pair from the scanner, which is
 * what `test/i18nNoTranslatorAlias.test.ts` exists to refuse.
 */
/**
 * Whether a failure's detail line should be shown at all.
 *
 * `unreachable` is the one state in which the provider demonstrably said
 * nothing — that is what the headline says — and yet `SyncError::Unreachable`
 * carries a message, which for WebDAV is `reqwest`'s own text. So the block
 * read "Nextcloud could not be reached…" followed by "The provider said:
 * error sending request … dns error: failed to lookup address information":
 * this machine's resolver quoted as the server's words, structurally rather
 * than in some edge case. Found by the ru-RU translator.
 *
 * The folder path is the asymmetry and the reason this is not simply "hide
 * the message on unreachable": `root_now`'s failures also land in
 * `Unreachable`, but there the message really is the OS speaking, so "The
 * filesystem said:" stays true and the detail is worth having. Nothing is
 * lost by suppressing it for Nextcloud, because the headline already names
 * the cause.
 */
function showsDetail(
  code: SyncFailureCode,
  provider: SyncProvider | null,
): boolean {
  return code !== "unreachable" || provider === "folder";
}

function ProviderMessage({
  provider,
  message,
}: {
  provider: SyncProvider | null;
  message: string;
}) {
  const { t } = useI18n();
  return provider === "folder" ? (
    <>
      {t("The filesystem said: {{message}}", {
        message,
        defaultValue: `The filesystem said: ${message}`,
      })}
    </>
  ) : (
    <>
      {t("The provider said: {{message}}", {
        message,
        defaultValue: `The provider said: ${message}`,
      })}
    </>
  );
}

/**
 * The outcome of one action, in that outcome's own words.
 *
 * A conflict is not reported here — it is a question, and `ConflictPanel`
 * asks it.
 */
function OutcomeReport({
  outcome,
  thisDeviceId,
  provider,
  verb,
  testId,
}: {
  outcome: SyncOutcome;
  thisDeviceId: string;
  /**
   * The provider that answered, which is the **stored** one and never the
   * draft: every action reported here runs against what `configure_sync` last
   * wrote, so a half-switched radio must not relabel someone else's error.
   *
   * Read by the `reached` arm and by {@link ProviderMessage}, because what a
   * connection test proves differs in kind between the two engines — one
   * probe reads, the other writes — and a single sentence gets it backwards
   * for one of them.
   */
  provider: SyncProvider | null;
  /** What this action claims when it succeeded. */
  verb: "pushed" | "pulled" | "reached" | "resolved";
  testId: string;
}) {
  const { t } = useI18n();
  const failureText = useFailureText(provider);
  if (outcome.state === "conflict") return null;

  const failed = outcome.state === "failed";
  return (
    <div
      className={
        failed
          ? "space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
          : "space-y-1 rounded-md border border-border/60 bg-card/50 p-2 text-sm"
      }
      data-testid={testId}
      data-outcome={outcome.state}
      role={failed ? "alert" : "status"}
    >
      <div className="flex items-start gap-2">
        {failed ? (
          <XCircle
            className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : (
          <CheckCircle2
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 space-y-1">
          {outcome.state === "failed" ? (
            <p>{failureText(outcome.code)}</p>
          ) : outcome.state === "unchanged" ? (
            <p>
              {t(
                "Both copies already agree, so nothing was transferred.",
                "Both copies already agree, so nothing was transferred.",
              )}
            </p>
          ) : verb === "pushed" ? (
            <p>
              {t("Uploaded as generation {{generation}}.", {
                generation: outcome.manifest.generation,
                defaultValue: `Uploaded as generation ${outcome.manifest.generation}.`,
              })}
            </p>
          ) : verb === "pulled" ? (
            <p>
              {t(
                "This device's keys were replaced with generation {{generation}}.",
                {
                  generation: outcome.manifest.generation,
                  defaultValue: `This device's keys were replaced with generation ${outcome.manifest.generation}.`,
                },
              )}
            </p>
          ) : verb === "resolved" ? (
            <p>
              {t("Settled on generation {{generation}}.", {
                generation: outcome.manifest.generation,
                defaultValue: `Settled on generation ${outcome.manifest.generation}.`,
              })}
            </p>
          ) : provider === "folder" ? (
            // What the folder probe actually proved: it staged an empty file
            // and removed it, so writability is established rather than
            // assumed. See `FolderEngine::probe`.
            <p>
              {t(
                "The folder is there, and this app can write into it.",
                "The folder is there, and this app can write into it.",
              )}
            </p>
          ) : (
            // And what the WebDAV probe did *not* prove. It is a `PROPFIND`
            // with `Depth: 0` asking for `resourcetype` alone, so it
            // establishes that the server answers and the app password
            // authenticates — and nothing about write access. Making it prove
            // writability would let one sentence serve both engines and is
            // arguably better behaviour, but it would start writing to the
            // user's Nextcloud and so belongs in its own change, not in a
            // copy fix.
            <p>
              {t(
                "Nextcloud answered and accepted the app password. Whether this app may write there is not something this check can tell you.",
                "Nextcloud answered and accepted the app password. Whether this app may write there is not something this check can tell you.",
              )}
            </p>
          )}
          {outcome.state === "failed" &&
          outcome.message !== null &&
          showsDetail(outcome.code, provider) ? (
            <p className="text-xs break-all text-muted-foreground">
              <ProviderMessage provider={provider} message={outcome.message} />
            </p>
          ) : null}
          {outcome.state !== "failed" ? (
            <ManifestFacts
              manifest={outcome.manifest}
              thisDeviceId={thisDeviceId}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Pull: preview, then apply.
 *
 * The first step writes nothing. That is the whole point of the dialog — a
 * pull replaces the API keys on this device, so the user has to be told what
 * they are replacing them with before it happens, not afterwards.
 */
function PullDialog({
  open,
  onOpenChange,
  thisDeviceId,
  provider,
  previewPull,
  onPull,
  onOutcome,
  onPreviewConflict,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thisDeviceId: string;
  /** The stored provider, so a failure is attributed to what produced it. */
  provider: SyncProvider | null;
  previewPull: () => Promise<SyncPreviewOutcome>;
  onPull: () => Promise<SyncOutcome>;
  /** Report what the pull answered, so the host can act on a conflict. */
  onOutcome?: (outcome: SyncOutcome) => void;
  /** Report a preview that came back `conflict`, for the same reason. */
  onPreviewConflict?: (outcome: SyncPreviewOutcome) => void;
}) {
  const { t } = useI18n();
  const failureText = useFailureText(provider);
  const [preview, setPreview] = useState<SyncPreviewOutcome | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setPreviewing(false);
      setPreviewError(null);
      setApplying(false);
      setApplyError(null);
      setOutcome(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    void (async () => {
      try {
        const next = await previewPull();
        if (cancelled) return;
        setPreview(next);
        if (next.state === "conflict") onPreviewConflict?.(next);
      } catch (error) {
        if (!cancelled) setPreviewError(errorMessage(error));
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, previewPull, onPreviewConflict]);

  /**
   * Whether the pull may be offered at all.
   *
   * Only a preview that opened the envelope earns the button. A preview that
   * failed has already told us the pull would fail for the same reason — the
   * contract says the two share their failure vocabulary precisely because the
   * conditions are the same — and `wrong-passphrase` is the case that matters:
   * it is discovered here, before anybody's keys have been touched, which is
   * the entire reason this step exists. Offering "replace my keys" under a
   * failed preview would throw that away.
   */
  const installable = preview?.state === "ok";

  const apply = useCallback(async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const next = await onPull();
      setOutcome(next);
      onOutcome?.(next);
    } catch (error) {
      setApplyError(errorMessage(error));
    } finally {
      setApplying(false);
    }
  }, [onPull, onOutcome]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="sync-pull-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("Pull from the provider", "Pull from the provider")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "This replaces the API keys stored on this device with the provider's copy.",
              "This replaces the API keys stored on this device with the provider's copy.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {previewing ? (
            <div
              className="flex items-center gap-2 text-muted-foreground"
              role="status"
              data-testid="sync-pull-previewing"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t(
                "Opening the provider's copy to see what is in it",
                "Opening the provider's copy to see what is in it",
              )}
            </div>
          ) : null}

          {previewError !== null ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"
              role="alert"
              data-testid="sync-pull-preview-error"
            >
              {/* An app-side failure, and only ever that. `settle()` routes
                  `Failure::Refused` — the one variant carrying the provider's
                  words — into `Ok(SyncOutcome::Failed)`, which is reported by
                  `ProviderMessage` further down. A rejection can only be
                  `Failure::Broken`, so this frame must not imply the provider
                  spoke: it did not, and may never have been reached. */}
              {t("This app could not open the provider's copy: {{message}}", {
                message: previewError,
                defaultValue: `This app could not open the provider's copy: ${previewError}`,
              })}
            </p>
          ) : null}

          {preview?.state === "ok" ? (
            <div className="space-y-2" data-testid="sync-pull-preview">
              <p>
                {/* Both counts, because the number that matters is the one
                    being replaced. "It holds 5 keys" invites a pull that
                    silently drops the six this device has. */}
                {t(
                  "The {{local}} key(s) on this device would be replaced by the {{remote}} in the provider's copy.",
                  {
                    local: preview.preview.localKeyCount,
                    remote: preview.preview.keyCount,
                    defaultValue: `The ${preview.preview.localKeyCount} key(s) on this device would be replaced by the ${preview.preview.keyCount} in the provider's copy.`,
                  },
                )}
              </p>
              {preview.preview.localKeyCount > preview.preview.keyCount ? (
                <p
                  className="text-xs text-amber-600 dark:text-amber-400"
                  data-testid="sync-pull-shrinks"
                >
                  {t(
                    "That is fewer keys than this device holds now. The ones not in the provider's copy will be gone from this device.",
                    "That is fewer keys than this device holds now. The ones not in the provider's copy will be gone from this device.",
                  )}
                </p>
              ) : null}
              <ManifestFacts
                manifest={preview.preview.manifest}
                thisDeviceId={thisDeviceId}
              />
            </div>
          ) : null}

          {preview?.state === "failed" ? (
            <div
              className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"
              role="alert"
              data-testid="sync-pull-preview-failed"
            >
              <p>{failureText(preview.code)}</p>
              {preview.message !== null &&
              showsDetail(preview.code, provider) ? (
                <p className="break-all text-muted-foreground">
                  <ProviderMessage
                    provider={provider}
                    message={preview.message}
                  />
                </p>
              ) : null}
              <p className="text-muted-foreground">
                {t(
                  "Nothing on this device has been touched. A pull would fail for the same reason, so it is not offered.",
                  "Nothing on this device has been touched. A pull would fail for the same reason, so it is not offered.",
                )}
              </p>
            </div>
          ) : null}

          {applying ? (
            <div
              className="flex items-center gap-2 text-muted-foreground"
              role="status"
              data-testid="sync-pull-applying"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t("Installing the keys", "Installing the keys")}
            </div>
          ) : null}

          {applyError !== null ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"
              role="alert"
              data-testid="sync-pull-error"
            >
              {/* Same: a rejected invoke, so the words are this app's. */}
              {t("This app could not run the pull: {{message}}", {
                message: applyError,
                defaultValue: `This app could not run the pull: ${applyError}`,
              })}
            </p>
          ) : null}

          {outcome !== null ? (
            <OutcomeReport
              outcome={outcome}
              thisDeviceId={thisDeviceId}
              provider={provider}
              verb="pulled"
              testId="sync-pull-outcome"
            />
          ) : null}

          {outcome?.state === "conflict" || preview?.state === "conflict" ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="sync-pull-diverged"
            >
              {t(
                "The two copies have diverged, so nothing was installed. Close this and settle it under Sync status.",
                "The two copies have diverged, so nothing was installed. Close this and settle it under Sync status.",
              )}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {outcome === null ? t("Cancel", "Cancel") : t("Close", "Close")}
          </Button>
          {outcome === null ? (
            <Button
              type="button"
              size="sm"
              disabled={applying || previewing || !installable}
              onClick={() => void apply()}
            >
              {t("Replace this device's keys", "Replace this device's keys")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SyncSettings({
  section: controlledSection,
  onSectionChange,
  initialSection = "provider",
  allowPush = true,
  previewPull,
}: SyncSettingsProps) {
  const { t, language } = useI18n();
  const sync = useSyncSettings();
  const [ownSection, setOwnSection] =
    useState<SyncSettingsSection>(initialSection);
  const section = controlledSection ?? ownSection;
  const selectSection = (next: SyncSettingsSection) => {
    setOwnSection(next);
    onSectionChange?.(next);
  };

  // Held in a local so that the early return below narrows it for the whole
  // body: every `status.deviceId` after that point is the real thing rather
  // than an empty-string fallback standing in for a state that cannot occur.
  const status = sync.status;
  const settings: SyncSettingsValue | null = status?.settings ?? null;
  const [draft, setDraft] = useState<SyncDraft | null>(null);
  const [credential, setCredential] =
    useState<SyncSecretDraft>(SYNC_SECRET_KEEP);
  const [passphrase, setPassphrase] =
    useState<SyncSecretDraft>(SYNC_SECRET_KEEP);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testOutcome, setTestOutcome] = useState<SyncOutcome | null>(null);
  // The verb travels with the outcome: `resolve_sync_conflict` answers in the
  // same shape a push does, and reporting a kept *remote* copy as "uploaded"
  // would describe the opposite of what happened.
  const [transfer, setTransfer] = useState<{
    outcome: SyncOutcome;
    verb: "pushed" | "pulled" | "resolved";
  } | null>(null);
  const [cadenceAdjustedTo, setCadenceAdjustedTo] = useState<number | null>(
    null,
  );
  const [pullOpen, setPullOpen] = useState(false);

  const dirty =
    settings !== null &&
    draft !== null &&
    syncPanelDirty(draft, settings, credential, passphrase);
  // Read inside the effect below without listing it as a dependency: the
  // effect exists to follow the backend, and a draft that *is* dirty is the
  // one thing it must not overwrite.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (settings === null) return;
    if (dirtyRef.current) return;
    setDraft(syncDraftFromSettings(settings));
  }, [settings]);

  const idPrefix = useId();
  const fieldId = (name: string) => `${idPrefix}-${name}`;

  const save = useCallback(async () => {
    if (draft === null || settings === null) return;
    const requested = draft.autoPushMinutes;
    setBusy(true);
    setActionError(null);
    try {
      await sync.configure(syncSettingsInput(draft, credential, passphrase));
      setCredential(SYNC_SECRET_KEEP);
      setPassphrase(SYNC_SECRET_KEEP);
      setCadenceAdjustedTo(requested);
      // Drop the draft so the screen shows what was *stored*, not what was
      // asked for. The effect above deliberately refuses to overwrite a dirty
      // draft, and a clamped cadence makes the draft dirty against the value
      // that came back — so without this the field kept the number the backend
      // had just rejected, said "Stored as 20 minutes" beside it, and left
      // Save armed to send the rejected number again. A save that landed is
      // the one moment the backend's answer outranks the draft.
      setDraft(null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [draft, settings, sync, credential, passphrase]);

  /**
   * Open the native picker and put what it chose in the draft.
   *
   * Declared up here with the other actions rather than beside the control it
   * belongs to, because everything below the early returns is past a
   * conditional and a hook may not live there.
   *
   * `null` is a cancellation and is left alone deliberately: someone who
   * opened the dialog and closed it still wants the folder they already had,
   * so a cancellation that cleared the path would be the picker destroying
   * the setting it exists to fill. The draft is updated through the functional
   * form so the write lands on whatever the draft is when the dialog closes,
   * which may be seconds after this callback was made.
   */
  const chooseFolder = useCallback(async () => {
    if (settings === null) return;
    setBusy(true);
    setActionError(null);
    try {
      const picked = await sync.pickFolder();
      if (picked === null) return;
      setDraft((previous) => ({
        ...(previous ?? syncDraftFromSettings(settings)),
        folderPath: picked,
      }));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [settings, sync]);

  const discard = useCallback(() => {
    if (settings === null) return;
    setDraft(syncDraftFromSettings(settings));
    setCredential(SYNC_SECRET_KEEP);
    setPassphrase(SYNC_SECRET_KEEP);
    setActionError(null);
  }, [settings]);

  /**
   * Run one network action, keeping its outcome where the user asked for it.
   *
   * A rejection is not an outcome: `SyncOutcome` describes what the backend
   * decided, and a command that never answered has decided nothing. So it
   * goes to `actionError` rather than being dressed up as a `failed` outcome
   * with a code this app made up.
   */
  const runAction = useCallback(
    async (
      action: () => Promise<SyncOutcome>,
      store: (outcome: SyncOutcome | null) => void,
    ) => {
      setBusy(true);
      setActionError(null);
      store(null);
      try {
        store(await action());
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!sync.available) {
    return (
      <p className="rounded-xl border border-border/60 bg-card/60 px-4 py-6 text-sm text-muted-foreground">
        {t(
          // "a folder this machine can see", not "on this machine": a network
          // mount is reachable from here without being here, and the provider
          // description two rows away offers exactly that case.
          "Cloud sync is only available in the desktop app: it writes into a folder this machine can see or talks WebDAV to a Nextcloud server, neither of which a browser can do, and it keeps its secrets in the operating system's keyring.",
          "Cloud sync is only available in the desktop app: it writes into a folder this machine can see or talks WebDAV to a Nextcloud server, neither of which a browser can do, and it keeps its secrets in the operating system's keyring.",
        )}
      </p>
    );
  }

  // The first read failed, so there is no state to show. Rendering the
  // controls over a default object would put an empty provider on screen,
  // which reads as "nothing is set up here" — a claim this screen is in no
  // position to make when it could not ask.
  if (status === null || settings === null) {
    return (
      <div className="min-w-0" data-testid="sync-settings-host">
        {sync.error !== null ? (
          <div
            className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-4 text-sm"
            role="alert"
            data-testid="sync-unreadable"
          >
            <p className="font-medium">
              {t(
                "This screen could not read the sync settings",
                "This screen could not read the sync settings",
              )}
            </p>
            <p className="text-xs break-all text-muted-foreground">
              {sync.error}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "The desktop host did not answer, so the settings below are hidden rather than shown empty: an empty screen would say nothing is set up here, and that is not something this app currently knows.",
                "The desktop host did not answer, so the settings below are hidden rather than shown empty: an empty screen would say nothing is set up here, and that is not something this app currently knows.",
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void sync.reload()}
            >
              {t("Try again", "Try again")}
            </Button>
          </div>
        ) : (
          <div
            className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"
            role="status"
            data-testid="sync-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t("Loading…", "Loading…")}
          </div>
        )}
      </div>
    );
  }

  const current = draft ?? syncDraftFromSettings(settings);
  const provider = current.provider;
  const automatic = current.autoPushMinutes !== null;
  // Not a policy bound — those are the backend's and this screen does not know
  // them — but arithmetic: zero minutes between pushes is not a cadence, so
  // the draft is incomplete rather than wrong, and Save says so instead of
  // sending a number nobody meant.
  const cadenceUnset = automatic && (current.autoPushMinutes ?? 0) <= 0;
  // The bounds the backend will clamp to, read from the status rather than
  // from a constant in this tree.
  const cadenceRange = syncCadenceRange(status);
  const adjustment = syncCadenceAdjustment(
    cadenceAdjustedTo,
    settings.autoPushMinutes,
  );
  const passphraseMissing =
    !settings.passphrasePresent && !syncSecretReplaces(passphrase);
  // Read off the *draft*, not the stored settings, so that choosing a provider
  // and saying what it still needs happen in one pass rather than the warning
  // arriving a save later.
  const missingField = syncProviderIncomplete(current);

  const saveText =
    sync.saveState === "saving"
      ? t("Saving…", "Saving…")
      : sync.saveState === "saved"
        ? t("Saved", "Saved")
        : sync.saveState === "loading"
          ? t("Loading…", "Loading…")
          : sync.saveState === "error"
            ? t("Could not save: {{error}}", {
                error: sync.error ?? "",
                defaultValue: `Could not save: ${sync.error ?? ""}`,
              })
            : cadenceUnset
              ? t(
                  "Give the number of minutes between pushes, or choose manual.",
                  "Give the number of minutes between pushes, or choose manual.",
                )
              : dirty
                ? t("Not saved yet", "Not saved yet")
                : "";

  const setProvider = (next: SyncProvider) => {
    setDraft({ ...current, provider: next });
    // The old answer was about the old provider.
    setTestOutcome(null);
  };

  return (
    <div className="min-w-0 space-y-4" data-testid="sync-settings-host">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="toolbar"
          aria-label={t("Sync settings sections", "Sync settings sections")}
          className="glass-surface glass-sheen glass-fade ui-segment-group scrollbar-themed"
        >
          {SYNC_SETTINGS_SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="ui-segment"
              data-active={section === entry.id}
              aria-pressed={section === entry.id}
              onClick={() => selectSection(entry.id)}
            >
              {t(entry.label, entry.label)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span
            role="status"
            aria-live="polite"
            data-testid="sync-save-state"
            data-state={sync.saveState}
            data-dirty={dirty}
            className={
              sync.saveState === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {saveText}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={!dirty || busy}
            onClick={discard}
          >
            {t("Discard changes", "Discard changes")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="text-xs"
            disabled={!dirty || busy || cadenceUnset}
            data-testid="sync-save"
            onClick={() => void save()}
          >
            {t("Save changes", "Save changes")}
          </Button>
        </div>
      </div>

      {actionError !== null ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
          role="alert"
          data-testid="sync-action-error"
        >
          {actionError}
        </p>
      ) : null}

      {section === "provider" ? (
        <SettingsSection
          title={t("Provider", "Provider")}
          description={t(
            "Where the sealed copy of this device's API keys is kept.",
            "Where the sealed copy of this device's API keys is kept.",
          )}
          testId="sync-section-provider"
        >
          <fieldset
            className="min-w-0 space-y-2 py-3"
            disabled={busy}
            aria-label={t("Sync provider", "Sync provider")}
          >
            <label className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2">
              <input
                type="radio"
                name="sync-provider"
                className="checkbox-themed mt-1 shrink-0"
                value="nextcloud"
                checked={provider === "nextcloud"}
                onChange={() => setProvider("nextcloud")}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-medium">
                  {/* Neither option is ranked over the other. The line that
                      used to name this one "the better-supported option" was
                      about the old Drive engine's token expiring, and there is
                      no token any more — so what is left is the one real
                      difference, which each description states from its own
                      side rather than as a verdict. */}
                  {t(
                    "Nextcloud — reached directly over WebDAV",
                    "Nextcloud — reached directly over WebDAV",
                  )}
                </span>
                <span className="block text-xs break-words text-muted-foreground">
                  {t(
                    "A URL, a username and an app password, which is precisely how Nextcloud expects a third-party client to sign in. This app talks to the server directly, so nothing else has to be running on this device.",
                    "A URL, a username and an app password, which is precisely how Nextcloud expects a third-party client to sign in. This app talks to the server directly, so nothing else has to be running on this device.",
                  )}
                </span>
              </span>
            </label>
            <label className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2">
              <input
                type="radio"
                name="sync-provider"
                className="checkbox-themed mt-1 shrink-0"
                value="folder"
                checked={provider === "folder"}
                onChange={() => setProvider("folder")}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-medium">
                  {/* Deliberately vague about the carrier. A sync client is
                      only one of the three cases the description lists, and
                      naming it in the label presupposed a client that a
                      network mount and a USB stick do not have — the same
                      shape of defect as asserting a WebDAV property of both
                      engines. */}
                  {/* Em dash, matching the Nextcloud label above: the two are
                      answers to one question and have to scan as a pair, and
                      every locale will mirror whatever shape it is handed. */}
                  {t(
                    "A folder this machine can see — carried by something you already have",
                    "A folder this machine can see — carried by something you already have",
                  )}
                </span>
                <span className="block text-xs break-words text-muted-foreground">
                  {t(
                    "Google Drive for desktop, Dropbox, OneDrive, iCloud Drive, Syncthing — or a network mount, or a USB stick. This app writes two files into the folder you choose and something you already trust carries them, so there is no credential here to expire. Whatever carries the folder does have to be working at the time: a sync client running, a share mounted, a disk plugged in.",
                    "Google Drive for desktop, Dropbox, OneDrive, iCloud Drive, Syncthing — or a network mount, or a USB stick. This app writes two files into the folder you choose and something you already trust carries them, so there is no credential here to expire. Whatever carries the folder does have to be working at the time: a sync client running, a share mounted, a disk plugged in.",
                  )}
                </span>
              </span>
            </label>
          </fieldset>

          {provider === "nextcloud" ? (
            <>
              <SettingRow
                htmlFor={fieldId("webdav-url")}
                label={t("WebDAV URL", "WebDAV URL")}
                description={t(
                  "The collection to write into, such as https://cloud.example.test/remote.php/dav/files/alice/better-cloudflare",
                  "The collection to write into, such as https://cloud.example.test/remote.php/dav/files/alice/better-cloudflare",
                )}
              >
                <Input
                  id={fieldId("webdav-url")}
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  className="h-8 w-72 text-sm"
                  value={current.webdavUrl ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({
                      ...current,
                      webdavUrl:
                        event.target.value === "" ? null : event.target.value,
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                htmlFor={fieldId("webdav-username")}
                label={t("WebDAV username", "WebDAV username")}
                description={t(
                  "The Nextcloud account the app password belongs to.",
                  "The Nextcloud account the app password belongs to.",
                )}
              >
                <Input
                  id={fieldId("webdav-username")}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 w-56 text-sm"
                  value={current.webdavUsername ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({
                      ...current,
                      webdavUsername:
                        event.target.value === "" ? null : event.target.value,
                    })
                  }
                />
              </SettingRow>
            </>
          ) : null}

          {provider === "folder" ? (
            <>
              <SettingRow
                label={t("Folder", "Folder")}
                description={t(
                  "Chosen through the system's own folder picker, which is what proved it existed at the moment you chose it. It is not a secret and it is shown back in full, because the whole question this provider asks you to answer is whether the sealed copy is going where you think it is.",
                  "Chosen through the system's own folder picker, which is what proved it existed at the moment you chose it. It is not a secret and it is shown back in full, because the whole question this provider asks you to answer is whether the sealed copy is going where you think it is.",
                )}
                className="items-start"
              >
                <div
                  className="flex min-w-0 flex-col items-start gap-1.5"
                  data-testid="sync-folder-field"
                >
                  {/* Wrapped text rather than a box: the whole path has to be
                      readable, and an input of any width truncates the end of
                      a long one — which is precisely the half that says which
                      folder this is. It is also not typable, because a path
                      typed by hand is the one setting here that fails
                      silently: a typo names a folder that does not exist,
                      which this feature reports as `unreachable` and the user
                      reads as "my drive is offline". */}
                  <span
                    className={
                      current.folderPath === null
                        ? "max-w-xs text-xs text-muted-foreground"
                        : "max-w-xs font-mono text-xs break-all"
                    }
                    data-testid="sync-folder-path"
                  >
                    {current.folderPath ??
                      t("No folder chosen yet", "No folder chosen yet")}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={busy}
                    data-testid="sync-pick-folder"
                    onClick={() => void chooseFolder()}
                  >
                    {t("Choose folder…", "Choose folder…")}
                  </Button>
                </div>
              </SettingRow>
              <div className="space-y-2 py-3 text-xs text-muted-foreground">
                {/* Neither sentence may name an internal. The user never sees
                    the word `unreachable` — that is a `SyncFailureCode` — and
                    a push that succeeded says "Uploaded as generation N", so
                    "would report success" describes a screen that does not
                    exist. The three-step consequence is what earns this
                    paragraph its length and is kept whole. */}
                <p data-testid="sync-folder-absent-note">
                  {t(
                    "A folder that is not there is reported as one that could not be reached, and is never created. A missing folder almost always means an unmounted share or an unplugged disk, and creating it would put the sealed copy on the local disk, underneath where the share should have been: the push would report a new generation, your sync client would never see the bytes, and the mount coming back would hide them again.",
                    "A folder that is not there is reported as one that could not be reached, and is never created. A missing folder almost always means an unmounted share or an unplugged disk, and creating it would put the sealed copy on the local disk, underneath where the share should have been: the push would report a new generation, your sync client would never see the bytes, and the mount coming back would hide them again.",
                  )}
                </p>
                {/* The two real names, spelled out. They are the one thing on
                    this screen a user has to recognise in a file listing, and
                    naming them is also what gives the conflict-copy example
                    an antecedent — "beside these files" pointed at names that
                    appeared nowhere. They are `SYNC_BLOB_NAME` and
                    `SYNC_MANIFEST_NAME`; renaming either means editing this
                    sentence, which is the cost of keeping a filename
                    unlocalised and literal rather than interpolated. */}
                <p data-testid="sync-folder-conflict-copy-note">
                  {t(
                    "This app writes better-cloudflare-vault.enc and better-cloudflare-vault.json, plus a timestamped copy of each beside them when you settle a conflict, and a short-lived file while it saves, and it reads those two exact names and no others. A sync client may leave a conflict copy of its own there too, named something like better-cloudflare-vault (1).enc; it is left alone for you to look at rather than adopted — which also means this app cannot tell you one is there.",
                    "This app writes better-cloudflare-vault.enc and better-cloudflare-vault.json, plus a timestamped copy of each beside them when you settle a conflict, and a short-lived file while it saves, and it reads those two exact names and no others. A sync client may leave a conflict copy of its own there too, named something like better-cloudflare-vault (1).enc; it is left alone for you to look at rather than adopted — which also means this app cannot tell you one is there.",
                  )}
                </p>
              </div>
            </>
          ) : null}

          {/* Both engines write both files, so this is deliberately outside
              the per-provider branches. It began inside the folder one, which
              inverted it: `src/lib/sync/types.ts` justifies the coarse device
              label with "this sits unencrypted in someone else's storage" —
              the Nextcloud case precisely — and `webdav.rs` writes the same
              `SYNC_MANIFEST_NAME` to the server, so the only disclosure that
              the manifest is cleartext was shown exclusively to the users
              whose copy never leaves their own disk. Found by the ja-JP
              translator, who also noticed the sentence named `deviceLabel`
              and silently omitted the `deviceId` sitting beside it — which
              the call-site comment I wrote for this very string already
              listed, so the reasoning had both and the sentence shipped with
              one. The id is on screen elsewhere anyway ("{{label}} · {{id}}"),
              so omitting it protected nothing.

              A privacy disclosure rather than a detail, and its own string
              rather than a clause on the conflict-copy note, which is already
              the longest in the feature and the worst for bidi. */}
          {provider !== null ? (
            <p
              className="py-3 text-xs text-muted-foreground"
              data-testid="sync-manifest-privacy-note"
            >
              {t(
                "Of the two files, better-cloudflare-vault.json is a small unencrypted manifest — a generation number, a checksum, a size, when it was written, and a stable id and a coarse name for the device that wrote it, so that two machines can tell which copy is newer and whose it is. Your keys are only ever in better-cloudflare-vault.enc.",
                "Of the two files, better-cloudflare-vault.json is a small unencrypted manifest — a generation number, a checksum, a size, when it was written, and a stable id and a coarse name for the device that wrote it, so that two machines can tell which copy is newer and whose it is. Your keys are only ever in better-cloudflare-vault.enc.",
              )}
            </p>
          ) : null}

          {provider === null ? (
            <p className="py-3 text-xs text-muted-foreground">
              {/* "set it up" left "it" pointing at the provider, so it read
                  as "choose a provider to set the provider up". What this
                  block stands in for is the per-provider settings below it,
                  so that is what the sentence promises. */}
              {t(
                "Choose a provider to see what it needs.",
                "Choose a provider to see what it needs.",
              )}
            </p>
          ) : providerNeedsCredential(provider) ? (
            <SecretField
              id={fieldId("credential")}
              testId="sync-credential-field"
              label={t("App password", "App password")}
              description={t(
                "Kept in the operating system's keyring, never in this app's settings file, and never read back out to this screen.",
                "Kept in the operating system's keyring, never in this app's settings file, and never read back out to this screen.",
              )}
              present={settings.credentialPresent}
              // Named rather than a bare participle. `presentText` is a prop
              // precisely so it may name its own field, and "Stored on this
              // device" made every gendered locale agree with a noun the
              // string never mentions — correct today only because there is
              // exactly one credential-bearing provider.
              presentText={t(
                "A credential is stored on this device",
                "A credential is stored on this device",
              )}
              absentText={t(
                "Nothing is stored for this provider yet.",
                "Nothing is stored for this provider yet.",
              )}
              draft={credential}
              onChange={setCredential}
              disabled={busy}
            />
          ) : (
            // Not a credential field standing empty. `credentialPresent` is
            // `false` for a folder and always will be, so rendering the field
            // would put "Nothing is stored for this provider yet" on screen as
            // if something were missing, and ask for a secret the backend has
            // no slot to keep and would never read.
            <p
              className="py-3 text-xs text-muted-foreground"
              data-testid="sync-credential-not-needed"
            >
              {t(
                "A folder has nothing to authenticate with, so there is no credential to store: access is decided by the folder's own permissions. The passphrase under Encryption still applies — it seals what is written, not the connection.",
                "A folder has nothing to authenticate with, so there is no credential to store: access is decided by the folder's own permissions. The passphrase under Encryption still applies — it seals what is written, not the connection.",
              )}
            </p>
          )}

          {current.enabled && missingField !== null ? (
            <p
              className="pb-3 text-xs text-amber-600 dark:text-amber-400"
              role="status"
              data-testid="sync-provider-incomplete"
            >
              {/* "as not configured" is gone from all three: `not-configured`
                  is a `SyncFailureCode` and naming it here leaks an internal
                  the user never sees. The passphrase sibling below words the
                  same refusal without it, and all four now match. */}
              {missingField === "folderPath"
                ? t(
                    "Sync is switched on and no folder has been chosen, so every push, pull and conflict resolution will be refused until one is.",
                    "Sync is switched on and no folder has been chosen, so every push, pull and conflict resolution will be refused until one is.",
                  )
                : missingField === "webdavUrl"
                  ? t(
                      "Sync is switched on and no WebDAV URL is set, so every push, pull and conflict resolution will be refused until one is.",
                      "Sync is switched on and no WebDAV URL is set, so every push, pull and conflict resolution will be refused until one is.",
                    )
                  : t(
                      "Sync is switched on and no WebDAV username is set, so every push, pull and conflict resolution will be refused until one is.",
                      "Sync is switched on and no WebDAV username is set, so every push, pull and conflict resolution will be refused until one is.",
                    )}
            </p>
          ) : null}

          <SettingRow
            // "Test connection" outlived the thing it named: a local folder
            // has no connection to test, which is why the description below
            // was reworded and this label should have moved with it. "Access"
            // is what both probes are actually about — one reads, one writes,
            // and both answer "can this device get at the provider".
            label={t("Test access", "Test access")}
            description={
              dirty
                ? t(
                    "This tests the settings already stored, not the unsaved changes above. Save first to test what you have just typed.",
                    "This tests the settings already stored, not the unsaved changes above. Save first to test what you have just typed.",
                  )
                : // What each probe does, because the two differ in kind and a
                  // sentence covering both gets one of them backwards. The
                  // folder's probe writes — a zero-byte staging file it then
                  // removes — which in a folder a sync client is watching is
                  // an event that client may well propagate, so "nothing is
                  // uploaded" would be untrue there. Nextcloud's reads, and
                  // so cannot speak for write access at all.
                  settings.provider === "folder"
                  ? t(
                      "Checks that the folder is there and that this app can write into it, by creating an empty file and removing it again. None of your keys leave this device — though a sync client watching the folder may see that file appear and disappear.",
                      "Checks that the folder is there and that this app can write into it, by creating an empty file and removing it again. None of your keys leave this device — though a sync client watching the folder may see that file appear and disappear.",
                    )
                  : t(
                      "Asks Nextcloud about the collection and nothing else, which is enough to show that the server answers and the app password works. It does not check that this app may write there. Nothing is uploaded.",
                      "Asks Nextcloud about the collection and nothing else, which is enough to show that the server answers and the app password works. It does not check that this app may write there. Nothing is uploaded.",
                    )
            }
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy}
              data-testid="sync-test"
              onClick={() =>
                void runAction(sync.testConnection, setTestOutcome)
              }
            >
              {t("Test access", "Test access")}
            </Button>
          </SettingRow>
          {/* A connection test has no business returning `conflict` — it
              reaches the endpoint and reports on the credential — but
              `SyncOutcome` is the whole union, so the one shape this report
              has no words for is excluded rather than rendered as an empty
              box. */}
          {testOutcome !== null && testOutcome.state !== "conflict" ? (
            <div className="pb-3">
              <OutcomeReport
                outcome={testOutcome}
                thisDeviceId={status.deviceId}
                // `settings.provider`, not `provider`: the test ran against
                // what is stored, which is what the description above says and
                // what the backend actually did. The draft can have moved on.
                provider={settings.provider}
                verb="reached"
                testId="sync-test-outcome"
              />
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {section === "encryption" ? (
        <SettingsSection
          title={t("Encryption", "Encryption")}
          description={t(
            "One passphrase seals the whole bundle before it leaves this device.",
            "One passphrase seals the whole bundle before it leaves this device.",
          )}
          testId="sync-section-encryption"
        >
          <div className="space-y-2 py-3 text-xs text-muted-foreground">
            <p>
              {t(
                "Each API key is already sealed under its own password, but the labels and email addresses around them are not — they are what says which Cloudflare accounts you administer. So the bundle is sealed again as a whole, and the provider sees one opaque envelope rather than a list of your accounts.",
                "Each API key is already sealed under its own password, but the labels and email addresses around them are not — they are what says which Cloudflare accounts you administer. So the bundle is sealed again as a whole, and the provider sees one opaque envelope rather than a list of your accounts.",
              )}
            </p>
            <p data-testid="sync-passphrase-loss">
              {t(
                "This is a second secret to keep, and losing it has a precise cost: you lose the ability to restore from the provider. You do not lose the keys on this device. Those are in the operating system's keyring, still sealed under their own passwords, and nothing on this screen touches them.",
                "This is a second secret to keep, and losing it has a precise cost: you lose the ability to restore from the provider. You do not lose the keys on this device. Those are in the operating system's keyring, still sealed under their own passwords, and nothing on this screen touches them.",
              )}
            </p>
          </div>

          <SecretField
            id={fieldId("passphrase")}
            testId="sync-passphrase-field"
            label={t("Sync passphrase", "Sync passphrase")}
            description={t(
              "Kept in the keyring beside the keys themselves, so an automatic push does not have to stop and ask for it.",
              "Kept in the keyring beside the keys themselves, so an automatic push does not have to stop and ask for it.",
            )}
            present={settings.passphrasePresent}
            presentText={t(
              "A passphrase is set on this device",
              "A passphrase is set on this device",
            )}
            absentText={t(
              "No sync passphrase is set, so there is nothing to seal the bundle with.",
              "No sync passphrase is set, so there is nothing to seal the bundle with.",
            )}
            draft={passphrase}
            onChange={setPassphrase}
            disabled={busy}
          />

          {settings.passphrasePresent && passphrase.mode === "clear" ? (
            <p
              className="pb-3 text-xs text-amber-600 dark:text-amber-400"
              data-testid="sync-passphrase-clear-note"
            >
              {t(
                "Removing it does not delete anything already uploaded. It means this device can no longer open what is there.",
                "Removing it does not delete anything already uploaded. It means this device can no longer open what is there.",
              )}
            </p>
          ) : null}

          {current.enabled && passphraseMissing ? (
            <p
              className="pb-3 text-xs text-amber-600 dark:text-amber-400"
              data-testid="sync-passphrase-missing"
            >
              {/* "a push" understated it. `sync_passphrase` is awaited by
                  `push`, `pull`, `preview` and `resolve` in
                  `commands/sync.rs`, so a pull is refused without one too —
                  and a user reading this while trying to *restore* is in
                  exactly the case the old wording left out. */}
              {t(
                "Sync is switched on and no passphrase is set, so every push, pull and conflict resolution will be refused until one is.",
                "Sync is switched on and no passphrase is set, so every push, pull and conflict resolution will be refused until one is.",
              )}
            </p>
          ) : null}
        </SettingsSection>
      ) : null}

      {section === "schedule" ? (
        <SettingsSection
          title={t("Schedule", "Schedule")}
          description={t(
            "Whether this device syncs at all, and whether it does so on its own.",
            "Whether this device syncs at all, and whether it does so on its own.",
          )}
          testId="sync-section-schedule"
        >
          <SettingRow
            htmlFor={fieldId("enabled")}
            label={t("Sync this device", "Sync this device")}
            description={t(
              "Off, nothing is uploaded or downloaded. The settings and the stored secrets are kept, so turning it back on needs no setting up again.",
              "Off, nothing is uploaded or downloaded. The settings and the stored secrets are kept, so turning it back on needs no setting up again.",
            )}
          >
            <Switch
              id={fieldId("enabled")}
              size="sm"
              checked={current.enabled}
              disabled={busy}
              onCheckedChange={(checked: boolean) =>
                setDraft({ ...current, enabled: checked })
              }
            />
          </SettingRow>

          <fieldset
            className="min-w-0 space-y-2 py-3"
            disabled={busy || !current.enabled}
            aria-label={t("When to push", "When to push")}
          >
            <label className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2">
              <input
                type="radio"
                name="sync-cadence"
                className="checkbox-themed mt-1 shrink-0"
                value="manual"
                checked={!automatic}
                onChange={() => setDraft({ ...current, autoPushMinutes: null })}
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-medium">
                  {t("Manual only", "Manual only")}
                </span>
                <span className="block text-xs break-words text-muted-foreground">
                  {t(
                    "The default. An upload of a credential store should be something you asked for, not something you find out about.",
                    "The default. An upload of a credential store should be something you asked for, not something you find out about.",
                  )}
                </span>
              </span>
            </label>
            <label className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2">
              <input
                type="radio"
                name="sync-cadence"
                className="checkbox-themed mt-1 shrink-0"
                value="automatic"
                checked={automatic}
                onChange={() =>
                  setDraft({
                    ...current,
                    // Whatever the backend last stored, or nothing: this
                    // screen does not know the allowed range, so it does not
                    // invent a starting cadence. The field below is empty
                    // until a number is typed, and the backend has the last
                    // word on it.
                    autoPushMinutes: settings.autoPushMinutes ?? 0,
                  })
                }
              />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-xs font-medium">
                  {t("Automatically", "Automatically")}
                </span>
                <span className="block text-xs break-words text-muted-foreground">
                  {t(
                    "Pushes on its own, as often as you say below.",
                    "Pushes on its own, as often as you say below.",
                  )}
                </span>
              </span>
            </label>
          </fieldset>

          {automatic ? (
            <SettingRow
              htmlFor={fieldId("cadence")}
              label={t("Minutes between pushes", "Minutes between pushes")}
              description={t(
                "An interval outside the allowed range is stored as the nearest one that is allowed. What you see here after saving is what was stored.",
                "An interval outside the allowed range is stored as the nearest one that is allowed. What you see here after saving is what was stored.",
              )}
            >
              <div className="flex flex-col items-end gap-1">
                {/* `min`/`max` come from the status, never from a constant
                    here: they are `MIN_AUTO_PUSH_MINUTES` and
                    `MAX_AUTO_PUSH_MINUTES` in Rust, and the contract carries
                    them precisely so that this field can advertise a range
                    without a second copy of the numbers to drift. The clamp
                    itself stays the backend's — the notice below reports what
                    it decided rather than predicting it. */}
                <Input
                  id={fieldId("cadence")}
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={cadenceRange.min}
                  max={cadenceRange.max}
                  className="h-8 w-28 text-sm"
                  value={
                    current.autoPushMinutes === null ||
                    current.autoPushMinutes === 0
                      ? ""
                      : String(current.autoPushMinutes)
                  }
                  disabled={busy}
                  data-testid="sync-cadence-minutes"
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10);
                    // The note belonged to the cadence that was saved, not to
                    // the one now being typed.
                    setCadenceAdjustedTo(null);
                    setDraft({
                      ...current,
                      autoPushMinutes: Number.isFinite(parsed) ? parsed : 0,
                    });
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  {/* The same key `NumberField` uses, verbatim, so this hint
                      arrives already translated in all twelve locales. */}
                  {t("Between {{min}} and {{max}}", {
                    min: cadenceRange.min,
                    max: cadenceRange.max,
                    defaultValue: `Between ${cadenceRange.min} and ${cadenceRange.max}`,
                  })}
                </p>
                {adjustment !== null ? (
                  <p
                    role="status"
                    className="text-[11px] text-amber-600 dark:text-amber-400"
                    data-testid="sync-cadence-adjusted"
                  >
                    {t("Stored as {{value}} minutes", {
                      value: adjustment,
                      defaultValue: `Stored as ${adjustment} minutes`,
                    })}
                  </p>
                ) : null}
              </div>
            </SettingRow>
          ) : null}
        </SettingsSection>
      ) : null}

      {section === "status" ? (
        <SettingsSection
          title={t("Sync status", "Sync status")}
          description={t(
            "What this device last did, and what the provider currently holds.",
            "What this device last did, and what the provider currently holds.",
          )}
          testId="sync-section-status"
        >
          <SettingRow label={t("This device", "This device")}>
            <span className="text-xs break-all text-muted-foreground">
              {t("{{label}} · {{id}}", {
                label: status.deviceLabel,
                id: status.deviceId,
                defaultValue: `${status.deviceLabel} · ${status.deviceId}`,
              })}
            </span>
          </SettingRow>

          <SettingRow label={t("Last sync", "Last sync")}>
            <span
              className="text-xs text-muted-foreground"
              data-testid="sync-last-synced"
            >
              {settings.lastSyncedAt === null
                ? t(
                    "This device has never completed one.",
                    "This device has never completed one.",
                  )
                : fullTimestamp(settings.lastSyncedAt, language)}
            </span>
          </SettingRow>

          <div className="space-y-1 py-3">
            <p className="text-sm font-medium">
              {t("Last copy this device saw", "Last copy this device saw")}
            </p>
            {status.lastKnown ? (
              <ManifestFacts
                manifest={status.lastKnown}
                thisDeviceId={status.deviceId}
                testId="sync-last-known"
              />
            ) : (
              <p
                className="text-xs text-muted-foreground"
                data-testid="sync-last-known"
              >
                {t(
                  "None yet. Nothing has been pushed or pulled from this device.",
                  "None yet. Nothing has been pushed or pulled from this device.",
                )}
              </p>
            )}
          </div>

          <SettingRow
            label={t("Transfer", "Transfer")}
            description={
              dirty
                ? t(
                    "Save your changes first: a push seals the bundle with the passphrase and credential already stored, not with the ones typed above.",
                    "Save your changes first: a push seals the bundle with the passphrase and credential already stored, not with the ones typed above.",
                  )
                : allowPush
                  ? t(
                      "A push uploads this device's keys. A pull replaces them with the provider's copy, and asks first.",
                      "A push uploads this device's keys. A pull replaces them with the provider's copy, and asks first.",
                    )
                  : t(
                      "A pull replaces this device's keys with the provider's copy, and asks first.",
                      "A pull replaces this device's keys with the provider's copy, and asks first.",
                    )
            }
          >
            {allowPush ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={busy || dirty}
                data-testid="sync-push"
                onClick={() =>
                  void runAction(sync.push, (outcome) =>
                    setTransfer(
                      outcome === null ? null : { outcome, verb: "pushed" },
                    ),
                  )
                }
              >
                {t("Push now", "Push now")}
              </Button>
            ) : (
              // Said rather than omitted. An upload from a host that cannot
              // see this device's keys would seal an empty bundle over the
              // user's only remaining copy, which is the one failure in this
              // feature that cannot be undone from the app.
              <span
                className="max-w-xs text-xs text-muted-foreground"
                data-testid="sync-push-unavailable"
              >
                {t(
                  "Uploading is not offered here: a push seals the keys this device holds, and they are not available on this screen. Sign in first to push.",
                  "Uploading is not offered here: a push seals the keys this device holds, and they are not available on this screen. Sign in first to push.",
                )}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={busy || dirty}
              data-testid="sync-pull"
              onClick={() => setPullOpen(true)}
            >
              {t("Pull…", "Pull…")}
            </Button>
          </SettingRow>

          {transfer !== null && transfer.outcome.state !== "conflict" ? (
            <div className="pb-3">
              <OutcomeReport
                outcome={transfer.outcome}
                thisDeviceId={status.deviceId}
                provider={settings.provider}
                verb={transfer.verb}
                testId="sync-transfer-outcome"
              />
            </div>
          ) : null}

          {transfer?.outcome.state === "conflict" ? (
            <div className="pb-3">
              <ConflictPanel
                conflict={transfer.outcome.conflict}
                thisDeviceId={status.deviceId}
                busy={busy}
                allowKeepLocal={allowPush}
                onResolve={(resolution) =>
                  void runAction(
                    () => sync.resolveConflict(resolution),
                    (outcome) =>
                      setTransfer(
                        outcome === null ? null : { outcome, verb: "resolved" },
                      ),
                  )
                }
              />
            </div>
          ) : null}

          <PullDialog
            open={pullOpen}
            onOpenChange={setPullOpen}
            thisDeviceId={status.deviceId}
            provider={settings.provider}
            previewPull={previewPull ?? sync.previewPull}
            onPull={sync.pull}
            onPreviewConflict={(outcome) => {
              if (outcome.state !== "conflict") return;
              setTransfer({
                outcome: { state: "conflict", conflict: outcome.conflict },
                verb: "pulled",
              });
            }}
            // A pull can come back `conflict` — the contract says so, and
            // `SyncConflict.local` is nullable precisely for a pull onto a
            // device with no copy of its own. The dialog cannot settle it (a
            // modal the user must not close to keep a question is worse than
            // the question), so its outcome is lifted here, where the conflict
            // panel above it is. Without this the dialog's own advice —
            // settle it under Sync status — pointed at a section with nothing
            // to settle.
            onOutcome={(outcome) => setTransfer({ outcome, verb: "pulled" })}
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}
