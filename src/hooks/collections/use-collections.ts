/**
 * The renderer's half of key collections: one read, and the eight operations
 * that change something.
 *
 * Shaped after `useSyncSettings` — an `overview`, a `reload`, a `state` and an
 * `error` — with two differences, both forced by what is being edited:
 *
 * 1. **There is no draft and no save.** The sync panel edits one settings
 *    object and writes it with a button, because `SyncSettingsInput` is a
 *    single record. A collection has no settings; it has *operations*, each
 *    taking a secret that must not sit on screen between a keystroke and a
 *    Save. So every call here is one command, performed when the user asks for
 *    it, and the panel has nothing unsaved to warn about.
 * 2. **An outcome is returned, never stored.** Each command answers a
 *    {@link CollectionOutcome}, and a `failed` carries a code the panel words
 *    into a sentence. The hook keeps only `error`, which is for a *rejection*
 *    — an unregistered command, a dead host — because that is a broken host
 *    rather than a refusal, and the two must not be dressed up as each other.
 *
 * `status` after a write is deliberately re-read rather than patched. Half the
 * state this screen shows is in the backend's memory (which collections are
 * open) and the other half re-seals on every member change, so a renderer
 * applying its own idea of the result would be guessing at both. The one place
 * this matters most is unlock state: the contract says it is in-memory and
 * session-scoped, so the only honest source for "this collection is unlocked"
 * is a status the backend reported, and the only way to keep it honest is to
 * ask again.
 *
 * The commands are named by {@link COLLECTION_COMMANDS} rather than spelled
 * here, so a typo cannot survive a build, and the invoke composes the same
 * three pieces every other command in this app does — the UI deadline, the
 * per-command budget and `tauri-client.ts`'s error normalisation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  createPreferenceFailureReporter,
  getTauriInvokeTimeoutMs,
  normalizeTauriInvokeError,
  withTauriUiTimeout,
} from "@/lib/api/tauri-client";
import {
  COLLECTION_COMMANDS,
  type CollectionCommand,
  type CollectionCommandArgs,
  type CollectionCommandResults,
  type CollectionOutcome,
  type CollectionsOverview,
} from "@/lib/collections/types";
import { isDesktop } from "@/lib/environment";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

/**
 * What the hook is doing.
 *
 * There is no `saved`: nothing here is a save. `working` covers every
 * operation, which is enough for the panel because it disables the whole
 * screen while one is in flight — two collections cannot be unlocked at once
 * from one window, and a second passphrase typed over a first one in flight is
 * a race with nothing to gain.
 */
export type CollectionsState = "idle" | "loading" | "working" | "error";

export interface UseCollectionsResult {
  /** `false` on the web build: every collection command is desktop-gated. */
  available: boolean;
  /** `null` until the first read lands, and after a first read that failed. */
  overview: CollectionsOverview | null;
  state: CollectionsState;
  /**
   * The last read or command *rejection* in words, cleared by the next
   * success. Never a refusal: a {@link CollectionOutcome} with
   * `state: "failed"` is the backend answering, and the panel words it.
   *
   * Read together with `overview`: an error with `overview === null` means the
   * screen cannot see the current state at all.
   */
  error: string | null;
  /** Re-read `list_collections`. */
  reload: () => Promise<void>;
  create: (label: string, passphrase: string) => Promise<CollectionOutcome>;
  rename: (id: string, label: string) => Promise<CollectionOutcome>;
  /**
   * Destroy the collection's envelope and clear `collectionId` on its members.
   *
   * No key is lost and the collection need not be unlocked — see the
   * contract's note on this command. The panel says both of those to the user
   * before it calls this.
   */
  deleteCollection: (id: string) => Promise<CollectionOutcome>;
  unlock: (id: string, passphrase: string) => Promise<CollectionOutcome>;
  /** Drop the derived key from the backend's memory. */
  lock: (id: string) => Promise<CollectionOutcome>;
  /**
   * Seal a key's secret into the collection.
   *
   * Two secrets are in play and only one of them is an argument: the
   * collection must already be unlocked, and `keyPassword` opens the key so
   * there is a secret to seal. It is omitted when the OS vault already holds
   * the key; the backend answers `key-locked` when neither route works.
   */
  addKey: (
    id: string,
    keyId: string,
    keyPassword?: string,
  ) => Promise<CollectionOutcome>;
  removeKey: (id: string, keyId: string) => Promise<CollectionOutcome>;
  /**
   * Re-seal under a new passphrase, proving the old one.
   *
   * This rotates the collection only. Every member key's own password is
   * untouched and still opens that key.
   */
  rotate: (
    id: string,
    currentPassphrase: string,
    newPassphrase: string,
  ) => Promise<CollectionOutcome>;
}

const reportCollectionFailure = createPreferenceFailureReporter((error) => {
  reportRuntimeError(error, {
    source: "runtime",
    label: "Collections command",
  });
});

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

/**
 * One collection command, under the application's standard UI deadline.
 *
 * Both halves are keyed on the command name, which is what makes the
 * contract's two maps load-bearing rather than documentation:
 *
 * - {@link CollectionCommandArgs} checks the argument object against the name.
 *   Tauri arguments are named, so a renderer sending `{ password }` to a
 *   handler expecting `keyPassword` typechecks on both sides and fails only
 *   when a user reaches it.
 * - {@link CollectionCommandResults} checks what comes back. This file
 *   previously took the answer as a free type parameter and told it what to
 *   be, which is how it came to *assume* that `list` answers with an overview
 *   and the other eight with an outcome — an assumption that happened to be
 *   right and could not be checked. The map now says so, so `lock` answering
 *   `null` is a fact the compiler knows rather than one this file guesses.
 */
async function collectionInvoke<Command extends CollectionCommand>(
  command: Command,
  args: CollectionCommandArgs[Command],
): Promise<CollectionCommandResults[Command]> {
  try {
    return await withTauriUiTimeout(
      tauriInvoke<CollectionCommandResults[Command]>(command, args),
      command,
      getTauriInvokeTimeoutMs(command),
    );
  } catch (error) {
    throw normalizeTauriInvokeError(error, command);
  }
}

/**
 * Every command but the read.
 *
 * `runAction` re-reads the listing after the commands that change something,
 * so handing it `list_collections` would make a read look like an operation
 * and re-read after itself. With the results map in place that is a type
 * error rather than a thing to remember.
 */
type CollectionMutation = Exclude<
  CollectionCommand,
  typeof COLLECTION_COMMANDS.list
>;

/** The no-argument command's payload, named once rather than inline. */
const NO_ARGS: Record<string, never> = {};

export function useCollections(): UseCollectionsResult {
  const available = isDesktop();
  const [overview, setOverview] = useState<CollectionsOverview | null>(null);
  const [state, setState] = useState<CollectionsState>(
    available ? "loading" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!available) return;
    setState("loading");
    try {
      const next = await collectionInvoke(COLLECTION_COMMANDS.list, NO_ARGS);
      if (!mountedRef.current) return;
      setOverview(next);
      setError(null);
      setState("idle");
    } catch (readError) {
      reportCollectionFailure(readError);
      if (!mountedRef.current) return;
      // `overview` is left as it was rather than cleared: a read that failed
      // after a good one has not made the previous answer untrue, and the
      // error line says the screen is now out of date. Only the first read
      // leaves it null, which is what "cannot see the state at all" means.
      setError(describeError(readError));
      setState("error");
    }
  }, [available]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Run one operation and keep the listing in step with what it did.
   *
   * The outcome is returned rather than stored, for the reason the header
   * gives. What this owns is the side effect, and there are two cases where
   * the listing on screen is no longer true afterwards:
   *
   * - **`ok`** — anything from a new collection to a changed membership to a
   *   derived key appearing or disappearing from memory.
   * - **`locked`** — which is the panel being *wrong about the present*. It
   *   only ever offers an operation needing the key when its last status said
   *   the collection was open, so this refusal means the backend has since
   *   dropped it. Re-reading turns a confusing refusal into a screen that
   *   agrees with it and offers the unlock.
   *
   * Every other refusal changed nothing, so the listing is still correct and
   * a re-read would only make a failed operation look like it had an effect.
   */
  const runAction = useCallback(
    async <Command extends CollectionMutation>(
      command: Command,
      args: CollectionCommandArgs[Command],
    ): Promise<CollectionOutcome> => {
      setState("working");
      const outcome = await (async () => {
        try {
          const result = await collectionInvoke(command, args);
          if (mountedRef.current) setError(null);
          // `lock` answers `null`, which the contract's results map now states
          // and spells out the reading of: an empty answer is a success, and
          // that is safe **because every refusal carries a code** — a
          // `CollectionFailure` without one is not representable, so nothing
          // empty can be a refusal in disguise. Treating it as a failure would
          // report a lock that worked as a lock that did not, with nothing on
          // the Rust side looking wrong.
          return result ?? { state: "ok" as const };
        } catch (actionError) {
          reportCollectionFailure(actionError);
          if (mountedRef.current) {
            setError(describeError(actionError));
            setState("error");
          }
          throw actionError;
        }
      })();
      if (outcome.state === "ok" || outcome.code === "locked") {
        // `reload` owns the state from here: `loading`, then `idle` or
        // `error`. Nothing sets `working` back by hand, because a second
        // writer of this value is how it gets stuck.
        await reload();
      } else if (mountedRef.current) {
        setState("idle");
      }
      return outcome;
    },
    [reload],
  );

  const create = useCallback(
    (label: string, passphrase: string) =>
      runAction(COLLECTION_COMMANDS.create, { label, passphrase }),
    [runAction],
  );
  const rename = useCallback(
    (id: string, label: string) =>
      runAction(COLLECTION_COMMANDS.rename, { id, label }),
    [runAction],
  );
  const deleteCollection = useCallback(
    (id: string) => runAction(COLLECTION_COMMANDS.delete, { id }),
    [runAction],
  );
  const unlock = useCallback(
    (id: string, passphrase: string) =>
      runAction(COLLECTION_COMMANDS.unlock, { id, passphrase }),
    [runAction],
  );
  const lock = useCallback(
    (id: string) => runAction(COLLECTION_COMMANDS.lock, { id }),
    [runAction],
  );
  /**
   * `keyPassword` is left out of the payload entirely when it is empty, rather
   * than sent as `""`.
   *
   * The contract makes it optional and says it is omitted when the OS vault
   * holds the key. An empty string is not that — it is a password, and an
   * empty one, so a backend that tried it would fail to open a key the vault
   * could have supplied and answer `key-locked` for a key that was never
   * locked.
   */
  const addKey = useCallback(
    (id: string, keyId: string, keyPassword?: string) =>
      runAction(
        COLLECTION_COMMANDS.addKey,
        keyPassword === undefined || keyPassword === ""
          ? { id, keyId }
          : { id, keyId, keyPassword },
      ),
    [runAction],
  );
  const removeKey = useCallback(
    (id: string, keyId: string) =>
      runAction(COLLECTION_COMMANDS.removeKey, { id, keyId }),
    [runAction],
  );
  const rotate = useCallback(
    (id: string, currentPassphrase: string, newPassphrase: string) =>
      runAction(COLLECTION_COMMANDS.rotate, {
        id,
        currentPassphrase,
        newPassphrase,
      }),
    [runAction],
  );

  return {
    available,
    overview,
    state,
    error,
    reload,
    create,
    rename,
    deleteCollection,
    unlock,
    lock,
    addKey,
    removeKey,
    rotate,
  };
}
