//! Model Context Protocol (MCP) JSON-RPC server — 2024-11-05 specification.
//!
//! Provides a full MCP server over HTTP with:
//! - **Tools** (50+): Cloudflare API, DNS utilities, SPF, domain audit
//! - **Resources** (8): DNS record types, TTL presets, SPF syntax, zone settings, etc.
//! - **Prompts** (8): DNS troubleshoot, SPF debug, security audit, migration, etc.
//! - **Protocol**: JSON-RPC 2.0 with capability negotiation
//!
//! The server manages its own lifecycle (start/stop), tool enable/disable,
//! bearer-token auth, and graceful shutdown.

mod dns_mutation_validation;

pub mod permissions;
pub mod prompts;
pub mod protocol;
pub mod resources;
pub mod schemas;
pub mod tools;

use std::sync::Arc;

use axum::extract::State as AxumState;
use axum::http::uri::Authority;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;

use permissions::PermissionGrantSet;
use protocol::{
    error_response, error_response_with_data, initialize_response, success_response, tool_disabled,
    tool_error, tool_success, JsonRpcRequest, RpcErrorCode,
};

const DEFAULT_MCP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_PORT: u16 = 8787;

// ─── Re-exports ────────────────────────────────────────────────────────────

pub use prompts::{McpPrompt, PromptArgument, PromptMessage};
pub use resources::{McpResource, McpResourceTemplate};
pub use tools::McpToolDescriptor;

// ─── Public types ──────────────────────────────────────────────────────────

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
    /// Returned once on start so the frontend can pass it to MCP clients.
    pub auth_token: Option<String>,
}

// ─── Internal types ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct HttpRuntimeState {
    grants: Arc<RwLock<PermissionGrantSet>>,
    auth_token: Arc<RwLock<Option<String>>>,
    bind_host: String,
    bind_port: u16,
}

struct RunningMcpServer {
    host: String,
    port: u16,
    grants: Arc<RwLock<PermissionGrantSet>>,
    #[allow(dead_code)]
    auth_token: Arc<RwLock<Option<String>>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task_handle: JoinHandle<()>,
}

// ─── McpServerManager ──────────────────────────────────────────────────────

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

// ─── Tool / Config Helpers (delegate to tools module) ──────────────────────

/// All tool definitions with full schemas.
pub fn available_tool_definitions() -> Vec<McpToolDescriptor> {
    tools::available_tool_definitions()
}

pub fn default_enabled_tool_set() -> PermissionGrantSet {
    PermissionGrantSet::defaults()
}

pub fn sanitize_enabled_tools(list: &[String]) -> PermissionGrantSet {
    PermissionGrantSet::from_requested(list)
}

fn normalize_host(host: Option<String>) -> String {
    let next = host.unwrap_or_else(|| DEFAULT_MCP_HOST.to_string());
    let trimmed = next.trim();
    if trimmed.is_empty() {
        DEFAULT_MCP_HOST.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_port(port: Option<u16>) -> u16 {
    let next = port.unwrap_or(DEFAULT_MCP_PORT);
    if next == 0 {
        DEFAULT_MCP_PORT
    } else {
        next
    }
}

/// Generate a cryptographically random 64-character hex bearer token.
fn generate_auth_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn effective_auth_token(auth_token: Option<String>) -> String {
    auth_token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
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
    let mut enabled = permissions::permission_registry()
        .iter()
        .filter(|permission| grants.allows(permission))
        .map(|permission| permission.invocation_name.to_string())
        .collect::<Vec<_>>();
    enabled.sort();
    let all_tools = tools::available_tool_definitions();
    let tool_count = all_tools.len();
    let tools_list = all_tools
        .into_iter()
        .map(|mut tool| {
            tool.enabled = grants.allows_id(&tool.permission_id);
            tool
        })
        .collect::<Vec<_>>();
    McpServerStatus {
        running,
        host: host.clone(),
        port,
        url: format!("http://{}:{}/mcp", host, port),
        enabled_tools: enabled,
        tool_count,
        resource_count: resources::list_resources().len(),
        prompt_count: prompts::list_prompts().len(),
        tools: tools_list,
        last_error,
        auth_token,
    }
}

impl McpServerManager {
    pub async fn get_status(&self) -> McpServerStatus {
        let last_error = self.last_error.read().await.clone();
        let runtime_ref = self.runtime.read().await;
        if let Some(runtime) = runtime_ref.as_ref() {
            let grants = runtime.grants.read().await.clone();
            let token = runtime.auth_token.read().await.clone();
            return build_status(
                true,
                runtime.host.clone(),
                runtime.port,
                &grants,
                last_error,
                token,
            );
        }
        drop(runtime_ref);
        let host = self.config_host.read().await.clone();
        let port = *self.config_port.read().await;
        let grants = self.config_grants.read().await.clone();
        let token = self.config_auth_token.read().await.clone();
        build_status(false, host, port, &grants, last_error, token)
    }

    async fn stop_internal(&self) -> Result<(), String> {
        let runtime = { self.runtime.write().await.take() };
        if let Some(mut runtime) = runtime {
            if let Some(tx) = runtime.shutdown_tx.take() {
                let _ = tx.send(());
            }
            if let Err(err) = runtime.task_handle.await {
                *self.last_error.write().await = Some(err.to_string());
            }
            let grants = runtime.grants.read().await.clone();
            *self.config_host.write().await = runtime.host;
            *self.config_port.write().await = runtime.port;
            *self.config_grants.write().await = grants;
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
        let runtime_grants = {
            let runtime = self.runtime.read().await;
            runtime.as_ref().map(|running| Arc::clone(&running.grants))
        };
        if let Some(grants_ref) = runtime_grants {
            *grants_ref.write().await = next;
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

        let normalized_host = normalize_host(host);
        let normalized_port = normalize_port(port);
        let desired_enabled = if let Some(list) = enabled_tools {
            sanitize_enabled_tools(&list)
        } else {
            self.config_grants.read().await.clone()
        };
        let grants_ref = Arc::new(RwLock::new(desired_enabled.clone()));
        // Missing or blank credentials are never valid expected tokens.
        let effective_token = Some(effective_auth_token(auth_token));
        let token_ref = Arc::new(RwLock::new(effective_token.clone()));

        let bind_addr = format!("{}:{}", normalized_host, normalized_port);
        let listener = TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("Failed to bind MCP server on {}: {}", bind_addr, e))?;
        let actual_addr = listener
            .local_addr()
            .map_err(|e| format!("Failed to read MCP server address: {}", e))?;
        let actual_port = actual_addr.port();

        let state = HttpRuntimeState {
            grants: Arc::clone(&grants_ref),
            auth_token: Arc::clone(&token_ref),
            bind_host: normalized_host.clone(),
            bind_port: actual_port,
        };
        let app = Router::new()
            .route("/mcp", post(handle_mcp_rpc))
            .route("/health", get(handle_health))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                bearer_auth_middleware,
            ))
            .layer(middleware::from_fn_with_state(
                state.clone(),
                origin_validation_middleware,
            ))
            .with_state(state);

        *self.last_error.write().await = None;
        let last_error_ref = Arc::clone(&self.last_error);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let task_handle = tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            if let Err(err) = server.await {
                *last_error_ref.write().await = Some(err.to_string());
            }
        });

        *self.config_host.write().await = normalized_host.clone();
        *self.config_port.write().await = actual_port;
        *self.config_grants.write().await = desired_enabled;
        *self.config_auth_token.write().await = effective_token;
        *self.runtime.write().await = Some(RunningMcpServer {
            host: normalized_host,
            port: actual_port,
            grants: grants_ref,
            auth_token: token_ref,
            shutdown_tx: Some(shutdown_tx),
            task_handle,
        });

        Ok(self.get_status().await)
    }
}

// ─── Auth middleware ────────────────────────────────────────────────────────

async fn bearer_auth_middleware(
    AxumState(state): AxumState<HttpRuntimeState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    // RFC 8707 resource indicators do not apply here: this is a custom,
    // server-local bearer token and not an OAuth access-token flow.
    let token = state.auth_token.read().await;
    if let Some(expected) = token.as_deref() {
        if expected.is_empty() || bearer_token(request.headers()) != Some(expected) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(error_response(
                    None,
                    RpcErrorCode::Unauthorized.code(),
                    "Unauthorized: invalid or missing bearer token".to_string(),
                )),
            )
                .into_response();
        }
    }
    next.run(request).await
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all("authorization").iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let value = value.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Bearer")
        || token.is_empty()
        || token.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some(token)
}

// ─── HTTP handlers ─────────────────────────────────────────────────────────

fn normalize_origin_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
}

fn origin_host_allowed(origin_host: &str, bind_host: &str) -> bool {
    let origin_host = normalize_origin_host(origin_host);
    let bind_host = normalize_origin_host(bind_host);
    if bind_host == "0.0.0.0" || bind_host == "::" {
        return origin_host.eq_ignore_ascii_case("localhost")
            || origin_host == "127.0.0.1"
            || origin_host == "::1";
    }
    origin_host.eq_ignore_ascii_case(bind_host)
}

fn validate_origin(
    headers: &HeaderMap,
    bind_host: &str,
    bind_port: u16,
) -> Result<(), &'static str> {
    let mut origins = headers.get_all("origin").iter();
    let Some(origin) = origins.next() else {
        // Deliberate native/non-browser path.
        return Ok(());
    };
    if origins.next().is_some() {
        return Err("multiple Origin headers are not allowed");
    }
    let origin = origin
        .to_str()
        .map_err(|_| "Origin must contain valid ASCII header text")?;
    if origin == "null" {
        return Err("opaque Origin values are not allowed");
    }

    let (scheme, authority_text) = origin
        .split_once("://")
        .ok_or("Origin must be an absolute http or https origin")?;
    if scheme != "http" && scheme != "https" {
        return Err("Origin scheme must be http or https");
    }
    if scheme != "http" {
        return Err("Origin scheme does not match this HTTP MCP server");
    }
    if authority_text.is_empty()
        || authority_text.contains(['/', '?', '#'])
        || authority_text.contains('@')
    {
        return Err("Origin must not contain credentials, a path, query, or fragment");
    }

    let authority: Authority = authority_text
        .parse()
        .map_err(|_| "Origin authority is malformed")?;
    if !origin_host_allowed(authority.host(), bind_host) {
        return Err("Origin host does not match the MCP bind host policy");
    }
    if authority.port().is_some() && authority.port_u16().is_none() {
        return Err("Origin port is outside the valid range");
    }
    let effective_port = authority.port_u16().unwrap_or(80);
    if effective_port != bind_port {
        return Err("Origin port does not match the MCP bind port");
    }
    Ok(())
}

fn origin_rejection(reason: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(error_response(
            None,
            RpcErrorCode::Unauthorized.code(),
            format!("Forbidden Origin: {reason}"),
        )),
    )
        .into_response()
}

async fn origin_validation_middleware(
    AxumState(state): AxumState<HttpRuntimeState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if let Err(reason) = validate_origin(request.headers(), &state.bind_host, state.bind_port) {
        return origin_rejection(reason);
    }
    next.run(request).await
}

async fn handle_health() -> impl IntoResponse {
    // Minimal health check — do not leak server metadata to unauthenticated callers
    Json(json!({ "status": "ok" }))
}

/// Full MCP JSON-RPC 2.0 handler with all spec methods.
async fn handle_mcp_rpc(
    AxumState(state): AxumState<HttpRuntimeState>,
    Json(payload): Json<Value>,
) -> Response {
    // ── Parse incoming request ──────────────────────────────────────────
    let request = match serde_json::from_value::<JsonRpcRequest>(payload) {
        Ok(req) => req,
        Err(_err) => {
            let body = Json(error_response(
                None,
                RpcErrorCode::ParseError.code(),
                // Redact internal parse error details to avoid information leakage
                "Invalid JSON-RPC payload".to_string(),
            ));
            return (StatusCode::BAD_REQUEST, body).into_response();
        }
    };

    if !matches!(
        request.jsonrpc.as_ref(),
        Some(Value::String(version)) if version == "2.0"
    ) {
        let body = Json(error_response(
            request.id.clone(),
            RpcErrorCode::InvalidRequest.code(),
            "Invalid JSON-RPC version: expected exactly '2.0'".to_string(),
        ));
        return (StatusCode::BAD_REQUEST, body).into_response();
    }

    let id = request.id.clone();
    let params = request.params.unwrap_or_else(|| json!({}));

    let result: Result<Value, Value> = match request.method.as_str() {
        // ── Lifecycle ───────────────────────────────────────────────────
        "initialize" => Ok(initialize_response()),
        "notifications/initialized" | "initialized" => {
            // No-op notification acknowledgment
            if id.is_none() {
                return StatusCode::NO_CONTENT.into_response();
            }
            Ok(json!({}))
        }
        "ping" => Ok(json!({})),

        // ── Tools ───────────────────────────────────────────────────────
        "tools/list" => {
            let grants = state.grants.read().await.clone();
            let cursor = params.get("cursor").and_then(|v| v.as_str());
            let all_tools = tools::available_tool_definitions();
            let filtered: Vec<Value> = all_tools
                .into_iter()
                .filter(|tool| grants.allows_id(&tool.permission_id))
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "title": tool.title,
                        "description": tool.description,
                        "inputSchema": tool.input_schema
                    })
                })
                .collect();
            // No pagination needed (small catalogue) — nextCursor is null
            let _ = cursor;
            Ok(json!({ "tools": filtered }))
        }

        "tools/call" => {
            let tool_name = params
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|v| !v.is_empty());

            match tool_name {
                Some(name) => {
                    let grants = state.grants.read().await.clone();
                    let args = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    match tools::execute_tool_with_grants(&grants, &name, &args).await {
                        Ok(value) => Ok(tool_success(&value)),
                        Err(err) => {
                            if permissions::permission_for_invocation(&name)
                                .is_some_and(|permission| !grants.allows(permission))
                            {
                                Ok(tool_disabled(&name))
                            } else {
                                Ok(tool_error(&err))
                            }
                        }
                    }
                }
                None => Err(error_response(
                    id.clone(),
                    RpcErrorCode::InvalidParams.code(),
                    "Missing tools/call param 'name'".to_string(),
                )),
            }
        }

        // ── Resources ───────────────────────────────────────────────────
        "resources/list" => {
            let res_list: Vec<Value> = resources::list_resources()
                .into_iter()
                .map(|r| {
                    json!({
                        "uri": r.uri,
                        "name": r.name,
                        "description": r.description,
                        "mimeType": r.mime_type
                    })
                })
                .collect();
            Ok(json!({ "resources": res_list }))
        }

        "resources/templates/list" => {
            let templates: Vec<Value> = resources::list_resource_templates()
                .into_iter()
                .map(|t| {
                    json!({
                        "uriTemplate": t.uri_template,
                        "name": t.name,
                        "description": t.description,
                        "mimeType": t.mime_type
                    })
                })
                .collect();
            Ok(json!({ "resourceTemplates": templates }))
        }

        "resources/read" => {
            let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
            match resources::read_resource(uri) {
                Ok(content) => {
                    let text = serde_json::to_string_pretty(&content).unwrap_or_default();
                    Ok(json!({
                        "contents": [{
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": text
                        }]
                    }))
                }
                Err(err) => Err(error_response_with_data(
                    id.clone(),
                    RpcErrorCode::ResourceNotFound.code(),
                    err,
                    json!({ "uri": uri }),
                )),
            }
        }

        // ── Prompts ─────────────────────────────────────────────────────
        "prompts/list" => {
            let prompt_list: Vec<Value> = prompts::list_prompts()
                .into_iter()
                .map(|p| {
                    let mut obj = json!({
                        "name": p.name,
                        "description": p.description
                    });
                    if let Some(args) = p.arguments {
                        let args_json: Vec<Value> = args
                            .into_iter()
                            .map(|a| {
                                json!({
                                    "name": a.name,
                                    "description": a.description,
                                    "required": a.required
                                })
                            })
                            .collect();
                        obj["arguments"] = json!(args_json);
                    }
                    obj
                })
                .collect();
            Ok(json!({ "prompts": prompt_list }))
        }

        "prompts/get" => {
            let prompt_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match prompts::get_prompt(prompt_name, &args) {
                Ok(messages) => {
                    let msgs: Vec<Value> = messages
                        .into_iter()
                        .map(|m| {
                            json!({
                                "role": m.role,
                                "content": {
                                    "type": m.content.content_type,
                                    "text": m.content.text
                                }
                            })
                        })
                        .collect();
                    Ok(json!({
                        "description": format!("Prompt: {}", prompt_name),
                        "messages": msgs
                    }))
                }
                Err(err) => Err(error_response_with_data(
                    id.clone(),
                    RpcErrorCode::PromptNotFound.code(),
                    err,
                    json!({ "name": prompt_name }),
                )),
            }
        }

        // ── Logging ─────────────────────────────────────────────────────
        "logging/setLevel" => {
            // Acknowledge but no-op for now
            Ok(json!({}))
        }

        // ── Unknown method ──────────────────────────────────────────────
        _ => Err(error_response(
            id.clone(),
            RpcErrorCode::MethodNotFound.code(),
            format!("Method '{}' not found", request.method),
        )),
    };

    // ── Build response ──────────────────────────────────────────────────
    // Notifications (no id) get NO_CONTENT
    if id.is_none() {
        return StatusCode::NO_CONTENT.into_response();
    }

    let response_body = match result {
        Ok(result_val) => success_response(id.unwrap_or(Value::Null), result_val),
        Err(err_val) => err_val, // already a full JSON-RPC error response
    };
    (StatusCode::OK, Json(response_body)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn headers_with_origin(origin: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static(origin));
        headers
    }

    #[test]
    fn absent_and_exact_local_http_origins_are_allowed() {
        assert!(validate_origin(&HeaderMap::new(), "127.0.0.1", 8787).is_ok());
        assert!(validate_origin(
            &headers_with_origin("http://127.0.0.1:8787"),
            "127.0.0.1",
            8787
        )
        .is_ok());
        assert!(validate_origin(&headers_with_origin("http://localhost"), "localhost", 80).is_ok());
        assert!(validate_origin(&headers_with_origin("http://[::1]:8787"), "::1", 8787).is_ok());
    }

    #[test]
    fn wildcard_bind_allows_only_loopback_origins() {
        assert!(validate_origin(
            &headers_with_origin("http://localhost:8787"),
            "0.0.0.0",
            8787
        )
        .is_ok());
        assert!(validate_origin(
            &headers_with_origin("http://192.0.2.10:8787"),
            "0.0.0.0",
            8787
        )
        .is_err());
    }

    #[test]
    fn unsafe_origin_matrix_is_rejected() {
        let rejected = [
            "null",
            "not-an-origin",
            "file://localhost",
            "https://127.0.0.1:8787",
            "http://user:password@127.0.0.1:8787",
            "http://127.0.0.1:8787/",
            "http://127.0.0.1:8787/path",
            "http://127.0.0.1:8787?query",
            "http://127.0.0.1:8787#fragment",
            "http://localhost:8787",
            "http://127.0.0.1:9999",
        ];
        for origin in rejected {
            let headers = headers_with_origin(origin);
            assert!(
                validate_origin(&headers, "127.0.0.1", 8787).is_err(),
                "origin should be rejected: {origin}"
            );
        }

        let mut repeated = headers_with_origin("http://127.0.0.1:8787");
        repeated.append("origin", HeaderValue::from_static("http://127.0.0.1:8787"));
        assert!(validate_origin(&repeated, "127.0.0.1", 8787).is_err());

        let mut non_ascii = HeaderMap::new();
        non_ascii.insert(
            "origin",
            HeaderValue::from_bytes(b"http://127.0.0.1:8787\xff").unwrap(),
        );
        assert!(validate_origin(&non_ascii, "127.0.0.1", 8787).is_err());
    }

    fn test_runtime_state() -> HttpRuntimeState {
        HttpRuntimeState {
            grants: Arc::new(RwLock::new(PermissionGrantSet::all())),
            auth_token: Arc::new(RwLock::new(Some("test-token".to_string()))),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 8787,
        }
    }

    #[tokio::test]
    async fn jsonrpc_version_must_be_exactly_2_0_before_dispatch() {
        for version in [
            None,
            Some(Value::Null),
            Some(json!(2.0)),
            Some(json!("2")),
            Some(json!("2.0 ")),
            Some(json!("JSON-RPC 2.0")),
        ] {
            let mut payload = json!({
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "cf_bulk_delete_dns_records",
                    "arguments": {"confirmHighRisk": true}
                }
            });
            if let Some(version) = version {
                payload["jsonrpc"] = version;
            }
            let response = handle_mcp_rpc(AxumState(test_runtime_state()), Json(payload)).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        let response = handle_mcp_rpc(
            AxumState(test_runtime_state()),
            Json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn blank_tokens_are_replaced_with_fresh_random_credentials() {
        let first = effective_auth_token(None);
        let second = effective_auth_token(Some(" \t\r\n ".to_string()));
        let malformed = effective_auth_token(Some("not a bearer token".to_string()));
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_eq!(malformed.len(), 64);
        assert_ne!(first, second);
        assert_ne!(second, malformed);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert!(second
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert_eq!(
            effective_auth_token(Some("  configured-token  ".to_string())),
            "configured-token"
        );
    }

    #[test]
    fn missing_or_malformed_authorization_never_yields_a_token() {
        assert!(bearer_token(&HeaderMap::new()).is_none());

        for value in [
            "",
            "Bearer",
            "Bearer ",
            "Bearer  token",
            "Bearer token ",
            "Bearer token extra",
            "Basic token",
            "token",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", HeaderValue::from_str(value).unwrap());
            assert!(bearer_token(&headers).is_none(), "{value}");
        }

        let mut valid = HeaderMap::new();
        valid.insert(
            "authorization",
            HeaderValue::from_static("Bearer configured-token"),
        );
        assert_eq!(bearer_token(&valid), Some("configured-token"));

        let mut case_insensitive_scheme = HeaderMap::new();
        case_insensitive_scheme.insert(
            "authorization",
            HeaderValue::from_static("bearer configured-token"),
        );
        assert_eq!(
            bearer_token(&case_insensitive_scheme),
            Some("configured-token")
        );

        valid.append(
            "authorization",
            HeaderValue::from_static("Bearer configured-token"),
        );
        assert!(bearer_token(&valid).is_none());
    }

    fn reserve_local_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    async fn raw_mcp_request(
        port: u16,
        authorization: Option<&str>,
        extra_headers: &[(&str, &str)],
        body: &str,
    ) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let mut headers = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(authorization) = authorization {
            headers.push_str(&format!("Authorization: {authorization}\r\n"));
        }
        for (name, value) in extra_headers {
            headers.push_str(&format!("{name}: {value}\r\n"));
        }
        let request = format!("{headers}\r\n{body}");
        stream.write_all(request.as_bytes()).await.unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    fn assert_http_status(response: &str, status: u16) {
        let status_line = response.lines().next().unwrap_or("");
        assert!(
            status_line.contains(&format!(" {status} ")),
            "unexpected response: {status_line}"
        );
    }

    #[tokio::test]
    async fn origin_middleware_runs_before_json_extraction() {
        let manager = McpServerManager::default();
        let port = reserve_local_port();
        let status = manager
            .start(
                Some("127.0.0.1".to_string()),
                Some(port),
                Some(Vec::new()),
                Some("test-token".to_string()),
            )
            .await
            .unwrap();
        assert_eq!(status.port, port);

        let foreign = raw_mcp_request(
            port,
            Some("Bearer test-token"),
            &[("Origin", "http://evil.example:8787")],
            "not-json",
        )
        .await;
        assert_http_status(&foreign, 403);

        let repeated = raw_mcp_request(
            port,
            Some("Bearer test-token"),
            &[
                ("Origin", &format!("http://127.0.0.1:{port}")),
                ("Origin", &format!("http://127.0.0.1:{port}")),
            ],
            "not-json",
        )
        .await;
        assert_http_status(&repeated, 403);

        let exact_origin = format!("http://127.0.0.1:{port}");
        let valid_origin_bad_body = raw_mcp_request(
            port,
            Some("Bearer test-token"),
            &[("Origin", &exact_origin)],
            "not-json",
        )
        .await;
        assert_http_status(&valid_origin_bad_body, 400);

        let native_bad_body =
            raw_mcp_request(port, Some("Bearer test-token"), &[], "not-json").await;
        assert_http_status(&native_bad_body, 400);

        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn malformed_authorization_is_rejected_by_the_running_server() {
        let manager = McpServerManager::default();
        let port = reserve_local_port();
        manager
            .start(
                Some("127.0.0.1".to_string()),
                Some(port),
                Some(Vec::new()),
                Some("test-token".to_string()),
            )
            .await
            .unwrap();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        for authorization in [
            None,
            Some("Bearer"),
            Some("Bearer "),
            Some("Bearer test-token extra"),
            Some("Basic test-token"),
        ] {
            let response = raw_mcp_request(port, authorization, &[], body).await;
            assert_http_status(&response, 401);
        }
        let authorized = raw_mcp_request(port, Some("Bearer test-token"), &[], body).await;
        assert_http_status(&authorized, 200);
        manager.stop().await.unwrap();
    }

    #[tokio::test]
    async fn explicit_empty_grants_survive_start_set_stop_and_restart() {
        let manager = McpServerManager::default();
        assert!(manager.get_status().await.enabled_tools.is_empty());
        let port = reserve_local_port();

        let started = manager
            .start(
                Some("127.0.0.1".to_string()),
                Some(port),
                Some(Vec::new()),
                Some("test-token".to_string()),
            )
            .await
            .unwrap();
        assert!(started.enabled_tools.is_empty());

        let enabled = manager
            .set_enabled_tools(vec!["dns_validate_record".to_string()])
            .await
            .unwrap();
        assert_eq!(enabled.enabled_tools, ["dns_validate_record"]);
        let emptied = manager.set_enabled_tools(Vec::new()).await.unwrap();
        assert!(emptied.enabled_tools.is_empty());

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

        let explicitly_restarted = manager
            .start(
                None,
                Some(port),
                Some(Vec::new()),
                Some("third-token".to_string()),
            )
            .await
            .unwrap();
        assert!(explicitly_restarted.enabled_tools.is_empty());
        manager.stop().await.unwrap();
        assert!(manager.get_status().await.enabled_tools.is_empty());
    }

    #[tokio::test]
    async fn handler_rejects_wrong_jsonrpc_before_rpc_dispatch() {
        let state = HttpRuntimeState {
            grants: Arc::new(RwLock::new(PermissionGrantSet::all())),
            auth_token: Arc::new(RwLock::new(Some("not-used-here".to_string()))),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 8787,
        };
        let payload = json!({
            "jsonrpc": "1.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "cf_bulk_delete_dns_records",
                "arguments": {}
            }
        });
        let response = handle_mcp_rpc(AxumState(state), Json(payload)).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
