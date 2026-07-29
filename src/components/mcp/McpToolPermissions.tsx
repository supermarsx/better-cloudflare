"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import {
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_FALLBACKS,
  planMcpPermissionChange,
  reconcileMcpEnabledToolIds,
  reconcileMcpEnabledToolIdsDetailed,
  resolveMcpTool,
  type ResolvedMcpTool,
} from "@/lib/mcp/tool-permissions";
import { TauriClient, type McpServerStatus } from "@/lib/api/tauri-client";
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

export interface McpToolPermissionsProps {
  client?: McpToolPermissionsClient;
  storage?: McpToolPermissionsStorage;
  /**
   * Optional parent-owned desired selection. Changes are treated as permission
   * requests, so imported/profile values use the same reconciliation and
   * high-risk confirmation path as direct UI changes.
   */
  enabledTools?: readonly string[];
  /**
   * Called only after the desktop service has applied the reconciled selection.
   * The parent should replace its source-of-truth selection and status with
   * these exact values.
   */
  onApplied?: (enabledTools: string[], status: McpServerStatus) => void;
}

interface PendingPermissionChange {
  enabledTools: string[];
  heading: string;
  highRiskTools: ResolvedMcpTool[];
  notifyParentOnCancel: boolean;
  controlledRequestKey: string | null;
  appliedRequestKey: string;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
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

function resolveCatalog(status: McpServerStatus): ResolvedMcpTool[] {
  const backendById = new Map(
    (Array.isArray(status.tools) ? status.tools : [])
      .map((tool) => [String(tool.name ?? "").trim(), tool] as const)
      .filter(([id]) => id),
  );
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
    .filter(([id]) => !MCP_TOOL_FALLBACKS.some((tool) => tool.id === id))
    .map(([, backend]) => resolveMcpTool(backend));
  return [...knownTools, ...unknownTools];
}

function statusEnabledSelection(
  status: McpServerStatus,
  fallback: readonly string[],
) {
  if (Array.isArray(status.enabledTools)) {
    return reconcileMcpEnabledToolIdsDetailed(status.enabledTools);
  }
  if (Array.isArray(status.enabled_tools)) {
    return reconcileMcpEnabledToolIdsDetailed(status.enabled_tools);
  }
  if (Array.isArray(status.tools) && status.tools.length > 0) {
    return reconcileMcpEnabledToolIdsDetailed(
      status.tools
        .filter((tool) => tool.enabled === true)
        .map((tool) => tool.name),
    );
  }
  return reconcileMcpEnabledToolIdsDetailed(fallback);
}

function exactAppliedSelection(
  status: McpServerStatus,
  requestedTools: readonly string[],
): string[] {
  const requested = reconcileMcpEnabledToolIds(requestedTools);
  const applied = statusEnabledSelection(status, requested);
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
  enabledTools: controlledEnabledTools,
  onApplied,
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

  const appliedToolsRef = React.useRef<string[]>([]);
  const lastStatusRef = React.useRef<McpServerStatus | null>(null);
  const controlledEnabledToolsRef = React.useRef(controlledEnabledTools);
  const onAppliedRef = React.useRef(onApplied);
  const lastControlledRequestRef = React.useRef<string | null>(
    controlledEnabledTools === undefined
      ? null
      : reconciliationKey(
          reconcileMcpEnabledToolIdsDetailed(controlledEnabledTools),
        ),
  );
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const cancelConfirmationRef = React.useRef<HTMLButtonElement>(null);
  const confirmationTriggerRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    controlledEnabledToolsRef.current = controlledEnabledTools;
  }, [controlledEnabledTools]);

  React.useEffect(() => {
    onAppliedRef.current = onApplied;
  }, [onApplied]);

  const mergeRemovedToolIds = React.useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setRemovedToolIds((current) => [...new Set([...current, ...ids])]);
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
      if (pending.length > 0 && storage.stageMcpEnabledTools) {
        storage.stageMcpEnabledTools(
          reconciledTools,
          pending,
          reconcileMcpEnabledToolIdsDetailed(removedIds).removedToolIds,
        );
      } else {
        storage.setMcpEnabledTools(reconciledTools);
      }
    },
    [storage],
  );

  const publishApplied = React.useCallback(
    (nextEnabledTools: readonly string[], status: McpServerStatus) => {
      const reconciledTools = reconcileMcpEnabledToolIds(nextEnabledTools);
      appliedToolsRef.current = reconciledTools;
      lastStatusRef.current = status;
      setAppliedTools(reconciledTools);
      onAppliedRef.current?.([...reconciledTools], status);
    },
    [],
  );

  const rollbackServerSelection = React.useCallback(
    async (
      previousEnabledTools: readonly string[],
      cause: unknown,
    ): Promise<never> => {
      const previous = reconcileMcpEnabledToolIds(previousEnabledTools);
      try {
        const rollbackStatus = await client.save(previous);
        exactAppliedSelection(rollbackStatus, previous);
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(cause)} Automatic rollback to the previous MCP server selection also failed: ${errorMessage(rollbackError)}`,
        );
      }
      throw new Error(
        `${errorMessage(cause)} The previous MCP server selection was restored.`,
      );
    },
    [client],
  );

  const verifyAppliedOrRollback = React.useCallback(
    async (
      status: McpServerStatus,
      requestedEnabledTools: readonly string[],
      previousEnabledTools: readonly string[],
    ): Promise<string[]> => {
      try {
        return exactAppliedSelection(status, requestedEnabledTools);
      } catch (error) {
        return rollbackServerSelection(previousEnabledTools, error);
      }
    },
    [rollbackServerSelection],
  );

  const closeConfirmation = React.useCallback(
    (
      notifyParent: boolean,
      restoreFocus = true,
      clearStagedRequest = true,
    ): HTMLElement | null => {
      const trigger = confirmationTriggerRef.current;
      confirmationTriggerRef.current = null;
      setPending(null);

      if (clearStagedRequest) {
        try {
          persistApplied(appliedToolsRef.current);
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
        );
      }

      if (restoreFocus) {
        queueMicrotask(() => {
          if (trigger?.isConnected) trigger.focus();
        });
      }
      return trigger;
    },
    [persistApplied],
  );

  const openConfirmation = React.useCallback(
    (
      enabledTools: readonly string[],
      heading: string,
      highRiskTools: readonly ResolvedMcpTool[],
      trigger: HTMLElement | null,
      notifyParentOnCancel: boolean,
      controlledRequestKey: string | null = null,
    ) => {
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
      });
    },
    [],
  );

  const loadPermissions = React.useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    setSaveError(null);
    setRemovedToolIds([]);
    setPending(null);

    let persistedSnapshot: McpToolPermissionsStorageSnapshot;
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
      mergeRemovedToolIds(persistedSnapshot.removedToolIds);
    } catch (error) {
      persistedSnapshot = {
        enabledTools: [],
        removedToolIds: [],
        pendingHighRiskToolIds: [],
        configured: false,
      };
      setSaveError(
        `Saved MCP permissions could not be read: ${errorMessage(error)}`,
      );
    }

    try {
      const loadedStatus = await client.load();
      const nextCatalog = resolveCatalog(loadedStatus);
      const controlledRequest = controlledEnabledToolsRef.current;
      const stagedImportedTools =
        persistedSnapshot.pendingHighRiskToolIds ?? [];
      const desiredReconciliation = reconcileMcpEnabledToolIdsDetailed(
        controlledRequest ?? [
          ...persistedSnapshot.enabledTools,
          ...stagedImportedTools,
        ],
      );
      const serverReconciliation = statusEnabledSelection(loadedStatus, []);
      const loadRemovedToolIds = [
        ...desiredReconciliation.removedToolIds,
        ...serverReconciliation.removedToolIds,
        ...nextCatalog.filter((tool) => !tool.known).map((tool) => tool.id),
      ];
      mergeRemovedToolIds(loadRemovedToolIds);

      const controlledPlan =
        controlledRequest === undefined
          ? null
          : planMcpPermissionChange(
              persistedSnapshot.enabledTools,
              desiredReconciliation.enabledToolIds,
            );
      const candidateTools = desiredReconciliation.enabledToolIds;
      const unconfirmedHighRiskIds = new Set([
        ...(controlledPlan?.newlyEnabledHighRiskToolIds ?? []),
        ...(controlledRequest === undefined ? stagedImportedTools : []),
      ]);
      const conservativeTools = candidateTools.filter(
        (id) => !unconfirmedHighRiskIds.has(id),
      );

      lastControlledRequestRef.current =
        controlledRequest === undefined
          ? null
          : reconciliationKey(desiredReconciliation);

      const appliedStatus = await client.save(conservativeTools);
      const confirmedAppliedTools = await verifyAppliedOrRollback(
        appliedStatus,
        conservativeTools,
        serverReconciliation.enabledToolIds,
      );
      const pendingHighRiskTools = nextCatalog.filter((tool) =>
        unconfirmedHighRiskIds.has(tool.id),
      );
      const stagedPendingIds =
        controlledRequest === undefined
          ? pendingHighRiskTools.map((tool) => tool.id)
          : [];

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
        );
      }
      setCatalog(resolveCatalog(appliedStatus));
      publishApplied(confirmedAppliedTools, appliedStatus);
      setLoadState("ready");

      if (pendingHighRiskTools.length > 0) {
        openConfirmation(
          candidateTools,
          "Apply imported or parent MCP permissions?",
          pendingHighRiskTools,
          null,
          false,
          controlledRequest === undefined
            ? null
            : reconciliationKey(desiredReconciliation),
        );
      }
    } catch (error) {
      setCatalog([]);
      appliedToolsRef.current = [];
      setAppliedTools([]);
      setLoadError(
        `MCP permissions could not be loaded and reconciled: ${errorMessage(error)}`,
      );
      setLoadState("error");
    }
  }, [
    client,
    mergeRemovedToolIds,
    openConfirmation,
    persistApplied,
    publishApplied,
    rollbackServerSelection,
    storage,
    verifyAppliedOrRollback,
  ]);

  React.useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);

  React.useEffect(() => {
    if (pending) cancelConfirmationRef.current?.focus();
  }, [pending]);

  const savePermissions = React.useCallback(
    async (requestedTools: readonly string[]) => {
      const nextRequestedTools =
        reconcileMcpEnabledToolIdsDetailed(requestedTools);
      mergeRemovedToolIds(nextRequestedTools.removedToolIds);
      setSaving(true);
      setSaveError(null);

      try {
        const status = await client.save(nextRequestedTools.enabledToolIds);
        const applied = await verifyAppliedOrRollback(
          status,
          nextRequestedTools.enabledToolIds,
          appliedToolsRef.current,
        );
        try {
          persistApplied(applied);
        } catch (error) {
          await rollbackServerSelection(
            appliedToolsRef.current,
            new Error(
              `The applied MCP selection could not be persisted locally: ${errorMessage(error)}`,
            ),
          );
        }
        setCatalog(resolveCatalog(status));
        publishApplied(applied, status);
      } catch (error) {
        setSaveError(
          `MCP permissions could not be saved. No local selection was changed: ${errorMessage(error)}`,
        );
      } finally {
        setSaving(false);
      }
    },
    [
      client,
      mergeRemovedToolIds,
      persistApplied,
      publishApplied,
      rollbackServerSelection,
      verifyAppliedOrRollback,
    ],
  );

  const requestPermissionChange = React.useCallback(
    (
      requestedTools: readonly string[],
      heading: string,
      trigger: HTMLElement | null,
      notifyParentOnCancel = false,
      controlledRequestKey: string | null = null,
    ) => {
      const plan = planMcpPermissionChange(
        appliedToolsRef.current,
        requestedTools,
      );
      mergeRemovedToolIds(plan.removedToolIds);
      const highRiskIds = new Set(plan.newlyEnabledHighRiskToolIds);
      const highRiskTools = catalog.filter((tool) => highRiskIds.has(tool.id));

      if (highRiskTools.length > 0) {
        openConfirmation(
          plan.enabledToolIds,
          heading,
          highRiskTools,
          trigger,
          notifyParentOnCancel,
          controlledRequestKey,
        );
        return;
      }

      void savePermissions(plan.enabledToolIds);
    },
    [catalog, mergeRemovedToolIds, openConfirmation, savePermissions],
  );

  React.useEffect(() => {
    if (
      loadState !== "ready" ||
      controlledEnabledTools === undefined ||
      saving
    ) {
      return;
    }

    const requested = reconcileMcpEnabledToolIdsDetailed(
      controlledEnabledTools,
    );
    mergeRemovedToolIds(requested.removedToolIds);
    const requestKey = reconciliationKey(requested);
    if (lastControlledRequestRef.current === requestKey) return;
    if (pending !== null) {
      if (
        pending.controlledRequestKey === requestKey ||
        pending.appliedRequestKey === requestKey
      ) {
        return;
      }
      closeConfirmation(false);
      return;
    }
    lastControlledRequestRef.current = requestKey;
    if (sameToolIds(requested.enabledToolIds, appliedToolsRef.current)) {
      if (requested.removedToolIds.length > 0 && lastStatusRef.current) {
        onAppliedRef.current?.(
          [...appliedToolsRef.current],
          lastStatusRef.current,
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
    );
  }, [
    controlledEnabledTools,
    closeConfirmation,
    loadState,
    mergeRemovedToolIds,
    pending,
    requestPermissionChange,
    saving,
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
          onClick={loadPermissions}
        >
          Retry loading tools
        </Button>
      </div>
    );
  }

  return (
    <section
      className="min-w-0 space-y-4"
      aria-labelledby="mcp-tool-permissions-heading"
    >
      <div className="space-y-1">
        <h3 id="mcp-tool-permissions-heading" className="font-medium">
          MCP tool permissions
        </h3>
        <p className="text-xs text-muted-foreground">
          Grant only the Cloudflare actions that connected MCP clients should be
          allowed to use.
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
          disabled={saving}
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

      {saveError && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs break-words [overflow-wrap:anywhere]"
          role="alert"
        >
          {saveError}
        </div>
      )}

      {pending && (
        <div
          ref={dialogRef}
          className="space-y-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3"
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
            } else if (!event.shiftKey && document.activeElement === last) {
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
              onClick={() => closeConfirmation(pending.notifyParentOnCancel)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => {
                const nextEnabledTools = pending.enabledTools;
                const trigger = closeConfirmation(false, false, false);
                void savePermissions(nextEnabledTools).finally(() => {
                  setTimeout(() => {
                    if (trigger?.isConnected) trigger.focus();
                  }, 0);
                });
              }}
            >
              Confirm enable
            </Button>
          </div>
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
                        saving || pending !== null || enabledVisibleCount === 0
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
    </section>
  );
}
