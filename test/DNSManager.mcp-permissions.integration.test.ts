import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const DNS_MANAGER_SOURCE = readFileSync(
  new URL("../src/components/dns/DNSManager.tsx", import.meta.url),
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  const startIndex = DNS_MANAGER_SOURCE.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing integration marker: ${start}`);
  const endIndex = DNS_MANAGER_SOURCE.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing integration marker: ${end}`);
  return DNS_MANAGER_SOURCE.slice(startIndex, endIndex);
}

test("mounts categorized MCP permissions and removes the legacy flat controls", () => {
  assert.equal(
    DNS_MANAGER_SOURCE.match(/<McpToolPermissions/g)?.length,
    1,
    "DNSManager must keep exactly one permission component instance",
  );
  assert.match(DNS_MANAGER_SOURCE, /createPortal\(\s*<McpToolPermissions/);
  assert.match(DNS_MANAGER_SOURCE, /interactive=\{mcpPermissionsInteractive\}/);
  assert.match(DNS_MANAGER_SOURCE, /onError=\{handleMcpPermissionsError\}/);
  assert.doesNotMatch(DNS_MANAGER_SOURCE, /applyMcpEnabledTools/);
  assert.doesNotMatch(DNS_MANAGER_SOURCE, /mcpToolCatalog/);
  assert.doesNotMatch(
    DNS_MANAGER_SOURCE,
    /\{t\("Enable all", "Enable all"\)\}/,
  );
  assert.doesNotMatch(
    DNS_MANAGER_SOURCE,
    /\{t\("Disable all", "Disable all"\)\}/,
  );
});

test("treats an explicit empty onApplied selection as authoritative and ready", () => {
  const handler = sourceBetween(
    "const handleMcpPermissionsApplied = useCallback(",
    "const setMcpServerRunning = useCallback(",
  );

  assert.match(handler, /const confirmedTools = \[\.\.\.enabledTools\];/);
  assert.match(handler, /setMcpEnabledTools\(confirmedTools\);/);
  assert.match(
    handler,
    /if \(application\.synchronization === "final"\) \{[\s\S]*setMcpRequestedTools\(confirmedTools\);/,
  );
  assert.match(handler, /setMcpStatus\(status\);/);
  assert.match(handler, /setMcpPermissionsReady\(true\);/);
  assert.doesNotMatch(handler, /enabledTools\.length/);
});

test("bootstrap permission failures stay unready and report one owned diagnostic", () => {
  const handler = sourceBetween(
    "const handleMcpPermissionsError = useCallback(",
    "const setMcpServerRunning = useCallback(",
  );

  assert.match(
    handler,
    /failure\.operation === "bootstrap"[\s\S]*setMcpPermissionsReady\(false\);/,
  );
  assert.match(handler, /"Synchronize MCP server preferences"/);
  assert.match(handler, /"Update MCP tool access"/);
  assert.match(handler, /setMcpActionError\(diagnostic\.message\);/);
  assert.doesNotMatch(handler, /setMcpPermissionsReady\(true\)/);
});

test("starts and restarts MCP with confirmed permissions only", () => {
  const serverControl = sourceBetween(
    "const setMcpServerRunning = useCallback(",
    "useEffect(() => {\n    if (!prefsReady) return;",
  );
  const startupSynchronization = sourceBetween(
    "useEffect(() => {\n    if (!prefsReady || !mcpPermissionsReady",
    "const persistTabStateBestEffort = useCallback(",
  );

  assert.match(
    serverControl,
    /TauriClient\.startMcpServer\(\s*nextHost,\s*nextPort,\s*mcpEnabledTools,\s*\)/,
  );
  assert.doesNotMatch(serverControl, /mcpRequestedTools/);
  assert.match(
    startupSynchronization,
    /TauriClient\.startMcpServer\(\s*mcpServerHostRef\.current,\s*mcpServerPortRef\.current,\s*mcpEnabledToolsRef\.current,\s*\)/,
  );
  assert.doesNotMatch(startupSynchronization, /mcpRequestedTools/);
});

test("stages persisted, profile, and imported permission requests for reconciliation", () => {
  const initialPermissionState = sourceBetween(
    "const [initialMcpPermissionSnapshot]",
    "const [mcpStatus",
  );
  const profileApplication = sourceBetween(
    "const applySessionSettingsProfile = useCallback(",
    "const loadZones = useCallback(",
  );
  const desktopPreferenceImport = sourceBetween(
    "if (Array.isArray(prefObj.mcp_enabled_tools))",
    "if (typeof prefObj.loading_overlay_timeout_ms",
  );
  const fileImport = sourceBetween(
    "const importSessionSettings = useCallback(",
    "const cloneSessionSettingsFrom = useCallback(",
  );

  assert.match(
    initialPermissionState,
    /\.\.\.initialMcpPermissionSnapshot\.pendingHighRiskToolIds/,
  );
  assert.match(
    profileApplication,
    /if \(!sameMcpToolIds\(requestedTools, mcpEnabledToolsRef\.current\)\) \{\s*setMcpPermissionsReady\(false\);/,
  );
  assert.doesNotMatch(profileApplication, /setMcpEnabledTools\(\s*Array\.from/);
  assert.match(
    desktopPreferenceImport,
    /\.\.\.persistedPermissionSnapshot\.pendingHighRiskToolIds/,
  );
  assert.match(
    desktopPreferenceImport,
    /setMcpEnabledTools\(confirmedTools\);/,
  );
  assert.match(fileImport, /applySessionSettingsProfile\(profile\);/);
});
