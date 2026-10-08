/**
 * Portable configuration: the public surface.
 *
 * Importers take this module rather than the files behind it, so that the
 * contract in `./types` and the four functions that honour it are read
 * together. The helpers the parsers share are deliberately not re-exported:
 * they bound and strip file-supplied strings, and a caller reaching for them
 * is a caller doing something a parser should have done.
 */
export {
  buildEnvelope,
  parseEnvelope,
  type PortableEnvelopeOptions,
} from "./envelope";
export { exportPersonas, parsePersonasFile } from "./personas";
export {
  applyPortableToolPermissions,
  exportToolPermissions,
  parseToolPermissionsFile,
  type PortableToolPermissionsApplication,
  type PortableToolPermissionsState,
} from "./permissions";
export {
  diffPortableSettings,
  exportSettings,
  parseSettingsFile,
} from "./settings";
export {
  MAX_MCP_PERMISSION_SET_NAME_BYTES,
  MAX_MCP_PERMISSION_SETS,
  MAX_PORTABLE_FILE_BYTES,
  MAX_PORTABLE_PERSONAS,
  PORTABLE_FORMAT,
  PORTABLE_FORMAT_VERSION,
  PORTABLE_FEATURE_SWITCH_KEYS,
  PORTABLE_FEATURE_SWITCH_POLICY,
  PORTABLE_GATED_PREFERENCE_KEYS,
  PORTABLE_MACHINE_LOCAL_PREFERENCE_KEYS,
  type PortableEnvelope,
  type PortableKind,
  type PortableParse,
  type PortableParseWarning,
  type PortablePermissionSet,
  type PortablePersona,
  type PortablePersonasEnvelope,
  type PortableRejection,
  type PortableSettings,
  type PortableSettingsDiff,
  type PortableSettingsDiffRow,
  type PortableSwitchPolicy,
  type PortableSettingsEnvelope,
  type PortableToolPermissions,
  type PortableToolPermissionsEnvelope,
  type PortableWithheldReason,
  type PortableWithheldRow,
} from "./types";
