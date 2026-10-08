/**
 * Tool permissions on their way out of the app and back in.
 *
 * The whole of the security story here is that there is no second gate. An
 * imported selection goes through {@link partitionMcpPermissionPolicySelection},
 * the same function a click in the permissions screen goes through, so an id
 * above `read` risk arrives *pending confirmation* and an id with no reviewed
 * entry in the catalogue is dropped rather than being granted at the `admin`
 * risk `resolveMcpTool` assigns an unknown tool. Re-deriving the risk rules
 * here would create exactly the second gate that could drift from the first.
 *
 * What a file cannot do, then, is enable anything the user was not going to be
 * asked about. What it *can* do is pre-fill the question.
 */
import {
  capMcpPermissionDiagnosticIds,
  normalizeMcpPermissionSetName,
  partitionMcpPermissionPolicySelection,
  reconcileMcpEnabledToolIds,
  reconcileMcpEnabledToolIdsDetailed,
  reconcileMcpPermissionSets,
  MCP_PERMISSION_POLICY_VERSION,
  type McpPermissionPolicyPartition,
} from "@/lib/mcp/tool-permissions";

import {
  buildEnvelope,
  isPortableRecord,
  parseEnvelope,
  portableReject,
  portableSubject,
  portableWarning,
  type PortableEnvelopeOptions,
} from "./envelope";
import {
  MAX_MCP_PERMISSION_SETS,
  type PortableParse,
  type PortableParseWarning,
  type PortablePermissionSet,
  type PortableToolPermissions,
  type PortableToolPermissionsEnvelope,
} from "./types";

/**
 * The permission state of a machine, as the preference layer holds it.
 *
 * Named sets are a map there -- the name is the storage key -- and an array
 * here, because a file must not depend on JSON object key order to say which
 * set is which.
 *
 * There is no `pendingHighRiskToolIds` field, and that is not an omission: an
 * apply replaces the pending list rather than adding to it, exactly as
 * `stageMcpEnabledTools` does, so what is pending here is not an input.
 */
export interface PortableToolPermissionsState {
  enabledToolIds: readonly string[];
  sets?: Readonly<Record<string, readonly string[]>>;
}

/**
 * What an import would leave the permission state as.
 *
 * Extends {@link McpPermissionPolicyPartition} rather than restating it,
 * because the three id lists *are* the partition's: they are what
 * `Storage.stageMcpEnabledTools` takes, in the order it takes them, and
 * `removedToolIds` is what `mcpRemovedImportedToolIds` records.
 */
export interface PortableToolPermissionsApplication extends McpPermissionPolicyPartition {
  sets: Record<string, string[]>;
  warnings: PortableParseWarning[];
}

export function exportToolPermissions(
  state: PortableToolPermissionsState,
  options: PortableEnvelopeOptions,
): PortableToolPermissionsEnvelope {
  // Reconciled on the way out as well as on the way in, so an id that left the
  // catalogue while a set sat in storage is not written to a file that would
  // then report it as unknown on the machine reading it.
  const sets: PortablePermissionSet[] = Object.entries(
    reconcileMcpPermissionSets(state.sets),
  ).map(([name, toolIds]) => ({ name, toolIds }));

  return buildEnvelope(
    "tool-permissions",
    {
      // The *current* policy version, not whatever the preference happens to
      // hold: this is a statement about the build doing the writing.
      policyVersion: MCP_PERMISSION_POLICY_VERSION,
      enabledToolIds: reconcileMcpEnabledToolIds(state.enabledToolIds),
      sets,
    },
    options,
  );
}

/**
 * Project the payload without judging any of the ids.
 *
 * Ids are kept exactly as the file spelled them, including ones this build has
 * never heard of, because {@link applyPortableToolPermissions} is the one
 * place allowed to decide what happens to them -- and it cannot report an id
 * as unknown if the parser has already swallowed it. This is why
 * `reconcileMcpPermissionSets` is not used here, despite being this function
 * in miniature: it takes the map shape storage uses rather than the array a
 * file carries, and it drops unknown ids silently, which is precisely the
 * diagnostic an import has to show.
 */
export function parseToolPermissionsFile(
  raw: string,
): PortableParse<PortableToolPermissionsEnvelope> {
  const envelope = parseEnvelope(raw, "tool-permissions");
  if (!envelope.ok) return envelope;

  const payload = envelope.value.payload;
  if (!isPortableRecord(payload)) {
    return portableReject("malformed-payload", "the payload is not an object");
  }
  // Every field is required. The payload shape is small and fully specified,
  // so a file missing one of them was not written by this app, and deciding
  // what it must have meant is how a parser acquires a second, looser
  // contract alongside the one in `./types`.
  if (
    typeof payload.policyVersion !== "number" ||
    !Number.isSafeInteger(payload.policyVersion) ||
    payload.policyVersion < 0
  ) {
    return portableReject(
      "malformed-payload",
      "policyVersion is not a whole number",
    );
  }
  if (!Array.isArray(payload.enabledToolIds)) {
    return portableReject(
      "malformed-payload",
      "enabledToolIds is not an array",
    );
  }
  if (!Array.isArray(payload.sets)) {
    return portableReject("malformed-payload", "sets is not an array");
  }

  const sets: PortablePermissionSet[] = [];
  const names = new Set<string>();
  for (const entry of payload.sets) {
    if (sets.length >= MAX_MCP_PERMISSION_SETS) break;
    if (!isPortableRecord(entry)) continue;
    // Refuses rather than truncates, and refuses a duplicate: the name is the
    // key the set is stored under, so two sets that normalize to one name
    // would silently become one set.
    const name = normalizeMcpPermissionSetName(entry.name);
    if (name === null || names.has(name)) continue;
    names.add(name);
    sets.push({
      name,
      toolIds: Array.isArray(entry.toolIds)
        ? entry.toolIds.filter((id): id is string => typeof id === "string")
        : [],
    });
  }
  const droppedSets = payload.sets.length - sets.length;

  const value: PortableToolPermissions = {
    policyVersion: payload.policyVersion,
    enabledToolIds: payload.enabledToolIds.filter(
      (id): id is string => typeof id === "string",
    ),
    sets,
  };

  return {
    ok: true,
    value: { ...envelope.value, payload: value },
    warnings: portableWarning(
      "too-many-sets",
      // The count rather than the names: a set is dropped for a name that is
      // unusable or for arriving past the ceiling, and in the first case the
      // name is exactly the string there is no safe way to quote.
      droppedSets > 0 ? [String(droppedSets)] : [],
    ),
  };
}

/**
 * What an imported selection would leave this machine's permissions as.
 *
 * The two steps `Storage.applyMcpPermissionSet` takes, in its order: partition
 * the selection, then hand the three lists to the staging path. Nothing is
 * carried over from what is currently enabled, and that is deliberate --
 * switching to a saved set replaces the enabled set outright and puts even an
 * already-confirmed destructive tool back to pending, so an import that
 * retained such a grant would be a second, softer gate for the same act of
 * adopting a selection. The current state is consulted for one thing only:
 * keeping the sets this machine has saved.
 */
export function applyPortableToolPermissions(
  current: PortableToolPermissionsState,
  incoming: PortableToolPermissions,
): PortableToolPermissionsApplication {
  const partition = partitionMcpPermissionPolicySelection(
    incoming.enabledToolIds,
  );
  const removed = new Set(partition.removedToolIds);

  const sets: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  // The file's sets win a name collision -- that is what importing them means
  // -- and the machine's other sets survive, because an import of permissions
  // is not a request to forget the selections someone saved.
  for (const set of incoming.sets) {
    if (Object.keys(sets).length >= MAX_MCP_PERMISSION_SETS) break;
    // Normalized again rather than trusted: the parser does this, but this
    // function is also reachable with a payload a caller built by hand.
    const name = normalizeMcpPermissionSetName(set.name);
    if (name === null || name in sets) continue;
    const reconciliation = reconcileMcpEnabledToolIdsDetailed(set.toolIds);
    for (const id of reconciliation.removedToolIds) removed.add(id);
    sets[name] = reconciliation.enabledToolIds;
  }
  for (const [name, toolIds] of Object.entries(
    reconcileMcpPermissionSets(current.sets),
  )) {
    if (Object.keys(sets).length >= MAX_MCP_PERMISSION_SETS) break;
    if (name in sets) continue;
    sets[name] = toolIds;
  }

  // Capped the way every other persisted diagnostic list is: this one is
  // written to `mcpRemovedImportedToolIds`, and a file naming two thousand
  // invented ids must not be able to grow that preference by naming them.
  const removedToolIds = capMcpPermissionDiagnosticIds([...removed]);

  return {
    enabledToolIds: partition.enabledToolIds,
    pendingHighRiskToolIds: partition.pendingHighRiskToolIds,
    removedToolIds,
    sets,
    warnings: [
      ...portableWarning("unknown-tool-id", removedToolIds),
      ...portableWarning("high-risk-pending", partition.pendingHighRiskToolIds),
      ...portableWarning(
        "policy-version-differs",
        incoming.policyVersion === MCP_PERMISSION_POLICY_VERSION
          ? []
          : [portableSubject(String(incoming.policyVersion))],
      ),
    ],
  };
}
