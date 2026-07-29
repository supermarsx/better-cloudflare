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
  assert.match(
    DNS_MANAGER_SOURCE,
    /<McpToolPermissions\s+enabledTools=\{mcpRequestedTools\}\s+onApplied=\{handleMcpPermissionsApplied\}\s*\/>/,
  );
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
  assert.match(handler, /setMcpRequestedTools\(confirmedTools\);/);
  assert.match(handler, /setMcpStatus\(status\);/);
  assert.match(handler, /setMcpPermissionsReady\(true\);/);
  assert.doesNotMatch(handler, /enabledTools\.length/);
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
    /TauriClient\.startMcpServer\(\s*mcpServerHost,\s*mcpServerPort,\s*mcpEnabledTools,\s*\)/,
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
    /if \(Array\.isArray\(profile\.mcpEnabledTools\)\) \{\s*setMcpPermissionsReady\(false\);\s*setMcpRequestedTools\(/,
  );
  assert.doesNotMatch(
    profileApplication,
    /setMcpEnabledTools\(\s*Array\.from/,
  );
  assert.match(
    desktopPreferenceImport,
    /setMcpPermissionsReady\(false\);\s*setMcpRequestedTools\(/,
  );
  assert.doesNotMatch(desktopPreferenceImport, /setMcpEnabledTools\(/);
  assert.match(fileImport, /applySessionSettingsProfile\(profile\);/);
});
