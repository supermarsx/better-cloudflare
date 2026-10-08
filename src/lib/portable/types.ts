/**
 * The file format for configuration that leaves the app, and the rules an
 * import obeys.
 *
 * Types and constants only. Implementations live beside this file so that the
 * shape a reader has to trust is small, and so that the security properties
 * below can be read in one place rather than inferred from four parsers.
 *
 * ## Three properties this format exists to hold
 *
 * **An export carries no credentials, by construction.** A settings payload is
 * a {@link BrowserPreferenceData}, and `apiKeys` / `currentSession` are not
 * keys of that type -- they are on `StorageData`, one level up. The exporter
 * passes its object through `sanitizeBrowserPreferencesValue`, whose schema is
 * declared `satisfies Record<keyof BrowserPreferenceData, PreferenceKind>`, so
 * every preference is classified and nothing else survives. A credential field
 * added to storage later is therefore excluded by default: it would have to be
 * added to `BrowserPreferenceData` *and* classified in that schema to appear in
 * an export, and both are visible edits.
 *
 * **An import cannot grant a tool permission that manual use would have asked
 * about.** Imported tool ids go through the same
 * `partitionMcpPermissionPolicySelection` that a click in the permissions
 * screen does, so anything above `read` risk arrives *pending confirmation*
 * rather than enabled, and an id with no reviewed entry in the catalogue is
 * dropped instead of being granted at `admin` risk. There is no import-only
 * path into the enabled set.
 *
 * **An import cannot move a feature switch in its dangerous direction.** Which
 * direction that is differs per switch, and treating them alike gets half of
 * them wrong. Turning registry monitoring or the latency probe *on* restarts
 * outbound work someone deliberately stopped, so that direction needs a
 * deliberate tick and is excluded from "apply all"; turning them off only
 * stops requests and is safe. `passkeysEnabled` is the mirror image: turning
 * it *on* merely adds a sign-in route and can strand nobody, while turning it
 * *off* removes one -- and because a passkey here releases the API key from
 * the OS vault without that key's password, it is a second *route* rather than
 * a second factor, and may be the only route a user still remembers. The
 * settings screen therefore refuses to turn it off without proving that key's
 * password in the same dialog. An import has no such proof and a tick is not
 * one, so that direction is withheld outright. See
 * {@link PORTABLE_FEATURE_SWITCH_POLICY}.
 */
import type { BrowserPreferenceData } from "@/lib/storage/storage-util";

/**
 * Marks a file as this app's. Checked before anything else, so an unrelated
 * JSON file dropped on the importer is refused on sight rather than coerced
 * into a shape it was never meant to have.
 */
export const PORTABLE_FORMAT = "better-cloudflare/portable-config";

/**
 * Bumped only for a change an older build could not read correctly. A new
 * optional field does not need it: unknown keys are dropped, so an older build
 * reading a newer file loses the field rather than misreading the file.
 */
export const PORTABLE_FORMAT_VERSION = 1;

/** The largest import this will parse, before it is parsed. */
export const MAX_PORTABLE_FILE_BYTES = 2 * 1024 * 1024;

/** Bounds on a persona bundle, matched to `MAX_CUSTOM_PERSONAS` in Rust. */
export const MAX_PORTABLE_PERSONAS = 64;

/**
 * Bounds on saved permission sets, and on the name one carries.
 *
 * Re-exported rather than restated: a file may carry exactly as many sets as
 * the app can hold, and two constants with the same value today are two
 * constants that disagree after the first change to one of them.
 */
export {
  MAX_MCP_PERMISSION_SETS,
  MAX_MCP_PERMISSION_SET_NAME_BYTES,
} from "@/lib/mcp/tool-permissions";

export type PortableKind = "personas" | "tool-permissions" | "settings";

export interface PortableEnvelope<
  TKind extends PortableKind = PortableKind,
  TPayload = unknown,
> {
  format: typeof PORTABLE_FORMAT;
  version: number;
  kind: TKind;
  /** ISO 8601, for the reader's benefit. Never trusted for ordering. */
  exportedAt: string;
  /** The app version that wrote the file, for a support conversation. */
  appVersion: string;
  payload: TPayload;
}

/**
 * A persona as it travels.
 *
 * No `id` and no `builtin`, mirroring `AiPersonaInput` in
 * `bc-ai-agent/src/personas.rs`: the backend issues ids and decides what is
 * builtin, so a file cannot claim an id, shadow a builtin, or pass itself off
 * as one. Import therefore goes through the ordinary create command and gets
 * the ordinary validation -- byte bounds and the control-character rule --
 * with no second code path to keep in step.
 */
export interface PortablePersona {
  name: string;
  description: string;
  systemPrompt: string;
}

/** A named selection of tools the user can switch between. */
export interface PortablePermissionSet {
  name: string;
  /** Catalogue ids. Reconciled on import; unknown ids are dropped. */
  toolIds: string[];
}

export interface PortableToolPermissions {
  /**
   * `MCP_PERMISSION_POLICY_VERSION` at export. A file from a build with a
   * different policy version still imports -- the ids are reconciled against
   * the current catalogue either way -- but the number is reported, because
   * "nine of your tools no longer exist" reads very differently when the
   * policy itself has moved on.
   */
  policyVersion: number;
  enabledToolIds: string[];
  sets: PortablePermissionSet[];
}

export interface PortableSettings {
  preferences: BrowserPreferenceData;
}

export type PortablePersonasEnvelope = PortableEnvelope<
  "personas",
  PortablePersona[]
>;
export type PortableToolPermissionsEnvelope = PortableEnvelope<
  "tool-permissions",
  PortableToolPermissions
>;
export type PortableSettingsEnvelope = PortableEnvelope<
  "settings",
  PortableSettings
>;

/**
 * Why a file was refused outright, as a tag rather than a sentence, so the
 * renderer picks the wording and the translators have a fixed set of keys.
 */
export type PortableRejection =
  | "not-json"
  | "not-our-format"
  | "unsupported-version"
  | "wrong-kind"
  | "malformed-payload"
  | "too-large"
  | "empty";

/**
 * What a parse dropped while still succeeding.
 *
 * Separate from {@link PortableRejection} on purpose: a file holding sixty
 * good personas and one malformed entry should import sixty, and say so. Only
 * a file that is not usable at all is rejected.
 */
export interface PortableParseWarning {
  reason:
    | "unknown-tool-id"
    | "high-risk-pending"
    | "invalid-persona"
    | "too-many-personas"
    | "too-many-sets"
    | "unknown-preference"
    | "policy-version-differs";
  /** Catalogue ids, persona names, or preference keys, bounded by the parser. */
  subjects: string[];
}

export type PortableParse<T> =
  | { ok: true; value: T; warnings: PortableParseWarning[] }
  | { ok: false; rejection: PortableRejection; detail: string };

/** One preference an import would change. */
export interface PortableSettingsDiffRow {
  key: keyof BrowserPreferenceData;
  /** `undefined` means the preference is unset, which is not the same as off. */
  current: unknown;
  incoming: unknown;
}

/**
 * What an import would do, computed before anything is written so the user
 * sees it first. A settings import never applies without this being shown.
 */
export interface PortableSettingsDiff {
  /** Applied by "apply all". */
  changed: PortableSettingsDiffRow[];
  /**
   * Feature switches moving in the direction that needs a deliberate choice.
   * Excluded from "apply all" and applied only per row.
   */
  optIn: PortableSettingsDiffRow[];
  /**
   * Changes an import is not allowed to make at all, with the reason.
   *
   * Distinct from {@link optIn} because a tick cannot substitute for every
   * guard. Turning passkeys *off* is the case: the settings screen refuses
   * that until the password for the signed-in key has been proven in the same
   * dialog, and ticking a row in an import preview is not that proof.
   */
  withheld: PortableWithheldRow[];
  /** Present in both and equal. Counted rather than listed. */
  unchangedCount: number;
  /**
   * Preferences the file carries that this build did not accept -- either
   * unknown to the schema, or carrying a value of the wrong shape for a key
   * it does know. Already dropped by the parser; surfaced so a file written by
   * a newer build, or a hand-edited one, is legible rather than silently
   * thinner than it looks.
   */
  droppedKeys: string[];
}

/** Why a change was refused outright, as a tag the renderer words. */
export type PortableWithheldReason = "needs-password-proof";

export interface PortableWithheldRow extends PortableSettingsDiffRow {
  reason: PortableWithheldReason;
}

/**
 * The preference keys an import must never write directly.
 *
 * Granting a tool is gated, and the gate lives in the permissions layer rather
 * than in a preference write -- an import routes it through
 * `applyPortableToolPermissions` instead, so these four never appear in a
 * diff row at all.
 *
 * Declared `satisfies readonly (keyof BrowserPreferenceData)[]` so a rename in
 * storage breaks this list at compile time rather than quietly emptying it.
 */
export const PORTABLE_GATED_PREFERENCE_KEYS = [
  "mcpEnabledTools",
  "mcpPendingHighRiskTools",
  "mcpRemovedImportedToolIds",
  "mcpPermissionPolicyVersion",
] as const satisfies readonly (keyof BrowserPreferenceData)[];

/**
 * How an import may move each feature switch, and in which direction.
 *
 * The direction matters, and getting it wrong in either place is a real
 * hazard, so it is stated per key rather than applied uniformly.
 *
 * `enabling-needs-opt-in` — turning the feature *on* restarts outbound work
 * someone deliberately stopped, so it needs a deliberate tick. Turning it off
 * only stops requests and is safe to apply with everything else.
 *
 * `disabling-withheld` — turning the feature *off* removes something the user
 * may depend on, and no tick substitutes for the guard the UI applies. This is
 * `passkeysEnabled`: a passkey here is not a second factor but a second
 * *route*, because it releases the API key from the OS vault without that
 * key's password. For someone who enrolled one and has relied on it since, it
 * can be the only route they still remember. The settings screen therefore
 * refuses to turn it off until `decryptApiKey` has proven the password for the
 * signed-in key in the same dialog — and an import has no such proof, so a
 * profile carrying `passkeysEnabled: false` would route straight around the
 * lockout defence. Turning passkeys *on* is the safe direction: it only adds a
 * route and can strand nobody.
 */
export type PortableSwitchPolicy =
  "enabling-needs-opt-in" | "disabling-withheld";

export const PORTABLE_FEATURE_SWITCH_POLICY = {
  passkeysEnabled: "disabling-withheld",
  registryMonitoringEnabled: "enabling-needs-opt-in",
  cloudflareLatencyEnabled: "enabling-needs-opt-in",
} as const satisfies Partial<
  Record<keyof BrowserPreferenceData, PortableSwitchPolicy>
>;

/** The feature switches the policy above governs. */
export const PORTABLE_FEATURE_SWITCH_KEYS = Object.keys(
  PORTABLE_FEATURE_SWITCH_POLICY,
) as readonly (keyof typeof PORTABLE_FEATURE_SWITCH_POLICY)[];

/**
 * Preferences that describe *this* machine or *this* moment and mean nothing
 * on another one. Excluded from an export so an import does not drag a
 * stranger's open tabs, last zone, or update-check timestamp along with their
 * genuine preferences.
 */
export const PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS = [
  "__storageRevision",
  "lastZone",
  "lastActiveTabId",
  "lastOpenTabs",
  "updateCheckLastCheckedAt",
] as const satisfies readonly (keyof BrowserPreferenceData)[];
