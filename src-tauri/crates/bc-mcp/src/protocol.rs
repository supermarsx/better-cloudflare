//! MCP 2024-11-05 protocol types and JSON-RPC handling.
//!
//! Implements the core JSON-RPC 2.0 message envelope and MCP-specific
//! method routing, capability negotiation, and error codes.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ─── MCP Protocol Version ──────────────────────────────────────────────────

pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME: &str = "better-cloudflare-mcp";

// ─── JSON-RPC 2.0 ─────────────────────────────────────────────────────────

/// Standard JSON-RPC error codes plus MCP-specific ones.
#[derive(Debug, Clone, Copy)]
pub enum RpcErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    /// MCP: tool execution failed
    ToolExecutionError = -32000,
    /// MCP: resource not found
    ResourceNotFound = -32001,
    /// MCP: prompt not found
    PromptNotFound = -32002,
    /// MCP: unauthorized
    Unauthorized = -32003,
}

impl RpcErrorCode {
    pub fn code(self) -> i64 {
        self as i64
    }
}

/// Inbound JSON-RPC 2.0 request.
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

/// Build a successful JSON-RPC 2.0 response.
pub fn success_response(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

/// Build an error JSON-RPC 2.0 response.
pub fn error_response(id: Option<Value>, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message
        }
    })
}

/// Build an error with optional data field.
pub fn error_response_with_data(id: Option<Value>, code: i64, message: String, data: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message,
            "data": data
        }
    })
}

// ─── MCP Capability Negotiation ────────────────────────────────────────────

/// Server capabilities advertised during `initialize`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub tools: ToolsCapability,
    pub resources: ResourcesCapability,
    pub prompts: PromptsCapability,
    pub logging: LoggingCapability,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolsCapability {
    /// Whether the server supports tools/list_changed notifications.
    #[serde(rename = "listChanged")]
    pub list_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourcesCapability {
    /// Whether the server supports resource subscriptions.
    pub subscribe: bool,
    /// Whether the server supports resources/list_changed notifications.
    #[serde(rename = "listChanged")]
    pub list_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptsCapability {
    /// Whether the server supports prompts/list_changed notifications.
    #[serde(rename = "listChanged")]
    pub list_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoggingCapability {}

impl Default for ServerCapabilities {
    fn default() -> Self {
        Self {
            tools: ToolsCapability { list_changed: true },
            resources: ResourcesCapability {
                subscribe: false,
                list_changed: false,
            },
            prompts: PromptsCapability { list_changed: false },
            logging: LoggingCapability {},
        }
    }
}

/// Build the `initialize` response.
pub fn initialize_response() -> Value {
    let caps = ServerCapabilities::default();
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": caps,
        "serverInfo": {
            "name": SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION")
        }
    })
}

// ─── MCP Content Types ─────────────────────────────────────────────────────

/// Content block for tool results and resource contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text {
        text: String,
    },
    #[serde(rename = "image")]
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    #[serde(rename = "resource")]
    Resource {
        resource: ResourceContent,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContent {
    pub uri: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
}

/// Build a tools/call success response (text content).
pub fn tool_success(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value
    })
}

/// Build a tools/call error response.
pub fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true
    })
}

/// Build a tools/call disabled response.
pub fn tool_disabled(name: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": format!("Tool '{}' is disabled.", name) }],
        "isError": true
    })
}

// ─── Argument helpers ──────────────────────────────────────────────────────

/// Extract a required string argument, trimming whitespace.
pub fn get_required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .ok_or_else(|| format!("Missing required argument '{}'", key))
}

/// Extract an optional string argument, trimming whitespace.
pub fn get_optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Extract an optional u64 argument.
pub fn get_optional_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

/// Extract an optional u32 argument (from u64).
pub fn get_optional_u32(args: &Value, key: &str) -> Option<u32> {
    get_optional_u64(args, key).map(|v| v as u32)
}

/// Extract an optional u16 argument.
pub fn get_optional_u16(args: &Value, key: &str) -> Option<u16> {
    get_optional_u64(args, key).map(|v| v as u16)
}

/// Extract an optional u8 argument.
pub fn get_optional_u8(args: &Value, key: &str) -> Option<u8> {
    get_optional_u64(args, key).map(|v| v as u8)
}

/// Extract an optional bool argument.
pub fn get_optional_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

/// Extract an optional string array.
pub fn get_string_array(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(|v| {
        v.as_array().map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(String::from))
                .collect()
        })
    })
}

/// Create a CloudflareClient from standard args (api_key + optional email).
pub fn make_cf_client(args: &Value) -> Result<bc_cloudflare_api::CloudflareClient, String> {
    let api_key = get_required_string(args, "api_key")?;
    let email = get_optional_string(args, "email");
    Ok(bc_cloudflare_api::CloudflareClient::new(
        &api_key,
        email.as_deref(),
    ))
}
