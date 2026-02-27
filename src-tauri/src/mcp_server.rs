use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;

use crate::cloudflare_api::CloudflareClient;
use crate::commands::DNSRecordInput;
use crate::spf;

const DEFAULT_MCP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_PORT: u16 = 8787;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub name: String,
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub url: String,
    pub enabled_tools: Vec<String>,
    pub tools: Vec<McpToolDescriptor>,
    pub last_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Clone)]
struct HttpRuntimeState {
    enabled_tools: Arc<RwLock<HashSet<String>>>,
}

struct RunningMcpServer {
    host: String,
    port: u16,
    enabled_tools: Arc<RwLock<HashSet<String>>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task_handle: JoinHandle<()>,
}

pub struct McpServerManager {
    runtime: RwLock<Option<RunningMcpServer>>,
    config_host: RwLock<String>,
    config_port: RwLock<u16>,
    config_enabled_tools: RwLock<HashSet<String>>,
    last_error: Arc<RwLock<Option<String>>>,
}

impl Default for McpServerManager {
    fn default() -> Self {
        Self {
            runtime: RwLock::new(None),
            config_host: RwLock::new(DEFAULT_MCP_HOST.to_string()),
            config_port: RwLock::new(DEFAULT_MCP_PORT),
            config_enabled_tools: RwLock::new(default_enabled_tool_set()),
            last_error: Arc::new(RwLock::new(None)),
        }
    }
}

fn available_tool_definitions() -> Vec<McpToolDescriptor> {
    vec![
        ("cf_verify_token", "Verify Cloudflare token", "Validate a Cloudflare API token or key/email pair."),
        ("cf_list_zones", "List zones", "List Cloudflare zones for an account."),
        ("cf_list_dns_records", "List DNS records", "Fetch DNS records for a specific zone."),
        ("cf_create_dns_record", "Create DNS record", "Create a DNS record in a zone."),
        ("cf_update_dns_record", "Update DNS record", "Update an existing DNS record by record ID."),
        ("cf_delete_dns_record", "Delete DNS record", "Delete a DNS record by record ID."),
        ("cf_bulk_create_dns_records", "Bulk create DNS records", "Create many DNS records in one operation."),
        ("cf_export_dns_records", "Export DNS records", "Export DNS records in JSON, CSV, or BIND format."),
        ("cf_purge_cache", "Purge cache", "Purge all or selected files from Cloudflare cache."),
        ("cf_get_zone_setting", "Get zone setting", "Read a single Cloudflare zone setting by ID."),
        ("cf_update_zone_setting", "Update zone setting", "Update a single Cloudflare zone setting by ID."),
        ("cf_get_dnssec", "Get DNSSEC", "Fetch DNSSEC configuration for a zone."),
        ("cf_update_dnssec", "Update DNSSEC", "Update DNSSEC configuration for a zone."),
        ("spf_simulate", "Simulate SPF", "Run SPF evaluation for a domain/IP combination."),
        ("spf_graph", "Build SPF graph", "Build SPF include/redirect graph for a domain."),
    ]
    .into_iter()
    .map(|(name, title, description)| McpToolDescriptor {
        name: name.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        input_schema: json!({ "type": "object" }),
        enabled: true,
    })
    .collect()
}

fn default_enabled_tool_set() -> HashSet<String> {
    available_tool_definitions()
        .into_iter()
        .map(|tool| tool.name)
        .collect()
}

fn sanitize_enabled_tools(list: &[String]) -> HashSet<String> {
    let allowed = default_enabled_tool_set();
    list.iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty() && allowed.contains(name))
        .collect()
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

fn build_status(
    running: bool,
    host: String,
    port: u16,
    enabled_tools: &HashSet<String>,
    last_error: Option<String>,
) -> McpServerStatus {
    let mut enabled = enabled_tools.iter().cloned().collect::<Vec<_>>();
    enabled.sort();
    let tools = available_tool_definitions()
        .into_iter()
        .map(|mut tool| {
            tool.enabled = enabled_tools.contains(&tool.name);
            tool
        })
        .collect::<Vec<_>>();
    McpServerStatus {
        running,
        host: host.clone(),
        port,
        url: format!("http://{}:{}/mcp", host, port),
        enabled_tools: enabled,
        tools,
        last_error,
    }
}

impl McpServerManager {
    pub async fn get_status(&self) -> McpServerStatus {
        let last_error = self.last_error.read().await.clone();
        let runtime_ref = self.runtime.read().await;
        if let Some(runtime) = runtime_ref.as_ref() {
            let enabled = runtime.enabled_tools.read().await.clone();
            return build_status(
                true,
                runtime.host.clone(),
                runtime.port,
                &enabled,
                last_error,
            );
        }
        drop(runtime_ref);
        let host = self.config_host.read().await.clone();
        let port = *self.config_port.read().await;
        let enabled = self.config_enabled_tools.read().await.clone();
        build_status(false, host, port, &enabled, last_error)
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
            let enabled = runtime.enabled_tools.read().await.clone();
            *self.config_host.write().await = runtime.host;
            *self.config_port.write().await = runtime.port;
            *self.config_enabled_tools.write().await = enabled;
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
        *self.config_enabled_tools.write().await = next.clone();
        let runtime_enabled = {
            let runtime = self.runtime.read().await;
            runtime
                .as_ref()
                .map(|running| Arc::clone(&running.enabled_tools))
        };
        if let Some(enabled_ref) = runtime_enabled {
            *enabled_ref.write().await = next;
        }
        Ok(self.get_status().await)
    }

    pub async fn start(
        &self,
        host: Option<String>,
        port: Option<u16>,
        enabled_tools: Option<Vec<String>>,
    ) -> Result<McpServerStatus, String> {
        self.stop_internal().await?;

        let normalized_host = normalize_host(host);
        let normalized_port = normalize_port(port);
        let desired_enabled = if let Some(list) = enabled_tools {
            sanitize_enabled_tools(&list)
        } else {
            self.config_enabled_tools.read().await.clone()
        };
        let enabled_ref = Arc::new(RwLock::new(desired_enabled.clone()));

        let bind_addr = format!("{}:{}", normalized_host, normalized_port);
        let listener = TcpListener::bind(&bind_addr)
            .await
            .map_err(|e| format!("Failed to bind MCP server on {}: {}", bind_addr, e))?;
        let actual_addr = listener
            .local_addr()
            .map_err(|e| format!("Failed to read MCP server address: {}", e))?;
        let actual_port = actual_addr.port();

        let state = HttpRuntimeState {
            enabled_tools: Arc::clone(&enabled_ref),
        };
        let app = Router::new()
            .route("/mcp", post(handle_mcp_rpc))
            .route("/health", get(handle_health))
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
        *self.config_enabled_tools.write().await = desired_enabled;
        *self.runtime.write().await = Some(RunningMcpServer {
            host: normalized_host,
            port: actual_port,
            enabled_tools: enabled_ref,
            shutdown_tx: Some(shutdown_tx),
            task_handle,
        });

        Ok(self.get_status().await)
    }
}

fn get_required_string(args: &Value, key: &str) -> Result<String, String> {
    let value = args
        .get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing required argument '{}'", key))?;
    Ok(value.to_string())
}

fn get_optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn success_response(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn error_response(id: Option<Value>, code: i64, message: String) -> Value {
    let response_id = id.unwrap_or(Value::Null);
    json!({
        "jsonrpc": "2.0",
        "id": response_id,
        "error": {
            "code": code,
            "message": message
        }
    })
}

async fn handle_health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn execute_tool(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "cf_verify_token" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let ok = client.verify_token().await.map_err(|e| e.to_string())?;
            Ok(json!({ "valid": ok }))
        }
        "cf_list_zones" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let zones = client.get_zones().await.map_err(|e| e.to_string())?;
            serde_json::to_value(zones).map_err(|e| e.to_string())
        }
        "cf_list_dns_records" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let page = args.get("page").and_then(|v| v.as_u64()).map(|v| v as u32);
            let per_page = args
                .get("per_page")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let records = client
                .get_dns_records(&zone_id, page, per_page)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(records).map_err(|e| e.to_string())
        }
        "cf_create_dns_record" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let record_value = args
                .get("record")
                .cloned()
                .ok_or_else(|| "Missing required argument 'record'".to_string())?;
            let record: DNSRecordInput = serde_json::from_value(record_value)
                .map_err(|e| format!("Invalid record payload: {}", e))?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let created = client
                .create_dns_record(&zone_id, record)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(created).map_err(|e| e.to_string())
        }
        "cf_update_dns_record" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let record_id = get_required_string(args, "record_id")?;
            let record_value = args
                .get("record")
                .cloned()
                .ok_or_else(|| "Missing required argument 'record'".to_string())?;
            let record: DNSRecordInput = serde_json::from_value(record_value)
                .map_err(|e| format!("Invalid record payload: {}", e))?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let updated = client
                .update_dns_record(&zone_id, &record_id, record)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(updated).map_err(|e| e.to_string())
        }
        "cf_delete_dns_record" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let record_id = get_required_string(args, "record_id")?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            client
                .delete_dns_record(&zone_id, &record_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": true, "record_id": record_id }))
        }
        "cf_bulk_create_dns_records" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let dryrun = args
                .get("dryrun")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let records_value = args
                .get("records")
                .cloned()
                .ok_or_else(|| "Missing required argument 'records'".to_string())?;
            let records: Vec<DNSRecordInput> = serde_json::from_value(records_value)
                .map_err(|e| format!("Invalid records payload: {}", e))?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let result = client
                .create_bulk_dns_records(&zone_id, records, dryrun)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }
        "cf_export_dns_records" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let format = get_optional_string(args, "format").unwrap_or_else(|| "json".to_string());
            let page = args.get("page").and_then(|v| v.as_u64()).map(|v| v as u32);
            let per_page = args
                .get("per_page")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let data = client
                .export_dns_records(&zone_id, &format, page, per_page)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "format": format, "data": data }))
        }
        "cf_purge_cache" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let purge_everything = args
                .get("purge_everything")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let files = args.get("files").and_then(|v| {
                v.as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
            });
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let result = client
                .purge_cache(&zone_id, purge_everything, files)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }
        "cf_get_zone_setting" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let setting_id = get_required_string(args, "setting_id")?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let result = client
                .get_zone_setting(&zone_id, &setting_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }
        "cf_update_zone_setting" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let setting_id = get_required_string(args, "setting_id")?;
            let value = args
                .get("value")
                .cloned()
                .ok_or_else(|| "Missing required argument 'value'".to_string())?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let result = client
                .update_zone_setting(&zone_id, &setting_id, value)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }
        "cf_get_dnssec" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let result = client.get_dnssec(&zone_id).await.map_err(|e| e.to_string())?;
            Ok(result)
        }
        "cf_update_dnssec" => {
            let api_key = get_required_string(args, "api_key")?;
            let email = get_optional_string(args, "email");
            let zone_id = get_required_string(args, "zone_id")?;
            let payload = args
                .get("payload")
                .cloned()
                .ok_or_else(|| "Missing required argument 'payload'".to_string())?;
            let client = CloudflareClient::new(&api_key, email.as_deref());
            let result = client
                .update_dnssec(&zone_id, payload)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }
        "spf_simulate" => {
            let domain = get_required_string(args, "domain")?;
            let ip = get_required_string(args, "ip")?;
            let simulation = spf::simulate_spf(&domain, &ip).await?;
            serde_json::to_value(simulation).map_err(|e| e.to_string())
        }
        "spf_graph" => {
            let domain = get_required_string(args, "domain")?;
            let graph = spf::build_spf_graph(&domain).await?;
            serde_json::to_value(graph).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown tool '{}'", name)),
    }
}

async fn handle_mcp_rpc(
    AxumState(state): AxumState<HttpRuntimeState>,
    Json(payload): Json<Value>,
) -> Response {
    let request = match serde_json::from_value::<JsonRpcRequest>(payload) {
        Ok(req) => req,
        Err(err) => {
            let body = Json(error_response(
                None,
                -32700,
                format!("Invalid JSON-RPC payload: {}", err),
            ));
            return (StatusCode::BAD_REQUEST, body).into_response();
        }
    };

    let id = request.id.clone();
    let params = request.params.unwrap_or_else(|| json!({}));
    let result = match request.method.as_str() {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "better-cloudflare-mcp",
                "version": env!("CARGO_PKG_VERSION")
            }
        })),
        "notifications/initialized" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => {
            let enabled = state.enabled_tools.read().await.clone();
            let tools = available_tool_definitions()
                .into_iter()
                .filter(|tool| enabled.contains(&tool.name))
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "title": tool.title,
                        "description": tool.description,
                        "inputSchema": tool.input_schema
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let tool_name = params
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "Missing tools/call param 'name'".to_string());

            match tool_name {
                Ok(name) => {
                    let enabled = state.enabled_tools.read().await;
                    if !enabled.contains(&name) {
                        Ok(json!({
                            "content": [{ "type": "text", "text": format!("Tool '{}' is disabled.", name) }],
                            "isError": true
                        }))
                    } else {
                        drop(enabled);
                        let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                        match execute_tool(&name, &args).await {
                            Ok(value) => Ok(json!({
                                "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string()) }],
                                "structuredContent": value
                            })),
                            Err(err) => Ok(json!({
                                "content": [{ "type": "text", "text": err }],
                                "isError": true
                            })),
                        }
                    }
                }
                Err(err) => Err(err),
            }
        }
        _ => Err(format!("Method '{}' not found", request.method)),
    };

    if id.is_none() {
        return StatusCode::NO_CONTENT.into_response();
    }
    let response = match result {
        Ok(result) => success_response(id.unwrap_or(Value::Null), result),
        Err(err) => error_response(id, -32601, err),
    };
    (StatusCode::OK, Json(response)).into_response()
}

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
) -> Result<McpServerStatus, String> {
    manager.start(host, port, enabled_tools).await
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
