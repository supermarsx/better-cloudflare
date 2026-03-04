//! Thin Tauri command wrappers around [`bc_mcp`].

pub use bc_mcp::{McpServerManager, McpServerStatus};
use tauri::State;

#[tauri::command]
pub async fn mcp_get_server_status(
    manager: State<'_, McpServerManager>,
) -> Result<McpServerStatus, String> {
    Ok(manager.get_status().await)
}

#[tauri::command]
pub async fn mcp_start_server(
    manager: State<'_, McpServerManager>,
    host: Option<String>,
    port: Option<u16>,
    enabled_tools: Option<Vec<String>>,
    auth_token: Option<String>,
) -> Result<McpServerStatus, String> {
    manager.start(host, port, enabled_tools, auth_token).await
}

#[tauri::command]
pub async fn mcp_stop_server(
    manager: State<'_, McpServerManager>,
) -> Result<McpServerStatus, String> {
    manager.stop().await
}

#[tauri::command]
pub async fn mcp_set_enabled_tools(
    manager: State<'_, McpServerManager>,
    enabled_tools: Vec<String>,
) -> Result<McpServerStatus, String> {
    manager.set_enabled_tools(enabled_tools).await
}
