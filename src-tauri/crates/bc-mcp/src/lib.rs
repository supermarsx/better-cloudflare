//! Model Context Protocol (MCP) JSON-RPC server — 2024-11-05 specification.
//!
//! The HTTP boundary is fail-closed and bounded by connection, request, body,
//! JSON shape, execution-time, concurrency, and response-size budgets.

mod dns_mutation_validation;
mod resource_limits;
mod transport;

pub mod permissions;
pub mod prompts;
pub mod protocol;
pub mod resources;
pub mod schemas;
pub mod tools;

use std::sync::Arc;

use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use permissions::PermissionGrantSet;
use resource_limits::{
    bounded_message, RuntimePolicy, MAX_AUTH_TOKEN_BYTES, MAX_CONFIGURED_GRANTS,
};

const DEFAULT_MCP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_PORT: u16 = 8787;
const MAX_BIND_HOST_BYTES: usize = 255;

pub use prompts::{McpPrompt, PromptArgument, PromptMessage};
pub use resources::{McpResource, McpResourceTemplate};
pub use tools::McpToolDescriptor;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub url: String,
    pub enabled_tools: Vec<String>,
    pub tool_count: usize,
    pub resource_count: usize,
    pub prompt_count: usize,
    pub tools: Vec<McpToolDescriptor>,
    pub last_error: Option<String>,
    /// The bearer token protecting the MCP server (auto-generated if not set).
    pub auth_token: Option<String>,
}

struct RunningMcpServer {
    host: String,
    port: u16,
    grants: Arc<RwLock<PermissionGrantSet>>,
    #[allow(dead_code)]
    auth_token: Arc<RwLock<Option<String>>>,
    shutdown: CancellationToken,
    task_handle: JoinHandle<Result<(), String>>,
}

pub struct McpServerManager {
    runtime: RwLock<Option<RunningMcpServer>>,
    config_host: RwLock<String>,
    config_port: RwLock<u16>,
    config_grants: RwLock<PermissionGrantSet>,
    config_auth_token: RwLock<Option<String>>,
    last_error: Arc<RwLock<Option<String>>>,
}

impl Default for McpServerManager {
    fn default() -> Self {
        Self {
            runtime: RwLock::new(None),
            config_host: RwLock::new(DEFAULT_MCP_HOST.to_string()),
            config_port: RwLock::new(DEFAULT_MCP_PORT),
            config_grants: RwLock::new(default_enabled_tool_set()),
            config_auth_token: RwLock::new(None),
            last_error: Arc::new(RwLock::new(None)),
        }
    }
}

pub fn available_tool_definitions() -> Vec<McpToolDescriptor> {
    tools::available_tool_definitions()
}

pub fn default_enabled_tool_set() -> PermissionGrantSet {
    PermissionGrantSet::defaults()
}

pub fn sanitize_enabled_tools(list: &[String]) -> PermissionGrantSet {
    let bounded = list
        .iter()
        .take(MAX_CONFIGURED_GRANTS)
        .filter(|name| name.len() <= resource_limits::MAX_METHOD_BYTES)
        .cloned()
        .collect::<Vec<_>>();
    PermissionGrantSet::from_requested(&bounded)
}

fn normalize_host(host: Option<String>) -> Result<String, String> {
    let next = host.unwrap_or_else(|| DEFAULT_MCP_HOST.to_string());
    let trimmed = next.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_MCP_HOST.to_string());
    }
    if trimmed.len() > MAX_BIND_HOST_BYTES
        || trimmed
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("MCP bind host is malformed or exceeds 255 bytes.".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_port(port: Option<u16>) -> u16 {
    match port {
        Some(0) | None => DEFAULT_MCP_PORT,
        Some(port) => port,
    }
}

fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn generate_auth_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn effective_auth_token(auth_token: Option<String>) -> String {
    auth_token
        .map(|token| token.trim().to_string())
        .filter(|token| {
            !token.is_empty()
                && token.len() <= MAX_AUTH_TOKEN_BYTES
                && !token.chars().any(char::is_whitespace)
        })
        .unwrap_or_else(generate_auth_token)
}

pub fn build_status(
    running: bool,
    host: String,
    port: u16,
    grants: &PermissionGrantSet,
    last_error: Option<String>,
    auth_token: Option<String>,
) -> McpServerStatus {
    let mut enabled_tools = permissions::permission_registry()
        .iter()
        .filter(|permission| grants.allows(permission))
        .map(|permission| permission.invocation_name.to_string())
        .collect::<Vec<_>>();
    enabled_tools.sort();
    let all_tools = tools::available_tool_definitions();
    let tool_count = all_tools.len();
    let tools = all_tools
        .into_iter()
        .map(|mut tool| {
            tool.enabled = grants.allows_id(&tool.permission_id);
            tool
        })
        .collect();
    McpServerStatus {
        running,
        host: host.clone(),
        port,
        url: format!("http://{}/mcp", host_port(&host, port)),
        enabled_tools,
        tool_count,
        resource_count: resources::list_resources().len(),
        prompt_count: prompts::list_prompts().len(),
        tools,
        last_error: last_error.map(|error| bounded_message(&error)),
        auth_token,
    }
}

impl McpServerManager {
    pub async fn get_status(&self) -> McpServerStatus {
        let last_error = self.last_error.read().await.clone();
        let runtime = self.runtime.read().await;
        if let Some(runtime) = runtime.as_ref() {
            let running = !runtime.task_handle.is_finished();
            let grants = runtime.grants.read().await.clone();
            let token = runtime.auth_token.read().await.clone();
            return build_status(
                running,
                runtime.host.clone(),
                runtime.port,
                &grants,
                last_error,
                token,
            );
        }
        drop(runtime);
        let host = self.config_host.read().await.clone();
        let port = *self.config_port.read().await;
        let grants = self.config_grants.read().await.clone();
        let token = self.config_auth_token.read().await.clone();
        build_status(false, host, port, &grants, last_error, token)
    }

    async fn stop_internal(&self) -> Result<(), String> {
        let runtime = self.runtime.write().await.take();
        if let Some(runtime) = runtime {
            let RunningMcpServer {
                host,
                port,
                grants,
                auth_token: _,
                shutdown,
                mut task_handle,
            } = runtime;
            shutdown.cancel();
            let deadline =
                RuntimePolicy::default().shutdown_grace + std::time::Duration::from_secs(2);
            match timeout(deadline, &mut task_handle).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => {
                    *self.last_error.write().await = Some(bounded_message(&error));
                }
                Ok(Err(error)) => {
                    *self.last_error.write().await = Some(bounded_message(&error.to_string()));
                }
                Err(_) => {
                    task_handle.abort();
                    let _ = task_handle.await;
                    *self.last_error.write().await =
                        Some("MCP server shutdown exceeded its deadline.".to_string());
                }
            }
            *self.config_host.write().await = host;
            *self.config_port.write().await = port;
            *self.config_grants.write().await = grants.read().await.clone();
        }
        Ok(())
    }

    pub async fn stop(&self) -> Result<McpServerStatus, String> {
        self.stop_internal().await?;
        Ok(self.get_status().await)
    }

    pub async fn set_enabled_tools(
        &self,
        enabled_tools: Vec<String>,
    ) -> Result<McpServerStatus, String> {
        let next = sanitize_enabled_tools(&enabled_tools);
        *self.config_grants.write().await = next.clone();
        let running_grants = self
            .runtime
            .read()
            .await
            .as_ref()
            .map(|runtime| Arc::clone(&runtime.grants));
        if let Some(grants) = running_grants {
            *grants.write().await = next;
        }
        Ok(self.get_status().await)
    }

    pub async fn start(
        &self,
        host: Option<String>,
        port: Option<u16>,
        enabled_tools: Option<Vec<String>>,
        auth_token: Option<String>,
    ) -> Result<McpServerStatus, String> {
        self.stop_internal().await?;

        let host = normalize_host(host)?;
        let port = normalize_port(port);
        let desired_grants = if let Some(enabled_tools) = enabled_tools.as_deref() {
            sanitize_enabled_tools(enabled_tools)
        } else {
            self.config_grants.read().await.clone()
        };
        let grants = Arc::new(RwLock::new(desired_grants.clone()));
        let effective_token = Some(effective_auth_token(auth_token));
        let token = Arc::new(RwLock::new(effective_token.clone()));

        let bind_address = host_port(&host, port);
        let listener = TcpListener::bind(&bind_address)
            .await
            .map_err(|error| format!("Failed to bind MCP server on {bind_address}: {error}"))?;
        let actual_port = listener
            .local_addr()
            .map_err(|error| format!("Failed to read MCP server address: {error}"))?
            .port();

        let policy = RuntimePolicy::default();
        let shutdown = CancellationToken::new();
        let state = transport::HttpRuntimeState::production(
            Arc::clone(&grants),
            Arc::clone(&token),
            host.clone(),
            actual_port,
            shutdown.clone(),
            policy,
        );
        let app = transport::router(state);
        let task_shutdown = shutdown.clone();
        let last_error = Arc::clone(&self.last_error);
        *self.last_error.write().await = None;
        let task_handle = tokio::spawn(async move {
            let result = transport::serve(listener, app, task_shutdown, policy).await;
            if let Err(error) = result.as_ref() {
                *last_error.write().await = Some(bounded_message(error));
            }
            result
        });

        *self.config_host.write().await = host.clone();
        *self.config_port.write().await = actual_port;
        *self.config_grants.write().await = desired_grants;
        *self.config_auth_token.write().await = effective_token;
        *self.runtime.write().await = Some(RunningMcpServer {
            host,
            port: actual_port,
            grants,
            auth_token: token,
            shutdown,
            task_handle,
        });
        Ok(self.get_status().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve_local_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    #[test]
    fn blank_or_oversized_tokens_are_replaced_with_random_credentials() {
        let missing = effective_auth_token(None);
        let blank = effective_auth_token(Some(" \t\r\n ".to_string()));
        let oversized = effective_auth_token(Some("x".repeat(MAX_AUTH_TOKEN_BYTES + 1)));
        assert_eq!(missing.len(), 64);
        assert_eq!(blank.len(), 64);
        assert_eq!(oversized.len(), 64);
        assert_ne!(missing, blank);
        assert_ne!(blank, oversized);
        assert_eq!(
            effective_auth_token(Some(" configured-token ".to_string())),
            "configured-token"
        );
    }

    #[test]
    fn configured_grants_and_status_diagnostics_are_bounded() {
        let mut requested = vec!["dns_validate_record".to_string()];
        requested.extend((0..1_000).map(|index| format!("unknown-{index}")));
        let grants = sanitize_enabled_tools(&requested);
        assert!(grants.allows_id("bc.mcp.v1.dns.validate_record"));
        let status = build_status(
            false,
            DEFAULT_MCP_HOST.to_string(),
            DEFAULT_MCP_PORT,
            &grants,
            Some("e".repeat(resource_limits::MAX_ERROR_MESSAGE_BYTES * 2)),
            None,
        );
        assert!(status.last_error.unwrap().len() <= resource_limits::MAX_ERROR_MESSAGE_BYTES + 3);
        assert_eq!(
            build_status(false, "::1".to_string(), 8787, &grants, None, None).url,
            "http://[::1]:8787/mcp"
        );
    }

    #[tokio::test]
    async fn explicit_empty_grants_survive_start_stop_and_restart() {
        let manager = McpServerManager::default();
        let port = reserve_local_port();
        let started = manager
            .start(
                Some(DEFAULT_MCP_HOST.to_string()),
                Some(port),
                Some(Vec::new()),
                Some("test-token".to_string()),
            )
            .await
            .unwrap();
        assert!(started.enabled_tools.is_empty());

        manager
            .set_enabled_tools(vec!["dns_validate_record".to_string()])
            .await
            .unwrap();
        assert!(manager
            .set_enabled_tools(Vec::new())
            .await
            .unwrap()
            .enabled_tools
            .is_empty());
        manager.stop().await.unwrap();

        let restarted = manager
            .start(
                None,
                Some(port),
                None,
                Some("replacement-token".to_string()),
            )
            .await
            .unwrap();
        assert!(restarted.enabled_tools.is_empty());
        manager.stop().await.unwrap();
    }
}
