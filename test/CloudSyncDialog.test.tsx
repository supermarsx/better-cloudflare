/**
 * Cloud sync on the login screen — the host that makes a restore possible.
 *
 * Two claims, and both are about a machine that has nothing yet.
 *
 * **The route exists.** `src/App.tsx` renders `DNSManager`, and therefore
 * every settings screen in it, only once `isAuthenticated`. A fresh install
 * has no API keys, so if sync configuration lived only there the user would
 * land on the login form with no way to configure a provider, no way to pull
 * the keys, and so no way to sign in — the restore path unreachable at exactly
 * the moment it is the only thing that matters. The menu item is that route,
 * and it is gated on the build rather than on having keys.
 *
 * **Push is withheld, and says so.** A push seals whatever key list this
 * device currently holds and uploads it as a new generation. From this screen
 * that list is empty, so a push would upload nothing over the user's only
 * remaining copy — the one act in this feature with no recovery. So the host
 * passes `allowPush={false}`, which also gates "keep this device's copy" on a
 * conflict, because keeping the local side archives the provider's copy in
 * favour of keys this screen cannot see. That is a push in different words.
 *
 * The second claim is checked twice on purpose: once through the rendered
 * screen, and once against the source. The rendered check is the real one, but
 * it passes vacuously if the panel ever stops offering a push button at all,
 * whereas the source check fails if the prop is dropped in a refactor — which
 * is how this would actually regress.
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
} from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { CloudSyncDialog } from "../src/components/auth/CloudSyncDialog";
import { LoginSettingsMenu } from "../src/components/auth/login-form/LoginSettingsMenu";
import { SYNC_COMMANDS, type SyncStatus } from "../src/lib/sync/types";
import type { ApiKey } from "../src/types/dns";

import { useEnglishLocale } from "./i18n-ready";
import { stripComments } from "./source-text";

useEnglishLocale();

afterEach(() => {
  cleanup();
  clearMocks();
});

/**
 * A device part-way through a restore: the provider and passphrase are in,
 * and nothing has ever been synced *to* this machine.
 *
 * Deliberately not a blank status. With no provider the panel correctly offers
 * no pull — there is nowhere to pull from — so a blank status would prove
 * nothing about whether pull is available here. This is the state someone
 * restoring is actually in by the time it matters.
 */
function restoringStatus(): SyncStatus {
  return {
    settings: {
      version: 1,
      enabled: true,
      provider: "nextcloud",
      webdavUrl: "https://cloud.example.test/remote.php/dav/files/alice/bc",
      webdavUsername: "alice",
      folderPath: null,
      credentialPresent: true,
      passphrasePresent: true,
      autoPushMinutes: null,
      lastSyncedAt: null,
    },
    lastKnown: null,
    deviceId: "device-fresh",
    deviceLabel: "Windows 11",
    autoPushMinutesRange: { min: 15, max: 10080 },
  };
}

function mockHost() {
  mockIPC(async (command) => {
    if (command === SYNC_COMMANDS.status) return restoringStatus();
    throw new Error(`unexpected command ${command}`);
  });
}

const selectedKey: ApiKey = {
  id: "key-1",
  label: "Primary",
  encryptedKey: "encrypted",
  salt: "salt",
  iv: "iv",
  iterations: 1,
  keyLength: 32,
  algorithm: "AES-GCM",
  createdAt: new Date().toISOString(),
};

const menuProps = {
  onAddKey: () => {},
  onSettings: () => {},
  onEditKey: () => {},
  onDeleteKey: () => {},
};

/**
 * Open the menu and return its items in document order.
 *
 * Matched by position and text rather than accessible name, and asserted as a
 * whole list — the idiom `test/LoginSettingsMenu.test.tsx` documents, because
 * once Radix has mounted its portal under jsdom the computed accessible name
 * of everything inside it comes back empty.
 */
async function openMenu() {
  const trigger = screen.getByRole("button", { name: /keys and settings/i });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await waitFor(() =>
    assert.ok(screen.getAllByRole("menuitem", { hidden: true }).length > 0),
  );
  return screen.getAllByRole("menuitem", { hidden: true });
}

test("the login menu offers cloud sync on desktop, and not on the web build", async () => {
  // The web build has no such feature: sync speaks WebDAV and keeps its
  // secrets in the OS keyring. Omitting the callback is what hides it, so
  // there is no way to show an item that leads nowhere.
  const view = render(
    <LoginSettingsMenu {...menuProps} hasKeys={false} selectedKey={null} />,
  );
  assert.deepEqual(
    (await openMenu()).map((item) => item.textContent),
    ["Add New Key", "Manage Key", "Settings"],
    "the web build must not offer a feature it does not have",
  );

  view.rerender(
    <LoginSettingsMenu
      {...menuProps}
      hasKeys={false}
      selectedKey={null}
      onCloudSync={() => {}}
    />,
  );
  assert.deepEqual(
    screen
      .getAllByRole("menuitem", { hidden: true })
      .map((item) => item.textContent),
    ["Add New Key", "Manage Key", "Cloud sync", "Settings"],
    "cloud sync sits above Settings, where someone restoring will look",
  );
});

test("cloud sync is reachable with no keys at all", async () => {
  // The whole point. Every other dialog on this screen needs a key to act on;
  // this one is useful precisely when there are none, so it must not be gated
  // on `hasKeys` or on a selected key the way key management is.
  render(
    <LoginSettingsMenu
      {...menuProps}
      hasKeys={false}
      selectedKey={null}
      onCloudSync={() => {}}
    />,
  );

  const items = await openMenu();
  const cloudSync = items[2];
  assert.equal(cloudSync.textContent, "Cloud sync");
  assert.ok(
    cloudSync.getAttribute("aria-disabled") === null,
    "a machine with no keys is the case this item exists for",
  );
  // Contrast: key management is disabled in the same render.
  assert.equal(items[1].getAttribute("aria-disabled"), "true");
});

test("the dialog hosts the sync panel with uploading withheld", async () => {
  mockHost();
  render(<CloudSyncDialog open onOpenChange={() => {}} />);

  await waitFor(() =>
    assert.ok(screen.getByTestId("login-cloud-sync-dialog") !== null),
  );

  // Both controls live in the Sync status section, so get there first. The
  // panel opens on Provider, which is the right order for a setup and the
  // wrong one for this assertion.
  await waitFor(() =>
    assert.ok(screen.getByRole("button", { name: "Sync status" }) !== null),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sync status" }));

  // Pull is the reason this screen exists, so it has to be offered.
  await waitFor(() =>
    assert.ok(
      screen.queryByRole("button", { name: /pull/i }) !== null,
      "a restore host that does not offer a pull is not a restore host",
    ),
  );

  // Push must not be, and the panel must say why rather than leaving a gap:
  // a control that is simply missing reads as a bug, and this one's absence
  // is the point.
  assert.ok(
    screen.queryByRole("button", { name: /^push/i }) === null,
    "a push from here uploads an empty vault over the user's only copy",
  );
  assert.ok(
    screen.getByText(/uploading is not offered here/i) !== null,
    "the withheld push has to explain itself",
  );
});

test("the dialog passes allowPush={false}, checked against the source", () => {
  // The rendered assertion above is the real one, but it would pass vacuously
  // if the panel ever stopped offering a push button at all. This fails if the
  // prop is dropped, which is how it would actually regress — an innocuous
  // refactor of a host, not a decision about uploads.
  // Comments stripped. This assertion is clean today only because nobody has
  // yet described this component's props in a sentence beside the code — the
  // day someone writes "mounts <SyncSettings allowPush={false} />" in a
  // comment, it stops asserting and nothing says so. Stripping makes it safe
  // by construction rather than by luck.
  const source = stripComments(
    readFileSync(
      new URL("../src/components/auth/CloudSyncDialog.tsx", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    source,
    /<SyncSettings\s+allowPush=\{false\}\s*\/>/,
    "the login host must mount the panel with uploading withheld",
  );
});
