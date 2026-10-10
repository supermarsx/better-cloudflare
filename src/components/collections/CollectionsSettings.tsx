/**
 * Collections settings: the named sets of API keys that one passphrase opens,
 * and the eight things a user can do to one.
 *
 * Arranged like `SyncSettings` — `SettingsSection` blocks, a state indicator
 * carrying its own attributes so a test need not race it, and the pure rules
 * in `./collections-view.ts` so that what is here is markup, words and one
 * hook call.
 *
 * # Four things this screen must not soften
 *
 * All four are in `@/lib/collections/types`' header with the reasoning. They
 * are repeated to the user here because here is where they matter.
 *
 * 1. **Adding a key is a two-secret operation and cannot be one click.** The
 *    backend has to *read* the key's secret in order to seal it into the
 *    collection, so the key must be openable at that moment — by its own
 *    password or from the OS vault — *and* the collection must be unlocked.
 *    So the Add control is a dialog that asks for the key's own password and
 *    says why, and `key-locked` is worded as the refusal it is rather than
 *    surfacing as a crash. A button that just added a key would be a lie
 *    about what the backend can do, and the contract header says as much.
 * 2. **Deleting a collection loses no keys.** Every key keeps its own
 *    envelope, which is the whole recoverability argument, so a deleted
 *    collection costs the shared passphrase and nothing else — and the
 *    collection does not even have to be unlocked to go. Users assume the
 *    opposite, and the assumption is frightening, so the confirmation says it
 *    outright.
 * 3. **Rotating rotates the collection only.** Each member key's own password
 *    still opens that key afterwards. Saying only "the passphrase was
 *    changed" would let someone believe they had revoked an access they have
 *    not revoked, so the rotate dialog states the caveat *before* the change
 *    and the success line repeats it after.
 * 4. **Unlock state is in memory for the session.** It is false after a
 *    relaunch, always. Nothing here persists it, and nothing here keeps its
 *    own copy of it: {@link isCollectionUnlocked} reads the backend's last
 *    answer and defaults to locked, and every operation re-reads.
 *
 * # Why there is no draft and no Save
 *
 * `SyncSettings` edits a draft and writes it with a button, because its
 * contract takes one settings object. There is no equivalent here. A
 * collection has no editable settings — it has operations, each of which
 * needs a secret — and a passphrase sitting in panel state waiting for a Save
 * would be a secret kept alive for no reason, with a "not saved yet" notice
 * drawing attention to it. So each operation lives in a dialog that is
 * **mounted only while it is open**, which is what makes closing it the thing
 * that discards the typed secret, and this panel has nothing unsaved to warn
 * about. The state indicator therefore carries `data-busy` where the sync
 * panel carries `data-dirty`; see {@link COLLECTIONS_STATE_TESTID}.
 *
 * # Strings, and the one component that could have shared them
 *
 * `SyncSettings`' `SecretField` documents at length what happens when one
 * string has to agree with a noun it cannot see: `"Keep the stored one"`
 * divided three locales, and es-ES agreed with a gender that two fields
 * happened to share. This panel renders a password field five times over —
 * four collection passphrases and one key password — so it is in exactly that
 * position, and the fix the header recommends is taken instead of the hazard:
 * {@link PassphraseField} carries **no prose of its own**. Every sentence
 * around a secret is a literal `t()` call at the call site that knows which
 * secret it is talking about.
 */
import { useCallback, useId, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, Lock, LockOpen, XCircle } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { useCollections } from "@/hooks/collections/use-collections";
import {
  MAX_COLLECTION_LABEL_LENGTH,
  MAX_COLLECTION_MEMBERS,
  type CollectionFailureCode,
  type CollectionOutcome,
  type CollectionRecord,
} from "@/lib/collections/types";
import { fullTimestamp } from "@/lib/notifications/notifications-view";

import {
  ConfirmDialog,
  SettingRow,
  SettingsSection,
} from "../dns/NotificationsSettingsControls";
import {
  collectionActionNeedsUnlock,
  collectionIsFull,
  collectionLabelProblem,
  collectionMemberRows,
  collectionShowsDetail,
  isCollectionUnlocked,
  unassignedKeyRows,
  type CollectionAction,
  type CollectionKeyRow,
  type CollectionKeySummary,
} from "./collections-view";

/**
 * The readiness signal, for tests and for anyone wiring this panel.
 *
 * `data-state` is the hook's state and `data-busy` says whether an operation
 * is in flight. There is deliberately **no `data-dirty`**: the sync panel's
 * dirty flag reports a draft that differs from what is stored, and this panel
 * has no draft — see the header. A `data-dirty="false"` here would be a
 * constant dressed up as a fact.
 *
 * `data-state="idle"` with `data-busy="false"` is the honest point at which
 * the controls are real: the first read has landed and nothing is in flight.
 * There is no effect deriving state from the listing, so unlike the sync panel
 * there is no second commit to wait for — but the signal is still the thing to
 * synchronise on rather than a section's testid, because an operation in
 * flight disables every control and a click on a disabled control does
 * nothing at all.
 */
export const COLLECTIONS_STATE_TESTID = "collections-state";

/**
 * The sections, in nav order.
 *
 * Exported for the reason `SYNC_SETTINGS_SECTIONS` is: the rows live in this
 * file, where the settings-search registry test cannot see them, so a section
 * is the finest thing `settings-search.ts` can name. Unlike the sync panel
 * these are **not** a nav — there are two of them and both are short, so they
 * are rendered together and the host has no open-section to own.
 */
export const COLLECTIONS_SETTINGS_SECTIONS: readonly {
  id: "collections" | "unassigned";
  /** English label; rendered through `t(label, label)`. */
  label: string;
}[] = [
  { id: "collections", label: "Collections" },
  { id: "unassigned", label: "Keys in no collection" },
];

export interface CollectionsSettingsProps {
  /**
   * The stored API keys, for turning ids into names.
   *
   * A prop rather than a read of its own, and this is a gap in the contract
   * rather than a preference: `CollectionsOverview` carries `memberIds` and
   * `unassignedKeyIds` and nothing that resolves either to a label, while the
   * contract header is explicit that a key's label stays cleartext in
   * `bc-storage` and is deliberately *not* sealed a second time. So the names
   * have to come from whoever already holds the key list — `DNSManager` and
   * the login screen both do — and a panel that read them itself would be a
   * second copy of that list to keep in step.
   *
   * Defaulting to empty is not a fallback so much as the honest rendering of
   * "this host did not say": a row whose id is in no summary renders as a
   * remark about the drift rather than as a blank line.
   */
  keys?: readonly CollectionKeySummary[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What one `failed` outcome means, in words rather than in its code.
 *
 * Takes the action as well as the code, which is the collections analogue of
 * `useFailureText`'s provider argument in `SyncSettings`: three of the codes
 * cannot be worded once for every operation that can raise them. The clearest
 * is `wrong-passphrase` — when unlocking, the passphrase simply did not open
 * the collection; when rotating, it was the *current* one that was wrong and
 * the reassurance the user needs is that nothing was changed. One sentence for
 * both gets the second one's reassurance wrong, which on this screen means
 * leaving someone unsure whether their passphrase is now the new one.
 *
 * The four refusals about a missing or wrong secret — `locked`,
 * `no-passphrase`, `wrong-passphrase`, `key-locked` — are a deliberate set,
 * near-identical in shape and each naming a *different* missing thing. That is
 * the point of them: which secret is missing is the only thing the user can
 * act on. They want translating as a set.
 */
function useFailureText(): (
  code: CollectionFailureCode,
  action: CollectionAction,
) => string {
  const { t } = useI18n();
  // Exhaustive with no `default`: a fourteenth code must fail the build here
  // rather than reach a user as a hyphenated identifier in English.
  return useCallback(
    (code: CollectionFailureCode, action: CollectionAction): string => {
      switch (code) {
        case "not-found":
          return t(
            "That collection is no longer there. Another window may have deleted it.",
            "That collection is no longer there. Another window may have deleted it.",
          );
        case "locked":
          return t(
            "This collection is locked, so this app does not hold the passphrase it needs. Unlock it and try again.",
            "This collection is locked, so this app does not hold the passphrase it needs. Unlock it and try again.",
          );
        case "wrong-passphrase":
          // Two sentences for one code, because the reassurance differs. A
          // rotation that failed on the current passphrase has changed
          // nothing, and someone who is not told that has to guess which
          // passphrase their collection now has.
          return action === "rotate"
            ? t(
                "The current passphrase you typed did not open this collection, so the passphrase was not changed.",
                "The current passphrase you typed did not open this collection, so the passphrase was not changed.",
              )
            : t(
                "That passphrase did not open this collection.",
                "That passphrase did not open this collection.",
              );
        case "no-passphrase":
          // Not "no passphrase was supplied", which told a user who had just
          // typed one that they had not. No user can reach this code: the
          // Rust raises it only on `passphrase.is_empty()`, with a test
          // pinning that whitespace is a *weak* passphrase and not an absent
          // one; all three UI routes that carry a passphrase gate on
          // non-empty (create, unlock, rotate); and `CollectionVault::unlock`
          // verifies through `require_passphrase` before inserting, so
          // add-key and remove-key inherit a non-empty one. The one field
          // that may legitimately be empty answers `key-locked` instead.
          //
          // So this is an app-side failure wearing a user-side sentence, and
          // the repair is the construction two sync strings already use for
          // the same reason — "This app could not open the provider's copy",
          // "This app could not run the pull". Proved by the fr-FR
          // translator, who traced each of the thirteen codes to what can
          // actually raise it rather than reading the sentences.
          //
          // Third wording, and the second correction is the zh-CN
          // translator's. "This app could not supply the passphrase this
          // operation needs" fixed the false blame but said what `locked`
          // already says — that the app lacks the passphrase it needs — so it
          // collapsed the one property the header above insists this set of
          // four has. It also dropped the consequence clause every other
          // refusal here carries. This wording keeps all three: a *different*
          // missing thing (not sent, against `locked`'s not held), the
          // outcome, and the app as the actor that failed.
          return t(
            "This app did not send a passphrase, so nothing was opened or sealed.",
            "This app did not send a passphrase, so nothing was opened or sealed.",
          );
        case "already-member":
          // The contract collapses "already in this one" and "in a different
          // one" into a single code, so the sentence has to cover both — and
          // the exclusivity rule is the part the user can act on, because it
          // is what makes the second case a thing they have to undo
          // elsewhere.
          return t(
            "That key is already in a collection. A key belongs to at most one, so remove it from the collection it is in before adding it here.",
            "That key is already in a collection. A key belongs to at most one, so remove it from the collection it is in before adding it here.",
          );
        case "not-a-member":
          return t(
            "That key is not in this collection, so there was nothing to remove.",
            "That key is not in this collection, so there was nothing to remove.",
          );
        case "key-locked":
          // The two-secret constraint, as the sentence someone stuck on it
          // needs. It says what the backend was trying to do, because "could
          // not open the key" on its own reads as a fault rather than as a
          // step that is missing its password.
          //
          // "the key's own password is needed here" used to end it, which
          // reads as *absent* — and this one code covers two cases. The
          // backend raises it both when no password was supplied and no OS
          // vault entry exists, and when a supplied password fails the tag
          // check: `key_secret` in `commands/collections.rs` has a branch and
          // a test for each. Found from the sentence by the fr-FR translator,
          // tracing all thirteen codes to what can raise them, and from the
          // code by the agent who wrote that branch, independently.
          //
          // Reworded rather than split into a fourteenth code, because the
          // user acts identically on both: supply the key's password and
          // retry. A second code would cost a contract change, a crate change
          // and a sentence in twelve locales to express a distinction nobody
          // does anything different about. "wrong or missing" is the whole
          // fix, and the backend's two branches stay as they are.
          return t(
            "That key could not be opened, so there was no secret to seal into this collection. A collection has to read a key's secret in order to wrap it, and the password given for it was wrong or missing.",
            "That key could not be opened, so there was no secret to seal into this collection. A collection has to read a key's secret in order to wrap it, and the password given for it was wrong or missing.",
          );
        case "too-large":
          // Both halves of the code, because the member cap is checked before
          // the seal and the seal can still refuse under it. Naming only the
          // cap would be a sentence that contradicts the screen, which can
          // see the collection is below it.
          return t(
            "This collection cannot take another key: it has reached either the limit of {{limit}} keys or the size this app will seal in one piece.",
            {
              limit: MAX_COLLECTION_MEMBERS,
              defaultValue: `This collection cannot take another key: it has reached either the limit of ${MAX_COLLECTION_MEMBERS} keys or the size this app will seal in one piece.`,
            },
          );
        case "duplicate-label":
          return t(
            "A collection with that name already exists on this device.",
            "A collection with that name already exists on this device.",
          );
        case "invalid-label":
          return t(
            "A collection needs a name of between one and {{limit}} characters.",
            {
              limit: MAX_COLLECTION_LABEL_LENGTH,
              defaultValue: `A collection needs a name of between one and ${MAX_COLLECTION_LABEL_LENGTH} characters.`,
            },
          );
        case "corrupt":
          return t(
            "This collection's stored bytes could not be read as a collection. They were refused rather than guessed at.",
            "This collection's stored bytes could not be read as a collection. They were refused rather than guessed at.",
          );
        case "payload-too-new":
          return t(
            "This collection was written by a newer version of this app. It was refused rather than read, because reading it wrongly would be worse.",
            "This collection was written by a newer version of this app. It was refused rather than read, because reading it wrongly would be worse.",
          );
        case "backend-error":
          // The only code with no cause of its own: the message below it is
          // all the content there is, which is why `collectionShowsDetail`
          // lets it through.
          return t(
            "The desktop app refused this operation.",
            "The desktop app refused this operation.",
          );
      }
    },
    [t],
  );
}

/** What one `ok` outcome claims, which differs per operation. */
function useSuccessText(): (action: CollectionAction) => string {
  const { t } = useI18n();
  return useCallback(
    (action: CollectionAction): string => {
      switch (action) {
        case "create":
          return t(
            "The collection was created.",
            "The collection was created.",
          );
        case "rename":
          return t(
            "The collection was renamed.",
            "The collection was renamed.",
          );
        case "delete":
          // The reassurance is repeated after the fact as well as before it:
          // the confirmation explains it, and this is what the user reads
          // once the thing is actually gone.
          return t(
            "The collection was deleted. No key was lost.",
            "The collection was deleted. No key was lost.",
          );
        case "unlock":
          return t(
            "This collection is unlocked. It stays unlocked until this app closes.",
            "This collection is unlocked. It stays unlocked until this app closes.",
          );
        case "lock":
          return t(
            "This collection is locked. Its passphrase is no longer held in memory.",
            "This collection is locked. Its passphrase is no longer held in memory.",
          );
        case "add-key":
          return t(
            "The key was added to this collection.",
            "The key was added to this collection.",
          );
        case "remove-key":
          return t(
            "The key was removed from this collection. The key itself is untouched and still opens with its own password.",
            "The key was removed from this collection. The key itself is untouched and still opens with its own password.",
          );
        case "rotate":
          // The caveat, after the fact. The dialog says it before as well,
          // because someone rotating in a hurry reads one of the two.
          return t(
            "This collection's passphrase was changed. Each key in it keeps its own password, and that password still opens that key.",
            "This collection's passphrase was changed. Each key in it keeps its own password, and that password still opens that key.",
          );
      }
    },
    [t],
  );
}

/**
 * The outcome of one operation, in that outcome's own words.
 *
 * The verbatim `message` is framed rather than printed bare, for the reason
 * sync's `ProviderMessage` is: an English sentence inside a Japanese screen
 * has to read as something someone else said rather than as a gap in the
 * translation. There is only one party who can be speaking here — these
 * messages come from this app's own desktop backend, not from a server — so
 * unlike sync's two frames there is one, and it is a literal `t()` call at the
 * one place it is used.
 */
function OutcomeReport({
  outcome,
  action,
  testId,
}: {
  outcome: CollectionOutcome;
  action: CollectionAction;
  testId: string;
}) {
  const { t } = useI18n();
  const failureText = useFailureText();
  const successText = useSuccessText();
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
      data-action={action}
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
          <p>
            {outcome.state === "failed"
              ? failureText(outcome.code, action)
              : successText(action)}
          </p>
          {outcome.state === "failed" &&
          outcome.message !== null &&
          collectionShowsDetail(outcome.code) ? (
            <p className="text-xs break-all text-muted-foreground">
              {t("The desktop app said: {{message}}", {
                message: outcome.message,
                defaultValue: `The desktop app said: ${outcome.message}`,
              })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A labelled password box, and nothing else.
 *
 * Carries no prose of its own on purpose — see the file header. The label
 * arrives as a prop from a call site that knows whether it is asking for a
 * collection's passphrase or a key's own password, so no string in here has to
 * agree with a noun it cannot see.
 */
function PassphraseField({
  id,
  label,
  value,
  onChange,
  disabled,
  autoFocus,
  testId,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  testId: string;
  /** Said by the call site, where the subject of the sentence is known. */
  hint?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="h-8 text-sm"
        data-testid={testId}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * The frame every operation dialog shares: a title, a description, the
 * controls, the refusal if there was one, and two buttons.
 *
 * Structure is shared; words are not. Every string except `Cancel` arrives as
 * a prop, which is the split the `SecretField` header argues for — a shared
 * component may not hold a sentence that has to agree with a subject only its
 * caller knows. `Cancel` is safe because it is an imperative with no subject
 * to agree with, and it is already the string `ConfirmDialog` shares.
 *
 * The dialog is rendered by its caller only while it is open, so the state in
 * here — including a typed passphrase — is created on open and destroyed on
 * close. That is deliberate and it is the reason the caller does not keep a
 * draft.
 */
function CollectionDialog({
  title,
  description,
  testId,
  confirmLabel,
  confirmDisabled,
  busy,
  outcome,
  action,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  description: ReactNode;
  testId: string;
  confirmLabel: string;
  confirmDisabled: boolean;
  busy: boolean;
  /** The last refusal, kept on screen so the dialog can be retried. */
  outcome: CollectionOutcome | null;
  action: CollectionAction;
  children: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {children}
          {outcome !== null ? (
            <OutcomeReport
              outcome={outcome}
              action={action}
              testId="collection-dialog-outcome"
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onClose}
          >
            {t("Cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid={`${testId}-confirm`}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a label the backend will refuse should say, if anything. */
function useLabelProblemText(): (
  problem: "empty" | "too-long" | "duplicate" | null,
) => string | null {
  const { t } = useI18n();
  return useCallback(
    (problem) => {
      if (problem === null) return null;
      if (problem === "empty") {
        return t("A collection needs a name.", "A collection needs a name.");
      }
      if (problem === "too-long") {
        return t(
          "A collection's name may be at most {{limit}} characters long.",
          {
            limit: MAX_COLLECTION_LABEL_LENGTH,
            defaultValue: `A collection's name may be at most ${MAX_COLLECTION_LABEL_LENGTH} characters long.`,
          },
        );
      }
      return t(
        "A collection with that name already exists on this device.",
        "A collection with that name already exists on this device.",
      );
    },
    [t],
  );
}

/** One key, as a line in a list. */
function KeyLine({ row }: { row: CollectionKeyRow }) {
  const { t } = useI18n();
  if (row.label === null) {
    return (
      <span className="text-xs break-all text-muted-foreground">
        {/* Not expected, and not silent either: `memberIds` is a cleartext
            index kept beside the key records rather than inside them, so an id
            with no key is drift, and a blank row would be the worst way to
            learn of it. */}
        {t("A key that is no longer stored on this device ({{id}})", {
          id: row.id,
          defaultValue: `A key that is no longer stored on this device (${row.id})`,
        })}
      </span>
    );
  }
  return (
    <span className="min-w-0 text-xs">
      <span className="font-medium break-all">{row.label}</span>
      {row.email !== null ? (
        <span className="break-all text-muted-foreground"> {row.email}</span>
      ) : null}
    </span>
  );
}

export function CollectionsSettings({
  keys = [],
}: CollectionsSettingsProps = {}) {
  const { t } = useI18n();
  const collections = useCollections();
  const labelProblemText = useLabelProblemText();

  const overview = collections.overview;
  const busy = collections.state === "working";

  /** The last operation's answer, and which operation it answered. */
  const [report, setReport] = useState<{
    outcome: CollectionOutcome;
    action: CollectionAction;
  } | null>(null);
  /** A rejection — a dead host — as opposed to a refusal. */
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Which dialog is open, if any.
   *
   * One at a time and mounted only while open, so a typed secret exists only
   * for as long as the dialog the user is looking at.
   */
  const [dialog, setDialog] = useState<
    | { kind: "create" }
    | { kind: "unlock" | "rename" | "rotate" | "add-key"; id: string }
    | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const idPrefix = useId();
  const fieldId = (name: string) => `${idPrefix}-${name}`;

  /**
   * Run one operation, and sort its three possible endings.
   *
   * A rejection is not a refusal: an unregistered command or a dead host is a
   * broken host, and reporting it as a `failed` outcome would word it as one
   * of the thirteen refusals the backend never gave. It goes to its own alert,
   * beside the control that was pressed.
   */
  const run = useCallback(
    async (
      action: CollectionAction,
      call: () => Promise<CollectionOutcome>,
    ): Promise<CollectionOutcome | null> => {
      setActionError(null);
      setReport(null);
      try {
        const outcome = await call();
        // Both endings are reported, not just the good one. Three operations
        // — lock, remove-key and delete — are pressed directly rather than
        // from a dialog, so a refusal of one of those has nowhere else to go,
        // and a silently refused Lock is a collection the user believes is
        // closed.
        setReport({ outcome, action });
        return outcome;
      } catch (error) {
        setActionError(errorMessage(error));
        return null;
      }
    },
    [],
  );

  if (!collections.available) {
    return (
      <p
        className="px-4 py-6 text-sm text-muted-foreground"
        data-testid="collections-web-notice"
      >
        {t(
          "Collections are only available in the desktop app: a collection's passphrase is held in memory by the desktop app and each key's secret is sealed there, neither of which a browser can do.",
          "Collections are only available in the desktop app: a collection's passphrase is held in memory by the desktop app and each key's secret is sealed there, neither of which a browser can do.",
        )}
      </p>
    );
  }

  // The first read failed, so there is no state to show. Rendering an empty
  // list instead would say no collection has been created here, which is not
  // something this screen is in a position to claim when it could not ask.
  if (overview === null) {
    return (
      <div className="min-w-0" data-testid="collections-settings-host">
        {collections.error !== null ? (
          <div
            className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-4 text-sm"
            role="alert"
            data-testid="collections-unreadable"
          >
            <p className="font-medium">
              {t(
                "This screen could not read the collections",
                "This screen could not read the collections",
              )}
            </p>
            <p className="text-xs break-all text-muted-foreground">
              {collections.error}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "The desktop app did not answer, so nothing is listed rather than listed as empty: an empty list would say no collection has been created here, and that is not something this app currently knows.",
                "The desktop app did not answer, so nothing is listed rather than listed as empty: an empty list would say no collection has been created here, and that is not something this app currently knows.",
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void collections.reload()}
            >
              {t("Try again", "Try again")}
            </Button>
          </div>
        ) : (
          <div
            className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"
            role="status"
            data-testid="collections-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t("Loading…", "Loading…")}
          </div>
        )}
      </div>
    );
  }

  const open = dialog;
  const openRecord =
    open !== null && open.kind !== "create"
      ? (overview.collections.find((entry) => entry.id === open.id) ?? null)
      : null;
  const deleting =
    confirmDelete === null
      ? null
      : (overview.collections.find((entry) => entry.id === confirmDelete) ??
        null);
  const unassigned = unassignedKeyRows(overview, keys);

  const stateText =
    collections.state === "loading"
      ? t("Loading…", "Loading…")
      : collections.state === "working"
        ? t("Working…", "Working…")
        : "";

  return (
    <div className="min-w-0 space-y-4" data-testid="collections-settings-host">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          role="status"
          aria-live="polite"
          data-testid={COLLECTIONS_STATE_TESTID}
          data-state={collections.state}
          data-busy={busy}
          className="text-xs text-muted-foreground"
        >
          {stateText}
        </span>
        <Button
          type="button"
          size="sm"
          className="text-xs"
          data-testid="collection-create"
          disabled={busy}
          onClick={() => setDialog({ kind: "create" })}
        >
          {t("Create a collection", "Create a collection")}
        </Button>
      </div>

      {actionError !== null ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
          role="alert"
          data-testid="collections-action-error"
        >
          {actionError}
        </p>
      ) : null}

      {report !== null ? (
        <OutcomeReport
          outcome={report.outcome}
          action={report.action}
          testId="collection-outcome"
        />
      ) : null}

      <SettingsSection
        title={t("Collections", "Collections")}
        description={t(
          "A collection seals several API keys under one passphrase, so unlocking it once makes all of them usable. Every key in a collection also keeps its own password, and that password still opens that key on its own.",
          "A collection seals several API keys under one passphrase, so unlocking it once makes all of them usable. Every key in a collection also keeps its own password, and that password still opens that key on its own.",
        )}
        testId="collections-section-list"
      >
        {overview.collections.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">
            {t(
              "No collection has been created on this device yet.",
              "No collection has been created on this device yet.",
            )}
          </p>
        ) : (
          <div className="space-y-3 py-3">
            {overview.collections.map((record) => (
              <CollectionCard
                key={record.id}
                record={record}
                unlocked={isCollectionUnlocked(overview, record.id)}
                keys={keys}
                busy={busy}
                onUnlock={() => setDialog({ kind: "unlock", id: record.id })}
                onLock={() =>
                  void run("lock", () => collections.lock(record.id))
                }
                onRename={() => setDialog({ kind: "rename", id: record.id })}
                onRotate={() => setDialog({ kind: "rotate", id: record.id })}
                onDelete={() => setConfirmDelete(record.id)}
                onAddKey={() => setDialog({ kind: "add-key", id: record.id })}
                onRemoveKey={(keyId) =>
                  void run("remove-key", () =>
                    collections.removeKey(record.id, keyId),
                  )
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t("Keys in no collection", "Keys in no collection")}
        description={t(
          "These keys are in no collection. Each one opens with its own password, or from the operating system's vault, exactly as it always has — a collection is something extra and nothing is forced into one.",
          "These keys are in no collection. Each one opens with its own password, or from the operating system's vault, exactly as it always has — a collection is something extra and nothing is forced into one.",
        )}
        testId="collections-section-unassigned"
      >
        {unassigned.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">
            {t(
              "Every stored key is in a collection.",
              "Every stored key is in a collection.",
            )}
          </p>
        ) : (
          <ul className="space-y-1 py-3" data-testid="collections-unassigned">
            {unassigned.map((row) => (
              <li key={row.id} className="flex min-w-0">
                <KeyLine row={row} />
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {open !== null && open.kind === "create" ? (
        <CreateDialog
          collections={overview.collections}
          busy={busy}
          fieldId={fieldId}
          labelProblemText={labelProblemText}
          onClose={() => setDialog(null)}
          onCreate={(label, passphrase) =>
            run("create", () => collections.create(label, passphrase))
          }
        />
      ) : null}

      {open !== null && open.kind === "unlock" && openRecord !== null ? (
        <UnlockDialog
          record={openRecord}
          busy={busy}
          fieldId={fieldId}
          onClose={() => setDialog(null)}
          onUnlock={(passphrase) =>
            run("unlock", () => collections.unlock(openRecord.id, passphrase))
          }
        />
      ) : null}

      {open !== null && open.kind === "rename" && openRecord !== null ? (
        <RenameDialog
          record={openRecord}
          collections={overview.collections}
          busy={busy}
          fieldId={fieldId}
          labelProblemText={labelProblemText}
          onClose={() => setDialog(null)}
          onRename={(label) =>
            run("rename", () => collections.rename(openRecord.id, label))
          }
        />
      ) : null}

      {open !== null && open.kind === "rotate" && openRecord !== null ? (
        <RotateDialog
          record={openRecord}
          busy={busy}
          fieldId={fieldId}
          onClose={() => setDialog(null)}
          onRotate={(current, next) =>
            run("rotate", () =>
              collections.rotate(openRecord.id, current, next),
            )
          }
        />
      ) : null}

      {open !== null && open.kind === "add-key" && openRecord !== null ? (
        <AddKeyToCollectionDialog
          record={openRecord}
          candidates={unassigned}
          busy={busy}
          fieldId={fieldId}
          onClose={() => setDialog(null)}
          onAdd={(keyId, keyPassword) =>
            run("add-key", () =>
              collections.addKey(openRecord.id, keyId, keyPassword),
            )
          }
        />
      ) : null}

      {deleting !== null ? (
        <ConfirmDialog
          open
          title={t("Delete {{label}}?", {
            label: deleting.label,
            defaultValue: `Delete ${deleting.label}?`,
          })}
          description={t(
            "No key is lost. Every key in this collection is also sealed under its own password, so deleting this collection takes away only the shared passphrase and leaves every key usable exactly as before. This collection does not even have to be unlocked to be deleted.",
            "No key is lost. Every key in this collection is also sealed under its own password, so deleting this collection takes away only the shared passphrase and leaves every key usable exactly as before. This collection does not even have to be unlocked to be deleted.",
          )}
          confirmLabel={t("Delete this collection", "Delete this collection")}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const id = deleting.id;
            setConfirmDelete(null);
            void run("delete", () => collections.deleteCollection(id));
          }}
        />
      ) : null}
    </div>
  );
}

/** One collection, with everything that can be done to it. */
function CollectionCard({
  record,
  unlocked,
  keys,
  busy,
  onUnlock,
  onLock,
  onRename,
  onRotate,
  onDelete,
  onAddKey,
  onRemoveKey,
}: {
  record: CollectionRecord;
  unlocked: boolean;
  keys: readonly CollectionKeySummary[];
  busy: boolean;
  onUnlock: () => void;
  onLock: () => void;
  onRename: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onAddKey: () => void;
  onRemoveKey: (keyId: string) => void;
}) {
  const { t, language } = useI18n();
  const members = collectionMemberRows(record, keys);
  const full = collectionIsFull(record);
  // Asked separately per operation rather than once as "is it unlocked",
  // because which operations need the derived key is a fact about the
  // contract and belongs in the one function that states it. Two reads of it
  // also means a mutation that gets one of them wrong cannot hide behind the
  // other.
  const canAdd = !collectionActionNeedsUnlock("add-key") || unlocked;
  const canRemove = !collectionActionNeedsUnlock("remove-key") || unlocked;

  return (
    <div
      className="space-y-2 rounded-lg border border-border/50 bg-card/50 p-3"
      data-testid={`collection-${record.id}`}
      data-unlocked={unlocked}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium break-all">{record.label}</p>
          <p
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid={`collection-${record.id}-lock-state`}
          >
            {unlocked ? (
              <LockOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {/* Full sentences rather than the adjectives "Unlocked" and
                "Locked": a bare participle has to agree with a noun that is
                not in the string, which is the hazard `SecretField`'s header
                spent three locales learning. */}
            {unlocked
              ? t("This collection is unlocked", "This collection is unlocked")
              : t("This collection is locked", "This collection is locked")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {unlocked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              data-testid={`collection-${record.id}-lock`}
              disabled={busy}
              onClick={onLock}
            >
              {t("Lock this collection", "Lock this collection")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              data-testid={`collection-${record.id}-unlock`}
              disabled={busy}
              onClick={onUnlock}
            >
              {t("Unlock this collection", "Unlock this collection")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs"
            data-testid={`collection-${record.id}-rename`}
            disabled={busy}
            onClick={onRename}
          >
            {t("Rename", "Rename")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs"
            data-testid={`collection-${record.id}-rotate`}
            disabled={busy}
            onClick={onRotate}
          >
            {t("Change the passphrase", "Change the passphrase")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs text-destructive"
            data-testid={`collection-${record.id}-delete`}
            disabled={busy}
            onClick={onDelete}
          >
            {t("Delete", "Delete")}
          </Button>
        </div>
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">
          {/* Phrased as a label and a number rather than as "{{n}} keys": a
              counted noun needs a plural form, and a suffixed `_one` key is
              counted as an extra key by the coverage gate. */}
          {t("Keys in this collection", "Keys in this collection")}
        </dt>
        <dd data-testid={`collection-${record.id}-member-count`}>
          {record.memberIds.length}
        </dd>
        <dt className="text-muted-foreground">{t("Created", "Created")}</dt>
        <dd>{fullTimestamp(record.createdAt, language)}</dd>
        <dt className="text-muted-foreground">
          {/* NOT true of a rename, and this comment used to claim it was.
              `bc-collections/src/lib.rs:341` is explicit — "`updated_at` does
              not move: the contract defines it as the time of the last
              re-seal, and a rename re-seals nothing" — and `lib.rs:1059` pins
              it with `assert_eq!(renamed.updated_at, sealed.record.updated_at)`.
              So this field is the last *re-seal*, and "Last changed"
              over-claims: renaming a collection changes it and leaves this
              timestamp where it was.

              The label is left as it stands pending a decision, because the
              two honest repairs cost differently: relabel it (one key, eleven
              translations, no behaviour change) or make `rename` bump
              `updated_at` (a crate change against a deliberate contract
              decision, which would make "Last changed" true). Found by the
              de-DE translator, who checked the comment against the crate
              rather than translating the label it justifies. */}
          {t("Last changed", "Last changed")}
        </dt>
        <dd>{fullTimestamp(record.updatedAt, language)}</dd>
      </dl>

      <SettingRow
        label={t("Keys in this collection", "Keys in this collection")}
        description={t(
          "Removing a key from this collection does not delete the key. It goes back to opening with its own password only.",
          "Removing a key from this collection does not delete the key. It goes back to opening with its own password only.",
        )}
        className="items-start"
      >
        <div className="flex min-w-0 flex-col items-stretch gap-2">
          {canAdd ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              data-testid={`collection-${record.id}-add-key`}
              disabled={busy || full}
              onClick={onAddKey}
            >
              {t("Add a key", "Add a key")}
            </Button>
          ) : (
            <span
              className="max-w-xs text-xs text-muted-foreground"
              data-testid={`collection-${record.id}-locked-notice`}
            >
              {/* Replaced by a sentence rather than simply absent: a control
                  that has vanished reads as a bug, and this one's absence is
                  the point. The same reasoning `SyncSettings` applies to its
                  withheld push. */}
              {t(
                "This collection has to be unlocked before a key can be added to it or removed from it. Both of those change what the passphrase seals, so both need it.",
                "This collection has to be unlocked before a key can be added to it or removed from it. Both of those change what the passphrase seals, so both need it.",
              )}
            </span>
          )}
          {full ? (
            <span
              className="max-w-xs text-xs text-muted-foreground"
              data-testid={`collection-${record.id}-full-notice`}
            >
              {t(
                "This collection already holds the most keys one collection may hold, which is {{limit}}.",
                {
                  limit: MAX_COLLECTION_MEMBERS,
                  defaultValue: `This collection already holds the most keys one collection may hold, which is ${MAX_COLLECTION_MEMBERS}.`,
                },
              )}
            </span>
          ) : null}
        </div>
      </SettingRow>

      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "This collection holds no keys yet.",
            "This collection holds no keys yet.",
          )}
        </p>
      ) : (
        <ul
          className="space-y-1"
          data-testid={`collection-${record.id}-members`}
        >
          {members.map((row) => (
            <li
              key={row.id}
              className="flex min-w-0 items-center justify-between gap-2"
            >
              <KeyLine row={row} />
              {canRemove ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-xs text-destructive"
                  data-testid={`collection-${record.id}-remove-${row.id}`}
                  disabled={busy}
                  onClick={() => onRemoveKey(row.id)}
                >
                  {/* Not "Remove": on a row naming a key, that reads as
                      deleting the key. */}
                  {t(
                    "Remove from the collection",
                    "Remove from the collection",
                  )}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateDialog({
  collections,
  busy,
  fieldId,
  labelProblemText,
  onClose,
  onCreate,
}: {
  collections: readonly CollectionRecord[];
  busy: boolean;
  fieldId: (name: string) => string;
  labelProblemText: (
    problem: "empty" | "too-long" | "duplicate" | null,
  ) => string | null;
  onClose: () => void;
  onCreate: (
    label: string,
    passphrase: string,
  ) => Promise<CollectionOutcome | null>;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [outcome, setOutcome] = useState<CollectionOutcome | null>(null);
  const problem = collectionLabelProblem(label, collections);
  const problemText = label === "" ? null : labelProblemText(problem);

  return (
    <CollectionDialog
      title={t("Create a collection", "Create a collection")}
      description={t(
        "Name this collection and choose the passphrase that seals it. Every key you add to it is sealed with this passphrase in addition to its own password, so no key depends on this passphrase alone.",
        "Name this collection and choose the passphrase that seals it. Every key you add to it is sealed with this passphrase in addition to its own password, so no key depends on this passphrase alone.",
      )}
      testId="collection-create-dialog"
      confirmLabel={t("Create", "Create")}
      confirmDisabled={problem !== null || passphrase === ""}
      busy={busy}
      outcome={outcome}
      action="create"
      onClose={onClose}
      onConfirm={() => {
        void onCreate(label.trim(), passphrase).then((answer) => {
          if (answer === null || answer.state === "ok") onClose();
          else setOutcome(answer);
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor={fieldId("create-label")}
          className="text-xs font-medium"
        >
          {t("Collection name", "Collection name")}
        </Label>
        <Input
          id={fieldId("create-label")}
          className="h-8 text-sm"
          data-testid="collection-create-label"
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
        />
        {problemText !== null ? (
          <p
            className="text-[11px] text-destructive"
            data-testid="collection-create-label-problem"
          >
            {problemText}
          </p>
        ) : null}
      </div>
      <PassphraseField
        id={fieldId("create-passphrase")}
        testId="collection-create-passphrase"
        label={t("Collection passphrase", "Collection passphrase")}
        value={passphrase}
        disabled={busy}
        onChange={setPassphrase}
        hint={t(
          "This passphrase is not stored anywhere. It is held in memory while the collection is unlocked and asked for again after this app restarts.",
          "This passphrase is not stored anywhere. It is held in memory while the collection is unlocked and asked for again after this app restarts.",
        )}
      />
    </CollectionDialog>
  );
}

function UnlockDialog({
  record,
  busy,
  fieldId,
  onClose,
  onUnlock,
}: {
  record: CollectionRecord;
  busy: boolean;
  fieldId: (name: string) => string;
  onClose: () => void;
  onUnlock: (passphrase: string) => Promise<CollectionOutcome | null>;
}) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState("");
  const [outcome, setOutcome] = useState<CollectionOutcome | null>(null);

  return (
    <CollectionDialog
      title={t("Unlock {{label}}", {
        label: record.label,
        defaultValue: `Unlock ${record.label}`,
      })}
      description={t(
        "Type this collection's passphrase. It is held in memory until this app closes, never written to disk, and asked for again next time this app starts.",
        "Type this collection's passphrase. It is held in memory until this app closes, never written to disk, and asked for again next time this app starts.",
      )}
      testId="collection-unlock-dialog"
      confirmLabel={t("Unlock", "Unlock")}
      confirmDisabled={passphrase === ""}
      busy={busy}
      outcome={outcome}
      action="unlock"
      onClose={onClose}
      onConfirm={() => {
        void onUnlock(passphrase).then((answer) => {
          if (answer === null || answer.state === "ok") onClose();
          else setOutcome(answer);
        });
      }}
    >
      <PassphraseField
        id={fieldId("unlock-passphrase")}
        testId="collection-unlock-passphrase"
        label={t("Collection passphrase", "Collection passphrase")}
        value={passphrase}
        disabled={busy}
        autoFocus
        onChange={setPassphrase}
      />
    </CollectionDialog>
  );
}

function RenameDialog({
  record,
  collections,
  busy,
  fieldId,
  labelProblemText,
  onClose,
  onRename,
}: {
  record: CollectionRecord;
  collections: readonly CollectionRecord[];
  busy: boolean;
  fieldId: (name: string) => string;
  labelProblemText: (
    problem: "empty" | "too-long" | "duplicate" | null,
  ) => string | null;
  onClose: () => void;
  onRename: (label: string) => Promise<CollectionOutcome | null>;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState(record.label);
  const [outcome, setOutcome] = useState<CollectionOutcome | null>(null);
  const problem = collectionLabelProblem(label, collections, record.id);
  const problemText = labelProblemText(problem);

  return (
    <CollectionDialog
      title={t("Rename {{label}}", {
        label: record.label,
        defaultValue: `Rename ${record.label}`,
      })}
      description={t(
        "Only the name changes. The passphrase, the keys in this collection and each key's own password are all untouched, and this collection does not have to be unlocked to be renamed.",
        "Only the name changes. The passphrase, the keys in this collection and each key's own password are all untouched, and this collection does not have to be unlocked to be renamed.",
      )}
      testId="collection-rename-dialog"
      confirmLabel={t("Rename", "Rename")}
      confirmDisabled={problem !== null || label.trim() === record.label}
      busy={busy}
      outcome={outcome}
      action="rename"
      onClose={onClose}
      onConfirm={() => {
        void onRename(label.trim()).then((answer) => {
          if (answer === null || answer.state === "ok") onClose();
          else setOutcome(answer);
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor={fieldId("rename-label")}
          className="text-xs font-medium"
        >
          {t("Collection name", "Collection name")}
        </Label>
        <Input
          id={fieldId("rename-label")}
          className="h-8 text-sm"
          data-testid="collection-rename-label"
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
        />
        {problemText !== null ? (
          <p
            className="text-[11px] text-destructive"
            data-testid="collection-rename-label-problem"
          >
            {problemText}
          </p>
        ) : null}
      </div>
    </CollectionDialog>
  );
}

function RotateDialog({
  record,
  busy,
  fieldId,
  onClose,
  onRotate,
}: {
  record: CollectionRecord;
  busy: boolean;
  fieldId: (name: string) => string;
  onClose: () => void;
  onRotate: (
    current: string,
    next: string,
  ) => Promise<CollectionOutcome | null>;
}) {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [outcome, setOutcome] = useState<CollectionOutcome | null>(null);

  return (
    <CollectionDialog
      title={t("Change the passphrase for {{label}}", {
        label: record.label,
        defaultValue: `Change the passphrase for ${record.label}`,
      })}
      description={t(
        "The current passphrase is required even while this collection is unlocked, so that nobody who walks up to an open app can change it without knowing it.",
        "The current passphrase is required even while this collection is unlocked, so that nobody who walks up to an open app can change it without knowing it.",
      )}
      testId="collection-rotate-dialog"
      confirmLabel={t("Change the passphrase", "Change the passphrase")}
      confirmDisabled={current === "" || next === ""}
      busy={busy}
      outcome={outcome}
      action="rotate"
      onClose={onClose}
      onConfirm={() => {
        void onRotate(current, next).then((answer) => {
          if (answer === null || answer.state === "ok") onClose();
          else setOutcome(answer);
        });
      }}
    >
      {/* Said before the change as well as after it. Someone rotating because
          a passphrase leaked is about to believe they have revoked an access
          they have not revoked, and that belief is the whole hazard. */}
      <p
        className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
        data-testid="collection-rotate-caveat"
      >
        {t(
          "This changes the collection's passphrase and nothing else. Every key in this collection keeps its own password, and that password still opens that key. If you are changing this passphrase because somebody else learned it, change each key's own password too.",
          "This changes the collection's passphrase and nothing else. Every key in this collection keeps its own password, and that password still opens that key. If you are changing this passphrase because somebody else learned it, change each key's own password too.",
        )}
      </p>
      <PassphraseField
        id={fieldId("rotate-current")}
        testId="collection-rotate-current"
        label={t(
          "Current collection passphrase",
          "Current collection passphrase",
        )}
        value={current}
        disabled={busy}
        autoFocus
        onChange={setCurrent}
      />
      <PassphraseField
        id={fieldId("rotate-new")}
        testId="collection-rotate-new"
        label={t("New collection passphrase", "New collection passphrase")}
        value={next}
        disabled={busy}
        onChange={setNext}
      />
    </CollectionDialog>
  );
}

/**
 * Adding a key: the two-secret operation, put as two secrets.
 *
 * Reachable only while the collection is unlocked, which is the first of them.
 * The second is the key's own password, and it is a field with a sentence
 * saying why it is being asked for — because the backend has to read the key's
 * secret in order to seal it, and there is no way around that. It may be left
 * empty when the OS vault already holds the key; `key-locked` is what comes
 * back when neither route worked, and it is worded rather than crashed.
 */
function AddKeyToCollectionDialog({
  record,
  candidates,
  busy,
  fieldId,
  onClose,
  onAdd,
}: {
  record: CollectionRecord;
  candidates: readonly CollectionKeyRow[];
  busy: boolean;
  fieldId: (name: string) => string;
  onClose: () => void;
  onAdd: (
    keyId: string,
    keyPassword?: string,
  ) => Promise<CollectionOutcome | null>;
}) {
  const { t } = useI18n();
  // No default selection, on purpose: the picker starting on a key would make
  // Add a one-press action on whichever key happened to be first, which is
  // the shape the contract header singles out as the likely mistake here.
  const [keyId, setKeyId] = useState("");
  const [keyPassword, setKeyPassword] = useState("");
  const [outcome, setOutcome] = useState<CollectionOutcome | null>(null);

  return (
    <CollectionDialog
      title={t("Add a key to {{label}}", {
        label: record.label,
        defaultValue: `Add a key to ${record.label}`,
      })}
      description={t(
        "Adding a key needs two secrets. This collection has to be unlocked, which it is, and the key itself has to be opened so that its secret can be sealed into the collection.",
        "Adding a key needs two secrets. This collection has to be unlocked, which it is, and the key itself has to be opened so that its secret can be sealed into the collection.",
      )}
      testId="collection-add-key-dialog"
      confirmLabel={t("Add this key", "Add this key")}
      confirmDisabled={keyId === ""}
      busy={busy}
      outcome={outcome}
      action="add-key"
      onClose={onClose}
      onConfirm={() => {
        void onAdd(keyId, keyPassword).then((answer) => {
          if (answer === null || answer.state === "ok") onClose();
          else setOutcome(answer);
        });
      }}
    >
      {candidates.length === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="collection-add-key-none"
        >
          {t(
            "Every stored key is already in a collection, so there is none left to add to this one.",
            "Every stored key is already in a collection, so there is none left to add to this one.",
          )}
        </p>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={fieldId("add-key")} className="text-xs font-medium">
            {t("Key to add", "Key to add")}
          </Label>
          <select
            id={fieldId("add-key")}
            className="ui-focus glass-surface glass-surface-hover h-8 w-full rounded-md border border-border bg-background/10 px-2 text-sm focus-visible:outline-none"
            data-testid="collection-add-key-select"
            value={keyId}
            disabled={busy}
            onChange={(event) => setKeyId(event.target.value)}
          >
            <option value="">{t("Choose a key", "Choose a key")}</option>
            {candidates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label ?? row.id}
              </option>
            ))}
          </select>
        </div>
      )}
      <PassphraseField
        id={fieldId("add-key-password")}
        testId="collection-add-key-password"
        label={t("The key's own password", "The key's own password")}
        value={keyPassword}
        disabled={busy || candidates.length === 0}
        onChange={setKeyPassword}
        hint={t(
          "A collection has to read a key's secret in order to seal it, so the key has to be open at this moment. Leave this empty if the operating system's vault already holds this key.",
          "A collection has to read a key's secret in order to seal it, so the key has to be open at this moment. Leave this empty if the operating system's vault already holds this key.",
        )}
      />
    </CollectionDialog>
  );
}
