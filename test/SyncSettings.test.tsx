/**
 * The Sync settings panel, against a mocked IPC boundary.
 *
 * Four claims, and each one is a way this screen could lie about something
 * that costs the user their API keys:
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
  SYNC_COMMANDS,
  type SyncManifest,
  type SyncOutcome,
  type SyncPreviewOutcome,
  type SyncSettings as SyncSettingsValue,
  type SyncSettingsInput,
  type SyncStatus,
} from "../src/lib/sync/types";

import { useEnglishLocale } from "./i18n-ready";

const DEVICE_ID = "device-this";

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

/** The panel, opened on one section. */
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
  assert.equal(
    save.hasAttribute("disabled"),
    false,
    "Save is disabled, so this click would do nothing",
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
  assert.ok(screen.getByText("Stored on this device"));
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
    /Uploading is not offered here/u,
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
