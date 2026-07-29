"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";
import {
  MCP_TOOL_CATEGORIES,
  reconcileMcpEnabledToolIds,
  requiresMcpPermissionConfirmation,
  resolveMcpTool,
  type ResolvedMcpTool,
} from "@/lib/mcp/tool-permissions";
import { TauriClient, type McpServerStatus } from "@/lib/api/tauri-client";
import { storageManager } from "@/lib/storage/storage";

export interface McpToolPermissionsClient {
  load(): Promise<McpServerStatus>;
  save(enabledTools: string[]): Promise<McpServerStatus>;
}

export interface McpToolPermissionsStorage {
  getMcpEnabledTools(): string[];
  setMcpEnabledTools(enabledTools: string[]): void;
}

export interface McpToolPermissionsProps {
  client?: McpToolPermissionsClient;
  storage?: McpToolPermissionsStorage;
}

interface PendingPermissionChange {
  enabledTools: string[];
  heading: string;
  highRiskTools: ResolvedMcpTool[];
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
  destructive: "Destructive",
  "credential-admin": "Credential / admin",
} as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "An unexpected MCP permissions error occurred.";
}

function resolveCatalog(status: McpServerStatus): ResolvedMcpTool[] {
  const seen = new Set<string>();
  return (Array.isArray(status.tools) ? status.tools : [])
    .map(resolveMcpTool)
    .filter((tool) => {
      if (!tool.id || seen.has(tool.id)) return false;
      seen.add(tool.id);
      return true;
    });
}

function statusEnabledTools(
  status: McpServerStatus,
  fallback: readonly string[],
): string[] {
  if (Array.isArray(status.enabledTools)) {
    return reconcileMcpEnabledToolIds(status.enabledTools);
  }
  if (Array.isArray(status.enabled_tools)) {
    return reconcileMcpEnabledToolIds(status.enabled_tools);
  }
  if (Array.isArray(status.tools) && status.tools.length > 0) {
    return reconcileMcpEnabledToolIds(
      status.tools
        .filter((tool) => tool.enabled === true)
        .map((tool) => tool.name),
    );
  }
  return reconcileMcpEnabledToolIds(fallback);
}

function onlyAvailableTools(
  enabledTools: readonly string[],
  catalog: readonly ResolvedMcpTool[],
): string[] {
  const available = new Set(
    catalog.filter((tool) => tool.known).map((tool) => tool.id),
  );
  return reconcileMcpEnabledToolIds(enabledTools).filter((id) =>
    available.has(id),
  );
}

function matchesSearch(tool: ResolvedMcpTool, query: string): boolean {
  if (!query) return true;
  const category = MCP_TOOL_CATEGORIES.find(({ id }) => id === tool.categoryId);
  return [
    tool.id,
    tool.label,
    tool.description,
    category?.label ?? UNCLASSIFIED_CATEGORY.label,
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function McpToolPermissions({
  client = defaultClient,
  storage = storageManager,
}: McpToolPermissionsProps) {
  const [loadState, setLoadState] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  const [catalog, setCatalog] = React.useState<ResolvedMcpTool[]>([]);
  const [enabledTools, setEnabledTools] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [pending, setPending] = React.useState<PendingPermissionChange | null>(
    null,
  );
  const cancelConfirmationRef = React.useRef<HTMLButtonElement>(null);

  const loadPermissions = React.useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    setSaveError(null);

    let persistedTools: string[] = [];
    try {
      persistedTools = reconcileMcpEnabledToolIds(storage.getMcpEnabledTools());
    } catch (error) {
      setSaveError(
        `Saved MCP permissions could not be read: ${errorMessage(error)}`,
      );
    }

    try {
      const status = await client.load();
      const nextCatalog = resolveCatalog(status);
      const nextEnabledTools = onlyAvailableTools(
        statusEnabledTools(status, persistedTools),
        nextCatalog,
      );
      setCatalog(nextCatalog);
      setEnabledTools(nextEnabledTools);
      setLoadState("ready");

      try {
        storage.setMcpEnabledTools(nextEnabledTools);
      } catch (error) {
        setSaveError(
          `MCP permissions loaded, but the reconciled selection could not be stored: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      setCatalog([]);
      setEnabledTools([]);
      setLoadError(`MCP tools could not be loaded: ${errorMessage(error)}`);
      setLoadState("error");
    }
  }, [client, storage]);

  React.useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);

  React.useEffect(() => {
    if (pending) cancelConfirmationRef.current?.focus();
  }, [pending]);

  const savePermissions = React.useCallback(
    async (requestedTools: readonly string[]) => {
      const nextRequestedTools = onlyAvailableTools(requestedTools, catalog);
      setSaving(true);
      setSaveError(null);

      let status: McpServerStatus;
      try {
        status = await client.save(nextRequestedTools);
      } catch (error) {
        setSaveError(
          `MCP permissions could not be saved. No local selection was changed: ${errorMessage(error)}`,
        );
        setSaving(false);
        return;
      }

      const responseCatalog = resolveCatalog(status);
      const nextCatalog =
        responseCatalog.length > 0 ? responseCatalog : catalog;
      const appliedTools = onlyAvailableTools(
        statusEnabledTools(status, nextRequestedTools),
        nextCatalog,
      );
      setCatalog(nextCatalog);
      setEnabledTools(appliedTools);

      try {
        storage.setMcpEnabledTools(appliedTools);
      } catch (error) {
        setSaveError(
          `MCP permissions were applied, but could not be stored locally: ${errorMessage(error)}`,
        );
      } finally {
        setSaving(false);
      }
    },
    [catalog, client, storage],
  );

  const requestPermissionChange = React.useCallback(
    (
      requestedTools: readonly string[],
      heading: string,
      newlyEnabledTools: readonly ResolvedMcpTool[],
    ) => {
      const highRiskTools = newlyEnabledTools.filter((tool) =>
        requiresMcpPermissionConfirmation(tool.risk),
      );
      const nextEnabledTools = onlyAvailableTools(requestedTools, catalog);

      if (highRiskTools.length > 0) {
        setPending({
          enabledTools: nextEnabledTools,
          heading,
          highRiskTools,
        });
        return;
      }

      void savePermissions(nextEnabledTools);
    },
    [catalog, savePermissions],
  );

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleTools = catalog.filter((tool) =>
    matchesSearch(tool, normalizedSearch),
  );
  const knownTools = catalog.filter((tool) => tool.known);
  const unknownTools = catalog.filter((tool) => !tool.known);
  const enabledToolSet = new Set(enabledTools);
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
        Loading MCP tool permissions…
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
          placeholder="Search by tool, capability, category, or ID"
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
          className="space-y-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="mcp-permission-confirmation-heading"
          aria-describedby="mcp-permission-confirmation-description"
          onKeyDown={(event) => {
            if (event.key === "Escape") setPending(null);
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
              Confirm before granting these destructive or credential/admin
              capabilities:
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
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => {
                const nextEnabledTools = pending.enabledTools;
                setPending(null);
                void savePermissions(nextEnabledTools);
              }}
            >
              Confirm enable
            </Button>
          </div>
        </div>
      )}

      {catalog.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
          No MCP tools are available from the desktop service.
        </div>
      ) : visibleTools.length === 0 ? (
        <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-6 text-sm text-muted-foreground">
          No MCP tools match “{search.trim()}”.
        </div>
      ) : (
        <div className="space-y-4">
          {categories.map((category) => {
            const categoryTools = catalog.filter(
              (tool) => tool.categoryId === category.id,
            );
            const visibleCategoryTools = visibleTools.filter(
              (tool) => tool.categoryId === category.id,
            );
            if (visibleCategoryTools.length === 0) return null;

            const enabledCategoryCount = categoryTools.filter((tool) =>
              enabledToolSet.has(tool.id),
            ).length;
            const categoryIsClassified = category.id !== "unclassified";
            const newlyEnabledTools = categoryTools.filter(
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
                      {enabledCategoryCount} / {categoryTools.length} enabled
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
                        newlyEnabledTools.length === 0
                      }
                      onClick={() => {
                        const nextTools = [
                          ...enabledTools,
                          ...categoryTools
                            .filter((tool) => tool.known)
                            .map((tool) => tool.id),
                        ];
                        requestPermissionChange(
                          nextTools,
                          `Enable ${category.label}?`,
                          newlyEnabledTools,
                        );
                      }}
                    >
                      Select category
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        saving || pending !== null || enabledCategoryCount === 0
                      }
                      onClick={() => {
                        const categoryIds = new Set(
                          categoryTools.map((tool) => tool.id),
                        );
                        void savePermissions(
                          enabledTools.filter((id) => !categoryIds.has(id)),
                        );
                      }}
                    >
                      Clear category
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
                              ? [...enabledTools, tool.id]
                              : enabledTools.filter((id) => id !== tool.id);
                            requestPermissionChange(
                              nextTools,
                              `Enable ${tool.label}?`,
                              event.target.checked ? [tool] : [],
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
