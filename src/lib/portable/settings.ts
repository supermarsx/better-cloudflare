/**
 * Preferences on their way out of the app and back in.
 *
 * Both directions run through `sanitizeBrowserPreferencesValue`, which is what
 * makes the first property in `./types` true by construction rather than by
 * inspection: its schema is declared
 * `satisfies Record<keyof BrowserPreferenceData, PreferenceKind>`, so a
 * preference that is not classified there does not survive the pass, and
 * `apiKeys` and `currentSession` are not keys of that type at all. An export
 * therefore cannot carry a credential even if one is added to storage later --
 * it would have to be added to `BrowserPreferenceData` *and* classified in
 * that schema first, and both are visible edits.
 *
 * Nothing here writes anything. {@link diffPortableSettings} is the only
 * sanctioned path into a preference write: `changed` is what "apply all"
 * applies, `optIn` is what the user must tick row by row, `withheld` is what
 * an import may not do at all, and a key in
 * `PORTABLE_GATED_PREFERENCE_KEYS` reaches none of the three.
 */
import {
  sanitizeBrowserPreferencesValue,
  type BrowserPreferenceData,
} from "@/lib/storage/storage-util";

import {
  boundedWarningSubjects,
  buildEnvelope,
  isPortableRecord,
  parseEnvelope,
  portableReject,
  portableWarning,
  type PortableEnvelopeOptions,
} from "./envelope";
import {
  PORTABLE_FEATURE_SWITCH_POLICY,
  PORTABLE_GATED_PREFERENCE_KEYS,
  PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS,
  type PortableParse,
  type PortableSettings,
  type PortableSettingsDiff,
  type PortableSettingsDiffRow,
  type PortableSettingsEnvelope,
  type PortableWithheldRow,
} from "./types";

const GATED_KEYS: ReadonlySet<string> = new Set(PORTABLE_GATED_PREFERENCE_KEYS);
const MACHINE_LOCAL_KEYS: ReadonlySet<string> = new Set(
  PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS,
);

interface PortablePreferenceProjection {
  preferences: BrowserPreferenceData;
  /**
   * Keys the file carried that this build did not accept.
   *
   * Two causes, deliberately not distinguished: the schema has no entry for
   * the key at all, or it has one and the value was the wrong shape for it.
   * `sanitizeBrowserPreferencesValue` drops both the same way and does not say
   * which, and inferring it here would mean re-deriving its per-kind rules --
   * a second copy of the schema, which is the drift this module avoids
   * everywhere else. The honest report is "the file asked for this and it did
   * not survive", which is what the user needs to know either way.
   */
  droppedKeys: string[];
}

/**
 * The preferences of an untrusted object, and what was lost on the way.
 *
 * Machine-local keys are removed in both directions. The exporter leaves them
 * out, so a file that still carries `lastOpenTabs` or `__storageRevision` was
 * hand-made, and an import that honoured them would drag a stranger's open
 * tabs -- or their storage revision, which migrations read -- onto this
 * machine. They are not reported as dropped: they are known keys that this
 * format simply does not carry, which is not the downgrade `droppedKeys` is
 * there to make legible.
 */
function projectPortablePreferences(
  value: unknown,
): PortablePreferenceProjection {
  const preferences = sanitizeBrowserPreferencesValue(value);
  const kept = new Set(Object.keys(preferences));
  const droppedKeys = isPortableRecord(value)
    ? Object.keys(value).filter(
        (key) => !kept.has(key) && !MACHINE_LOCAL_KEYS.has(key),
      )
    : [];
  for (const key of PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS) {
    delete preferences[key];
  }
  return { preferences, droppedKeys };
}

/**
 * The preferences worth carrying, as they travel.
 *
 * Throws if the object cannot be sanitized, which is not a case this has to
 * handle gracefully: the ceilings `sanitizeBrowserPreferencesValue` enforces
 * are the storage layer's own, so a preference object that fails them could
 * not have been stored in the first place.
 */
export function exportSettings(
  preferences: BrowserPreferenceData,
  options: PortableEnvelopeOptions,
): PortableSettingsEnvelope {
  return buildEnvelope(
    "settings",
    { preferences: projectPortablePreferences(preferences).preferences },
    options,
  );
}

export function parseSettingsFile(
  raw: string,
): PortableParse<PortableSettingsEnvelope> {
  const envelope = parseEnvelope(raw, "settings");
  if (!envelope.ok) return envelope;

  const payload = envelope.value.payload;
  if (!isPortableRecord(payload) || !isPortableRecord(payload.preferences)) {
    return portableReject(
      "malformed-payload",
      "the payload has no preferences object",
    );
  }

  let projection: PortablePreferenceProjection;
  try {
    projection = projectPortablePreferences(payload.preferences);
  } catch (error) {
    // The bounds the sanitizer enforces are the ones storage enforces, so a
    // payload that breaks them is a payload this build could not apply.
    return portableReject(
      "malformed-payload",
      error instanceof Error
        ? error.message
        : "the preferences could not be read",
    );
  }

  return {
    ok: true,
    value: {
      ...envelope.value,
      payload: { preferences: projection.preferences },
    },
    warnings: portableWarning("unknown-preference", projection.droppedKeys),
  };
}

/**
 * Structural equality for preference values.
 *
 * Needed because most of these are objects and arrays: a column list that
 * round-tripped through JSON is a different array object with the same
 * members, and a diff row claiming it changed would be a row the user cannot
 * act on. Arrays compare in order, since order is meaningful for every array
 * in the schema -- `dnsTableColumns` is the column order the table renders.
 *
 * Recursion is safe without a depth guard: both sides have been through
 * `assertBoundedStorageValue`, which refuses anything nested deeper than
 * twelve levels, and the deepest shape the schema describes is three.
 */
function deepEqualPreference(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqualPreference(item, right[index]))
    );
  }
  if (!isPortableRecord(left) || !isPortableRecord(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      deepEqualPreference(left[key], right[key]),
  );
}

/**
 * What an import would change, computed before anything is written.
 *
 * Only keys the file carries are considered. A preference set here and absent
 * from the file is not a change an import makes -- importing a configuration
 * adds and overwrites, it does not unset -- so it appears in neither list.
 *
 * `current` is read key by key rather than compared wholesale because an
 * absent preference and a `false` one are different states: several of these
 * are documented "absent means on", so a row rendering `undefined` as "off"
 * would tell the user an import leaves a feature alone when it is about to
 * turn it off.
 *
 * Rows come out in schema order rather than file order: the sanitizer walks
 * `BROWSER_PREFERENCE_SCHEMA` to build its result, so two files listing the
 * same preferences in different orders produce the same diff.
 */
export function diffPortableSettings(
  current: BrowserPreferenceData | undefined,
  incoming: PortableSettings,
): PortableSettingsDiff {
  // Sanitized again rather than trusted: this is reachable with the payload
  // straight out of the file, which is also the only way `droppedKeys` is ever
  // non-empty -- a payload that came from `parseSettingsFile` has already had
  // them removed, and that parse named them in an `unknown-preference`
  // warning.
  let projection: PortablePreferenceProjection;
  try {
    projection = projectPortablePreferences(incoming.preferences);
  } catch {
    return {
      changed: [],
      optIn: [],
      withheld: [],
      unchangedCount: 0,
      droppedKeys: [],
    };
  }

  const changed: PortableSettingsDiffRow[] = [];
  const optIn: PortableSettingsDiffRow[] = [];
  const withheld: PortableWithheldRow[] = [];
  let unchangedCount = 0;

  for (const [key, value] of Object.entries(projection.preferences)) {
    const typedKey = key as keyof BrowserPreferenceData;
    // The permission preferences are gated with no row at all: granting a tool
    // is decided by `applyPortableToolPermissions`, and a preference write is
    // precisely the path around that gate.
    if (GATED_KEYS.has(key)) continue;

    const currentValue = current?.[typedKey];
    const policy =
      PORTABLE_FEATURE_SWITCH_POLICY[
        key as keyof typeof PORTABLE_FEATURE_SWITCH_POLICY
      ];

    // A feature switch is compared by *state*, not by value. Absence means on
    // for all three, so an unset preference and an explicit `true` are the
    // same state, and a row reading "(unset) -> on" would ask the user to
    // approve a change that changes nothing. Everything else is compared by
    // value, where `undefined` and `false` really are different -- see the
    // note on `current` above.
    const unchanged =
      policy === undefined
        ? deepEqualPreference(currentValue, value)
        : (currentValue !== false) === (value !== false);
    if (unchanged) {
      unchangedCount += 1;
      continue;
    }
    const row: PortableSettingsDiffRow = {
      key: typedKey,
      current: currentValue,
      incoming: value,
    };

    if (policy === undefined) {
      changed.push(row);
      continue;
    }

    // Absent means on for every one of these, so the state is `!== false`
    // rather than the value itself. Reading the raw value here would call an
    // unset preference "off" and get the direction backwards exactly half the
    // time.
    const enablingNow = currentValue === false && value !== false;
    const disablingNow = currentValue !== false && value === false;

    if (policy === "enabling-needs-opt-in") {
      // Turning it on restarts outbound work someone stopped; turning it off
      // only stops requests, which needs no ceremony.
      if (enablingNow) optIn.push(row);
      else changed.push(row);
      continue;
    }

    // "disabling-withheld": refused outright rather than offered as a tick,
    // because the guard it bypasses is a password proof and a tick is not one.
    if (disablingNow) withheld.push({ ...row, reason: "needs-password-proof" });
    else changed.push(row);
  }

  return {
    changed,
    optIn,
    withheld,
    unchangedCount,
    // Bounded like a warning's subjects, for the same reason: these are key
    // names the file chose.
    droppedKeys: boundedWarningSubjects(projection.droppedKeys),
  };
}
