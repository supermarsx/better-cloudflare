/**
 * The Sync settings panel, against a mocked IPC boundary.
 *
 * Each claim here is a way this screen could lie about something that costs
 * the user their API keys:
 *
 * **"Nothing is stored" and "nothing is wanted" are different screens.** A
 * folder has nothing to authenticate with, so `credentialPresent` is `false`
 * and always will be. Rendering the credential field anyway would put "nothing
 * is stored for this provider yet" in front of someone whose setup is complete
 * and ask them for a secret the backend has no slot to keep. The folder's own
 * setting — the path — is the one that can be missing, and that is reported as
 * what the backend will do about it: refuse as `not-configured`.
 *
 * **A secret the user did not touch is not sent.** The contract gives each
 * write-only field three meanings and the panel has to be able to express all
 * three, so the three are driven through the real controls and checked on the
 * payload `configure_sync` receives — absent, `""`, and a value. The rules
 * themselves are tested without a DOM in `test/syncView.test.ts`; what is
 * tested here is that the controls reach them.
 *
 * **A conflict is a question, not an error.** `SyncOutcome.conflict` means
 * nothing was written and the user has to pick a side, so both manifests have
 * to be on screen — the choice is unanswerable without them — with two
 * explicit choices and the fact that the discarded side is archived. Reporting
 * it as a failure would send someone looking for a fault that does not exist.
 *
 * **A pull asks before it replaces anything.** A pull overwrites this device's
 * keys, so `pull_sync` must only ever run from the second step: the preview
 * opens the envelope through `preview_sync_pull`, which writes nothing, and a
 * preview that failed or diverged does not offer the pull at all.
 *
 * **A command that is not there is a problem, not an empty screen.** This
 * feature's backend is `isDesktop()`-gated and new, so an `invoke` of an
 * unregistered command is a real case. The rejection has to reach the user as
 * a problem; rendering the settings over a default object would put an empty
 * provider on screen, which reads as "nothing is set up here" — a claim the
 * screen is in no position to make when it could not ask.
 *
 * **The panel is hostable with no session.** It is mounted both in the
 * settings tab and on the login screen, because the restore path cannot live
 * behind the sign-in it exists to make possible. Two claims hold that open: it
 * renders and reads its status given no props at all, and its import list
 * carries nothing session-bound — checked against the source, because the
 * dependency that breaks this will arrive as an innocuous import rather than
 * as a decision.
 *
 * Absence is `assert.ok(node === null, …)` throughout, never
 * `assert.equal(node, null)`: the latter serialises the whole jsdom tree to
 * build its diff and takes the worker with it instead of failing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  SyncSettings,
  SYNC_SETTINGS_SECTIONS,
} from "../src/components/dns/SyncSettings";
import {
  SYNC_BLOB_NAME,
  SYNC_COMMANDS,
  SYNC_MANIFEST_NAME,
  type SyncManifest,
  type SyncOutcome,
  type SyncPreviewOutcome,
  type SyncSettings as SyncSettingsValue,
  type SyncSettingsInput,
  type SyncStatus,
} from "../src/lib/sync/types";

import { useEnglishLocale } from "./i18n-ready";

const DEVICE_ID = "device-this";

/** A configured folder, and the one a picker hands back. */
const FOLDER = "C:\\Users\\alice\\Google Drive\\better-cloudflare";
const PICKED = "D:\\Dropbox\\vaults\\better-cloudflare";

function manifest(overrides: Partial<SyncManifest> = {}): SyncManifest {
  return {
    generation: 4,
    checksum: "b".repeat(64),
    bytes: 2048,
    writtenAt: "2026-10-09T09:00:00.000Z",
    deviceId: DEVICE_ID,
    deviceLabel: "Windows 11",
    payloadVersion: 1,
    iterations: 600_000,
    keyLength: 32,
    algorithm: "PBKDF2-HMAC-SHA256",
    ...overrides,
  };
}

function storedSettings(
  overrides: Partial<SyncSettingsValue> = {},
): SyncSettingsValue {
  return {
    version: 1,
    enabled: true,
    provider: "nextcloud",
    webdavUrl: "https://cloud.example.test/remote.php/dav/files/alice/bc",
    webdavUsername: "alice",
    folderPath: null,
    credentialPresent: true,
    passphrasePresent: true,
    autoPushMinutes: null,
    lastSyncedAt: "2026-10-09T09:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  settings?: SyncSettingsValue;
  lastKnown?: SyncManifest | null;
  /** Commands that reject, as an unregistered one does. */
  missing?: readonly string[];
  /**
   * The bounds the status reports, and the clamp that goes with them.
   *
   * `MIN_AUTO_PUSH_MINUTES` and `MAX_AUTO_PUSH_MINUTES` are Rust constants;
   * the renderer reads the range off `SyncStatus` and never applies it, so
   * this is a stub of what the backend does rather than a second copy of the
   * rule. The numbers here are this harness's, not the real ones.
   */
  cadenceRange?: { min: number; max: number };
  clampCadence?: (minutes: number | null) => number | null;
  /**
   * What the native folder picker answers with.
   *
   * `null` is the cancellation the contract specifies, and it is the default
   * here on purpose: a harness that silently returned a path would make a
   * test about cancelling pass for the wrong reason.
   */
  pickedFolder?: string | null;
  push?: SyncOutcome;
  pull?: SyncOutcome;
  test?: SyncOutcome;
  resolve?: SyncOutcome;
  preview?: SyncPreviewOutcome;
}

interface Harness {
  /** Every command that reached the host, in order. */
  calls: { command: string; args: Record<string, unknown> }[];
  /** The `settings` payload of each `configure_sync`, in order. */
  configured: SyncSettingsInput[];
  commands: () => string[];
}

function harness(options: HarnessOptions = {}): Harness {
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {};
  const calls: Harness["calls"] = [];
  const configured: SyncSettingsInput[] = [];
  let stored = options.settings ?? storedSettings();
  const missing = new Set(options.missing ?? []);

  mockIPC((command, args) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    if (missing.has(command)) {
      // What Tauri does with a command no handler is registered for.
      throw new Error(`Command ${command} not found`);
    }
    switch (command) {
      case SYNC_COMMANDS.status:
        return {
          settings: stored,
          lastKnown: options.lastKnown ?? null,
          deviceId: DEVICE_ID,
          deviceLabel: "Windows 11",
          autoPushMinutesRange: options.cadenceRange ?? {
            min: 15,
            max: 10_080,
          },
        } satisfies SyncStatus;
      case SYNC_COMMANDS.configure: {
        const input = (args as { settings: SyncSettingsInput }).settings;
        configured.push(input);
        // Behave like the backend would, so that a cleared secret really does
        // come back as absent and the screen has to cope with it.
        stored = {
          ...stored,
          enabled: input.enabled,
          provider: input.provider,
          webdavUrl: input.webdavUrl,
          webdavUsername: input.webdavUsername,
          folderPath: input.folderPath,
          autoPushMinutes: options.clampCadence
            ? options.clampCadence(input.autoPushMinutes)
            : input.autoPushMinutes,
          credentialPresent:
            "credential" in input
              ? input.credential !== ""
              : stored.credentialPresent,
          passphrasePresent:
            "passphrase" in input
              ? input.passphrase !== ""
              : stored.passphrasePresent,
        };
        return null;
      }
      case SYNC_COMMANDS.test:
        return options.test ?? { state: "ok", manifest: manifest() };
      case SYNC_COMMANDS.pickFolder:
        return options.pickedFolder ?? null;
      case SYNC_COMMANDS.push:
        return options.push ?? { state: "ok", manifest: manifest() };
      case SYNC_COMMANDS.previewPull:
        return (
          options.preview ?? {
            state: "ok",
            preview: { manifest: manifest(), keyCount: 5, localKeyCount: 3 },
          }
        );
      case SYNC_COMMANDS.pull:
        return options.pull ?? { state: "ok", manifest: manifest() };
      case SYNC_COMMANDS.resolve:
        return options.resolve ?? { state: "ok", manifest: manifest() };
      default:
        throw new Error(`unexpected command reached the host: ${command}`);
    }
  });

  return {
    calls,
    configured,
    commands: () => calls.map((call) => call.command),
  };
}

afterEach(() => {
  cleanup();
  clearMocks();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

/**
 * The panel, opened on one section and **settled**.
 *
 * The section's testid is not a sufficient synchronisation point, and this is
 * the third time that class of defect has been chased in this file. The
 * section renders the moment `status` is non-null, which is one commit *before*
 * the `[settings]` effect has set the draft — so a `fireEvent` landing in that
 * window could be dropped entirely, leaving the input holding its stored value
 * and Save disabled with `dirty=false`. It reproduced about one run in four,
 * and always as the next assertion rather than as the event that vanished.
 *
 * `data-state="idle"` with `data-dirty="false"` is the honest point: it is only
 * rendered once the first read has landed *and* the draft has been built from
 * it, which is exactly when the controls are real. Same reasoning as
 * {@link savedAndIdle}, one step earlier in the lifecycle.
 */
async function renderPanel(
  section: "provider" | "encryption" | "schedule" | "status",
): Promise<void> {
  await useEnglishLocale();
  render(<SyncSettings section={section} />);
  await waitFor(() =>
    assert.ok(
      screen.queryByTestId(`sync-section-${section}`),
      "the section never rendered",
    ),
  );
  await waitFor(() => {
    const state = screen.getByTestId("sync-save-state");
    assert.equal(state.getAttribute("data-state"), "idle");
    assert.equal(state.getAttribute("data-dirty"), "false");
  });
}

function credentialField(): HTMLElement {
  return screen.getByTestId("sync-credential-field");
}

function secretInput(field: HTMLElement): HTMLInputElement {
  const input = field.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(input, "the secret field has no password input");
  return input;
}

/**
 * Press Save, having first said out loud that it was pressable.
 *
 * `fireEvent.click` on a disabled button does nothing at all, so a Save that
 * was unexpectedly still disabled would otherwise show up as the *next*
 * `waitFor` expiring fifteen seconds later, naming a payload that never
 * arrived rather than the button that never fired.
 */
function clickSave(): void {
  const save = screen.getByTestId("sync-save");
  const state = screen.getByTestId("sync-save-state");
  assert.equal(
    save.hasAttribute("disabled"),
    false,
    // The reason is worth carrying: Save is disabled by `!dirty`, by `busy`
    // and by an unset cadence, and which of the three it was decides whether
    // the test is missing a synchronisation point or the panel is wrong.
    `Save is disabled, so this click would do nothing (dirty=${state.getAttribute("data-dirty")}, saveState=${state.getAttribute("data-state")}, text=${JSON.stringify(state.textContent)})`,
  );
  fireEvent.click(save);
}

/**
 * Wait for a save to have *finished*, not merely to have reached the host.
 *
 * The harness records a `configure_sync` the moment the mock handler runs,
 * which is well before the write resolves, the status is re-read and the panel
 * drops out of its busy state. Synchronising on the call log therefore lets the
 * next `fireEvent` land on controls that are still disabled — and a click on a
 * disabled control does nothing at all, so the failure surfaced later and
 * somewhere else, intermittently, depending on how the microtasks interleaved.
 * Two of those were chased before the cause was this line.
 *
 * The save-state indicator is the honest synchronisation point: `saved` with
 * `data-dirty="false"` is only rendered once the re-read has landed and the
 * draft has been reset, which is exactly when the panel is interactive again.
 */
async function savedAndIdle(): Promise<void> {
  await waitFor(() => {
    const state = screen.getByTestId("sync-save-state");
    assert.equal(state.getAttribute("data-state"), "saved");
    assert.equal(state.getAttribute("data-dirty"), "false");
  });
}

test("an untouched secret is not sent, and the other two are", async () => {
  const host = harness();
  await renderPanel("provider");

  // Nothing typed: Save is not even offered, because there is nothing to save.
  assert.equal(
    screen.getByTestId("sync-save").hasAttribute("disabled"),
    true,
    "Save is offered on a panel with no changes in it",
  );
  assert.equal(credentialField().getAttribute("data-secret-mode"), "keep");

  // (1) A change that is not the secret: the payload must leave the stored
  // credential alone rather than sending an empty string for it.
  const username = screen.getByLabelText("WebDAV username");
  fireEvent.change(username, { target: { value: "bob" } });
  clickSave();
  await savedAndIdle();
  assert.equal(host.configured.length, 1);
  assert.equal(host.configured[0].webdavUsername, "bob");
  assert.ok(
    !("credential" in host.configured[0]),
    `an untouched credential was sent: ${JSON.stringify(host.configured[0])}`,
  );
  assert.ok(!("passphrase" in host.configured[0]));

  // (2) Replace: the field asks for a value and sends exactly that value.
  fireEvent.click(
    within(credentialField()).getByRole("button", { name: "Replace" }),
  );
  await waitFor(() =>
    assert.equal(credentialField().getAttribute("data-secret-mode"), "set"),
  );
  // An opened box with nothing in it is still not a change.
  assert.equal(
    screen.getByTestId("sync-save").hasAttribute("disabled"),
    true,
    "an empty replace box counted as a change, which would send a deletion",
  );
  fireEvent.change(secretInput(credentialField()), {
    target: { value: "app-password" },
  });
  clickSave();
  await savedAndIdle();
  assert.equal(host.configured.length, 2);
  assert.equal(host.configured[1].credential, "app-password");

  // (3) Remove: the only payload that carries an empty string. The field has
  // already returned to `keep`, because a save that landed resets it.
  assert.equal(credentialField().getAttribute("data-secret-mode"), "keep");
  fireEvent.click(
    within(credentialField()).getByRole("button", { name: "Remove" }),
  );
  await waitFor(() =>
    assert.equal(credentialField().getAttribute("data-secret-mode"), "clear"),
  );
  clickSave();
  await savedAndIdle();
  assert.equal(host.configured.length, 3);
  assert.equal(host.configured[2].credential, "");

  // And the backend's answer is believed: with nothing stored any more, the
  // field stops offering to replace something that is not there.
  await waitFor(() =>
    assert.equal(
      credentialField().getAttribute("data-secret-present"),
      "false",
    ),
  );
  assert.ok(
    within(credentialField()).queryByRole("button", { name: "Replace" }) ===
      null,
    "Replace is still offered for a credential that was just removed",
  );
});

test("the nav renders exactly the section labels the index is checked against", async () => {
  // Closes the one link `test/settingsSearch.registry.test.ts` cannot see.
  // That suite proves the search index and `SYNC_SETTINGS_SECTIONS` agree, but
  // it reads `DNSManager.tsx`, where these labels do not appear — so it cannot
  // tell whether this panel's nav renders them or renders something else
  // entirely. Index ↔ exported list ↔ the words on screen: this is the third
  // link, and without it a hard-coded nav label would leave search matching a
  // word nobody can see, which is the failure that whole arrangement exists to
  // prevent.
  harness();
  await renderPanel("provider");
  const toolbar = screen.getByRole("toolbar", {
    name: "Sync settings sections",
  });
  assert.deepEqual(
    Array.from(toolbar.querySelectorAll("button")).map((button) =>
      (button.textContent ?? "").trim(),
    ),
    SYNC_SETTINGS_SECTIONS.map((section) => section.label),
  );
});

test("a stored secret is never rendered as a value", async () => {
  harness();
  await renderPanel("provider");
  // The keyring holds a credential, and the screen says so without a box full
  // of dots that the user would take for their real app password.
  assert.equal(credentialField().getAttribute("data-secret-present"), "true");
  assert.ok(
    credentialField().querySelector('input[type="password"]') === null,
    "a stored secret was rendered as an input, which claims to hold its value",
  );
  // And it says *something* about what the keyring holds, rather than nothing
  // at all. Matched on the phrase instead of the whole sentence: the subject
  // was added to that string so it would stop agreeing with a noun it never
  // named, and pinning the full literal here is what made this assertion go
  // stale both times it moved. The claim this test exists for is the absent
  // input above, not the wording.
  assert.match(
    credentialField().textContent ?? "",
    /stored on this device/iu,
    "a stored credential is on the device and the field says nothing of it",
  );
});

/** A folder provider as it arrives from the backend: path set, no credential. */
function folderSettings(
  overrides: Partial<SyncSettingsValue> = {},
): SyncSettingsValue {
  return storedSettings({
    provider: "folder",
    webdavUrl: null,
    webdavUsername: null,
    folderPath: FOLDER,
    // What the backend really reports for a folder, and always will: a folder
    // has no keyring slot, so this boolean is not a report about setup.
    credentialPresent: false,
    ...overrides,
  });
}

test("a folder asks for a path and no credential, and Nextcloud the other way round", async () => {
  // The distinction the contract exists to keep. `credentialPresent` is
  // `false` for a folder because a folder has nothing to authenticate with —
  // access is decided by the directory's own permissions — so "nothing is
  // stored" and "nothing is wanted" must not render as the same empty field
  // asking for a secret the backend has no slot to keep and would never read.
  harness({ settings: folderSettings() });
  await renderPanel("provider");

  assert.equal(screen.getByTestId("sync-folder-path").textContent, FOLDER);
  assert.ok(
    screen.queryByTestId("sync-credential-field") === null,
    "a folder was asked for a credential that has nowhere to be stored",
  );
  assert.match(
    screen.getByTestId("sync-credential-not-needed").textContent ?? "",
    /nothing to authenticate with/u,
  );
  // `credentialPresent: false` is not a gap in the setup, and must not be
  // reported as one.
  assert.ok(
    !/Nothing is stored for this provider yet/u.test(
      document.body.textContent ?? "",
    ),
    "a folder's absent credential was reported as a missing setup step",
  );
  assert.ok(
    screen.queryByTestId("sync-provider-incomplete") === null,
    "a folder with a path chosen was reported as not configured",
  );
  // And the other provider's fields are not on screen asking to be filled in.
  assert.ok(screen.queryByLabelText("WebDAV URL") === null);

  // The two things about a folder that are confusing when left unsaid: a
  // vanished folder is never recreated, which is why it reads as unreachable
  // rather than as empty, and a conflict copy left by the user's own sync
  // client is invisible to this app rather than adopted by it.
  assert.match(
    screen.getByTestId("sync-folder-absent-note").textContent ?? "",
    /is never created/u,
  );
  assert.match(
    screen.getByTestId("sync-folder-conflict-copy-note").textContent ?? "",
    /left alone/u,
  );

  // "vault" is the OS Vault feature's word for the **credential store**, so
  // the artefact written into the folder is "the sealed copy". Russian and
  // Chinese render both as one noun, which turns "write the vault into a
  // directory" into a claim that the keyring itself is being moved — inside
  // the one paragraph whose whole job is explaining a refusal that prevents
  // data loss. The filenames still contain the word and are exempt, as is
  // `too-large`'s "a partly restored key vault", which really does mean the
  // store.
  const providerText =
    screen.getByTestId("sync-section-provider").textContent ?? "";
  assert.match(providerText, /the sealed copy/u);
  assert.ok(
    !/\b(?:the|your) vault\b/iu.test(providerText),
    "the folder copy called the sealed artefact a vault, which is the credential store's word",
  );

  // Switching provider swaps both halves, which is the claim from the other
  // side: the field appears for the provider that authenticates and only then.
  fireEvent.click(screen.getByRole("radio", { name: /Nextcloud/u }));
  await waitFor(() => assert.ok(screen.queryByTestId("sync-credential-field")));
  assert.ok(
    screen.queryByTestId("sync-credential-not-needed") === null,
    "the no-credential note survived a switch to the provider that needs one",
  );
  assert.ok(
    screen.queryByTestId("sync-folder-field") === null,
    "the folder picker stayed on screen under Nextcloud",
  );
});

test("the folder copy names the files this app actually writes", async () => {
  // The one paragraph on this screen that sends the user to go and look in
  // their own folder, so the names in it have to be the names on disk. An
  // earlier draft abbreviated them to `vault (1).enc`, a file that can never
  // exist, and that was on its way into twelve locales — a literal filename is
  // deliberately not localised, so the error would have been identical in all
  // of them.
  //
  // Pinned against the constants rather than spelled out a second time here.
  // `SYNC_BLOB_NAME` and `SYNC_MANIFEST_NAME` are the on-disk format and so
  // effectively frozen — renaming either orphans every vault anyone has
  // already synced — but that migration would have to rewrite this sentence,
  // and this is what makes that a named failure instead of copy quietly
  // describing files the app no longer writes.
  //
  // Asserting on what renders *is* asserting on the catalogued English:
  // `useEnglishLocale` pins the language and `src/i18n.ts` loads `en-US` from
  // `src/locales/en-US.json`, so this text is the catalogue's value and not
  // the call site's default.
  harness({ settings: folderSettings() });
  await renderPanel("provider");

  const note =
    screen.getByTestId("sync-folder-conflict-copy-note").textContent ?? "";
  for (const name of [SYNC_BLOB_NAME, SYNC_MANIFEST_NAME]) {
    assert.ok(
      note.includes(name),
      `the conflict-copy paragraph does not name ${name}, so it sends the user looking for a file this app does not write`,
    );
  }
  // And the example is that same name with a number added, which is what a
  // sync client actually leaves behind — not a shortened stand-in.
  const example = SYNC_BLOB_NAME.replace(/\.enc$/u, " (1).enc");
  assert.ok(
    note.includes(example),
    `the example conflict copy should be ${example}, derived from SYNC_BLOB_NAME`,
  );
});

test("a picked folder reaches the draft and is saved as the path", async () => {
  const host = harness({
    settings: folderSettings({ folderPath: null }),
    pickedFolder: PICKED,
  });
  await renderPanel("provider");

  // A folder with no path is storable — `SyncSettings::normalize` only tidies
  // the text — and every operation then answers `not-configured`. So the
  // screen reports that rather than locking Save against a rule the backend
  // does not have.
  assert.match(
    screen.getByTestId("sync-provider-incomplete").textContent ?? "",
    /no folder has been chosen/u,
  );

  fireEvent.click(screen.getByTestId("sync-pick-folder"));
  await waitFor(() =>
    assert.equal(screen.getByTestId("sync-folder-path").textContent, PICKED),
  );
  assert.ok(
    screen.queryByTestId("sync-provider-incomplete") === null,
    "the warning outlived the folder being chosen",
  );

  clickSave();
  await savedAndIdle();
  assert.equal(host.configured.length, 1);
  assert.equal(
    host.configured[0].folderPath,
    PICKED,
    "the picked path never reached configure_sync",
  );
});

test("cancelling the folder picker leaves the configured folder alone", async () => {
  // `pick_sync_folder` answers `null` for a dismissed dialog, and the one
  // thing that must not do is clear the path: someone who opened the picker
  // and closed it still wants the folder they already had, so a cancellation
  // that emptied the field would be the picker destroying the setting it
  // exists to fill.
  const host = harness({ settings: folderSettings(), pickedFolder: null });
  await renderPanel("provider");

  fireEvent.click(screen.getByTestId("sync-pick-folder"));
  await waitFor(() =>
    assert.ok(host.commands().includes(SYNC_COMMANDS.pickFolder)),
  );
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("sync-pick-folder").hasAttribute("disabled"),
      false,
      "the panel never left its busy state after the picker was dismissed",
    ),
  );

  assert.equal(screen.getByTestId("sync-folder-path").textContent, FOLDER);
  // Nothing changed, so there is nothing to save — which is also how a draft
  // quietly reset to the stored value would be caught.
  assert.equal(
    screen.getByTestId("sync-save-state").getAttribute("data-dirty"),
    "false",
  );
  assert.equal(screen.getByTestId("sync-save").hasAttribute("disabled"), true);
  assert.ok(
    screen.queryByTestId("sync-action-error") === null,
    "a cancelled dialog was reported as a failure",
  );
});

test("a folder connection test reports the write it actually performed", async () => {
  // `FolderEngine::probe` stages an empty file and removes it, so it proves
  // writability rather than assuming it — and is itself a write, which in a
  // folder a sync client is watching is an observable event that client may
  // propagate. Both halves of that have to reach the screen.
  harness({ settings: folderSettings() });
  await renderPanel("provider");

  // The description says what the test will do, including that it writes —
  // in a folder a sync client is watching, that file appearing is an event
  // the client may propagate, so "nothing is uploaded" would be untrue.
  assert.match(
    screen.getByTestId("sync-section-provider").textContent ?? "",
    /creating an empty file and removing it again/u,
  );

  fireEvent.click(screen.getByTestId("sync-test"));
  const folderOutcome = await screen.findByTestId("sync-test-outcome");
  assert.match(folderOutcome.textContent ?? "", /this app can write into it/u);
  assert.ok(
    !/accepted the app password/u.test(folderOutcome.textContent ?? ""),
    "a folder probe claimed to have authenticated something",
  );
});

test("a WebDAV connection test does not claim write access it never checked", async () => {
  // `WebDavEngine::probe` is a `PROPFIND` with `Depth: 0` asking for
  // `resourcetype` alone, so it establishes that the server answers and the
  // app password authenticates — and nothing whatever about whether this app
  // may write there. A read-only mount, a revoked share, a permissions
  // change: all of those read as a clean probe here and fail on the first
  // push, which is the opposite of what the folder engine does and why one
  // sentence cannot serve both.
  harness({ settings: storedSettings() });
  await renderPanel("provider");
  assert.match(
    screen.getByTestId("sync-section-provider").textContent ?? "",
    /does not check that this app may write there/u,
  );

  fireEvent.click(screen.getByTestId("sync-test"));
  const davOutcome = await screen.findByTestId("sync-test-outcome");
  assert.match(davOutcome.textContent ?? "", /accepted the app password/u);
  assert.match(
    davOutcome.textContent ?? "",
    /not something this check can tell you/u,
    "a read-only PROPFIND was reported as proof this app may write there",
  );

  // And the wording follows the *stored* provider, never the radio. A test
  // run with the radio switched but nothing saved still reaches Nextcloud —
  // which is what the description beside it says — so a report worded for a
  // folder would describe an action that did not happen.
  // Matched on the word the radio exists to offer rather than on its full
  // label. That label has now moved twice — "carried by whatever sync client
  // you already use", then "on this machine", now "this machine can see" —
  // and each time it took a test fixture with it, which says the literal was
  // never what this assertion was about.
  fireEvent.click(screen.getByRole("radio", { name: /folder/iu }));
  fireEvent.click(screen.getByTestId("sync-test"));
  await waitFor(() =>
    assert.match(
      screen.getByTestId("sync-test-outcome").textContent ?? "",
      /accepted the app password/u,
      "an unsaved radio relabelled the outcome of a test against the stored provider",
    ),
  );
});

test("a folder's failure is not attributed to a provider that does not exist", async () => {
  // `folder.rs` wraps every `std::io::Error` in `SyncError::Provider`, so the
  // message on that path is the local filesystem's words. Framing it as "The
  // provider said: Access is denied." names a party that is not involved, and
  // defeats the point of the frame, which is to mark the words as someone
  // else's so an English sentence inside a translated screen reads as a
  // quotation rather than as a gap.
  harness({
    settings: folderSettings(),
    push: {
      state: "failed",
      code: "provider-error",
      message: "Access is denied. (os error 5)",
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const outcome = await screen.findByTestId("sync-transfer-outcome");
  assert.match(outcome.textContent ?? "", /filesystem said: Access is denied/u);
  assert.ok(
    !/provider said/u.test(outcome.textContent ?? ""),
    "a local filesystem error was quoted as a provider's words",
  );
});

test("the Transfer row and its outcome agree about what a push did", async () => {
  // `"Uploaded as generation N"` told the user their keys had reached somewhere
  // else, on the provider where this app cannot know whether they did.
  // `FolderEngine::put` writes two files into a directory on this machine and
  // returns; what carries them off it is a sync client the app cannot query. So
  // it was a success report about the destination of someone's API keys, made
  // without the information.
  //
  // Two strings, not one, and that is the point of asserting them together:
  // the Transfer row's description is the sentence that teaches what Push does,
  // and `OutcomeReport` renders four lines below it. Fixing only the outcome
  // left "A push uploads this device's keys" sitting directly above "Written to
  // the folder as generation 4" — a self-contradiction created by the fix.
  // Found by sync-engine reading the pair, which is the only way to find it.
  //
  // Both providers, because a branch can be wrong in two directions: the
  // folder must not say "uploaded", and Nextcloud — which really does upload —
  // must not lose the word in either string.
  harness({ settings: folderSettings() });
  await renderPanel("status");

  // The teaching sentence. A distinctive clause rather than the whole
  // description, which also carries the untouched "the provider's copy".
  assert.ok(
    screen.getByText(/writes this device's keys to the folder/u),
    "the Transfer row still describes a folder push as an upload",
  );

  fireEvent.click(screen.getByTestId("sync-push"));
  const folder = await screen.findByTestId("sync-transfer-outcome");
  await waitFor(() =>
    assert.match(folder.textContent ?? "", /Written to the folder/u),
  );
  assert.ok(
    !/[Uu]ploaded/u.test(folder.textContent ?? ""),
    "a folder write was reported as an upload off this machine",
  );
  // And nowhere else in the section either, which is the adjacency claim.
  assert.ok(
    !/[Uu]pload/u.test(
      screen.getByTestId("sync-section-status").textContent ?? "",
    ),
    "something in the status section told a folder user their keys were uploaded",
  );

  cleanup();
  harness();
  await renderPanel("status");

  assert.ok(
    screen.getByText(/uploads this device's keys/u),
    "Nextcloud's Transfer row stopped saying what it really does",
  );
  fireEvent.click(screen.getByTestId("sync-push"));
  const webdav = await screen.findByTestId("sync-transfer-outcome");
  await waitFor(() => assert.match(webdav.textContent ?? "", /[Uu]ploaded/u));
});

test("a folder error says what happened with nothing quoted under it", async () => {
  // `provider-error` was "The folder could not be used." — the shortest
  // headline in the set, and only informative beside the detail line below it.
  // The detail is there on every path today (every `SyncError::Provider`
  // carries a message, and `folder.rs` passes `io::Error::to_string` or a
  // literal at each site), but `SyncOutcome.message` is nullable in the
  // contract and a headline that needs company is not a headline.
  //
  // It can also say "the folder is there", which the shorter version could
  // not: every folder-side `Provider` error is raised past `root_now()`, so
  // the path had already been confirmed to exist and be a directory, and what
  // failed was a read or a write inside it.
  harness({
    settings: folderSettings(),
    push: { state: "failed", code: "provider-error", message: null },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const outcome = await screen.findByTestId("sync-transfer-outcome");
  const text = outcome.textContent ?? "";
  assert.match(text, /read or write/u);
  // Nothing is framed as a quotation, because there was nothing to quote.
  assert.ok(
    !/(?:filesystem|provider) said/u.test(text),
    "an absent message was still introduced as something someone said",
  );
});

test("an unreachable provider is not made to say why it was unreachable", async () => {
  // `unreachable` is the one state that means the provider demonstrably said
  // nothing — and `SyncError::Unreachable` carries a message anyway, which for
  // WebDAV is `reqwest`'s own text. So the detail line quoted this machine's
  // resolver under a frame promising the server's words, structurally and not
  // in some edge case. Found by the ru-RU translator reading the two together.
  harness({
    push: {
      state: "failed",
      code: "unreachable",
      message:
        "error sending request for url (https://cloud.example.test/): dns error: failed to lookup address information",
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const outcome = await screen.findByTestId("sync-transfer-outcome");
  assert.match(outcome.textContent ?? "", /could not be reached/u);
  assert.ok(
    !/dns error/u.test(outcome.textContent ?? ""),
    "this machine's own resolver was quoted as the unreachable server's words",
  );
  assert.ok(
    !/provider said/u.test(outcome.textContent ?? ""),
    "a provider that said nothing was framed as having said something",
  );

  // The folder is the asymmetry, and the reason this is not "hide the detail
  // on unreachable": `root_now`'s failures land in `Unreachable` too, but
  // there the message really is the OS speaking, so the detail is worth
  // keeping and the frame is true. Suppressing it for a folder as well would
  // pass the assertions above and throw away the only words that say which of
  // the three arms it was.
  cleanup();
  harness({
    settings: folderSettings(),
    push: {
      state: "failed",
      code: "unreachable",
      message: "The system cannot find the path specified. (os error 3)",
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const folderOutcome = await screen.findByTestId("sync-transfer-outcome");
  await waitFor(() =>
    assert.match(
      folderOutcome.textContent ?? "",
      /filesystem said: The system cannot find the path specified/u,
      "the OS's own account of a missing folder was suppressed with it",
    ),
  );
});

test("replacing a stored secret does not claim there is nothing stored", async () => {
  // One input branch, two causes: nothing is stored, or Replace was pressed on
  // something that is. A single placeholder read "Nothing is stored" for both,
  // so the replace path put it directly beside the keep button — which only
  // renders when something *is* stored. Two strings in one
  // row contradicting each other, in every locale. Found by the hi-IN
  // translator; no test objected, because both strings were correct for the
  // branch each was written for.
  harness();
  await renderPanel("provider");

  const field = credentialField();
  fireEvent.click(within(field).getByRole("button", { name: /^Replace$/u }));

  const input = secretInput(field);
  assert.equal(input.getAttribute("placeholder"), "Type a replacement");
  // The button whose presence is the contradiction. Asserted here rather than
  // taken on trust: it and the placeholder now read the same `present`, so a
  // test that only checked the placeholder would still pass if the two came
  // apart again.
  assert.ok(
    // Matched on the distinctive part rather than the whole label: this one
    // has already moved once, from the subjectless "Keep the stored one" to a
    // wording that names what is kept, and it will move again before it names
    // a particular secret — which it must never do, since one component
    // renders it for two.
    within(field).queryByRole("button", { name: /Keep the secret/u }),
    "the keep-stored button is gone, so this is no longer the replace path",
  );
  assert.ok(
    !/Nothing is stored/u.test(field.textContent ?? ""),
    "the replace path still tells the user nothing is stored",
  );

  // And the other cause keeps the other placeholder. Without this, deleting
  // the branch entirely and always saying "Type a replacement" would pass:
  // there is nothing to replace, and the field would be inviting it anyway.
  cleanup();
  harness({ settings: storedSettings({ credentialPresent: false }) });
  await renderPanel("provider");

  const empty = credentialField();
  assert.equal(
    secretInput(empty).getAttribute("placeholder"),
    "Nothing is stored",
  );
  assert.ok(
    !within(empty).queryByRole("button", { name: /Keep the secret/u }),
    "a secret that is not stored offered to keep the one already stored",
  );
});

test("a conflict is put as a question, with both copies and both choices", async () => {
  const local = manifest({ generation: 7 });
  const remote = manifest({
    generation: 9,
    deviceId: "device-laptop",
    deviceLabel: "macOS 15",
    writtenAt: "2026-10-09T11:30:00.000Z",
  });
  const host = harness({
    push: {
      state: "conflict",
      conflict: { local, remote, expectedGeneration: 7 },
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const panel = await screen.findByTestId("sync-conflict");

  // Not an error: nothing failed and nothing was written.
  assert.equal(panel.getAttribute("role"), "status");
  assert.ok(
    screen.queryByTestId("sync-transfer-outcome") === null,
    "a conflict was also reported as an outcome, which reads as a failure",
  );

  // Both sides, so the choice can be made on the facts.
  const localSide = within(panel).getByTestId("sync-conflict-local");
  const remoteSide = within(panel).getByTestId("sync-conflict-remote");
  // The generation each side carries, as its own cell rather than as a
  // substring of the concatenated row.
  within(localSide).getByText("7");
  within(remoteSide).getByText("9");
  assert.match(remoteSide.textContent ?? "", /macOS 15/u);
  assert.match(remoteSide.textContent ?? "", /Another device/u);

  // And the discarded side is archived, not deleted.
  assert.match(panel.textContent ?? "", /timestamped archive/u);
  assert.match(panel.textContent ?? "", /not deleted/u);

  // Two choices, and choosing one asks the backend for exactly that side.
  within(panel).getByRole("button", { name: "Keep the provider's copy" });
  fireEvent.click(
    within(panel).getByRole("button", { name: "Keep this device's copy" }),
  );
  await waitFor(() =>
    assert.ok(host.commands().includes(SYNC_COMMANDS.resolve)),
  );
  const resolveCall = host.calls.find(
    (call) => call.command === SYNC_COMMANDS.resolve,
  );
  assert.equal(resolveCall?.args.resolution, "keep-local");
});

test("a pull previews first and writes nothing until it is confirmed", async () => {
  const host = harness();
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-pull"));
  const preview = await screen.findByTestId("sync-pull-preview");
  // The preview opened the envelope and `pull_sync` has not run: that pairing
  // is the claim, and `preview_sync_pull` exists precisely because `pull_sync`
  // installs what it opens.
  assert.ok(host.commands().includes(SYNC_COMMANDS.previewPull));
  assert.ok(
    !host.commands().includes(SYNC_COMMANDS.pull),
    `the preview reached the installing command: ${host.commands().join(", ")}`,
  );
  // Both counts, so the number being destroyed is as visible as the number
  // arriving.
  assert.match(preview.textContent ?? "", /3 key\(s\) on this device/u);
  assert.match(preview.textContent ?? "", /the 5 in the provider/u);

  fireEvent.click(
    screen.getByRole("button", { name: "Replace this device's keys" }),
  );
  await screen.findByTestId("sync-pull-outcome");
  assert.equal(
    host.commands().filter((command) => command === SYNC_COMMANDS.pull).length,
    1,
  );
});

test("a pull that would lose keys says so before it is confirmed", async () => {
  // A remote copy with fewer keys than this device is the quiet case: the pull
  // succeeds, and the keys that were only here are gone.
  harness({
    preview: {
      state: "ok",
      preview: { manifest: manifest(), keyCount: 2, localKeyCount: 6 },
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-pull"));
  const warning = await screen.findByTestId("sync-pull-shrinks");
  assert.match(warning.textContent ?? "", /fewer keys than this device holds/u);
});

test("a preview that cannot open the envelope does not offer the pull", async () => {
  // The wrong-passphrase case, which is the whole reason the preview step
  // exists: it is discovered here, before the keys have been touched.
  const host = harness({
    preview: { state: "failed", code: "wrong-passphrase", message: null },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-pull"));
  const failure = await screen.findByTestId("sync-pull-preview-failed");
  assert.match(failure.textContent ?? "", /did not open the envelope/u);
  assert.match(failure.textContent ?? "", /Nothing on this device has been/u);

  const confirm = screen.getByRole("button", {
    name: "Replace this device's keys",
  });
  assert.equal(
    confirm.hasAttribute("disabled"),
    true,
    "a pull was offered after the preview failed to open the envelope",
  );
  fireEvent.click(confirm);
  assert.ok(
    !host.commands().includes(SYNC_COMMANDS.pull),
    "the disabled confirm still reached the installing command",
  );
});

test("a pull that conflicts leaves the question where it can be answered", async () => {
  // The dialog tells the user to settle it under Sync status, so the conflict
  // has to be there when they close the dialog. A modal they must keep open to
  // keep the question would be worse than the question.
  const host = harness({
    pull: {
      state: "conflict",
      conflict: {
        local: null,
        remote: manifest({ generation: 3, deviceId: "device-laptop" }),
        expectedGeneration: 0,
      },
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-pull"));
  await screen.findByTestId("sync-pull-dialog");
  fireEvent.click(
    screen.getByRole("button", { name: "Replace this device's keys" }),
  );
  await waitFor(() => assert.ok(host.commands().includes(SYNC_COMMANDS.pull)));

  const panel = await screen.findByTestId("sync-conflict");
  // Pulling onto a device with nothing of its own is the case
  // `SyncConflict.local === null` exists for, and it has to read as an absence
  // rather than as a blank copy.
  assert.match(
    within(panel).getByTestId("sync-conflict-local").textContent ?? "",
    /no copy of its own yet/u,
  );
  within(panel).getByRole("button", { name: "Keep the provider's copy" });
});

test("a preview that conflicts leaves the question where it can be answered", async () => {
  // Same lifting as a conflicted pull, one step earlier: the preview found the
  // divergence, so nothing was opened and nothing was written, and the
  // question belongs under Sync status rather than inside a modal.
  harness({
    preview: {
      state: "conflict",
      conflict: {
        local: manifest({ generation: 2 }),
        remote: manifest({ generation: 8, deviceId: "device-laptop" }),
        expectedGeneration: 2,
      },
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-pull"));
  await screen.findByTestId("sync-pull-diverged");
  assert.equal(
    screen
      .getByRole("button", { name: "Replace this device's keys" })
      .hasAttribute("disabled"),
    true,
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const panel = await screen.findByTestId("sync-conflict");
  within(panel).getByRole("button", { name: "Keep the provider's copy" });
});

test("a command that is not registered is a problem, not an empty screen", async () => {
  harness({ missing: [SYNC_COMMANDS.status] });
  await useEnglishLocale();
  render(<SyncSettings section="provider" />);

  const problem = await screen.findByTestId("sync-unreadable");
  assert.equal(problem.getAttribute("role"), "alert");
  assert.match(problem.textContent ?? "", /could not read the sync settings/u);
  assert.match(problem.textContent ?? "", /get_sync_status/u);

  // Not offered as a screen with nothing set up on it: there are no controls
  // at all, and nothing claims the feature is unconfigured.
  assert.ok(
    screen.queryByTestId("sync-section-provider") === null,
    "the provider controls were rendered over a state the screen could not read",
  );
  assert.ok(
    screen.queryByRole("radio", { name: /Nextcloud/u }) === null,
    "an empty provider choice was offered, which reads as nothing is set up",
  );
  assert.ok(
    !/No provider has been set up/u.test(document.body.textContent ?? ""),
    "a read failure was reported as the not-configured failure code",
  );
});

test("a failed outcome is reported by what it means, not by its code", async () => {
  harness({
    push: {
      state: "failed",
      code: "unauthorised",
      message: "401 Unauthorized",
    },
  });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const outcome = await screen.findByTestId("sync-transfer-outcome");
  assert.equal(outcome.getAttribute("data-outcome"), "failed");
  assert.equal(outcome.getAttribute("role"), "alert");
  // The code itself never reaches the user…
  assert.ok(
    !(outcome.textContent ?? "").includes("unauthorised"),
    "the failure code was shown instead of being worded",
  );
  assert.match(outcome.textContent ?? "", /rejected the credential/u);
  // …but the provider's own words do, labelled as theirs.
  assert.match(outcome.textContent ?? "", /provider said: 401 Unauthorized/u);
});

test("a rejected action is not dressed up as a failed outcome", async () => {
  harness({ missing: [SYNC_COMMANDS.push] });
  await renderPanel("status");

  fireEvent.click(screen.getByTestId("sync-push"));
  const problem = await screen.findByTestId("sync-action-error");
  assert.equal(problem.getAttribute("role"), "alert");
  assert.match(problem.textContent ?? "", /push_sync/u);
  assert.ok(
    screen.queryByTestId("sync-transfer-outcome") === null,
    "a command that never answered was reported as an outcome it did not produce",
  );
});

test("the cadence advertises the backend's range and reports its clamp", async () => {
  const host = harness({
    settings: storedSettings({ autoPushMinutes: null }),
    // Deliberately not the real constants: the renderer must be reading these
    // off the status, so a hard-coded 15 in the component would fail here.
    cadenceRange: { min: 20, max: 4_000 },
    clampCadence: (minutes) =>
      minutes === null ? null : Math.max(20, minutes),
  });
  await renderPanel("schedule");

  fireEvent.click(screen.getByRole("radio", { name: /Automatically/u }));
  const minutes = await screen.findByTestId("sync-cadence-minutes");
  // The range comes from `SyncStatus.autoPushMinutesRange`, which is why the
  // field may advertise one at all.
  assert.equal(minutes.getAttribute("min"), "20");
  assert.equal(minutes.getAttribute("max"), "4000");
  assert.ok(screen.getByText("Between 20 and 4000"));
  // Zero minutes is not a cadence, so Save waits for a real number.
  assert.equal(screen.getByTestId("sync-save").hasAttribute("disabled"), true);

  fireEvent.change(minutes, { target: { value: "5" } });
  clickSave();
  await savedAndIdle();
  assert.equal(host.configured.length, 1);
  assert.equal(
    host.configured[0].autoPushMinutes,
    5,
    "the renderer clamped the cadence itself instead of letting the backend decide",
  );
  // The backend stored 20 instead; the screen reports what it stored rather
  // than the number that was asked for.
  await waitFor(() => assert.ok(screen.queryByTestId("sync-cadence-adjusted")));
  assert.match(
    screen.getByTestId("sync-cadence-adjusted").textContent ?? "",
    /20 minutes/u,
  );
  // And the field itself holds the stored number, not the rejected one, with
  // nothing left to save. Showing 5 beside a note saying 20 was stored would
  // leave Save armed to send the rejected number again, forever.
  assert.equal(
    (screen.getByTestId("sync-cadence-minutes") as HTMLInputElement).value,
    "20",
  );
  assert.equal(screen.getByTestId("sync-save").hasAttribute("disabled"), true);
});

test("push is withheld, and explained, where this device's keys are not", async () => {
  // The login-screen host. A push seals whatever key list this device has, so
  // from a screen that cannot see the keys it would upload an empty bundle
  // over the user's only remaining copy — the one failure here that the app
  // cannot undo. Withheld with a reason, not silently absent.
  const host = harness();
  await useEnglishLocale();
  render(<SyncSettings section="status" allowPush={false} />);
  await waitFor(() => assert.ok(screen.queryByTestId("sync-section-status")));

  assert.ok(
    screen.queryByTestId("sync-push") === null,
    "a push was offered from a host that cannot see this device's keys",
  );
  assert.match(
    screen.getByTestId("sync-push-unavailable").textContent ?? "",
    // The distinctive part rather than the opening word. "Uploading" was
    // briefly reworded out of this notice during the provider-vocabulary pass
    // and then deliberately restored — it is a negation about an offer, not a
    // claim that anything reached anywhere — so what this assertion is for is
    // the notice being present at all. Scoped to the testid, so it cannot
    // collide with the keep-local notice phrased the same way.
    /not offered here/u,
  );
  // Pull is the whole point of this host, so it stays.
  assert.ok(screen.getByTestId("sync-pull"));
  assert.ok(!host.commands().includes(SYNC_COMMANDS.push));
});

test("keeping this device's copy is withheld wherever push is", async () => {
  // `keep-local` is a push in different words: it archives the provider's copy
  // in favour of this device's. From the host that cannot see this device's
  // keys, only the restore side is offered.
  const host = harness({
    pull: {
      state: "conflict",
      conflict: {
        local: null,
        remote: manifest({ generation: 3, deviceId: "device-laptop" }),
        expectedGeneration: 0,
      },
    },
  });
  await useEnglishLocale();
  render(<SyncSettings section="status" allowPush={false} />);
  await waitFor(() => assert.ok(screen.queryByTestId("sync-section-status")));

  fireEvent.click(screen.getByTestId("sync-pull"));
  await screen.findByTestId("sync-pull-dialog");
  fireEvent.click(
    screen.getByRole("button", { name: "Replace this device's keys" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  const panel = await screen.findByTestId("sync-conflict");
  // The restore side stays; the promoting side is withheld with a reason.
  within(panel).getByRole("button", { name: "Keep the provider's copy" });
  assert.ok(
    within(panel).queryByRole("button", {
      name: "Keep this device's copy",
    }) === null,
    "a host that cannot see this device's keys offered to promote them",
  );
  assert.match(
    within(panel).getByTestId("sync-keep-local-unavailable").textContent ?? "",
    /not offered here/u,
  );
  assert.ok(!host.commands().includes(SYNC_COMMANDS.resolve));
});

test("the panel runs with no props and no session", async () => {
  // How the login screen will mount it: no section, no callbacks, nothing from
  // a workspace. `get_sync_status` is a no-network read of preferences plus the
  // keyring, valid with zero API keys present.
  const host = harness({ settings: storedSettings({ lastSyncedAt: null }) });
  await useEnglishLocale();
  render(<SyncSettings />);

  // Uncontrolled: it opens on its own first section and the nav drives it.
  await waitFor(() => assert.ok(screen.queryByTestId("sync-section-provider")));
  assert.ok(host.commands().includes(SYNC_COMMANDS.status));
  fireEvent.click(screen.getByRole("button", { name: "Sync status" }));
  await waitFor(() => assert.ok(screen.queryByTestId("sync-section-status")));
  assert.match(
    screen.getByTestId("sync-last-synced").textContent ?? "",
    /never completed one/u,
  );
});

test("the panel and its hook import nothing that needs a session", async () => {
  // The import list is the thing that will quietly break the login-screen
  // host: a convenient `storageManager` or `useAuth` would compile, pass every
  // other test here, and only fail on the screen where no session exists.
  const forbidden =
    /(storageManager|cryptoManager|useAuth|isAuthenticated)|from "[^"]*(DNSManager|storage\/storage|auth\/)/u;
  for (const file of [
    "../src/components/dns/SyncSettings.tsx",
    "../src/hooks/dns/use-sync-settings.ts",
    "../src/components/dns/sync-view.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
      // Comments mention `DNSManager` on purpose, to say why this panel holds
      // nothing of it.
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    assert.ok(
      !forbidden.test(source),
      `${file} reaches for session-bound state, so it can no longer be hosted before login`,
    );
  }
});
