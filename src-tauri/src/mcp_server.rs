//! Thin Tauri command wrappers around [`bc_mcp`].
//!
//! Every command that changes the server or its permissions hands the audit
//! trail down with the call. The manager is constructed in `main` before the
//! managed [`Storage`] exists, so the trail is an argument rather than
//! something the manager was wired with — which also means there is no state
//! in which the MCP control plane runs unrecorded.

pub use bc_mcp::{McpServerManager, McpServerStatus};
use tauri::State;

use crate::storage::Storage;

#[tauri::command]
pub async fn mcp_get_server_status(
    manager: State<'_, McpServerManager>,
) -> Result<McpServerStatus, String> {
    Ok(manager.get_status().await)
}

#[tauri::command]
pub async fn mcp_start_server(
    manager: State<'_, McpServerManager>,
    storage: State<'_, Storage>,
    host: Option<String>,
    port: Option<u16>,
    enabled_tools: Option<Vec<String>>,
    auth_token: Option<String>,
) -> Result<McpServerStatus, String> {
    manager
        .start(host, port, enabled_tools, auth_token, storage.audit_trail())
        .await
}

#[tauri::command]
pub async fn mcp_stop_server(
    manager: State<'_, McpServerManager>,
    storage: State<'_, Storage>,
) -> Result<McpServerStatus, String> {
    manager.stop(storage.inner()).await
}

#[tauri::command]
pub async fn mcp_set_enabled_tools(
    manager: State<'_, McpServerManager>,
    storage: State<'_, Storage>,
    enabled_tools: Vec<String>,
) -> Result<McpServerStatus, String> {
    manager
        .set_enabled_tools(enabled_tools, storage.inner())
        .await
}
