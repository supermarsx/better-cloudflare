//! Model Context Protocol (MCP) JSON-RPC server — 2024-11-05 specification.
//!
//! The HTTP boundary is fail-closed and bounded by connection, request, body,
//! JSON shape, execution-time, concurrency, and response-size budgets.

mod dns_mutation_validation;
mod resource_limits;
mod transport;

pub mod audit;
pub mod features;
pub mod permissions;
pub mod prompts;
pub mod protocol;
pub mod resources;
pub mod schemas;
pub mod tools;

use std::sync::Arc;

use bc_storage::{AuditActor, AuditEntry, AuditOutcome, AuditTrail};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use permissions::{PermissionGrantHandle, PermissionGrantSet};
use resource_limits::{
    bounded_message, RuntimePolicy, MAX_AUTH_TOKEN_BYTES, MAX_CONFIGURED_GRANTS,
};

const DEFAULT_MCP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_PORT: u16 = 8787;
const MAX_BIND_HOST_BYTES: usize = 255;

pub use features::{registry_lookups_enabled, set_registry_lookups_enabled};
pub use permissions::{PermissionGrantHandle as McpGrantHandle, PermissionGrantSet as McpGrantSet};
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
    #[allow(dead_code)]
    auth_token: Arc<RwLock<Option<String>>>,
    shutdown: CancellationToken,
    task_handle: JoinHandle<Result<(), String>>,
}

pub struct McpServerManager {
    runtime: RwLock<Option<RunningMcpServer>>,
    config_host: RwLock<String>,
    config_port: RwLock<u16>,
    /// The grants in force, whether or not the server is running.
    ///
    /// One cell, shared with the HTTP transport and with in-process callers, so
    /// the status view, the transport and the AI assistant cannot drift into
    /// disagreeing about what the user enabled.
    grants: PermissionGrantHandle,
    config_auth_token: RwLock<Option<String>>,
    last_error: Arc<RwLock<Option<String>>>,
}

impl Default for McpServerManager {
    fn default() -> Self {
        Self {
            runtime: RwLock::new(None),
            config_host: RwLock::new(DEFAULT_MCP_HOST.to_string()),
            config_port: RwLock::new(DEFAULT_MCP_PORT),
            grants: PermissionGrantHandle::new(default_enabled_tool_set()),
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
    let mut rng = rand::rng();
    let bytes: [u8; 32] = rng.random();
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
    /// A read-only handle to the grants in force, for in-process callers.
    ///
    /// The AI assistant holds one of these so its dispatches are governed by
    /// the permissions the user configured here — the running server's grants
    /// while it runs, and the stored configuration while it does not, because
    /// both are the same cell.
    pub fn grant_handle(&self) -> PermissionGrantHandle {
        self.grants.clone()
    }

    pub async fn get_status(&self) -> McpServerStatus {
        let last_error = self.last_error.read().await.clone();
        let grants = self.grants.snapshot().await;
        let runtime = self.runtime.read().await;
        if let Some(runtime) = runtime.as_ref() {
            let running = !runtime.task_handle.is_finished();
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
        let token = self.config_auth_token.read().await.clone();
        build_status(false, host, port, &grants, last_error, token)
    }

    async fn stop_internal(&self) -> Result<(), String> {
        let runtime = self.runtime.write().await.take();
        if let Some(runtime) = runtime {
            let RunningMcpServer {
                host,
                port,
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
            // Grants outlive the runtime: they live in one cell the stopped
            // manager keeps reading from, so stopping the server does not
            // reset what the user enabled.
            *self.config_host.write().await = host;
            *self.config_port.write().await = port;
        }
        Ok(())
    }

    /// Stop the server, recording that the door was closed.
    ///
    /// The trail is an argument rather than something the manager was wired
    /// with, so there is no state in which the control plane runs unrecorded.
    pub async fn stop(&self, audit: &dyn AuditTrail) -> Result<McpServerStatus, String> {
        let running = self.runtime.read().await.as_ref().map(|runtime| {
            (
                host_port(&runtime.host, runtime.port),
                runtime.task_handle.is_finished(),
            )
        });
        self.stop_internal().await?;
        if let Some((address, _)) = running {
            audit.record(
                AuditEntry::new(
                    AuditActor::User,
                    audit::MCP_SERVER_STOP_OPERATION,
                    AuditOutcome::Succeeded,
                )
                .resource(&address),
            );
        }
        Ok(self.get_status().await)
    }

    /// Replace the tools MCP clients and the assistant may reach.
    ///
    /// Recorded as a user action: this is the setting that decides what every
    /// later tool call is allowed to do, so a trail that showed the calls but
    /// not this would answer "what was done" without answering "how was it
    /// allowed". Counts, not names — fifty-four tool names would not fit one
    /// entry, and the count of tools that can *change* something is what a
    /// reader is actually checking.
    pub async fn set_enabled_tools(
        &self,
        enabled_tools: Vec<String>,
        audit: &dyn AuditTrail,
    ) -> Result<McpServerStatus, String> {
        let previous = self.grants.snapshot().await.len();
        // One write reaches the running transport and the stored configuration
        // alike, because they read the same cell.
        self.grants
            .replace(sanitize_enabled_tools(&enabled_tools))
            .await;
        let grants = self.grants.snapshot().await;
        audit.record(
            AuditEntry::new(
                AuditActor::User,
                audit::MCP_GRANTS_CHANGED_OPERATION,
                AuditOutcome::Succeeded,
            )
            .detail("granted_tool_count", grants.len() as u64)
            .detail("previous_tool_count", previous as u64)
            .detail("mutating_tool_count", mutating_grant_count(&grants) as u64),
        );
        Ok(self.get_status().await)
    }

    /// Start the server, recording that the door was opened and how wide.
    ///
    /// Only a successful start is recorded: a start that failed to bind did
    /// nothing, and a trail of what was done has nothing to say about it. The
    /// bearer token is never recorded, here or anywhere.
    pub async fn start(
        &self,
        host: Option<String>,
        port: Option<u16>,
        enabled_tools: Option<Vec<String>>,
        auth_token: Option<String>,
        audit: Arc<dyn AuditTrail>,
    ) -> Result<McpServerStatus, String> {
        self.stop_internal().await?;

        let host = normalize_host(host)?;
        let port = normalize_port(port);
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

        // An explicit list replaces the grants; omitting it keeps whatever is
        // already in force, including an explicitly empty set. Applied only
        // once the socket is ours, so a failed start changes no permission.
        if let Some(enabled_tools) = enabled_tools.as_deref() {
            self.grants
                .replace(sanitize_enabled_tools(enabled_tools))
                .await;
        }

        let policy = RuntimePolicy::default();
        let shutdown = CancellationToken::new();
        let state = transport::HttpRuntimeState::production(
            self.grants.shared(),
            Arc::clone(&token),
            host.clone(),
            actual_port,
            shutdown.clone(),
            policy,
            Arc::clone(&audit),
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
        *self.config_auth_token.write().await = effective_token;
        let address = host_port(&host, actual_port);
        *self.runtime.write().await = Some(RunningMcpServer {
            host,
            port: actual_port,
            auth_token: token,
            shutdown,
            task_handle,
        });
        let grants = self.grants.snapshot().await;
        audit.record(
            AuditEntry::new(
                AuditActor::User,
                audit::MCP_SERVER_START_OPERATION,
                AuditOutcome::Succeeded,
            )
            .resource(&address)
            .detail("granted_tool_count", grants.len() as u64)
            .detail("mutating_tool_count", mutating_grant_count(&grants) as u64),
        );
        Ok(self.get_status().await)
    }
}

/// Granted tools that can change something, by the registry's effect tier.
fn mutating_grant_count(grants: &PermissionGrantSet) -> usize {
    permissions::permission_registry()
        .iter()
        .filter(|permission| grants.allows(permission))
        .filter(|permission| {
            matches!(
                permission.effect,
                permissions::PermissionEffect::Write | permissions::PermissionEffect::Destructive
            )
        })
        .count()
}

#[cfg(test)]
mod tests {
    use bc_storage::RecordingAuditTrail;

    use super::*;

    fn trail() -> Arc<RecordingAuditTrail> {
        Arc::new(RecordingAuditTrail::default())
    }

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

    /// The handle the AI assistant holds has to report the user's current
    /// choice, not a snapshot taken when the app booted — and stopping the
    /// server must not look like a revocation.
    #[tokio::test]
    async fn the_in_process_grant_handle_tracks_edits_and_survives_stop() {
        let manager = McpServerManager::default();
        let handle = manager.grant_handle();
        assert!(
            handle.snapshot().await.is_empty(),
            "nothing is granted until the user enables something"
        );

        let audit = trail();
        manager
            .set_enabled_tools(vec!["dns_validate_record".to_string()], audit.as_ref())
            .await
            .unwrap();
        assert!(handle
            .snapshot()
            .await
            .allows_id("bc.mcp.v1.dns.validate_record"));

        let port = reserve_local_port();
        manager
            .start(
                None,
                Some(port),
                None,
                Some("test-token".to_string()),
                audit.clone(),
            )
            .await
            .unwrap();
        assert!(handle
            .snapshot()
            .await
            .allows_id("bc.mcp.v1.dns.validate_record"));

        manager.stop(audit.as_ref()).await.unwrap();
        assert!(
            handle
                .snapshot()
                .await
                .allows_id("bc.mcp.v1.dns.validate_record"),
            "stopping the server must not revoke what the user enabled"
        );
    }

    #[tokio::test]
    async fn explicit_empty_grants_survive_start_stop_and_restart() {
        let manager = McpServerManager::default();
        let audit = trail();
        let port = reserve_local_port();
        let started = manager
            .start(
                Some(DEFAULT_MCP_HOST.to_string()),
                Some(port),
                Some(Vec::new()),
                Some("test-token".to_string()),
                audit.clone(),
            )
            .await
            .unwrap();
        assert!(started.enabled_tools.is_empty());

        manager
            .set_enabled_tools(vec!["dns_validate_record".to_string()], audit.as_ref())
            .await
            .unwrap();
        assert!(manager
            .set_enabled_tools(Vec::new(), audit.as_ref())
            .await
            .unwrap()
            .enabled_tools
            .is_empty());
        manager.stop(audit.as_ref()).await.unwrap();

        let restarted = manager
            .start(
                None,
                Some(port),
                None,
                Some("replacement-token".to_string()),
                audit.clone(),
            )
            .await
            .unwrap();
        assert!(restarted.enabled_tools.is_empty());
        manager.stop(audit.as_ref()).await.unwrap();
    }

    /// The control plane is the half of the trail that explains the other
    /// half: these are the events that decide what every later tool call is
    /// allowed to do.
    #[tokio::test]
    async fn the_server_lifecycle_and_permission_edits_are_recorded() {
        let manager = McpServerManager::default();
        let audit = trail();
        let port = reserve_local_port();

        manager
            .set_enabled_tools(
                vec![
                    "dns_validate_record".to_string(),
                    "cf_delete_dns_record".to_string(),
                ],
                audit.as_ref(),
            )
            .await
            .unwrap();
        manager
            .start(
                None,
                Some(port),
                None,
                Some("test-token".to_string()),
                audit.clone(),
            )
            .await
            .unwrap();
        manager.stop(audit.as_ref()).await.unwrap();

        assert_eq!(
            audit.operations(),
            vec![
                "mcp:grants_changed".to_string(),
                "mcp:server_start".to_string(),
                "mcp:server_stop".to_string(),
            ]
        );
        let entries = audit.entries();
        assert_eq!(entries[0]["actor"], serde_json::json!("user"));
        assert_eq!(entries[0]["granted_tool_count"], serde_json::json!(2));
        assert_eq!(
            entries[0]["mutating_tool_count"],
            serde_json::json!(1),
            "one of the two granted tools can change something"
        );
        assert_eq!(
            entries[1]["resource"],
            serde_json::json!(format!("127.0.0.1:{port}")),
            "the start entry names the address that was opened"
        );
        for entry in &entries {
            assert!(
                !entry.to_string().contains("test-token"),
                "the bearer token must never reach the trail: {entry}"
            );
        }
    }

    /// A start that never bound did nothing, so it is not in a record of what
    /// was done — and it must not leave a stop entry either.
    #[tokio::test]
    async fn a_failed_start_records_nothing() {
        let manager = McpServerManager::default();
        let audit = trail();
        let blocker = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = blocker.local_addr().unwrap().port();

        assert!(manager
            .start(
                None,
                Some(taken),
                None,
                Some("test-token".to_string()),
                audit.clone(),
            )
            .await
            .is_err());
        assert!(audit.is_empty(), "recorded: {:?}", audit.operations());

        // And stopping a server that was never running records nothing.
        manager.stop(audit.as_ref()).await.unwrap();
        assert!(audit.is_empty(), "recorded: {:?}", audit.operations());
    }
}
