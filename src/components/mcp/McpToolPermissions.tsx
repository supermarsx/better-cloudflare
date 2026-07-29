"use client";

import * as React from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import {
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_FALLBACKS,
  MAX_MCP_PERMISSION_DIAGNOSTIC_IDS,
  MAX_MCP_PERMISSION_TOOL_ID_LENGTH,
  MCP_PERMISSION_POLICY_VERSION,
  capMcpPermissionDiagnosticIds,
  partitionMcpPermissionPolicySelection,
  planMcpPermissionChange,
  reconcileMcpEnabledToolIds,
  reconcileMcpEnabledToolIdsDetailed,
  resolveMcpTool,
  type McpToolIdReconciliation,
  type ResolvedMcpTool,
} from "@/lib/mcp/tool-permissions";
import {
  TauriClient,
  type McpServerStatus,
  type McpToolDescriptor,
} from "@/lib/api/tauri-client";
import { sanitizeRuntimeText } from "@/lib/errors/runtime-reporting";
import { storageManager } from "@/lib/storage/storage";

export interface McpToolPermissionsClient {
  load(): Promise<McpServerStatus>;
  save(enabledTools: string[]): Promise<McpServerStatus>;
}

export interface McpToolPermissionsStorageSnapshot {
  enabledTools: string[];
  removedToolIds: string[];
  pendingHighRiskToolIds?: string[];
  configured: boolean;
  permissionPolicyVersion?: number;
}

export interface McpToolPermissionsStorage {
  getMcpEnabledTools(): string[];
  getMcpEnabledToolsSnapshot?(): McpToolPermissionsStorageSnapshot;
  setMcpEnabledTools(enabledTools: string[]): void;
  stageMcpEnabledTools?(
    enabledTools: string[],
    pendingHighRiskToolIds: string[],
    removedToolIds: string[],
  ): void;
}

export interface McpToolPermissionsApplication {
  /**
   * Provisional applications publish the conservative confirmed subset while
   * a requested high-risk selection remains staged for confirmation.
   */
  synchronization: "provisional" | "final";
}

export interface McpToolPermissionsFailure {
  operation: "bootstrap" | "update";
}

export interface McpToolPermissionsProps {
  client?: McpToolPermissionsClient;
  storage?: McpToolPermissionsStorage;
  /**
   * Whether confirmation UI and permission controls are currently available
   * for user interaction. Reconciliation continues while this is false.
   */
  interactive?: boolean;
  /**
   * Optional parent-owned desired selection. Changes are treated as permission
   * requests, so imported/profile values use the same reconciliation and
   * high-risk confirmation path as direct UI changes.
   */
  enabledTools?: readonly string[];
  /**
   * Called only after the desktop service has applied the reconciled selection.
   * Provisional applications update confirmed state and readiness without
   * replacing an outstanding requested high-risk selection. Final
   * applications synchronize the parent's requested selection as well.
   */
  onApplied?: (
    enabledTools: string[],
    status: McpServerStatus,
    application: McpToolPermissionsApplication,
  ) => void;
  /**
   * Reports a failed reconciliation without allowing the permission controller
   * to mark itself ready. The parent owns user-visible runtime diagnostics.
   */
  onError?: (error: unknown, failure: McpToolPermissionsFailure) => void;
}

interface PendingPermissionChange {
  enabledTools: string[];
  heading: string;
  highRiskTools: ResolvedMcpTool[];
  notifyParentOnCancel: boolean;
  controlledRequestKey: string | null;
  appliedRequestKey: string;
  generation: number;
  reconcileOnCancel: boolean;
}

interface ScheduledServerSave {
  enabledTools: string[];
  generation: number;
  resolve(status: McpServerStatus): void;
  reject(error: unknown): void;
}

interface McpCatalogueInspection {
  backendById: Map<string, McpToolDescriptor>;
  completeReviewedCatalogue: boolean;
}

const defaultClient: McpToolPermissionsClient = {
  load: () => TauriClient.getMcpServerStatus(),
  save: (enabledTools) => TauriClient.setMcpEnabledTools(enabledTools),
};

const UNCLASSIFIED_CATEGORY = {
  id: "unclassified",
  label: "Unclassified tools",
  description:
    "These tools are not part of the reviewed frontend contract and remain denied.",
} as const;

const RISK_LABELS = {
  read: "Read only",
  write: "Changes data",
  "bulk-sensitive": "Bulk sensitive",
  destructive: "Destructive",
  credential: "Credential access",
  admin: "Administrative",
} as const;

const REVIEWED_MCP_TOOL_IDS = new Set(
  MCP_TOOL_FALLBACKS.map(({ id }) => id),
);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeRuntimeText(error.message);
  }
  if (typeof error === "string" && error.trim()) {
    return sanitizeRuntimeText(error);
  }
  return "An unexpected MCP permissions error occurred.";
}

function sameToolIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((toolId, index) => toolId === right[index])
  );
}

function toolIdsKey(toolIds: readonly string[]): string {
  return toolIds.join("\u0000");
}

function reconciliationKey(reconciliation: {
  enabledToolIds: readonly string[];
  removedToolIds: readonly string[];
}): string {
  return `${toolIdsKey(reconciliation.enabledToolIds)}\u0001${toolIdsKey(
    reconciliation.removedToolIds,
  )}`;
}

function inspectStatusCatalogue(
  status: McpServerStatus,
): McpCatalogueInspection {
  const tools = Array.isArray(status.tools) ? status.tools : [];
  const maximumCatalogueSize =
    MCP_TOOL_FALLBACKS.length + MAX_MCP_PERMISSION_DIAGNOSTIC_IDS;
  if (tools.length > maximumCatalogueSize) {
    throw new Error(
      `The desktop service reported ${tools.length} MCP tool descriptors; the reviewed and diagnostic limit is ${maximumCatalogueSize}.`,
    );
  }

  const backendById = new Map<string, McpToolDescriptor>();
  let unknownDescriptorCount = 0;
  for (const tool of tools) {
    const id = String(tool.name ?? "").trim();
    if (!id || id.length > MAX_MCP_PERMISSION_TOOL_ID_LENGTH) {
      throw new Error(
        "The desktop service reported an empty or oversized MCP tool identifier.",
      );
    }
    if (typeof tool.enabled !== "boolean") {
      throw new Error(
        `The desktop service reported a non-boolean enabled state for MCP tool ${id}.`,
      );
    }
    if (backendById.has(id)) {
      throw new Error(
        `The desktop service reported duplicate or contradictory MCP tool descriptors for ${id}.`,
      );
    }
    if (!REVIEWED_MCP_TOOL_IDS.has(id)) {
      unknownDescriptorCount += 1;
      if (unknownDescriptorCount > MAX_MCP_PERMISSION_DIAGNOSTIC_IDS) {
        throw new Error(
          `The desktop service reported more than ${MAX_MCP_PERMISSION_DIAGNOSTIC_IDS} unreviewed MCP tool descriptors; excess diagnostic catalogue entries were denied.`,
        );
      }
    }
    backendById.set(id, tool);
  }

  return {
    backendById,
    completeReviewedCatalogue: MCP_TOOL_FALLBACKS.every(({ id }) =>
      backendById.has(id),
    ),
  };
}

function resolveCatalog(status: McpServerStatus): ResolvedMcpTool[] {
  const { backendById } = inspectStatusCatalogue(status);
  const knownTools = MCP_TOOL_FALLBACKS.map((fallback) =>
    resolveMcpTool(
      backendById.get(fallback.id) ?? {
        name: fallback.id,
        title: fallback.label,
        description: fallback.description,
        enabled: false,
      },
    ),
  );
  const unknownTools = [...backendById.entries()]
    .filter(([id]) => !REVIEWED_MCP_TOOL_IDS.has(id))
    .map(([, backend]) => resolveMcpTool(backend));
  return [...knownTools, ...unknownTools];
}

function authoritativeStatusSelection(status: McpServerStatus) {
  const candidates: ReturnType<
    typeof reconcileMcpEnabledToolIdsDetailed
  >[] = [];

  if (Array.isArray(status.enabledTools)) {
    candidates.push(reconcileMcpEnabledToolIdsDetailed(status.enabledTools));
  }
  if (Array.isArray(status.enabled_tools)) {
    candidates.push(reconcileMcpEnabledToolIdsDetailed(status.enabled_tools));
  }

  const catalogue = inspectStatusCatalogue(status);
  if (
    Array.isArray(status.tools) &&
    status.tools.length > 0 &&
    catalogue.completeReviewedCatalogue
  ) {
    candidates.push(
      reconcileMcpEnabledToolIdsDetailed(
        status.tools
          .filter((tool) => tool.enabled === true)
          .map((tool) => tool.name),
      ),
    );
  }

  const first = candidates[0];
  if (!first) return null;
  const sameSelection = candidates.every(
    (candidate) => sameToolIds(candidate.enabledToolIds, first.enabledToolIds),
  );
  if (!sameSelection) return null;
  return {
    enabledToolIds: first.enabledToolIds,
    removedToolIds: capMcpPermissionDiagnosticIds(
      candidates.flatMap((candidate) => candidate.removedToolIds),
    ),
  };
}

function requireAuthoritativeStatusSelection(status: McpServerStatus) {
  const selection = authoritativeStatusSelection(status);
  if (!selection) {
    throw new Error(
      "The desktop service response did not report authoritative MCP permission state. Expected enabledTools/enabled_tools or a complete reviewed tool catalogue.",
    );
  }
  return selection;
}

function exactAppliedSelection(
  status: McpServerStatus,
  requestedTools: readonly string[],
): string[] {
  const requested = reconcileMcpEnabledToolIds(requestedTools);
  const applied = requireAuthoritativeStatusSelection(status);
  if (
    applied.removedToolIds.length > 0 ||
    !sameToolIds(applied.enabledToolIds, requested)
  ) {
    const unexpected =
      applied.removedToolIds.length > 0
        ? ` Unknown IDs were reported as enabled: ${applied.removedToolIds.join(", ")}.`
        : "";
    throw new Error(
      `The desktop service did not apply the exact reconciled MCP permission selection.${unexpected}`,
    );
  }
  return applied.enabledToolIds;
}

class StalePermissionOperation extends Error {}

interface ModalIsolationState {
  owners: Set<symbol>;
  inertAttribute: string | null;
  ariaHiddenAttribute: string | null;
  pointerEvents: string;
  supportsInertProperty: boolean;
  inertProperty: boolean | undefined;
}

const modalIsolationStates = new WeakMap<HTMLElement, ModalIsolationState>();

function acquireModalIsolation(element: HTMLElement, owner: symbol): void {
  const existing = modalIsolationStates.get(element);
  if (existing) {
    existing.owners.add(owner);
    return;
  }

  const inertTarget = element as HTMLElement & { inert?: boolean };
  const supportsInertProperty = "inert" in inertTarget;
  modalIsolationStates.set(element, {
    owners: new Set([owner]),
    inertAttribute: element.getAttribute("inert"),
    ariaHiddenAttribute: element.getAttribute("aria-hidden"),
    pointerEvents: element.style.pointerEvents,
    supportsInertProperty,
    inertProperty: inertTarget.inert,
  });
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
  element.style.pointerEvents = "none";
  if (supportsInertProperty) inertTarget.inert = true;
}

function releaseModalIsolation(element: HTMLElement, owner: symbol): void {
  const state = modalIsolationStates.get(element);
  if (!state) return;
  state.owners.delete(owner);
  if (state.owners.size > 0) return;

  const inertTarget = element as HTMLElement & { inert?: boolean };
  if (
    state.supportsInertProperty &&
    typeof state.inertProperty === "boolean"
  ) {
    inertTarget.inert = state.inertProperty;
  }
  if (state.inertAttribute === null) element.removeAttribute("inert");
  else element.setAttribute("inert", state.inertAttribute);
  if (state.ariaHiddenAttribute === null) {
    element.removeAttribute("aria-hidden");
  } else {
    element.setAttribute("aria-hidden", state.ariaHiddenAttribute);
  }
  element.style.pointerEvents = state.pointerEvents;
  modalIsolationStates.delete(element);
}

function matchesSearch(tool: ResolvedMcpTool, query: string): boolean {
  if (!query) return true;
  const category = MCP_TOOL_CATEGORIES.find(({ id }) => id === tool.categoryId);
  return [
    tool.id,
    tool.label,
    tool.description,
    category?.label ?? UNCLASSIFIED_CATEGORY.label,
    RISK_LABELS[tool.risk],
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

export function McpToolPermissions({
  client = defaultClient,
  storage = storageManager,
  interactive = true,
  enabledTools: controlledEnabledTools,
  onApplied,
  onError,
}: McpToolPermissionsProps) {
  const [loadState, setLoadState] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  const [catalog, setCatalog] = React.useState<ResolvedMcpTool[]>([]);
  const [appliedTools, setAppliedTools] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [removedToolIds, setRemovedToolIds] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [pending, setPending] = React.useState<PendingPermissionChange | null>(
    null,
  );
  const controlledSelection = React.useMemo<McpToolIdReconciliation | null>(
    () =>
      controlledEnabledTools === undefined
        ? null
        : reconcileMcpEnabledToolIdsDetailed(controlledEnabledTools),
    [controlledEnabledTools],
  );

  const appliedToolsRef = React.useRef<string[]>([]);
  const lastStatusRef = React.useRef<McpServerStatus | null>(null);
  const removedToolIdsRef = React.useRef<string[]>([]);
  const latestControlledSelectionRef =
    React.useRef<McpToolIdReconciliation | null>(controlledSelection);
  const onAppliedRef = React.useRef(onApplied);
  const onErrorRef = React.useRef(onError);
  const clientRef = React.useRef(client);
  const mountedRef = React.useRef(true);
  const mountCleanupEpochRef = React.useRef(0);
  const generationRef = React.useRef(0);
  const inFlightClientLoadRef =
    React.useRef<Promise<McpServerStatus> | null>(null);
  const inFlightServerSaveRef = React.useRef<ScheduledServerSave | null>(null);
  const latestQueuedServerSaveRef = React.useRef<ScheduledServerSave | null>(
    null,
  );
  const drainServerSaveQueueRef = React.useRef<() => void>(() => {});
  const lastControlledRequestRef = React.useRef<string | null>(
    controlledSelection === null ? null : reconciliationKey(controlledSelection),
  );
  const observedControlledRequestRef = React.useRef<string | null>(
    lastControlledRequestRef.current,
  );
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const cancelConfirmationRef = React.useRef<HTMLButtonElement>(null);
  const confirmationTriggerRef = React.useRef<HTMLElement | null>(null);
  const reassertConfirmedSelectionRef = React.useRef<
    (generation: number) => void
  >(() => {});
  const modalPortalHost = React.useMemo(() => {
    if (typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.dataset.mcpPermissionModalPortal = "true";
    return host;
  }, []);

  const beginGeneration = React.useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrentGeneration = React.useCallback(
    (generation: number) =>
      mountedRef.current && generationRef.current === generation,
    [],
  );

  const drainServerSaveQueue = React.useCallback(() => {
    if (inFlightServerSaveRef.current) return;
    const scheduled = latestQueuedServerSaveRef.current;
    if (!scheduled) return;
    latestQueuedServerSaveRef.current = null;

    if (!isCurrentGeneration(scheduled.generation)) {
      scheduled.reject(new StalePermissionOperation());
      return;
    }

    inFlightServerSaveRef.current = scheduled;
    const finishScheduledSave = () => {
      if (inFlightServerSaveRef.current === scheduled) {
        inFlightServerSaveRef.current = null;
      }
      drainServerSaveQueueRef.current();
    };
    void Promise.resolve()
      .then(() => clientRef.current.save([...scheduled.enabledTools]))
      .then(
        (status) => {
          finishScheduledSave();
          scheduled.resolve(status);
        },
        (error) => {
          finishScheduledSave();
          scheduled.reject(error);
        },
      );
  }, [isCurrentGeneration]);
  drainServerSaveQueueRef.current = drainServerSaveQueue;

  const enqueueServerSave = React.useCallback(
    (enabledTools: readonly string[], generation: number) =>
      new Promise<McpServerStatus>((resolve, reject) => {
        const superseded = latestQueuedServerSaveRef.current;
        if (superseded) {
          superseded.reject(new StalePermissionOperation());
        }
        latestQueuedServerSaveRef.current = {
          enabledTools: reconcileMcpEnabledToolIds(enabledTools),
          generation,
          resolve,
          reject,
        };
        drainServerSaveQueueRef.current();
      }),
    [],
  );

  const hasPendingServerSave = React.useCallback(
    () =>
      inFlightServerSaveRef.current !== null ||
      latestQueuedServerSaveRef.current !== null,
    [],
  );

  const loadClientStatus = React.useCallback(() => {
    const inFlight = inFlightClientLoadRef.current;
    if (inFlight) return inFlight;

    const requestedLoad = Promise.resolve().then(() =>
      clientRef.current.load(),
    );
    const sharedLoad = requestedLoad.then(
      (status) => {
        if (inFlightClientLoadRef.current === sharedLoad) {
          inFlightClientLoadRef.current = null;
        }
        return status;
      },
      (error) => {
        if (inFlightClientLoadRef.current === sharedLoad) {
          inFlightClientLoadRef.current = null;
        }
        throw error;
      },
    );
    inFlightClientLoadRef.current = sharedLoad;
    return sharedLoad;
  }, []);

  React.useEffect(() => {
    mountCleanupEpochRef.current += 1;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const queued = latestQueuedServerSaveRef.current;
      latestQueuedServerSaveRef.current = null;
      queued?.reject(new StalePermissionOperation());
      const cleanupEpoch = ++mountCleanupEpochRef.current;
      queueMicrotask(() => {
        if (
          !mountedRef.current &&
          mountCleanupEpochRef.current === cleanupEpoch
        ) {
          inFlightClientLoadRef.current = null;
          latestControlledSelectionRef.current = null;
        }
      });
    };
  }, []);

  React.useEffect(() => {
    clientRef.current = client;
  }, [client]);

  React.useEffect(() => {
    latestControlledSelectionRef.current = controlledSelection;
  }, [controlledSelection]);

  React.useEffect(() => {
    onAppliedRef.current = onApplied;
  }, [onApplied]);

  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const reportFailure = React.useCallback(
    (
      error: unknown,
      operation: McpToolPermissionsFailure["operation"],
    ) => {
      try {
        onErrorRef.current?.(error, { operation });
      } catch {
        // A diagnostic callback must never take down permission recovery.
      }
    },
    [],
  );

  const mergeRemovedToolIds = React.useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    const merged = capMcpPermissionDiagnosticIds([
      ...removedToolIdsRef.current,
      ...ids,
    ]);
    removedToolIdsRef.current = merged;
    setRemovedToolIds(merged);
  }, []);

  const persistApplied = React.useCallback(
    (
      nextEnabledTools: readonly string[],
      pendingHighRiskToolIds: readonly string[] = [],
      removedIds: readonly string[] = [],
    ) => {
      const reconciledTools = reconcileMcpEnabledToolIds(nextEnabledTools);
      const pending = planMcpPermissionChange(reconciledTools, [
        ...reconciledTools,
        ...pendingHighRiskToolIds,
      ]).newlyEnabledHighRiskToolIds;
      const removed =
        reconcileMcpEnabledToolIdsDetailed(removedIds).removedToolIds;
      if (
        storage.stageMcpEnabledTools &&
        (pending.length > 0 || removed.length > 0)
      ) {
        storage.stageMcpEnabledTools(reconciledTools, pending, removed);
      } else {
        storage.setMcpEnabledTools(reconciledTools);
      }
    },
    [storage],
  );

  const publishApplied = React.useCallback(
    (
      nextEnabledTools: readonly string[],
      status: McpServerStatus,
      generation: number,
      synchronization: McpToolPermissionsApplication["synchronization"] = "final",
    ) => {
      if (!isCurrentGeneration(generation)) return;
      const reconciledTools = reconcileMcpEnabledToolIds(nextEnabledTools);
      appliedToolsRef.current = reconciledTools;
      lastStatusRef.current = status;
      setAppliedTools(reconciledTools);
      onAppliedRef.current?.([...reconciledTools], status, { synchronization });
    },
    [isCurrentGeneration],
  );

  const rollbackServerSelection = React.useCallback(
    async (
      previousEnabledTools: readonly string[],
      cause: unknown,
      generation: number,
    ): Promise<never> => {
      if (!isCurrentGeneration(generation)) {
        throw new StalePermissionOperation();
      }
      const previous = reconcileMcpEnabledToolIds(previousEnabledTools);
      try {
        const rollbackStatus = await enqueueServerSave(previous, generation);
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        exactAppliedSelection(rollbackStatus, previous);
      } catch (rollbackError) {
        if (
          rollbackError instanceof StalePermissionOperation ||
          !isCurrentGeneration(generation)
        ) {
          throw new StalePermissionOperation();
        }
        throw new Error(
          `${errorMessage(cause)} Automatic rollback to the previous MCP server selection also failed: ${errorMessage(rollbackError)}`,
        );
      }
      throw new Error(
        `${errorMessage(cause)} The previous MCP server selection was restored.`,
      );
    },
    [enqueueServerSave, isCurrentGeneration],
  );

  const verifyAppliedOrRollback = React.useCallback(
    async (
      status: McpServerStatus,
      requestedEnabledTools: readonly string[],
      previousEnabledTools: readonly string[],
      generation: number,
    ): Promise<string[]> => {
      if (!isCurrentGeneration(generation)) {
        throw new StalePermissionOperation();
      }
      try {
        return exactAppliedSelection(status, requestedEnabledTools);
      } catch (error) {
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        return rollbackServerSelection(previousEnabledTools, error, generation);
      }
    },
    [isCurrentGeneration, rollbackServerSelection],
  );

  const closeConfirmation = React.useCallback(
    (
      notifyParent: boolean,
      restoreFocus = true,
      clearStagedRequest = true,
      invalidateGeneration = true,
    ): HTMLElement | null => {
      const shouldReassertConfirmedSelection =
        invalidateGeneration &&
        clearStagedRequest &&
        (pending?.reconcileOnCancel === true || hasPendingServerSave());
      const generation = invalidateGeneration
        ? beginGeneration()
        : generationRef.current;
      const trigger = confirmationTriggerRef.current;
      confirmationTriggerRef.current = null;
      setPending(null);

      if (clearStagedRequest) {
        try {
          persistApplied(
            appliedToolsRef.current,
            [],
            removedToolIdsRef.current,
          );
        } catch (error) {
          setSaveError(
            `The pending MCP permission request was cancelled, but its local staging state could not be cleared: ${errorMessage(error)}`,
          );
        }
      }

      if (notifyParent && lastStatusRef.current) {
        onAppliedRef.current?.(
          [...appliedToolsRef.current],
          lastStatusRef.current,
          { synchronization: "final" },
        );
      }

      if (shouldReassertConfirmedSelection) {
        reassertConfirmedSelectionRef.current(generation);
      }

      if (restoreFocus) {
        queueMicrotask(() => {
          if (trigger?.isConnected) trigger.focus();
        });
      }
      return trigger;
    },
    [beginGeneration, hasPendingServerSave, pending, persistApplied],
  );

  const openConfirmation = React.useCallback(
    (
      enabledTools: readonly string[],
      heading: string,
      highRiskTools: readonly ResolvedMcpTool[],
      trigger: HTMLElement | null,
      notifyParentOnCancel: boolean,
      controlledRequestKey: string | null = null,
      generation: number,
    ) => {
      if (!isCurrentGeneration(generation)) return;
      confirmationTriggerRef.current =
        trigger ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      setPending({
        enabledTools: reconcileMcpEnabledToolIds(enabledTools),
        heading,
        highRiskTools: [...highRiskTools],
        notifyParentOnCancel,
        controlledRequestKey,
        appliedRequestKey: reconciliationKey(
          reconcileMcpEnabledToolIdsDetailed(appliedToolsRef.current),
        ),
        generation,
        reconcileOnCancel: hasPendingServerSave(),
      });
    },
    [hasPendingServerSave, isCurrentGeneration],
  );

  const loadPermissions = React.useCallback(
    async (generation: number) => {
      if (!isCurrentGeneration(generation)) return;
      setLoadState("loading");
      setLoadError(null);
      setSaveError(null);
      setRemovedToolIds([]);
      removedToolIdsRef.current = [];
      setPending(null);
      setSaving(false);

      let persistedSnapshot: McpToolPermissionsStorageSnapshot;
      let storageReadError: string | null = null;
      try {
        if (storage.getMcpEnabledToolsSnapshot) {
          persistedSnapshot = storage.getMcpEnabledToolsSnapshot();
        } else {
          const reconciled = reconcileMcpEnabledToolIdsDetailed(
            storage.getMcpEnabledTools(),
          );
          persistedSnapshot = {
            enabledTools: reconciled.enabledToolIds,
            removedToolIds: reconciled.removedToolIds,
            pendingHighRiskToolIds: [],
            configured: true,
          };
        }
      } catch (error) {
        persistedSnapshot = {
          enabledTools: [],
          removedToolIds: [],
          pendingHighRiskToolIds: [],
          configured: false,
        };
        storageReadError = `Saved MCP permissions could not be read: ${errorMessage(error)}`;
      }

      if (
        persistedSnapshot.permissionPolicyVersion !==
        MCP_PERMISSION_POLICY_VERSION
      ) {
        const legacyPartition = partitionMcpPermissionPolicySelection([
          ...persistedSnapshot.enabledTools,
          ...(persistedSnapshot.pendingHighRiskToolIds ?? []),
        ]);
        const legacyRemovedToolIds = capMcpPermissionDiagnosticIds([
          ...persistedSnapshot.removedToolIds,
          ...legacyPartition.removedToolIds,
        ]);
        persistedSnapshot = {
          ...persistedSnapshot,
          enabledTools: legacyPartition.enabledToolIds,
          pendingHighRiskToolIds: legacyPartition.pendingHighRiskToolIds,
          removedToolIds: legacyRemovedToolIds,
          permissionPolicyVersion: MCP_PERMISSION_POLICY_VERSION,
        };

        if (legacyPartition.pendingHighRiskToolIds.length > 0) {
          try {
            if (storage.stageMcpEnabledTools) {
              storage.stageMcpEnabledTools(
                legacyPartition.enabledToolIds,
                legacyPartition.pendingHighRiskToolIds,
                legacyRemovedToolIds,
              );
            } else {
              storage.setMcpEnabledTools(legacyPartition.enabledToolIds);
            }
          } catch (error) {
            const migrationError = `Legacy MCP permissions were restricted for this session, but their confirmation state could not be staged locally: ${errorMessage(error)}`;
            storageReadError = storageReadError
              ? `${storageReadError} ${migrationError}`
              : migrationError;
          }
        }
      }

      try {
        const loadedStatus = await loadClientStatus();
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        const controlledRequest = latestControlledSelectionRef.current;
        if (
          isCurrentGeneration(generation) &&
          latestControlledSelectionRef.current === controlledRequest
        ) {
          latestControlledSelectionRef.current = null;
        }
        const serverReconciliation =
          requireAuthoritativeStatusSelection(loadedStatus);
        const nextCatalog = resolveCatalog(loadedStatus);
        const stagedImportedTools =
          persistedSnapshot.pendingHighRiskToolIds ?? [];
        const desiredReconciliation =
          controlledRequest ??
          reconcileMcpEnabledToolIdsDetailed([
            ...persistedSnapshot.enabledTools,
            ...stagedImportedTools,
          ]);
        const loadRemovedToolIds = capMcpPermissionDiagnosticIds([
          ...persistedSnapshot.removedToolIds,
          ...desiredReconciliation.removedToolIds,
          ...serverReconciliation.removedToolIds,
          ...nextCatalog.filter((tool) => !tool.known).map((tool) => tool.id),
        ]);

        const controlledPlan =
          controlledRequest === null
            ? null
            : planMcpPermissionChange(
                persistedSnapshot.enabledTools,
                desiredReconciliation.enabledToolIds,
              );
        const candidateTools = desiredReconciliation.enabledToolIds;
        const unconfirmedHighRiskIds = new Set([
          ...(controlledPlan?.newlyEnabledHighRiskToolIds ?? []),
          ...(controlledRequest === null ? stagedImportedTools : []),
        ]);
        const conservativeTools = candidateTools.filter(
          (id) => !unconfirmedHighRiskIds.has(id),
        );

        const controlledRequestKey =
          controlledRequest === null
            ? null
            : reconciliationKey(desiredReconciliation);
        lastControlledRequestRef.current = controlledRequestKey;
        observedControlledRequestRef.current = controlledRequestKey;

        const appliedStatus = await enqueueServerSave(
          conservativeTools,
          generation,
        );
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        const confirmedAppliedTools = await verifyAppliedOrRollback(
          appliedStatus,
          conservativeTools,
          serverReconciliation.enabledToolIds,
          generation,
        );
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        const pendingHighRiskTools = nextCatalog.filter((tool) =>
          unconfirmedHighRiskIds.has(tool.id),
        );
        const stagedPendingIds = pendingHighRiskTools.map((tool) => tool.id);

        try {
          persistApplied(
            confirmedAppliedTools,
            stagedPendingIds,
            loadRemovedToolIds,
          );
        } catch (error) {
          await rollbackServerSelection(
            serverReconciliation.enabledToolIds,
            new Error(
              `The reconciled MCP selection could not be persisted locally: ${errorMessage(error)}`,
            ),
            generation,
          );
        }
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        setRemovedToolIds(loadRemovedToolIds);
        removedToolIdsRef.current = loadRemovedToolIds;
        setSaveError(storageReadError);
        setCatalog(resolveCatalog(appliedStatus));
        publishApplied(
          confirmedAppliedTools,
          appliedStatus,
          generation,
          pendingHighRiskTools.length > 0 ? "provisional" : "final",
        );
        setLoadState("ready");

        if (pendingHighRiskTools.length > 0) {
          openConfirmation(
            candidateTools,
            "Apply imported or parent MCP permissions?",
            pendingHighRiskTools,
            null,
            false,
            controlledRequest === null
              ? null
              : reconciliationKey(desiredReconciliation),
            generation,
          );
        }
      } catch (error) {
        if (
          error instanceof StalePermissionOperation ||
          !isCurrentGeneration(generation)
        ) {
          return;
        }
        setCatalog([]);
        appliedToolsRef.current = [];
        setAppliedTools([]);
        setLoadError(
          `MCP permissions could not be loaded and reconciled: ${errorMessage(error)}`,
        );
        setLoadState("error");
        reportFailure(error, "bootstrap");
      }
    },
    [
      enqueueServerSave,
      isCurrentGeneration,
      loadClientStatus,
      openConfirmation,
      persistApplied,
      publishApplied,
      reportFailure,
      rollbackServerSelection,
      storage,
      verifyAppliedOrRollback,
    ],
  );

  React.useEffect(() => {
    const generation = beginGeneration();
    void loadPermissions(generation);
  }, [beginGeneration, loadPermissions]);

  React.useEffect(() => {
    if (interactive && pending) cancelConfirmationRef.current?.focus();
  }, [interactive, pending]);

  const modalOpen = interactive && pending !== null;

  React.useLayoutEffect(() => {
    if (!modalOpen || !modalPortalHost || typeof document === "undefined")
      return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const portalContainsDialog = modalPortalHost.contains(dialog);
    if (
      portalContainsDialog &&
      modalPortalHost.parentElement !== document.body
    ) {
      document.body.appendChild(modalPortalHost);
    }

    const isolationOwner = Symbol("mcp-permission-modal");
    const isolatedElements = new Set<HTMLElement>();
    const ignoredTags = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"]);
    const isolateApplicationSibling = (element: Element) => {
      if (
        !(element instanceof HTMLElement) ||
        ignoredTags.has(element.tagName) ||
        isolatedElements.has(element)
      ) {
        return;
      }
      isolatedElements.add(element);
      acquireModalIsolation(element, isolationOwner);
    };

    let modalBranch: Element = dialog;
    while (modalBranch.parentElement) {
      const parent = modalBranch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling !== modalBranch) isolateApplicationSibling(sibling);
      }
      if (parent === document.body) break;
      modalBranch = parent;
    }

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            for (const record of records) {
              for (const node of Array.from(record.addedNodes)) {
                if (
                  node instanceof Element &&
                  node !== modalBranch &&
                  !node.contains(dialog)
                ) {
                  isolateApplicationSibling(node);
                }
              }
            }
          });
    mutationObserver?.observe(document.body, { childList: true });

    const keepFocusInDialog = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !dialog.contains(target) &&
        cancelConfirmationRef.current
      ) {
        cancelConfirmationRef.current.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInDialog, true);

    return () => {
      mutationObserver?.disconnect();
      document.removeEventListener("focusin", keepFocusInDialog, true);
      for (const element of isolatedElements) {
        releaseModalIsolation(element, isolationOwner);
      }
      if (
        portalContainsDialog &&
        modalPortalHost.parentElement === document.body
      ) {
        modalPortalHost.remove();
      }
    };
  }, [modalOpen, modalPortalHost]);

  const savePermissions = React.useCallback(
    async (
      requestedTools: readonly string[],
      generation = beginGeneration(),
      synchronization: McpToolPermissionsApplication["synchronization"] = "final",
      pendingHighRiskToolIds: readonly string[] = [],
    ): Promise<boolean> => {
      if (!isCurrentGeneration(generation)) return false;
      const nextRequestedTools =
        reconcileMcpEnabledToolIdsDetailed(requestedTools);
      mergeRemovedToolIds(nextRequestedTools.removedToolIds);
      const previousEnabledTools = [...appliedToolsRef.current];
      setSaving(true);
      setSaveError(null);

      try {
        const status = await enqueueServerSave(
          nextRequestedTools.enabledToolIds,
          generation,
        );
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        const applied = await verifyAppliedOrRollback(
          status,
          nextRequestedTools.enabledToolIds,
          previousEnabledTools,
          generation,
        );
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        try {
          persistApplied(
            applied,
            pendingHighRiskToolIds,
            removedToolIdsRef.current,
          );
        } catch (error) {
          await rollbackServerSelection(
            previousEnabledTools,
            new Error(
              `The applied MCP selection could not be persisted locally: ${errorMessage(error)}`,
            ),
            generation,
          );
        }
        if (!isCurrentGeneration(generation)) {
          throw new StalePermissionOperation();
        }
        setCatalog(resolveCatalog(status));
        publishApplied(applied, status, generation, synchronization);
        return true;
      } catch (error) {
        if (
          error instanceof StalePermissionOperation ||
          !isCurrentGeneration(generation)
        ) {
          return false;
        }
        setSaveError(
          `MCP permissions could not be saved. No local selection was changed: ${errorMessage(error)}`,
        );
        reportFailure(error, "update");
        return false;
      } finally {
        if (isCurrentGeneration(generation)) setSaving(false);
      }
    },
    [
      beginGeneration,
      enqueueServerSave,
      isCurrentGeneration,
      mergeRemovedToolIds,
      persistApplied,
      publishApplied,
      reportFailure,
      rollbackServerSelection,
      verifyAppliedOrRollback,
    ],
  );
  reassertConfirmedSelectionRef.current = (generation) => {
    void savePermissions(appliedToolsRef.current, generation);
  };

  const requestPermissionChange = React.useCallback(
    (
      requestedTools: readonly string[],
      heading: string,
      trigger: HTMLElement | null,
      notifyParentOnCancel = false,
      controlledRequestKey: string | null = null,
      generation = beginGeneration(),
    ) => {
      if (!isCurrentGeneration(generation)) return;
      const plan = planMcpPermissionChange(
        appliedToolsRef.current,
        requestedTools,
      );
      mergeRemovedToolIds(plan.removedToolIds);
      const highRiskIds = new Set(plan.newlyEnabledHighRiskToolIds);
      const highRiskTools = catalog.filter((tool) => highRiskIds.has(tool.id));

      if (highRiskTools.length > 0) {
        const conservativeTools = plan.enabledToolIds.filter(
          (toolId) => !highRiskIds.has(toolId),
        );
        if (!sameToolIds(conservativeTools, appliedToolsRef.current)) {
          void savePermissions(
            conservativeTools,
            generation,
            "provisional",
            plan.newlyEnabledHighRiskToolIds,
          ).then((applied) => {
            if (!applied || !isCurrentGeneration(generation)) return;
            openConfirmation(
              plan.enabledToolIds,
              heading,
              highRiskTools,
              trigger,
              notifyParentOnCancel,
              controlledRequestKey,
              generation,
            );
          });
          return;
        }
        openConfirmation(
          plan.enabledToolIds,
          heading,
          highRiskTools,
          trigger,
          notifyParentOnCancel,
          controlledRequestKey,
          generation,
        );
        return;
      }

      void savePermissions(plan.enabledToolIds, generation);
    },
    [
      beginGeneration,
      catalog,
      isCurrentGeneration,
      mergeRemovedToolIds,
      openConfirmation,
      savePermissions,
    ],
  );

  React.useEffect(() => {
    const requested = controlledSelection;
    const requestKey = requested === null ? null : reconciliationKey(requested);
    if (loadState === "loading") {
      return;
    }
    // Keep a failed bootstrap fail-closed until the user explicitly retries;
    // preference hydration must not enqueue a second backend reconciliation.
    if (loadState === "error") {
      return;
    }

    if (observedControlledRequestRef.current === requestKey) {
      if (latestControlledSelectionRef.current === requested) {
        latestControlledSelectionRef.current = null;
      }
      return;
    }

    if (latestControlledSelectionRef.current === requested) {
      latestControlledSelectionRef.current = null;
    }
    observedControlledRequestRef.current = requestKey;
    const generation = beginGeneration();
    setSaving(false);
    setSaveError(null);
    if (pending !== null) {
      const supersededByAppliedSelection =
        loadState === "ready" &&
        requested !== null &&
        sameToolIds(requested.enabledToolIds, appliedToolsRef.current);
      closeConfirmation(
        false,
        false,
        supersededByAppliedSelection,
        false,
      );
    }

    if (loadState !== "ready" || requested === null) {
      void loadPermissions(generation);
      return;
    }

    mergeRemovedToolIds(requested.removedToolIds);
    lastControlledRequestRef.current = requestKey;
    if (sameToolIds(requested.enabledToolIds, appliedToolsRef.current)) {
      if (hasPendingServerSave()) {
        void savePermissions(requested.enabledToolIds, generation);
        return;
      }
      if (lastStatusRef.current) {
        onAppliedRef.current?.(
          [...appliedToolsRef.current],
          lastStatusRef.current,
          { synchronization: "final" },
        );
      }
      return;
    }

    requestPermissionChange(
      requested.enabledToolIds,
      "Apply imported or parent MCP permissions?",
      null,
      true,
      requestKey,
      generation,
    );
  }, [
    beginGeneration,
    controlledSelection,
    closeConfirmation,
    hasPendingServerSave,
    loadState,
    loadPermissions,
    mergeRemovedToolIds,
    pending,
    requestPermissionChange,
    savePermissions,
  ]);

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleTools = catalog.filter((tool) =>
    matchesSearch(tool, normalizedSearch),
  );
  const knownTools = catalog.filter((tool) => tool.known);
  const unknownTools = catalog.filter((tool) => !tool.known);
  const enabledToolSet = new Set(appliedTools);
  const enabledKnownCount = knownTools.filter((tool) =>
    enabledToolSet.has(tool.id),
  ).length;
  const categories = [...MCP_TOOL_CATEGORIES, UNCLASSIFIED_CATEGORY];

  if (loadState === "loading") {
    return (
      <div
        className="rounded-lg border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        Loading and reconciling MCP tool permissions…
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div
        className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm"
        role="alert"
      >
        <p className="break-words [overflow-wrap:anywhere]">{loadError}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            const generation = beginGeneration();
            void loadPermissions(generation);
          }}
        >
          Retry loading tools
        </Button>
      </div>
    );
  }

  return (
    <section className="min-w-0" aria-labelledby="mcp-tool-permissions-heading">
      <div
        className="space-y-4"
        data-testid="mcp-permission-surrounding-content"
      >
        <div className="space-y-1">
          <h3 id="mcp-tool-permissions-heading" className="font-medium">
            MCP tool permissions
          </h3>
          <p className="text-xs text-muted-foreground">
            Grant only the Cloudflare actions that connected MCP clients should
            be allowed to use.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="mcp-tool-search" className="text-xs font-medium">
            Search tools
          </label>
          <Input
            id="mcp-tool-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by tool, capability, category, risk, or ID"
            autoComplete="off"
            disabled={saving || pending !== null}
          />
        </div>

        <output
          className="block rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs"
          aria-live="polite"
        >
          <span className="font-medium">
            {enabledKnownCount} of {knownTools.length} classified tools enabled.
          </span>{" "}
          {unknownTools.length > 0
            ? `${unknownTools.length} unclassified ${unknownTools.length === 1 ? "tool is" : "tools are"} denied.`
            : "No unclassified tools reported."}
        </output>

        {removedToolIds.length > 0 && (
          <div
            className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs break-words [overflow-wrap:anywhere]"
            role="alert"
          >
            Removed {removedToolIds.length} unknown MCP tool{" "}
            {removedToolIds.length === 1 ? "ID" : "IDs"} during reconciliation:{" "}
            {removedToolIds.join(", ")}. Unknown permissions remain denied.
          </div>
        )}

        {saveError && onError === undefined && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs break-words [overflow-wrap:anywhere]"
            role="alert"
          >
            {saveError}
          </div>
        )}

        {visibleTools.length === 0 ? (
          <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
            No MCP tools match “{search.trim()}”.
          </div>
        ) : (
          <div className="space-y-4">
            {categories.map((category) => {
              const visibleCategoryTools = visibleTools.filter(
                (tool) => tool.categoryId === category.id,
              );
              if (visibleCategoryTools.length === 0) return null;

              const enabledVisibleCount = visibleCategoryTools.filter((tool) =>
                enabledToolSet.has(tool.id),
              ).length;
              const categoryIsClassified = category.id !== "unclassified";
              const newlyEnabledVisibleTools = visibleCategoryTools.filter(
                (tool) => tool.known && !enabledToolSet.has(tool.id),
              );

              return (
                <fieldset
                  key={category.id}
                  className="min-w-0 space-y-3 rounded-lg border border-border/60 bg-card/30 p-3"
                >
                  <legend className="w-full px-1">
                    <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{category.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {enabledVisibleCount} / {visibleCategoryTools.length}{" "}
                        visible enabled
                      </span>
                    </span>
                  </legend>
                  <p className="text-xs text-muted-foreground break-words [overflow-wrap:anywhere]">
                    {category.description}
                  </p>

                  {categoryIsClassified && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          saving ||
                          pending !== null ||
                          newlyEnabledVisibleTools.length === 0
                        }
                        onClick={(event) => {
                          const nextTools = [
                            ...appliedTools,
                            ...visibleCategoryTools
                              .filter((tool) => tool.known)
                              .map((tool) => tool.id),
                          ];
                          requestPermissionChange(
                            nextTools,
                            `Enable visible ${category.label}?`,
                            event.currentTarget,
                          );
                        }}
                      >
                        Select visible
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          saving ||
                          pending !== null ||
                          enabledVisibleCount === 0
                        }
                        onClick={() => {
                          const visibleIds = new Set(
                            visibleCategoryTools.map((tool) => tool.id),
                          );
                          void savePermissions(
                            appliedTools.filter((id) => !visibleIds.has(id)),
                          );
                        }}
                      >
                        Clear visible
                      </Button>
                    </div>
                  )}

                  <div className="grid min-w-0 gap-2">
                    {visibleCategoryTools.map((tool) => {
                      const enabled = tool.known && enabledToolSet.has(tool.id);
                      const descriptionId = `mcp-tool-${tool.id}-description`;
                      return (
                        <label
                          key={tool.id}
                          className="flex min-w-0 items-start gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2"
                        >
                          <input
                            type="checkbox"
                            className="checkbox-themed mt-1 shrink-0"
                            checked={enabled}
                            disabled={saving || pending !== null || !tool.known}
                            aria-describedby={descriptionId}
                            onChange={(event) => {
                              const nextTools = event.target.checked
                                ? [...appliedTools, tool.id]
                                : appliedTools.filter((id) => id !== tool.id);
                              requestPermissionChange(
                                nextTools,
                                `Enable ${tool.label}?`,
                                event.currentTarget,
                              );
                            }}
                          />
                          <span className="min-w-0 flex-1 space-y-1">
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="font-medium break-words [overflow-wrap:anywhere]">
                                {tool.label}
                              </span>
                              <Tag
                                className={
                                  tool.known
                                    ? undefined
                                    : "border-destructive/50 text-destructive"
                                }
                              >
                                {tool.known
                                  ? RISK_LABELS[tool.risk]
                                  : "Unclassified · denied"}
                              </Tag>
                            </span>
                            <span
                              id={descriptionId}
                              className="block text-xs text-muted-foreground break-words [overflow-wrap:anywhere]"
                            >
                              {tool.description}
                              {!tool.known &&
                                " It cannot be enabled until reviewed frontend metadata is added."}
                            </span>
                            <code className="block text-[11px] text-muted-foreground/80 break-all">
                              {tool.id}
                            </code>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </div>
        )}
      </div>

      {modalOpen &&
        pending &&
        modalPortalHost &&
        createPortal(
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
            data-testid="mcp-permission-modal-backdrop"
            role="presentation"
          >
            <div
              ref={dialogRef}
              className="max-h-[min(80vh,44rem)] w-full max-w-xl space-y-3 overflow-y-auto rounded-lg border border-destructive/50 bg-background px-4 py-3 shadow-2xl"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="mcp-permission-confirmation-heading"
              aria-describedby="mcp-permission-confirmation-description"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeConfirmation(pending.notifyParentOnCancel);
                  return;
                }
                if (event.key !== "Tab" || !dialogRef.current) return;

                const focusable = focusableElements(dialogRef.current);
                if (focusable.length === 0) {
                  event.preventDefault();
                  return;
                }
                const first = focusable[0];
                const last = focusable.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (
                  !event.shiftKey &&
                  document.activeElement === last
                ) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <div className="space-y-1">
                <h4
                  id="mcp-permission-confirmation-heading"
                  className="text-sm font-semibold"
                >
                  {pending.heading}
                </h4>
                <p
                  id="mcp-permission-confirmation-description"
                  className="text-xs text-muted-foreground"
                >
                  Confirm before granting these write, bulk, destructive,
                  credential, or administrative capabilities:
                </p>
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                {pending.highRiskTools.map((tool) => (
                  <li
                    key={tool.id}
                    className="break-words [overflow-wrap:anywhere]"
                  >
                    {tool.label} ({RISK_LABELS[tool.risk]})
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  ref={cancelConfirmationRef}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    closeConfirmation(pending.notifyParentOnCancel)
                  }
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    const nextEnabledTools = pending.enabledTools;
                    const generation = pending.generation;
                    const trigger = closeConfirmation(
                      false,
                      false,
                      false,
                      false,
                    );
                    void savePermissions(nextEnabledTools, generation).finally(
                      () => {
                        if (!isCurrentGeneration(generation)) return;
                        setTimeout(() => {
                          if (
                            isCurrentGeneration(generation) &&
                            trigger?.isConnected
                          ) {
                            trigger.focus();
                          }
                        }, 0);
                      },
                    );
                  }}
                >
                  Confirm enable
                </Button>
              </div>
            </div>
          </div>,
          modalPortalHost,
        )}
    </section>
  );
}
