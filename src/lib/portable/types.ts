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
 * **An import cannot turn a feature on.** Feature switches
 * (`passkeysEnabled`, `registryMonitoringEnabled`, `cloudflareLatencyEnabled`)
 * are a security posture the user set on *this* machine; a file from elsewhere
 * re-opening the passkey ceremony path someone deliberately shut is the hazard
 * `BrowserPreferenceData` already names in its own comment. They are not
 * withheld outright -- that would make exporting a configured machine useless
 * -- but they are separated into {@link PortableSettingsDiff.optIn}, excluded
 * from "apply all", and applied only if the user ticks each one.
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
   * Feature switches. Excluded from "apply all" and applied only per-row, for
   * the reason this module's header gives.
   */
  optIn: PortableSettingsDiffRow[];
  /** Present in both and equal. Counted rather than listed. */
  unchangedCount: number;
  /**
   * Preferences the file carries that this build has no schema entry for.
   * Already dropped by the parser; surfaced so a downgrade is legible.
   */
  droppedKeys: string[];
}

/**
 * The preference keys an import must never write directly.
 *
 * `mcpEnabledTools` is here because granting a tool is gated, and the gate
 * lives in the permissions layer rather than in a preference write -- an
 * import routes it through `applyPortableToolPermissions` instead. The three
 * feature switches are here because turning a feature on is the user's call on
 * the machine it affects.
 *
 * Declared `satisfies readonly (keyof BrowserPreferenceData)[]` so a rename in
 * storage breaks this list at compile time rather than quietly emptying it.
 */
export const PORTABLE_GATED_PREFERENCE_KEYS = [
  "mcpEnabledTools",
  "mcpPendingHighRiskTools",
  "mcpRemovedImportedToolIds",
  "mcpPermissionPolicyVersion",
  "passkeysEnabled",
  "registryMonitoringEnabled",
  "cloudflareLatencyEnabled",
] as const satisfies readonly (keyof BrowserPreferenceData)[];

/** The subset of the above the user may still opt into, one row at a time. */
export const PORTABLE_OPT_IN_PREFERENCE_KEYS = [
  "passkeysEnabled",
  "registryMonitoringEnabled",
  "cloudflareLatencyEnabled",
] as const satisfies readonly (keyof BrowserPreferenceData)[];

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
