/**
 * The Collections settings panel, against a mocked IPC boundary.
 *
 * `bc-collections` does not exist yet, so `src/lib/collections/types.ts` *is*
 * the specification and this harness is a stand-in for the backend that will
 * have to satisfy it — the same way `test/SyncSettings.test.tsx` was written
 * before its engine existed.
 *
 * Each claim here is a way this screen could mislead someone about their API
 * keys:
 *
 * **Adding a key is two secrets and cannot be one click.** The backend has to
 * *read* a key's secret in order to seal it into a collection, so the key must
 * be openable at that moment and the collection must be unlocked. The contract
 * header says in so many words that a one-click add is the likely way to get
 * this wrong, so the picker starts on no key, Add is withheld until one is
 * chosen, the key's own password is asked for with a reason, and `key-locked`
 * arrives as a sentence rather than as a crash.
 *
 * **A locked collection refuses exactly what the contract says it must.**
 * Adding and removing re-seal the envelope and need the derived key; renaming,
 * deleting and rotating deliberately do not. A panel that demanded an unlock
 * to delete would ask for a passphrase to destroy a thing no key depends on,
 * and one that offered Add while locked would send a command to be refused.
 *
 * **Deleting loses no keys, and the confirmation says so.** Every key keeps
 * its own envelope. Users assume the opposite and the assumption is
 * frightening, so the words are checked and not merely the command.
 *
 * **Rotating rotates the collection only.** Each member key's own password
 * still opens that key. A screen that reported only "the passphrase was
 * changed" would let someone believe they had revoked an access they have not.
 *
 * **Unlock state is never read from anything remembered.** It is in the
 * backend's memory for the session, so the only honest source is a status the
 * backend reported — not a flag this panel set when an unlock succeeded.
 *
 * **A refusal is not a rejection.** Thirteen refusal codes are the backend
 * answering, and each becomes a sentence. An unregistered command is a broken
 * host and goes to its own alert; dressing one up as the other would word a
 * refusal the backend never gave.
 *
 * Absence is `assert.ok(node === null, …)` throughout, never
 * `assert.equal(node, null)`: the latter serialises the whole jsdom tree to
 * build its diff and takes the worker with it instead of failing.
 */
import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  CollectionsSettings,
  COLLECTIONS_STATE_TESTID,
} from "../src/components/collections/CollectionsSettings";
import type { CollectionKeySummary } from "../src/components/collections/collections-view";
import {
  COLLECTION_COMMANDS,
  MAX_COLLECTION_MEMBERS,
  type CollectionOutcome,
  type CollectionRecord,
  type CollectionsOverview,
} from "../src/lib/collections/types";

import { useEnglishLocale } from "./i18n-ready";

const KEYS: readonly CollectionKeySummary[] = [
  { id: "key-alpha", label: "Alpha account", email: "alpha@example.test" },
  { id: "key-beta", label: "Beta account" },
  { id: "key-gamma", label: "Gamma account" },
];

function record(overrides: Partial<CollectionRecord> = {}): CollectionRecord {
  return {
    id: "col-work",
    label: "Work",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-09T09:00:00.000Z",
    memberIds: ["key-alpha"],
    iterations: 600_000,
    // Bytes, not bits: `bc_crypto::AES_256_KEY_LENGTH_BYTES` is 32. See the
    // same note in `test/collectionsView.test.ts`.
    keyLength: 32,
    algorithm: "PBKDF2-SHA256/AES-256-GCM",
    ...overrides,
  };
}

interface HarnessOptions {
  collections?: CollectionRecord[];
  /** Which collections the backend holds a derived key for right now. */
  unlockedIds?: readonly string[];
  unassignedKeyIds?: readonly string[];
  /** Commands that reject, as an unregistered one does. */
  missing?: readonly string[];
  /**
   * Refusals to answer with instead of performing the operation.
   *
   * Only refusals: an `ok` is produced by the harness itself, which then
   * behaves like the backend would so that the re-read shows a real change.
   * A test that stubbed `ok` as a constant would pass against a panel that
   * never re-read anything.
   */
  refuse?: Partial<Record<string, CollectionOutcome>>;
  /**
   * What each successive `list_collections` reports as unlocked, overriding
   * what the operations above did. The last entry repeats.
   *
   * The seam for the two claims that cannot be driven through the happy path,
   * because both are about the backend's answer disagreeing with what this
   * screen asked for: a derived key that was never held after an `ok`, and
   * one dropped between a status and the operation that needed it. Unlock
   * state lives in the backend's memory, so it can change under the panel at
   * any moment and this is what that looks like.
   */
  unlockedReads?: readonly (readonly string[])[];
  /**
   * Report an empty `statuses` list rather than one entry per collection.
   *
   * The relaunch shape, and a real one: the contract does not say whether
   * `statuses` carries every collection or only the ones whose derived key is
   * held, so a backend that holds nothing may report nothing. The panel has to
   * read both as locked, which is two separate claims and therefore two tests.
   */
  omitStatuses?: boolean;
}

interface Harness {
  /** Every command that reached the host, in order. */
  calls: { command: string; args: Record<string, unknown> }[];
  commands: () => string[];
  argsFor: (command: string) => Record<string, unknown> | undefined;
}

function harness(options: HarnessOptions = {}): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  const calls: Harness["calls"] = [];
  const missing = new Set(options.missing ?? []);
  const refuse = options.refuse ?? {};

  let collections = (options.collections ?? [record()]).map((entry) => ({
    ...entry,
    memberIds: [...entry.memberIds],
  }));
  const unlocked = new Set(options.unlockedIds ?? []);
  let unassigned = [...(options.unassignedKeyIds ?? ["key-beta", "key-gamma"])];
  let nextId = 1;
  let reads = 0;

  const find = (id: unknown) =>
    collections.find((entry) => entry.id === id) ?? null;

  mockIPC((command, args) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    if (missing.has(command)) {
      // What Tauri does with a command no handler is registered for.
      throw new Error(`Command ${command} not found`);
    }
    const refusal = refuse[command];
    if (refusal !== undefined) return refusal;
    const payload = (args ?? {}) as Record<string, unknown>;

    switch (command) {
      case COLLECTION_COMMANDS.list: {
        const scripted = options.unlockedReads;
        const open =
          scripted === undefined
            ? unlocked
            : new Set(scripted[Math.min(reads, scripted.length - 1)]);
        reads += 1;
        return {
          collections,
          statuses: options.omitStatuses
            ? []
            : collections.map((entry) => ({
                id: entry.id,
                unlocked: open.has(entry.id),
              })),
          unassignedKeyIds: unassigned,
        } satisfies CollectionsOverview;
      }
      case COLLECTION_COMMANDS.create: {
        nextId += 1;
        collections = [
          ...collections,
          record({
            id: `col-new-${nextId}`,
            label: String(payload.label),
            memberIds: [],
          }),
        ];
        return { state: "ok" } satisfies CollectionOutcome;
      }
      case COLLECTION_COMMANDS.rename: {
        const target = find(payload.id);
        if (target) target.label = String(payload.label);
        return { state: "ok" } satisfies CollectionOutcome;
      }
      case COLLECTION_COMMANDS.delete: {
        const target = find(payload.id);
        // Every member keeps its own envelope, so a deleted collection
        // returns its keys to the unassigned list rather than destroying
        // them. The harness behaving otherwise would let the panel's
        // reassurance go unchecked.
        if (target) unassigned = [...unassigned, ...target.memberIds];
        collections = collections.filter((entry) => entry.id !== payload.id);
        unlocked.delete(String(payload.id));
        return { state: "ok" } satisfies CollectionOutcome;
      }
      case COLLECTION_COMMANDS.unlock:
        unlocked.add(String(payload.id));
        return { state: "ok" } satisfies CollectionOutcome;
      case COLLECTION_COMMANDS.lock:
        unlocked.delete(String(payload.id));
        // Deliberately *not* a `CollectionOutcome`. The contract names every
        // command's arguments and none of their return types, and `lock` is
        // the one documented as always succeeding — which a backend may well
        // express by returning nothing. Reading that as a refusal would be a
        // crash on the one operation that cannot fail.
        return null;
      case COLLECTION_COMMANDS.addKey: {
        const target = find(payload.id);
        const keyId = String(payload.keyId);
        if (target && !target.memberIds.includes(keyId)) {
          target.memberIds = [...target.memberIds, keyId];
        }
        unassigned = unassigned.filter((id) => id !== keyId);
        return { state: "ok" } satisfies CollectionOutcome;
      }
      case COLLECTION_COMMANDS.removeKey: {
        const target = find(payload.id);
        const keyId = String(payload.keyId);
        if (target) {
          target.memberIds = target.memberIds.filter((id) => id !== keyId);
        }
        unassigned = [...unassigned, keyId];
        return { state: "ok" } satisfies CollectionOutcome;
      }
      case COLLECTION_COMMANDS.rotate:
        return { state: "ok" } satisfies CollectionOutcome;
      default:
        // Never `undefined`: a permissive default crashes the render
        // somewhere else entirely and never names the command that was
        // missing.
        throw new Error(`unexpected command reached the host: ${command}`);
    }
  });

  return {
    calls,
    commands: () => calls.map((call) => call.command),
    argsFor: (command) => calls.find((call) => call.command === command)?.args,
  };
}

afterEach(() => {
  cleanup();
  clearMocks();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

/**
 * The panel, **settled**.
 *
 * A section's testid is not a sufficient synchronisation point anywhere in
 * this repo, and it is not one here either: an operation in flight disables
 * every control on the screen, and `fireEvent.click` on a disabled button does
 * nothing at all, so a click that landed in that window would surface fifteen
 * seconds later as a `waitFor` naming a command that never arrived.
 *
 * `data-state="idle"` with `data-busy="false"` is the honest point: the first
 * read has landed and nothing is in flight, which is exactly when the controls
 * are real.
 */
async function renderPanel(): Promise<void> {
  await useEnglishLocale();
  render(<CollectionsSettings keys={KEYS} />);
  await settled();
}

async function settled(): Promise<void> {
  await waitFor(() => {
    const state = screen.getByTestId(COLLECTIONS_STATE_TESTID);
    assert.equal(state.getAttribute("data-state"), "idle");
    assert.equal(state.getAttribute("data-busy"), "false");
  });
}

/**
 * Press a control, having first said out loud that it was pressable.
 *
 * A click on a disabled control does nothing, so a control that was
 * unexpectedly still disabled would otherwise show up as the *next* assertion
 * expiring, naming an outcome that never arrived rather than the button that
 * never fired.
 */
function press(node: HTMLElement, what: string): void {
  const state = screen.getByTestId(COLLECTIONS_STATE_TESTID);
  assert.equal(
    node.hasAttribute("disabled"),
    false,
    `${what} is disabled, so this click would do nothing (state=${state.getAttribute("data-state")}, busy=${state.getAttribute("data-busy")})`,
  );
  fireEvent.click(node);
}

function pressTestId(testId: string): void {
  press(screen.getByTestId(testId), testId);
}

test("adding a key is two secrets, and a key with no password is refused in words", async () => {
  const host = harness({
    unlockedIds: ["col-work"],
    refuse: {
      [COLLECTION_COMMANDS.addKey]: {
        state: "failed",
        code: "key-locked",
        message: null,
      },
    },
  });
  await renderPanel();

  pressTestId("collection-col-work-add-key");
  const dialog = await screen.findByTestId("collection-add-key-dialog");

  // The first of the two secrets, stated: the collection is open, and the key
  // still has to be opened.
  assert.match(dialog.textContent ?? "", /needs two secrets/u);
  assert.match(
    dialog.textContent ?? "",
    /sealed into the collection/u,
    "the dialog does not say why the key's own password is wanted",
  );

  // And it is not a one-click action: nothing is chosen, so there is nothing
  // to add. This is the shape the contract header singles out.
  const confirm = screen.getByTestId("collection-add-key-dialog-confirm");
  assert.equal(
    confirm.hasAttribute("disabled"),
    true,
    "Add was offered before a key had been chosen, which makes it a one-click add on whichever key is first",
  );
  const picker = screen.getByTestId(
    "collection-add-key-select",
  ) as HTMLSelectElement;
  assert.equal(picker.value, "", "the picker started on a key");

  fireEvent.change(picker, { target: { value: "key-beta" } });
  await waitFor(() =>
    assert.equal(
      screen
        .getByTestId("collection-add-key-dialog-confirm")
        .hasAttribute("disabled"),
      false,
    ),
  );

  // Confirm with no key password: the vault route is the one being tried, and
  // the backend says it did not work.
  pressTestId("collection-add-key-dialog-confirm");
  const outcome = await screen.findByTestId("collection-dialog-outcome");
  assert.equal(outcome.getAttribute("data-outcome"), "failed");
  assert.equal(outcome.getAttribute("role"), "alert");
  assert.ok(
    !(outcome.textContent ?? "").includes("key-locked"),
    "the failure code was shown instead of being worded",
  );
  assert.match(outcome.textContent ?? "", /could not be opened/u);
  assert.match(
    outcome.textContent ?? "",
    /read a key's secret in order to wrap it/u,
    "the refusal does not say why a password is needed, so it reads as a fault",
  );

  // The dialog is still open, on the key that was chosen, so the password can
  // be typed and the same attempt retried.
  assert.ok(screen.queryByTestId("collection-add-key-dialog") !== null);
  assert.equal(
    (screen.getByTestId("collection-add-key-select") as HTMLSelectElement)
      .value,
    "key-beta",
  );

  // An empty password box is not sent as an empty password: the contract makes
  // `keyPassword` optional precisely so the vault route can be taken, and `""`
  // is a password rather than the absence of one.
  const sent = host.argsFor(COLLECTION_COMMANDS.addKey);
  assert.equal(sent?.id, "col-work");
  assert.equal(sent?.keyId, "key-beta");
  assert.ok(
    !("keyPassword" in (sent ?? {})),
    `an empty key password was sent as a value: ${JSON.stringify(sent)}`,
  );
});

test("a typed key password reaches the backend as itself", async () => {
  const host = harness({ unlockedIds: ["col-work"] });
  await renderPanel();

  pressTestId("collection-col-work-add-key");
  await screen.findByTestId("collection-add-key-dialog");
  fireEvent.change(screen.getByTestId("collection-add-key-select"), {
    target: { value: "key-beta" },
  });
  fireEvent.change(screen.getByTestId("collection-add-key-password"), {
    target: { value: "beta-key-password" },
  });
  pressTestId("collection-add-key-dialog-confirm");

  await waitFor(() =>
    assert.ok(host.commands().includes(COLLECTION_COMMANDS.addKey)),
  );
  const sent = host.argsFor(COLLECTION_COMMANDS.addKey);
  assert.equal(sent?.keyPassword, "beta-key-password");

  // And the key is now where the backend put it, read back rather than
  // assumed: the member list came from a fresh `list_collections`.
  await settled();
  const members = screen.getByTestId("collection-col-work-members");
  assert.match(members.textContent ?? "", /Beta account/u);
});

test("a locked collection withholds the two operations that re-seal it, and explains", async () => {
  const host = harness({ unlockedIds: [] });
  await renderPanel();

  const card = screen.getByTestId("collection-col-work");
  assert.equal(card.getAttribute("data-unlocked"), "false");
  assert.match(
    screen.getByTestId("collection-col-work-lock-state").textContent ?? "",
    /This collection is locked/u,
  );

  // Not simply absent: a control that has vanished reads as a bug, and this
  // one's absence is the point.
  const notice = screen.getByTestId("collection-col-work-locked-notice");
  assert.match(notice.textContent ?? "", /has to be unlocked/u);
  assert.match(
    notice.textContent ?? "",
    /what the passphrase seals/u,
    "the notice does not say why these two operations need the passphrase",
  );
  assert.ok(
    screen.queryByTestId("collection-col-work-add-key") === null,
    "Add a key was offered on a locked collection, so pressing it sends a command to be refused",
  );
  assert.ok(
    screen.queryByTestId("collection-col-work-remove-key-alpha") === null,
    "Remove was offered on a locked collection",
  );
  assert.ok(!host.commands().includes(COLLECTION_COMMANDS.addKey));

  // The three that deliberately do not need it are all still offered.
  for (const testId of [
    "collection-col-work-rename",
    "collection-col-work-rotate",
    "collection-col-work-delete",
  ]) {
    assert.equal(
      screen.getByTestId(testId).hasAttribute("disabled"),
      false,
      `${testId} was withheld on a locked collection, but the contract says it does not need the derived key`,
    );
  }
});

test("the delete confirmation says no key is lost, and does not need an unlock", async () => {
  const host = harness({ unlockedIds: [] });
  await renderPanel();

  pressTestId("collection-col-work-delete");
  const prompt = await screen.findByText(/No key is lost/u);
  const text = prompt.textContent ?? "";
  assert.match(
    text,
    /sealed under its own password/u,
    "the confirmation does not say why no key is lost, so it reads as a promise rather than a fact",
  );
  assert.match(text, /does not even have to be unlocked/u);

  fireEvent.click(
    screen.getByRole("button", { name: "Delete this collection" }),
  );
  // Sent while locked, which is the claim: no unlock was demanded first.
  await waitFor(() =>
    assert.ok(host.commands().includes(COLLECTION_COMMANDS.delete)),
  );
  assert.ok(
    !host.commands().includes(COLLECTION_COMMANDS.unlock),
    "deleting a locked collection asked for an unlock first",
  );

  await settled();
  const outcome = screen.getByTestId("collection-outcome");
  assert.equal(outcome.getAttribute("data-action"), "delete");
  assert.match(outcome.textContent ?? "", /No key was lost/u);
  // And the key that was in it is back in the list of keys in no collection,
  // rather than gone.
  assert.match(
    screen.getByTestId("collections-unassigned").textContent ?? "",
    /Alpha account/u,
  );
});

test("unlock state is whatever the backend last reported, not what this screen asked for", async () => {
  // `unlock_collection` answers `ok`, and the backend then reports the
  // collection as *not* holding a key — a derived key dropped between the two
  // calls. A panel keeping its own flag would show it open regardless, which
  // is the lie the contract header forbids.
  harness({ unlockedReads: [[]] });
  await renderPanel();

  pressTestId("collection-col-work-unlock");
  await screen.findByTestId("collection-unlock-dialog");
  fireEvent.change(screen.getByTestId("collection-unlock-passphrase"), {
    target: { value: "right" },
  });
  pressTestId("collection-unlock-dialog-confirm");
  await settled();

  const card = screen.getByTestId("collection-col-work");
  assert.equal(
    card.getAttribute("data-unlocked"),
    "false",
    "the panel rendered a collection as unlocked on the strength of its own request rather than the backend's answer",
  );
  assert.ok(
    screen.queryByTestId("collection-col-work-add-key") === null,
    "the operations needing the derived key were offered for a collection the backend does not hold one for",
  );
});

test("a collection the backend reports no status for renders as locked", async () => {
  // The relaunch case, in the shape a backend that holds nothing may produce
  // it: an empty `statuses` rather than an entry saying `false`. "Unlocked
  // unless told otherwise" would render the contract's forbidden lie on the
  // very first paint, where it is least likely to be noticed.
  harness({ omitStatuses: true });
  await renderPanel();
  assert.equal(
    screen.getByTestId("collection-col-work").getAttribute("data-unlocked"),
    "false",
    "a collection with no reported status was rendered as unlocked",
  );
  assert.ok(
    screen.queryByTestId("collection-col-work-add-key") === null,
    "the operations needing the derived key were offered for a collection no status vouches for",
  );
});

test("unlocking says how long it lasts, and locking says what it drops", async () => {
  harness({ unlockedIds: [] });
  await renderPanel();

  pressTestId("collection-col-work-unlock");
  const dialog = await screen.findByTestId("collection-unlock-dialog");
  assert.match(
    dialog.textContent ?? "",
    /held in memory until this app closes/u,
  );
  assert.match(
    dialog.textContent ?? "",
    /never written to disk/u,
    "the unlock dialog does not say the passphrase is not stored",
  );

  fireEvent.change(screen.getByTestId("collection-unlock-passphrase"), {
    target: { value: "right" },
  });
  pressTestId("collection-unlock-dialog-confirm");
  await settled();
  assert.equal(
    screen.getByTestId("collection-col-work").getAttribute("data-unlocked"),
    "true",
  );
  assert.match(
    screen.getByTestId("collection-outcome").textContent ?? "",
    /stays unlocked until this app closes/u,
  );

  pressTestId("collection-col-work-lock");
  await settled();
  assert.equal(
    screen.getByTestId("collection-col-work").getAttribute("data-unlocked"),
    "false",
  );
  assert.match(
    screen.getByTestId("collection-outcome").textContent ?? "",
    /no longer held in memory/u,
  );
});

test("a command that answers with nothing is read as success, not as a refusal", async () => {
  // `lock_collection` is the one command the contract documents as always
  // succeeding, and the contract does not say what any command returns. This
  // harness answers it with nothing, which is what a backend expressing
  // "always succeeds" is likely to do — and a renderer that read an empty
  // answer as a refusal would crash on the only operation that cannot fail.
  harness({ unlockedIds: ["col-work"] });
  await renderPanel();

  pressTestId("collection-col-work-lock");
  const outcome = await screen.findByTestId("collection-outcome");
  assert.equal(outcome.getAttribute("data-outcome"), "ok");
  assert.match(outcome.textContent ?? "", /no longer held in memory/u);
  await settled();
  assert.equal(
    screen.getByTestId("collection-col-work").getAttribute("data-unlocked"),
    "false",
  );
});

test("rotating states the caveat before the change and repeats it after", async () => {
  harness({ unlockedIds: ["col-work"] });
  await renderPanel();

  pressTestId("collection-col-work-rotate");
  await screen.findByTestId("collection-rotate-dialog");
  const caveat = screen.getByTestId("collection-rotate-caveat");
  // The whole hazard: somebody rotating because a passphrase leaked is about
  // to believe they have revoked an access they have not revoked.
  assert.match(caveat.textContent ?? "", /keeps its own password/u);
  assert.match(caveat.textContent ?? "", /still opens that key/u);
  assert.match(
    caveat.textContent ?? "",
    /change each key's own password too/u,
    "the caveat does not say what to do about it, which leaves it as a remark",
  );

  fireEvent.change(screen.getByTestId("collection-rotate-current"), {
    target: { value: "old" },
  });
  fireEvent.change(screen.getByTestId("collection-rotate-new"), {
    target: { value: "new" },
  });
  pressTestId("collection-rotate-dialog-confirm");
  await settled();

  const outcome = screen.getByTestId("collection-outcome");
  assert.equal(outcome.getAttribute("data-action"), "rotate");
  assert.match(
    outcome.textContent ?? "",
    /still opens that key/u,
    "the success line reported a changed passphrase without saying what it did not change",
  );
});

test("a rotation refused on the current passphrase says nothing was changed", async () => {
  harness({
    unlockedIds: ["col-work"],
    refuse: {
      [COLLECTION_COMMANDS.rotate]: {
        state: "failed",
        code: "wrong-passphrase",
        message: "decryption failed",
      },
    },
  });
  await renderPanel();

  pressTestId("collection-col-work-rotate");
  await screen.findByTestId("collection-rotate-dialog");
  fireEvent.change(screen.getByTestId("collection-rotate-current"), {
    target: { value: "wrong" },
  });
  fireEvent.change(screen.getByTestId("collection-rotate-new"), {
    target: { value: "new" },
  });
  pressTestId("collection-rotate-dialog-confirm");

  const outcome = await screen.findByTestId("collection-dialog-outcome");
  // One code, two sentences. Without the second, somebody whose rotation was
  // refused has to guess which passphrase their collection now has.
  assert.match(
    outcome.textContent ?? "",
    /the passphrase was not changed/u,
    "a refused rotation did not say that nothing changed",
  );
  assert.match(outcome.textContent ?? "", /current passphrase/u);
});

test("the same code reads differently when it was an unlock that was refused", async () => {
  harness({
    refuse: {
      [COLLECTION_COMMANDS.unlock]: {
        state: "failed",
        code: "wrong-passphrase",
        message: "decryption failed",
      },
    },
  });
  await renderPanel();

  pressTestId("collection-col-work-unlock");
  await screen.findByTestId("collection-unlock-dialog");
  fireEvent.change(screen.getByTestId("collection-unlock-passphrase"), {
    target: { value: "wrong" },
  });
  pressTestId("collection-unlock-dialog-confirm");

  const outcome = await screen.findByTestId("collection-dialog-outcome");
  assert.match(outcome.textContent ?? "", /did not open this collection/u);
  assert.ok(
    !/was not changed/u.test(outcome.textContent ?? ""),
    "a refused unlock borrowed the rotation's reassurance, which is about a change it never attempted",
  );
  // The dialog stays open so the passphrase can be retyped.
  assert.ok(screen.queryByTestId("collection-unlock-dialog") !== null);
});

test("a locked refusal carries no quoted detail, and a backend error does", async () => {
  // The contract asks for the first by name: a detail line under a `locked`
  // refusal adds nothing and invites quoting something irrelevant as though
  // it were the explanation.
  harness({
    unlockedIds: ["col-work"],
    refuse: {
      [COLLECTION_COMMANDS.removeKey]: {
        state: "failed",
        code: "locked",
        message: "no derived key for collection col-work",
      },
    },
  });
  await renderPanel();

  pressTestId("collection-col-work-remove-key-alpha");
  const outcome = await screen.findByTestId("collection-outcome");
  assert.match(outcome.textContent ?? "", /This collection is locked/u);
  assert.ok(
    !(outcome.textContent ?? "").includes("no derived key for collection"),
    "a locked refusal quoted its message, which the contract asks it not to",
  );
  assert.ok(
    !(outcome.textContent ?? "").includes("said:"),
    "a detail line was framed for a refusal that should not have one",
  );
});

test("a backend error is nothing but its message, so the message is quoted", async () => {
  harness({
    refuse: {
      [COLLECTION_COMMANDS.create]: {
        state: "failed",
        code: "backend-error",
        message: "the keyring is locked",
      },
    },
  });
  await renderPanel();

  pressTestId("collection-create");
  await screen.findByTestId("collection-create-dialog");
  fireEvent.change(screen.getByTestId("collection-create-label"), {
    target: { value: "Personal" },
  });
  fireEvent.change(screen.getByTestId("collection-create-passphrase"), {
    target: { value: "a passphrase" },
  });
  pressTestId("collection-create-dialog-confirm");

  const outcome = await screen.findByTestId("collection-dialog-outcome");
  // Framed as a quotation rather than printed bare: an English sentence
  // inside a translated screen has to read as something someone else said
  // rather than as a gap in the translation.
  assert.match(
    outcome.textContent ?? "",
    /said: the keyring is locked/u,
    "the only content this code has was dropped",
  );
  assert.ok(
    !(outcome.textContent ?? "").includes("backend-error"),
    "the failure code was shown instead of being worded",
  );
});

test("a refusal is reported by what it means, not by its code", async () => {
  harness({
    refuse: {
      [COLLECTION_COMMANDS.create]: {
        state: "failed",
        code: "duplicate-label",
        message: null,
      },
    },
  });
  await renderPanel();

  pressTestId("collection-create");
  await screen.findByTestId("collection-create-dialog");
  fireEvent.change(screen.getByTestId("collection-create-label"), {
    target: { value: "Personal" },
  });
  fireEvent.change(screen.getByTestId("collection-create-passphrase"), {
    target: { value: "a passphrase" },
  });
  pressTestId("collection-create-dialog-confirm");

  const outcome = await screen.findByTestId("collection-dialog-outcome");
  assert.ok(
    !(outcome.textContent ?? "").includes("duplicate-label"),
    "the failure code was shown instead of being worded",
  );
  assert.match(outcome.textContent ?? "", /already exists on this device/u);
});

test("a name the backend would refuse is refused here first, with the reason", async () => {
  const host = harness({
    collections: [record({ id: "col-work", label: "Work" })],
  });
  await renderPanel();

  pressTestId("collection-create");
  await screen.findByTestId("collection-create-dialog");
  fireEvent.change(screen.getByTestId("collection-create-passphrase"), {
    target: { value: "a passphrase" },
  });
  fireEvent.change(screen.getByTestId("collection-create-label"), {
    target: { value: "Work" },
  });

  const problem = await screen.findByTestId("collection-create-label-problem");
  assert.match(problem.textContent ?? "", /already exists on this device/u);
  assert.equal(
    screen
      .getByTestId("collection-create-dialog-confirm")
      .hasAttribute("disabled"),
    true,
    "Create was offered for a name the panel can already see is taken",
  );
  assert.ok(
    !host.commands().includes(COLLECTION_COMMANDS.create),
    "a hopeless create was sent anyway",
  );
});

test("a typed passphrase does not survive closing the dialog", async () => {
  harness({ unlockedIds: [] });
  await renderPanel();

  pressTestId("collection-col-work-unlock");
  await screen.findByTestId("collection-unlock-dialog");
  fireEvent.change(screen.getByTestId("collection-unlock-passphrase"), {
    target: { value: "a secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    assert.ok(screen.queryByTestId("collection-unlock-dialog") === null),
  );

  pressTestId("collection-col-work-unlock");
  await screen.findByTestId("collection-unlock-dialog");
  // The dialog is mounted only while it is open, so closing it is what
  // discards the secret. A dialog kept mounted would hand the next person at
  // this machine the previous attempt.
  assert.equal(
    (screen.getByTestId("collection-unlock-passphrase") as HTMLInputElement)
      .value,
    "",
    "a passphrase typed into a dialog survived closing it",
  );
});

test("only keys in no collection are offered for adding, because membership is exclusive", async () => {
  harness({
    unlockedIds: ["col-work"],
    collections: [
      record({ memberIds: ["key-alpha"] }),
      record({ id: "col-home", label: "Home", memberIds: ["key-gamma"] }),
    ],
    unassignedKeyIds: ["key-beta"],
  });
  await renderPanel();

  pressTestId("collection-col-work-add-key");
  await screen.findByTestId("collection-add-key-dialog");
  const picker = screen.getByTestId("collection-add-key-select");
  const offered = Array.from(picker.querySelectorAll("option")).map(
    (option) => option.value,
  );
  assert.deepEqual(offered, ["", "key-beta"]);
  assert.ok(
    !offered.includes("key-alpha"),
    "a key already in this collection was offered for adding to it",
  );
  assert.ok(
    !offered.includes("key-gamma"),
    "a key in another collection was offered, but a key belongs to at most one",
  );
});

test("a collection at the member cap withholds Add and names the limit", async () => {
  harness({
    unlockedIds: ["col-work"],
    collections: [
      record({
        memberIds: Array.from(
          { length: MAX_COLLECTION_MEMBERS },
          (_unused, index) => `key-${index}`,
        ),
      }),
    ],
  });
  await renderPanel();

  const notice = screen.getByTestId("collection-col-work-full-notice");
  assert.match(notice.textContent ?? "", /128/u);
  assert.equal(
    screen.getByTestId("collection-col-work-add-key").hasAttribute("disabled"),
    true,
    "Add was offered on a full collection, so pressing it sends a command to be refused",
  );
});

test("removing a key returns it to the keys in no collection, and says the key is untouched", async () => {
  const host = harness({ unlockedIds: ["col-work"] });
  await renderPanel();

  // Said before the action as well: the row's own description, not only the
  // outcome afterwards.
  assert.match(
    screen.getByTestId("collection-col-work").textContent ?? "",
    /does not delete the key/u,
  );

  pressTestId("collection-col-work-remove-key-alpha");
  await settled();
  assert.equal(host.argsFor(COLLECTION_COMMANDS.removeKey)?.keyId, "key-alpha");
  assert.match(
    screen.getByTestId("collection-outcome").textContent ?? "",
    /still opens with its own password/u,
  );
  assert.match(
    screen.getByTestId("collections-unassigned").textContent ?? "",
    /Alpha account/u,
  );
});

test("a locked refusal brings the screen back into step with the backend", async () => {
  // The panel only ever offers Remove when its last status said the collection
  // was open, so this refusal means the backend has since dropped the key.
  // Leaving the card claiming otherwise would put a refusal nobody can act on
  // over a screen that says the opposite; re-reading turns it into a screen
  // that agrees with the refusal and offers the unlock.
  const host = harness({
    unlockedReads: [["col-work"], []],
    refuse: {
      [COLLECTION_COMMANDS.removeKey]: {
        state: "failed",
        code: "locked",
        message: null,
      },
    },
  });
  await renderPanel();
  assert.equal(
    screen.getByTestId("collection-col-work").getAttribute("data-unlocked"),
    "true",
  );

  pressTestId("collection-col-work-remove-key-alpha");
  await screen.findByTestId("collection-outcome");
  await settled();

  assert.equal(
    screen.getByTestId("collection-col-work").getAttribute("data-unlocked"),
    "false",
    "the card still claimed to be unlocked after the backend refused for want of the derived key",
  );
  assert.ok(
    screen.queryByTestId("collection-col-work-locked-notice") !== null,
    "the refusal left no way to do the thing it refused",
  );
  // Two reads: the first paint, and the one the refusal provoked.
  assert.equal(
    host.commands().filter((name) => name === COLLECTION_COMMANDS.list).length,
    2,
    `the panel did not re-read after a locked refusal: ${host.commands().join(", ")}`,
  );
});

test("a refusal that changed nothing does not provoke a re-read", async () => {
  // The other half of the rule above. `not-a-member` changed nothing, so the
  // listing on screen is still correct and a re-read would make a refused
  // operation look as though it had an effect.
  const host = harness({
    unlockedIds: ["col-work"],
    refuse: {
      [COLLECTION_COMMANDS.removeKey]: {
        state: "failed",
        code: "not-a-member",
        message: null,
      },
    },
  });
  await renderPanel();

  pressTestId("collection-col-work-remove-key-alpha");
  await screen.findByTestId("collection-outcome");
  await settled();
  assert.equal(
    host.commands().filter((name) => name === COLLECTION_COMMANDS.list).length,
    1,
    `a refusal that changed nothing was followed by a re-read: ${host.commands().join(", ")}`,
  );
});

test("a command that is not registered is a problem, not an empty list", async () => {
  harness({ missing: [COLLECTION_COMMANDS.list] });
  await useEnglishLocale();
  render(<CollectionsSettings keys={KEYS} />);

  const problem = await screen.findByTestId("collections-unreadable");
  assert.equal(problem.getAttribute("role"), "alert");
  assert.match(problem.textContent ?? "", /could not read the collections/u);
  assert.match(problem.textContent ?? "", /list_collections/u);

  // Not offered as a screen with nothing on it: there are no controls at all,
  // and nothing claims the feature is unused.
  assert.ok(
    screen.queryByTestId("collections-section-list") === null,
    "the list was rendered over a state the screen could not read",
  );
  assert.ok(
    !/No collection has been created/u.test(document.body.textContent ?? ""),
    "a read failure was reported as an empty collection list",
  );
});

test("a rejected operation is not dressed up as a refusal", async () => {
  harness({
    unlockedIds: ["col-work"],
    missing: [COLLECTION_COMMANDS.lock],
  });
  await renderPanel();

  pressTestId("collection-col-work-lock");
  const problem = await screen.findByTestId("collections-action-error");
  assert.equal(problem.getAttribute("role"), "alert");
  assert.match(problem.textContent ?? "", /lock_collection/u);
  assert.ok(
    screen.queryByTestId("collection-outcome") === null,
    "a command that never answered was reported as one of the thirteen refusals it never gave",
  );
});

test("a refused lock is reported, because nothing else would report it", async () => {
  // Lock, Remove and Delete are pressed directly rather than from a dialog,
  // so a refusal of one of them has nowhere else to go — and a silently
  // refused Lock is a collection the user believes is closed.
  harness({
    unlockedIds: ["col-work"],
    refuse: {
      [COLLECTION_COMMANDS.lock]: {
        state: "failed",
        code: "not-found",
        message: null,
      },
    },
  });
  await renderPanel();

  pressTestId("collection-col-work-lock");
  const outcome = await screen.findByTestId("collection-outcome");
  assert.equal(outcome.getAttribute("data-outcome"), "failed");
  assert.equal(outcome.getAttribute("data-action"), "lock");
  assert.match(outcome.textContent ?? "", /no longer there/u);
});

test("renaming states that it changes nothing else, and sends the trimmed name", async () => {
  const host = harness();
  await renderPanel();

  pressTestId("collection-col-work-rename");
  const dialog = await screen.findByTestId("collection-rename-dialog");
  assert.match(dialog.textContent ?? "", /Only the name changes/u);
  assert.match(
    dialog.textContent ?? "",
    /does not have to be unlocked to be renamed/u,
  );
  fireEvent.change(screen.getByTestId("collection-rename-label"), {
    target: { value: "  Day job  " },
  });
  pressTestId("collection-rename-dialog-confirm");

  await waitFor(() =>
    assert.ok(host.commands().includes(COLLECTION_COMMANDS.rename)),
  );
  assert.equal(host.argsFor(COLLECTION_COMMANDS.rename)?.label, "Day job");
});

test("the keys in no collection are described as still working on their own", async () => {
  harness({ unassignedKeyIds: ["key-beta", "key-gamma"] });
  await renderPanel();

  const section = screen.getByTestId("collections-section-unassigned");
  assert.match(section.textContent ?? "", /its own password/u);
  assert.match(
    section.textContent ?? "",
    /nothing is forced into one/u,
    "the unassigned section does not say collections are optional",
  );
  const list = within(section).getByTestId("collections-unassigned");
  assert.match(list.textContent ?? "", /Beta account/u);
  assert.match(list.textContent ?? "", /Gamma account/u);
});

test("a member id the host has no key for is reported rather than rendered blank", async () => {
  harness({
    collections: [record({ memberIds: ["key-alpha", "key-vanished"] })],
  });
  await renderPanel();

  const members = screen.getByTestId("collection-col-work-members");
  assert.match(members.textContent ?? "", /no longer stored on this device/u);
  assert.match(members.textContent ?? "", /key-vanished/u);
});

test("the panel runs with no props at all", async () => {
  // Hostable from the login screen as well as the settings tab, like the sync
  // panel: nothing here depends on a session, a selected account or an
  // `apiKey`. With no key list it still renders, and the ids it cannot
  // resolve say so.
  harness();
  await useEnglishLocale();
  render(<CollectionsSettings />);
  await settled();
  assert.ok(screen.queryByTestId("collection-col-work") !== null);
  assert.match(
    screen.getByTestId("collection-col-work-members").textContent ?? "",
    /no longer stored on this device/u,
  );
});
