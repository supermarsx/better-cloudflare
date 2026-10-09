/**
 * App-wide cloud sync for the API key vault, over Nextcloud or Google Drive.
 *
 * # Configuration scope: this is global, and it has to be
 *
 * Settings in this app fall into three tiers, and sync sits in the first one
 * for a reason that is easy to miss until it is fatal:
 *
 * 1. **Global, reachable with no key present.** Provider details, the
 *    passphrase, and *pull*. These live in the global `Preferences` blob and
 *    the OS keyring, neither of which is scoped to an account.
 * 2. **Global, post-login.** Push, the automatic cadence, conflict
 *    resolution, sync history. App-wide, but not needed to bootstrap.
 * 3. **Key-relevant.** Anything meaningless without a particular key: the
 *    zones it can see, per-zone overrides, its open tabs.
 *
 * Tier 1 is load-bearing. **A fresh machine has no API keys**, so if the only
 * route to sync configuration were the Session settings screen, the sequence
 * would be: land on the login form with no keys, be unable to configure a
 * provider, be unable to pull the keys, and therefore never be able to log in.
 * The restore path would be unreachable at precisely the moment it is the only
 * thing that matters.
 *
 * So the panel is hosted twice — in the Session settings screen, and from the
 * login screen's own settings menu, which already hosts the other global
 * pre-key concerns (`EncryptionSettingsDialog`, `PasskeyManagerDialog`). That
 * is also why nothing in this feature may depend on an authenticated session:
 * `get_sync_status` is a no-network read of global preferences and the
 * keyring, and it is valid with zero keys stored.
 *
 * # Desktop only
 *
 * Both engines are desktop-only, and not as a scoping decision. A browser
 * cannot talk WebDAV to a Nextcloud instance that has not published CORS
 * headers for this origin, and the credential store this syncs is the OS
 * keyring, which the web build does not have — the web build keeps its keys in
 * `src/lib/storage/storage.ts` under WebCrypto instead. So the subtab carries
 * `desktopOnly`, every command below is `isDesktop()`-gated, and there is no
 * half-working web path for someone to discover.
 *
 * # Why this needs a passphrase of its own
 *
 * There is no single "vault passphrase" in this app to reuse. Each API key is
 * sealed under *its own* password (`add_api_key(label, email, apiKey,
 * password)`), with its own `iterations`, `key_length` and `algorithm`. So the
 * stored bundle is a list of per-key envelopes — and, crucially, the fields
 * around each envelope are plaintext: `label` and `email` identify the
 * Cloudflare account the key belongs to.
 *
 * Uploading that bundle as it sits would hand the provider every account label
 * and email address in the clear. That is why the bundle is sealed again, as a
 * whole, under a passphrase set for sync specifically:
 *
 * - The provider sees one opaque envelope. Not a key count, not a label, not
 *   an email, not which accounts this person administers.
 * - The per-key envelopes inside stay sealed under their own passwords, so the
 *   sync passphrase is never sufficient to *use* a key. Someone who learns it
 *   gets the metadata and a pile of ciphertext they still cannot open.
 *
 * The {@link SyncManifest} stored beside the envelope is the exception, and it
 * is unencrypted of necessity — see its own documentation for exactly what it
 * exposes and what it withholds. It carries no key count for this reason,
 * which is why {@link SYNC_COMMANDS.previewPull} exists: opening the envelope
 * is the only way to learn how many keys a pull would replace, and that has to
 * happen in a step that installs nothing.
 *
 * It is a real cost — one more secret to lose — so it is stated plainly in the
 * UI rather than buried: losing it costs the ability to *restore* from the
 * provider, never the keys on this device, which are in the keyring and
 * untouched by any of this.
 *
 * The passphrase is kept in the OS keyring beside the keys themselves. That is
 * the same trust boundary the keys already live behind, and the alternative is
 * prompting on every automatic push, which in practice means nobody turns
 * automatic push on.
 *
 * # Provider credentials never go in {@link SyncSettings}
 *
 * Preferences are written to a plain config store. A Nextcloud app password or
 * a Drive token in there would sit on disk unsealed, so both live in the
 * keyring and the settings below carry only
 * {@link SyncSettings.credentialPresent}, a boolean, so the screen can say
 * "connected" without being able to read it.
 *
 * Note that this is *not* the `src/lib/portable` export format, and must not
 * reuse it. That format excludes credentials by construction — a deliberate
 * property documented in `src/lib/portable/types.ts`. This feature exists to
 * move credentials, so it is a separate format with a separate marker, and the
 * two must not become confusable: an exported settings file dropped on this
 * importer has to be refused as the wrong kind, not merged.
 *
 * # Why there is no "Sign in with Google" button
 *
 * A desktop OAuth client cannot keep a client secret — it ships inside a
 * binary anyone can unzip, and this repo is public. Shipping one and calling
 * it a secret would be theatre. So the Drive engine takes a credential the
 * user obtains themselves, exactly as `bc-registrar/src/google.rs` already
 * does: it is handed an access token and `bearer_auth`s it, with no flow.
 * Nextcloud has no such problem — URL, username and app password is precisely
 * how Nextcloud expects a third-party client to authenticate.
 *
 * # Conflicts are refused, not merged
 *
 * This syncs a credential store. A lost write is a lost API key, and there is
 * no field-level reconciliation that means anything for an opaque sealed
 * envelope. So every upload carries the generation it believed it was
 * replacing, a remote that has moved since produces {@link SyncConflict}
 * rather than a write, and the user picks a side explicitly. The side they
 * discard is kept as a timestamped copy beside the live blob rather than
 * deleted, because "I picked wrong" must not be the end of someone's keys.
 */

/** Which backend a configured sync talks to. */
export type SyncProvider = "nextcloud" | "google-drive";

/**
 * App-wide sync settings, stored in `Preferences` and therefore **not** secret.
 *
 * Everything here is safe to write to the config store and to show on screen.
 * Both secrets — the provider credential and the sync passphrase — are in the
 * keyring, and the two `*Present` booleans are how the UI reports them.
 */
export type SyncSettings = {
  /** Version field, following `bc_notify::NotificationSettings`. */
  readonly version: number;
  readonly enabled: boolean;
  readonly provider: SyncProvider | null;
  /**
   * The WebDAV collection URL, e.g.
   * `https://cloud.example.test/remote.php/dav/files/alice/better-cloudflare`.
   * Unused by Drive, which addresses its own `appDataFolder`.
   */
  readonly webdavUrl: string | null;
  /** The Nextcloud account the app password belongs to. Not the password. */
  readonly webdavUsername: string | null;
  /** True when the keyring holds a provider credential. Never the value. */
  readonly credentialPresent: boolean;
  /** True when the keyring holds a sync passphrase. Never the value. */
  readonly passphrasePresent: boolean;
  /**
   * Minutes between automatic pushes, or `null` for manual only.
   *
   * Manual is the default. An automatic upload of a credential store should be
   * something the user switched on, not something they find out about.
   */
  readonly autoPushMinutes: number | null;
  /** ISO 8601, or null if this device has never completed one. */
  readonly lastSyncedAt: string | null;
};

/**
 * Settings as they arrive from the renderer, with the secrets to store.
 *
 * Both secret fields are write-only and distinguish three cases, because
 * "leave it alone" and "clear it" are different intents and one nullable
 * string cannot carry both: `undefined` leaves what is stored in place, `""`
 * clears it, and any other value replaces it.
 */
export type SyncSettingsInput = Omit<
  SyncSettings,
  "version" | "credentialPresent" | "passphrasePresent" | "lastSyncedAt"
> & {
  /** The app password or Drive token. Never read back out to the renderer. */
  readonly credential?: string;
  /** The sync passphrase. Never read back out to the renderer. */
  readonly passphrase?: string;
};

/**
 * What identifies a stored blob, so two devices can tell whether they agree.
 *
 * `generation` is a monotonic counter rather than a timestamp, and the
 * distinction matters: two machines' clocks disagree by more than the interval
 * between two syncs, so a last-write-wins rule keyed on a wrong clock silently
 * drops the other device's keys. `writtenAt` is for the user to read, and
 * nothing branches on it.
 *
 * # This is the part the provider can read
 *
 * The manifest is stored **unencrypted** beside the blob, because every field
 * in it is needed to decide what to do *before* a passphrase is available: to
 * answer "has the remote moved?" without downloading, to refuse a blob a newer
 * build wrote, and to derive the key that would open the blob at all. So it is
 * deliberately the smallest set that makes coordination possible.
 *
 * - **Exposed**: that this app is in use, the vault's size, when it was last
 *   written, how many times, from how many devices, and the KDF parameters.
 * - **Withheld**: how many keys there are, their labels, which Cloudflare
 *   accounts and email addresses they belong to, and the keys themselves.
 *
 * There is deliberately no `keyCount`, though it would have been convenient
 * for a pre-pull warning: a count of API keys is a count of the Cloudflare
 * accounts someone administers. The count comes from
 * {@link SYNC_COMMANDS.previewPull} instead, which opens the envelope and
 * writes nothing — see {@link SyncPullPreview}. Withholding it here therefore
 * costs one extra command rather than costing the user the warning.
 */
export type SyncManifest = {
  readonly generation: number;
  /** SHA-256 of the sealed envelope, hex. Catches a truncated upload. */
  readonly checksum: string;
  readonly bytes: number;
  /** When the uploading device wrote it. Display only — see above. */
  readonly writtenAt: string;
  /** A stable per-install id, so "which device wrote this" is answerable. */
  readonly deviceId: string;
  /**
   * A coarse description of the writing device, e.g. `Windows 11`.
   *
   * Deliberately not a hostname. This sits unencrypted in someone else's
   * storage, and a hostname is frequently a person's name; the OS family is
   * enough for "which of my machines wrote this" when read next to
   * `deviceId`, which is what actually distinguishes two installs.
   */
  readonly deviceLabel: string;
  /** Payload format version, so a newer device's blob is refused not mangled. */
  readonly payloadVersion: number;
  /**
   * The PBKDF2 parameters the envelope was sealed with.
   *
   * These travel in the clear of necessity: `bc-crypto`'s envelope is
   * `salt || nonce || ciphertext || tag` and carries no iteration count, so a
   * build whose default has moved on could not open an older blob without
   * them. `bc_storage::ApiKey` stores the same three fields per key for the
   * same reason. KDF parameters are public inputs — an attacker holding the
   * blob can only use them to do the work the legitimate holder does.
   */
  readonly iterations: number;
  readonly keyLength: number;
  readonly algorithm: string;
};

/**
 * Why a push or pull did not happen.
 *
 * Codes, not prose — the renderer words them. This crosses the Tauri boundary
 * and the backend has no locale, the same reason `UndoRefusalCode` exists in
 * `@/lib/history/types`.
 */
export type SyncFailureCode =
  /** No provider chosen, or the keyring has no credential for it. */
  | "not-configured"
  /** Enabled and configured, but no sync passphrase has been set. */
  | "no-passphrase"
  /** The endpoint rejected the credential. */
  | "unauthorised"
  /** DNS, TLS, timeout — anything that never reached the endpoint. */
  | "unreachable"
  /** Reached it, and it answered with something unusable. */
  | "provider-error"
  /** Nothing has ever been pushed, so there is nothing to pull. */
  | "no-remote-blob"
  /** The remote blob's `payloadVersion` is newer than this build understands. */
  | "payload-too-new"
  /** The bytes do not match the manifest checksum. */
  | "corrupt"
  /** The passphrase did not open the envelope. */
  | "wrong-passphrase"
  /** The sealed envelope is larger than the format allows. */
  | "too-large";

/** The remote moved since this device last saw it. Nothing was written. */
export type SyncConflict = {
  /** This device's view. Null when pulling onto a device with no local blob. */
  readonly local: SyncManifest | null;
  readonly remote: SyncManifest;
  /**
   * The generation this device believed it was replacing. Lower than
   * `remote.generation` is the ordinary case: another device pushed between
   * this device's last sync and now.
   */
  readonly expectedGeneration: number;
};

/** The outcome of a push or a pull. Exactly one of these shapes. */
export type SyncOutcome =
  | { readonly state: "ok"; readonly manifest: SyncManifest }
  /** Both sides already agree; nothing was transferred. */
  | { readonly state: "unchanged"; readonly manifest: SyncManifest }
  | { readonly state: "conflict"; readonly conflict: SyncConflict }
  | {
      readonly state: "failed";
      readonly code: SyncFailureCode;
      /** The provider's own words, when it gave any. Not translated. */
      readonly message: string | null;
    };

/** What the settings screen shows without touching the network. */
export type SyncStatus = {
  readonly settings: SyncSettings;
  /** The last manifest this device pushed or pulled, if any. */
  readonly lastKnown: SyncManifest | null;
  /** This install's id and label, so the UI can say "this device". */
  readonly deviceId: string;
  readonly deviceLabel: string;
  /**
   * The bounds the backend will clamp {@link SyncSettings.autoPushMinutes} to.
   *
   * Carried here rather than restated in TypeScript so that Rust stays the
   * single source: `MIN_AUTO_PUSH_MINUTES` and `MAX_AUTO_PUSH_MINUTES` are
   * where the reasoning for the numbers lives, and a duplicated pair is a pair
   * that disagrees after the first change to one of them. Without this the
   * cadence field cannot honestly advertise a range at all.
   */
  readonly autoPushMinutesRange: { readonly min: number; readonly max: number };
};

/**
 * What a pull would do, before it does any of it.
 *
 * # Why this exists as its own command
 *
 * A pull replaces this device's entire API key list, which makes it the most
 * destructive thing in the feature — and {@link SYNC_COMMANDS.pull} both opens
 * the envelope *and* installs it, so it can never be the thing that shows a
 * preview. An earlier version of this file claimed the key count would "appear
 * at the preview step" while specifying no command that could produce one.
 * That was unbuildable, and it would have shipped as a single irreversible
 * button.
 *
 * So {@link SYNC_COMMANDS.previewPull} opens the envelope and **writes
 * nothing**: no key list change, no `lastSyncedAt`, no remembered manifest. It
 * is also where a wrong passphrase is normally discovered, which is the right
 * place for it — before the user's keys have been touched rather than after.
 */
export type SyncPullPreview = {
  readonly manifest: SyncManifest;
  /** Keys inside the envelope. Only knowable once it is open — see
   * {@link SyncManifest}'s note on why the manifest withholds this. */
  readonly keyCount: number;
  /** Keys on this device now, so the screen can say "3 become 5". */
  readonly localKeyCount: number;
};

/**
 * The outcome of a preview. Shares the failure and conflict shapes with
 * {@link SyncOutcome} deliberately: a preview fails for exactly the reasons a
 * pull fails, and a second vocabulary for the same conditions would mean the
 * screen wording them twice.
 */
export type SyncPreviewOutcome =
  | { readonly state: "ok"; readonly preview: SyncPullPreview }
  | { readonly state: "conflict"; readonly conflict: SyncConflict }
  | {
      readonly state: "failed";
      readonly code: SyncFailureCode;
      readonly message: string | null;
    };

/** Which side of a conflict to keep. Both keep a copy of the other. */
export type ConflictResolution = "keep-local" | "keep-remote";

/**
 * The commands this feature adds. Named here so the renderer and the backend
 * cannot drift on the strings: an unregistered command typechecks fine and
 * fails only when a user reaches it, which has happened in this repo before.
 */
export const SYNC_COMMANDS = {
  /** Read settings and the last known manifest. No network. */
  status: "get_sync_status",
  /** Write settings; stores or clears the keyring secrets. */
  configure: "configure_sync",
  /** Reach the endpoint and report whether the credential works. */
  test: "test_sync_connection",
  /** Seal and upload, refusing if the remote generation moved. */
  push: "push_sync",
  /** Open the envelope and report what a pull would do. Writes nothing. */
  previewPull: "preview_sync_pull",
  /** Download, open and install, refusing if this device has local changes. */
  pull: "pull_sync",
  /** Take one side of a conflict, keeping the other as a timestamped copy. */
  resolve: "resolve_sync_conflict",
} as const satisfies Record<string, string>;

/**
 * The argument each command takes, by its own name.
 *
 * Pinned because Tauri arguments are **named**: a renderer sending `{ config }`
 * to a handler expecting `settings` typechecks on both sides and fails only at
 * runtime, which is the same class of defect `SYNC_COMMANDS` exists to prevent
 * for the command strings themselves. Four of the seven take nothing, which is
 * also worth stating — a no-argument command is a decision here, not an
 * omission: the passphrase and the credential come from the keyring, never
 * from the renderer, so there is nothing for it to pass.
 */
export type SyncCommandArgs = {
  readonly get_sync_status: Record<string, never>;
  readonly test_sync_connection: Record<string, never>;
  readonly push_sync: Record<string, never>;
  readonly preview_sync_pull: Record<string, never>;
  readonly pull_sync: Record<string, never>;
  readonly configure_sync: { readonly settings: SyncSettingsInput };
  readonly resolve_sync_conflict: { readonly resolution: ConflictResolution };
};

/**
 * The largest sealed envelope this will move.
 *
 * `bc-crypto` caps one plaintext at `MAX_PLAINTEXT_BYTES` (64 KiB) and a
 * base64 envelope at `MAX_BASE64_CHARS` (~85 KiB), so this bound sits just
 * above the latter and the real limit is the crypto layer's. A vault that has
 * outgrown 64 KiB of JSON is a different problem from a sync one, so this
 * refuses with `too-large` rather than chunking: splitting a credential store
 * across provider objects multiplies the ways a partial restore can happen,
 * and a partially restored key vault is worse than a refused one.
 */
export const MAX_SYNC_ENVELOPE_BYTES = 96 * 1024;

/**
 * Marks a blob as this feature's, and distinguishes it from a portable
 * settings export, which is a different format that deliberately carries no
 * credentials. Checked before anything else.
 */
export const SYNC_PAYLOAD_FORMAT = "better-cloudflare/sync-vault";

/**
 * Bumped only for a change an older build would read *incorrectly*. A new
 * optional field does not need it: unknown keys are dropped.
 */
export const SYNC_PAYLOAD_VERSION = 1;

/** The object name under the configured collection or app-data folder. */
export const SYNC_BLOB_NAME = "better-cloudflare-vault.enc";

/** Its manifest, stored beside it so one request answers "has this moved?". */
export const SYNC_MANIFEST_NAME = "better-cloudflare-vault.json";
