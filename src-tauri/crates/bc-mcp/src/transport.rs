//! Bounded HTTP/1 and JSON-RPC transport for the MCP server.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::State as AxumState;
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER, TRANSFER_ENCODING};
use axum::http::uri::Authority;
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::stream;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

use crate::permissions::{self, PermissionGrantSet};
use crate::protocol::{
    error_response, error_response_with_data, initialize_response, success_response, tool_disabled,
    tool_error, tool_success, JsonRpcRequest, RpcErrorCode,
};
use crate::resource_limits::{
    bounded_message, serialize_json_limited, validate_json, RuntimePolicy, INBOUND_JSON_LIMITS,
    MAX_AUTH_TOKEN_BYTES, MAX_HEADER_BYTES, MAX_HEADER_COUNT, MAX_HEADER_VALUE_BYTES,
    MAX_ID_STRING_BYTES, MAX_METHOD_BYTES, RESPONSE_JSON_LIMITS, TOOL_RESULT_JSON_LIMITS,
};
use crate::{prompts, resources, tools};

type DispatchFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;

pub(crate) trait ToolDispatcher: Send + Sync {
    fn dispatch(&self, name: &'static str, args: Value) -> DispatchFuture;
}

#[derive(Debug)]
struct ProductionToolDispatcher;

impl ToolDispatcher for ProductionToolDispatcher {
    fn dispatch(&self, name: &'static str, args: Value) -> DispatchFuture {
        Box::pin(async move { tools::dispatch_prepared_tool(name, &args).await })
    }
}

#[derive(Clone)]
pub(crate) struct HttpRuntimeState {
    pub(crate) grants: Arc<RwLock<PermissionGrantSet>>,
    pub(crate) auth_token: Arc<RwLock<Option<String>>>,
    bind_host: Arc<str>,
    bind_port: u16,
    request_slots: Arc<Semaphore>,
    tool_slots: Arc<Semaphore>,
    shutdown: CancellationToken,
    policy: RuntimePolicy,
    dispatcher: Arc<dyn ToolDispatcher>,
}

impl HttpRuntimeState {
    pub(crate) fn production(
        grants: Arc<RwLock<PermissionGrantSet>>,
        auth_token: Arc<RwLock<Option<String>>>,
        bind_host: String,
        bind_port: u16,
        shutdown: CancellationToken,
        policy: RuntimePolicy,
    ) -> Self {
        Self {
            grants,
            auth_token,
            bind_host: Arc::from(bind_host),
            bind_port,
            request_slots: Arc::new(Semaphore::new(policy.max_in_flight_requests)),
            tool_slots: Arc::new(Semaphore::new(policy.max_in_flight_tools)),
            shutdown,
            policy,
            dispatcher: Arc::new(ProductionToolDispatcher),
        }
    }

    #[cfg(test)]
    fn with_dispatcher(dispatcher: Arc<dyn ToolDispatcher>, policy: RuntimePolicy) -> Self {
        Self {
            grants: Arc::new(RwLock::new(PermissionGrantSet::all())),
            auth_token: Arc::new(RwLock::new(Some("test-token".to_string()))),
            bind_host: Arc::from("127.0.0.1"),
            bind_port: 8787,
            request_slots: Arc::new(Semaphore::new(policy.max_in_flight_requests)),
            tool_slots: Arc::new(Semaphore::new(policy.max_in_flight_tools)),
            shutdown: CancellationToken::new(),
            policy,
            dispatcher,
        }
    }
}

#[derive(Clone)]
struct RequestAdmission {
    _permit: Arc<RequestPermit>,
}

struct RequestPermit {
    #[allow(dead_code)]
    permit: OwnedSemaphorePermit,
}

pub(crate) fn router(state: HttpRuntimeState) -> Router {
    Router::new()
        .route("/mcp", post(handle_mcp_rpc))
        .route("/health", get(handle_health))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            admission_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            bearer_auth_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            origin_validation_middleware,
        ))
        // The last layer runs first, before credentials or bodies are touched.
        .layer(middleware::from_fn(header_validation_middleware))
        .with_state(state)
}

pub(crate) async fn serve(
    listener: TcpListener,
    app: Router,
    shutdown: CancellationToken,
    policy: RuntimePolicy,
) -> Result<(), String> {
    let connection_slots = Arc::new(Semaphore::new(policy.max_connections));
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            Some(joined) = connections.join_next(), if !connections.is_empty() => {
                if let Err(error) = joined {
                    if error.is_panic() {
                        return Err("MCP connection task panicked.".to_string());
                    }
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted
                    .map_err(|error| format!("MCP listener accept failed: {error}"))?;
                let Ok(permit) = Arc::clone(&connection_slots).try_acquire_owned() else {
                    // The accept loop must remain bounded even under a slow-header flood.
                    drop(stream);
                    continue;
                };
                let app = app.clone();
                let connection_shutdown = shutdown.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    serve_connection(stream, app, connection_shutdown, policy).await;
                });
            }
        }
    }

    let graceful = async {
        while let Some(joined) = connections.join_next().await {
            if let Err(error) = joined {
                if error.is_panic() {
                    return Err("MCP connection task panicked during shutdown.".to_string());
                }
            }
        }
        Ok(())
    };

    match timeout(
        policy.shutdown_grace + std::time::Duration::from_millis(250),
        graceful,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            Err("MCP connections exceeded the graceful shutdown deadline.".to_string())
        }
    }
}

async fn serve_connection(
    stream: tokio::net::TcpStream,
    app: Router,
    shutdown: CancellationToken,
    policy: RuntimePolicy,
) {
    let _ = stream.set_nodelay(true);
    let service = hyper::service::service_fn(move |request| {
        let app = app.clone();
        async move { app.oneshot(request.map(Body::new)).await }
    });

    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(policy.header_read_timeout)
        .max_headers(MAX_HEADER_COUNT)
        .max_buf_size(MAX_HEADER_BYTES)
        .keep_alive(true);
    builder
        .http2()
        .max_concurrent_streams(policy.max_in_flight_requests as u32)
        .max_header_list_size(MAX_HEADER_BYTES as u32);
    let connection = builder.serve_connection(TokioIo::new(stream), service);
    tokio::pin!(connection);
    let lifetime = sleep(policy.connection_timeout);
    tokio::pin!(lifetime);

    tokio::select! {
        _ = &mut connection => {}
        _ = shutdown.cancelled() => {
            connection.as_mut().graceful_shutdown();
            let _ = timeout(policy.shutdown_grace, &mut connection).await;
        }
        _ = &mut lifetime => {
            connection.as_mut().graceful_shutdown();
            let _ = timeout(policy.shutdown_grace, &mut connection).await;
        }
    }
}

fn structured_http_error(
    status: StatusCode,
    code: RpcErrorCode,
    message: &'static str,
) -> Response {
    encoded_json_response(
        status,
        error_response(None, code.code(), message.to_string()),
    )
}

fn encoded_json_response(status: StatusCode, value: Value) -> Response {
    let bytes = serialize_json_limited(&value, crate::resource_limits::MAX_RESPONSE_BYTES)
        .or_else(|_| {
            serialize_json_limited(
                &error_response(
                    None,
                    RpcErrorCode::ResponseTooLarge.code(),
                    "The response exceeded the MCP serialization budget.".to_string(),
                ),
                16 * 1024,
            )
        })
        .unwrap_or_else(|_| {
            br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Response serialization failed"}}"#
                .to_vec()
        });
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .expect("fixed response headers are valid")
}

async fn header_validation_middleware(request: Request<Body>, next: Next) -> Response {
    let headers = request.headers();
    if headers.len() > MAX_HEADER_COUNT {
        return structured_http_error(
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            RpcErrorCode::InvalidRequest,
            "Too many HTTP headers.",
        );
    }

    let mut total = 0usize;
    for (name, value) in headers {
        if value.as_bytes().len() > MAX_HEADER_VALUE_BYTES {
            return structured_http_error(
                StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
                RpcErrorCode::InvalidRequest,
                "An HTTP header value is too large.",
            );
        }
        let Some(next_total) = total
            .checked_add(name.as_str().len())
            .and_then(|size| size.checked_add(value.as_bytes().len()))
        else {
            return structured_http_error(
                StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
                RpcErrorCode::InvalidRequest,
                "HTTP header size overflowed.",
            );
        };
        total = next_total;
        if total > MAX_HEADER_BYTES {
            return structured_http_error(
                StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
                RpcErrorCode::InvalidRequest,
                "HTTP headers exceed the server byte budget.",
            );
        }
    }

    let mut content_lengths = headers.get_all(CONTENT_LENGTH).iter();
    if let Some(length) = content_lengths.next() {
        if content_lengths.next().is_some() || headers.contains_key(TRANSFER_ENCODING) {
            return structured_http_error(
                StatusCode::BAD_REQUEST,
                RpcErrorCode::InvalidRequest,
                "Ambiguous HTTP message framing is not allowed.",
            );
        }
        let Some(length) = length
            .to_str()
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
        else {
            return structured_http_error(
                StatusCode::BAD_REQUEST,
                RpcErrorCode::InvalidRequest,
                "Content-Length is malformed.",
            );
        };
        if length > crate::resource_limits::MAX_REQUEST_BODY_BYTES {
            return structured_http_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                RpcErrorCode::InvalidRequest,
                "The request body exceeds the MCP byte budget.",
            );
        }
    } else if headers.contains_key(TRANSFER_ENCODING)
        && headers
            .get(TRANSFER_ENCODING)
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| !value.eq_ignore_ascii_case("chunked"))
    {
        return structured_http_error(
            StatusCode::BAD_REQUEST,
            RpcErrorCode::InvalidRequest,
            "Unsupported Transfer-Encoding.",
        );
    }
    next.run(request).await
}

async fn admission_middleware(
    AxumState(state): AxumState<HttpRuntimeState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    if state.shutdown.is_cancelled() {
        return structured_http_error(
            StatusCode::SERVICE_UNAVAILABLE,
            RpcErrorCode::ServerShuttingDown,
            "The MCP server is shutting down.",
        );
    }
    let Ok(permit) = Arc::clone(&state.request_slots).try_acquire_owned() else {
        let mut response = structured_http_error(
            StatusCode::TOO_MANY_REQUESTS,
            RpcErrorCode::ServerOverloaded,
            "The MCP server request limit is currently exhausted.",
        );
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static("1"));
        return response;
    };
    request.extensions_mut().insert(RequestAdmission {
        _permit: Arc::new(RequestPermit { permit }),
    });
    next.run(request).await
}

async fn bearer_auth_middleware(
    AxumState(state): AxumState<HttpRuntimeState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let token = state.auth_token.read().await;
    if let Some(expected) = token.as_deref() {
        if expected.is_empty()
            || expected.len() > MAX_AUTH_TOKEN_BYTES
            || bearer_token(request.headers()) != Some(expected)
        {
            return structured_http_error(
                StatusCode::UNAUTHORIZED,
                RpcErrorCode::Unauthorized,
                "Unauthorized: invalid or missing bearer token.",
            );
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
        || token.len() > MAX_AUTH_TOKEN_BYTES
        || token.chars().any(char::is_whitespace)
    {
        return None;
    }
    Some(token)
}

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

async fn origin_validation_middleware(
    AxumState(state): AxumState<HttpRuntimeState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Err(reason) = validate_origin(request.headers(), &state.bind_host, state.bind_port) {
        return encoded_json_response(
            StatusCode::FORBIDDEN,
            error_response(
                None,
                RpcErrorCode::Unauthorized.code(),
                format!("Forbidden Origin: {reason}"),
            ),
        );
    }
    next.run(request).await
}

async fn handle_health(mut request: Request<Body>) -> Response {
    let _admission = request.extensions_mut().remove::<RequestAdmission>();
    encoded_json_response(StatusCode::OK, json!({ "status": "ok" }))
}

fn content_type_is_json(headers: &HeaderMap) -> bool {
    let mut values = headers.get_all(CONTENT_TYPE).iter();
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return false;
    }
    value
        .to_str()
        .ok()
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
}

async fn handle_mcp_rpc(
    AxumState(state): AxumState<HttpRuntimeState>,
    mut request: Request<Body>,
) -> Response {
    let Some(admission) = request.extensions_mut().remove::<RequestAdmission>() else {
        return structured_http_error(
            StatusCode::SERVICE_UNAVAILABLE,
            RpcErrorCode::InternalError,
            "The MCP request was not admitted safely.",
        );
    };
    if !content_type_is_json(request.headers()) {
        return structured_http_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            RpcErrorCode::InvalidRequest,
            "Content-Type must be application/json.",
        );
    }

    let body = tokio::select! {
        _ = state.shutdown.cancelled() => {
            return structured_http_error(
                StatusCode::SERVICE_UNAVAILABLE,
                RpcErrorCode::ServerShuttingDown,
                "The MCP server is shutting down.",
            );
        }
        result = timeout(
            state.policy.request_body_timeout,
            to_bytes(request.into_body(), state.policy.max_request_body_bytes),
        ) => match result {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                return structured_http_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    RpcErrorCode::InvalidRequest,
                    "The request body is malformed or exceeds the MCP byte budget.",
                );
            }
            Err(_) => {
                return structured_http_error(
                    StatusCode::REQUEST_TIMEOUT,
                    RpcErrorCode::RequestTimeout,
                    "The request body exceeded its read deadline.",
                );
            }
        }
    };

    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(payload) => payload,
        Err(_) => {
            return structured_http_error(
                StatusCode::BAD_REQUEST,
                RpcErrorCode::ParseError,
                "Invalid JSON payload.",
            );
        }
    };
    if let Err(reason) = validate_json(&payload, INBOUND_JSON_LIMITS) {
        return encoded_json_response(
            StatusCode::BAD_REQUEST,
            error_response(
                None,
                RpcErrorCode::InvalidRequest.code(),
                format!("Invalid JSON-RPC payload: {reason}."),
            ),
        );
    }

    if payload_is_notification_only(&payload) {
        let work = process_payload(state.clone(), payload);
        tokio::select! {
            _ = state.shutdown.cancelled() => {}
            _ = timeout(state.policy.request_timeout, work) => {}
        }
        drop(admission);
        return StatusCode::NO_CONTENT.into_response();
    }

    streaming_rpc_response(state, payload, admission)
}

fn payload_is_notification_only(payload: &Value) -> bool {
    match payload {
        Value::Object(object) => valid_notification(object),
        Value::Array(items) if !items.is_empty() => items
            .iter()
            .all(|item| item.as_object().is_some_and(valid_notification)),
        _ => false,
    }
}

fn valid_notification(object: &serde_json::Map<String, Value>) -> bool {
    !object.contains_key("id")
        && object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && object
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| !method.is_empty() && method.len() <= MAX_METHOD_BYTES)
        && object
            .get("params")
            .is_none_or(|params| params.is_object() || params.is_array())
}

fn streaming_rpc_response(
    state: HttpRuntimeState,
    payload: Value,
    admission: RequestAdmission,
) -> Response {
    let stream = stream::once(async move {
        let _admission = admission;
        let response = tokio::select! {
            _ = state.shutdown.cancelled() => error_response(
                None,
                RpcErrorCode::ServerShuttingDown.code(),
                "The MCP server cancelled the request during shutdown.".to_string(),
            ),
            result = timeout(state.policy.request_timeout, process_payload(state.clone(), payload)) => {
                match result {
                    Ok(Some(response)) => response,
                    Ok(None) => error_response(
                        None,
                        RpcErrorCode::InvalidRequest.code(),
                        "The request produced no JSON-RPC response.".to_string(),
                    ),
                    Err(_) => error_response(
                        None,
                        RpcErrorCode::RequestTimeout.code(),
                        "The JSON-RPC request exceeded its deadline.".to_string(),
                    ),
                }
            }
        };
        let bytes = serialize_json_limited(&response, state.policy.max_response_bytes)
            .or_else(|_| {
                serialize_json_limited(
                    &error_response(
                        None,
                        RpcErrorCode::ResponseTooLarge.code(),
                        "The JSON-RPC response exceeded its byte budget.".to_string(),
                    ),
                    16 * 1024,
                )
            })
            .unwrap_or_else(|_| {
                br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Response serialization failed"}}"#
                    .to_vec()
            });
        Ok::<Bytes, Infallible>(Bytes::from(bytes))
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from_stream(stream))
        .expect("fixed response headers are valid")
}

async fn process_payload(state: HttpRuntimeState, payload: Value) -> Option<Value> {
    match payload {
        Value::Array(items) => {
            if items.is_empty() {
                return Some(error_response(
                    None,
                    RpcErrorCode::InvalidRequest.code(),
                    "A JSON-RPC batch must not be empty.".to_string(),
                ));
            }
            if items.len() > state.policy.max_batch_items {
                return Some(error_response(
                    None,
                    RpcErrorCode::InvalidRequest.code(),
                    format!(
                        "A JSON-RPC batch may contain at most {} items.",
                        state.policy.max_batch_items
                    ),
                ));
            }

            let mut responses = Vec::with_capacity(items.len());
            for item in items {
                if let Some(response) = process_single_request(&state, item).await {
                    responses.push(response);
                }
            }
            if responses.is_empty() {
                None
            } else {
                Some(Value::Array(responses))
            }
        }
        item => process_single_request(&state, item).await,
    }
}

async fn process_single_request(state: &HttpRuntimeState, payload: Value) -> Option<Value> {
    let Some(object) = payload.as_object() else {
        return Some(error_response(
            None,
            RpcErrorCode::InvalidRequest.code(),
            "Each JSON-RPC request must be an object.".to_string(),
        ));
    };
    let has_id = object.contains_key("id");
    let id = object.get("id").cloned();
    if let Some(id) = id.as_ref() {
        let id_is_valid = matches!(id, Value::Null | Value::Number(_))
            || id
                .as_str()
                .is_some_and(|text| text.len() <= MAX_ID_STRING_BYTES);
        if !id_is_valid {
            return Some(error_response(
                None,
                RpcErrorCode::InvalidRequest.code(),
                "JSON-RPC ids must be null, numbers, or bounded strings.".to_string(),
            ));
        }
    }

    let request = match serde_json::from_value::<JsonRpcRequest>(payload) {
        Ok(request) => request,
        Err(_) => {
            return Some(error_response(
                id,
                RpcErrorCode::InvalidRequest.code(),
                "Invalid JSON-RPC request object.".to_string(),
            ));
        }
    };
    if !matches!(
        request.jsonrpc.as_ref(),
        Some(Value::String(version)) if version == "2.0"
    ) {
        return Some(error_response(
            id,
            RpcErrorCode::InvalidRequest.code(),
            "Invalid JSON-RPC version: expected exactly '2.0'.".to_string(),
        ));
    }
    if request.method.is_empty() || request.method.len() > MAX_METHOD_BYTES {
        return Some(error_response(
            id,
            RpcErrorCode::InvalidRequest.code(),
            "JSON-RPC method is empty or exceeds its byte budget.".to_string(),
        ));
    }
    if request
        .params
        .as_ref()
        .is_some_and(|params| !params.is_object() && !params.is_array())
    {
        return Some(error_response(
            id,
            RpcErrorCode::InvalidParams.code(),
            "JSON-RPC params must be an object or array.".to_string(),
        ));
    }

    let response_id = id.unwrap_or(Value::Null);
    let result = dispatch_method(state, &request, response_id.clone()).await;
    if !has_id {
        return None;
    }
    Some(match result {
        Ok(result) => success_response(response_id, result),
        Err(error) => error,
    })
}

async fn dispatch_method(
    state: &HttpRuntimeState,
    request: &JsonRpcRequest,
    response_id: Value,
) -> Result<Value, Value> {
    let params = request
        .params
        .as_ref()
        .cloned()
        .unwrap_or_else(|| json!({}));
    match request.method.as_str() {
        "initialize" => Ok(initialize_response()),
        "notifications/initialized" | "initialized" | "ping" => Ok(json!({})),
        "tools/list" => {
            let grants = state.grants.read().await.clone();
            let filtered = tools::available_tool_definitions()
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
                .collect::<Vec<_>>();
            Ok(json!({ "tools": filtered }))
        }
        "tools/call" => dispatch_tool_call(state, &params, response_id).await,
        "resources/list" => {
            let list = resources::list_resources()
                .into_iter()
                .map(|resource| {
                    json!({
                        "uri": resource.uri,
                        "name": resource.name,
                        "description": resource.description,
                        "mimeType": resource.mime_type
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "resources": list }))
        }
        "resources/templates/list" => {
            let templates = resources::list_resource_templates()
                .into_iter()
                .map(|template| {
                    json!({
                        "uriTemplate": template.uri_template,
                        "name": template.name,
                        "description": template.description,
                        "mimeType": template.mime_type
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "resourceTemplates": templates }))
        }
        "resources/read" => {
            let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
            match resources::read_resource(uri) {
                Ok(content) => {
                    let text = serialize_json_limited(&content, state.policy.max_tool_result_bytes)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .ok_or_else(|| {
                            error_response(
                                Some(response_id.clone()),
                                RpcErrorCode::ResponseTooLarge.code(),
                                "The resource exceeded the MCP response budget.".to_string(),
                            )
                        })?;
                    Ok(json!({
                        "contents": [{
                            "uri": uri,
                            "mimeType": "application/json",
                            "text": text
                        }]
                    }))
                }
                Err(error) => Err(error_response_with_data(
                    Some(response_id),
                    RpcErrorCode::ResourceNotFound.code(),
                    error,
                    json!({ "uri": uri }),
                )),
            }
        }
        "prompts/list" => {
            let prompt_list = prompts::list_prompts()
                .into_iter()
                .map(|prompt| {
                    let mut value = json!({
                        "name": prompt.name,
                        "description": prompt.description
                    });
                    if let Some(arguments) = prompt.arguments {
                        value["arguments"] = Value::Array(
                            arguments
                                .into_iter()
                                .map(|argument| {
                                    json!({
                                        "name": argument.name,
                                        "description": argument.description,
                                        "required": argument.required
                                    })
                                })
                                .collect(),
                        );
                    }
                    value
                })
                .collect::<Vec<_>>();
            Ok(json!({ "prompts": prompt_list }))
        }
        "prompts/get" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match prompts::get_prompt(name, &arguments) {
                Ok(messages) => {
                    let messages = messages
                        .into_iter()
                        .map(|message| {
                            json!({
                                "role": message.role,
                                "content": {
                                    "type": message.content.content_type,
                                    "text": message.content.text
                                }
                            })
                        })
                        .collect::<Vec<_>>();
                    Ok(json!({
                        "description": format!("Prompt: {name}"),
                        "messages": messages
                    }))
                }
                Err(error) => Err(error_response_with_data(
                    Some(response_id),
                    RpcErrorCode::PromptNotFound.code(),
                    error,
                    json!({ "name": name }),
                )),
            }
        }
        "logging/setLevel" => Ok(json!({})),
        _ => Err(error_response(
            Some(response_id),
            RpcErrorCode::MethodNotFound.code(),
            format!("Method '{}' not found.", request.method),
        )),
    }
}

async fn dispatch_tool_call(
    state: &HttpRuntimeState,
    params: &Value,
    response_id: Value,
) -> Result<Value, Value> {
    let Some(name) = params
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && name.len() <= MAX_METHOD_BYTES)
    else {
        return Err(error_response(
            Some(response_id),
            RpcErrorCode::InvalidParams.code(),
            "Missing or oversized tools/call param 'name'.".to_string(),
        ));
    };
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let grants = state.grants.read().await.clone();
    let prepared = match tools::prepare_tool_invocation(&grants, name, &arguments) {
        Ok(prepared) => prepared,
        Err(error) => {
            if permissions::permission_for_invocation(name)
                .is_some_and(|permission| !grants.allows(permission))
            {
                return Ok(tool_disabled(name));
            }
            return Ok(tool_error(&error));
        }
    };

    let Ok(permit) = Arc::clone(&state.tool_slots).try_acquire_owned() else {
        return Err(error_response(
            Some(response_id),
            RpcErrorCode::ServerOverloaded.code(),
            "The MCP tool execution limit is currently exhausted.".to_string(),
        ));
    };
    let dispatch = state
        .dispatcher
        .dispatch(prepared.canonical_name, prepared.arguments);
    let result = tokio::select! {
        _ = state.shutdown.cancelled() => {
            drop(permit);
            return Err(error_response(
                Some(response_id),
                RpcErrorCode::ServerShuttingDown.code(),
                "Tool execution was cancelled during server shutdown.".to_string(),
            ));
        }
        result = timeout(state.policy.tool_timeout, dispatch) => result
    };
    drop(permit);

    match result {
        Err(_) => Err(error_response(
            Some(response_id),
            RpcErrorCode::RequestTimeout.code(),
            "Tool execution exceeded its deadline.".to_string(),
        )),
        Ok(Err(error)) => Ok(tool_error(&bounded_message(&error))),
        Ok(Ok(value)) => {
            if validate_json(&value, TOOL_RESULT_JSON_LIMITS).is_err()
                || serialize_json_limited(&value, state.policy.max_tool_result_bytes).is_err()
            {
                return Err(error_response(
                    Some(response_id),
                    RpcErrorCode::ResponseTooLarge.code(),
                    "Tool output exceeded the MCP response budget.".to_string(),
                ));
            }
            let result = tool_success(&value);
            if validate_json(&result, RESPONSE_JSON_LIMITS).is_err() {
                return Err(error_response(
                    Some(response_id),
                    RpcErrorCode::ResponseTooLarge.code(),
                    "Tool output exceeded the MCP response structure budget.".to_string(),
                ));
            }
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::body::to_bytes;
    use axum::http::HeaderValue;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Notify;

    use super::*;
    use crate::resource_limits::{MAX_RESPONSE_BYTES, MAX_TOOL_RESULT_BYTES};

    #[derive(Clone)]
    enum StubBehavior {
        Echo,
        Hang {
            entered: Arc<Notify>,
            dropped: Arc<AtomicBool>,
        },
        Large,
        Error,
        Track {
            active: Arc<AtomicUsize>,
            peak: Arc<AtomicUsize>,
        },
    }

    struct StubDispatcher {
        behavior: StubBehavior,
    }

    struct DropSignal {
        dropped: Arc<AtomicBool>,
    }

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    impl ToolDispatcher for StubDispatcher {
        fn dispatch(&self, _name: &'static str, args: Value) -> DispatchFuture {
            match self.behavior.clone() {
                StubBehavior::Echo => Box::pin(async move { Ok(args) }),
                StubBehavior::Hang { entered, dropped } => Box::pin(async move {
                    let _drop_signal = DropSignal { dropped };
                    entered.notify_one();
                    std::future::pending::<Result<Value, String>>().await
                }),
                StubBehavior::Large => Box::pin(async {
                    Ok(json!({ "payload": "x".repeat(MAX_TOOL_RESULT_BYTES + 1) }))
                }),
                StubBehavior::Error => Box::pin(async {
                    Err("e".repeat(crate::resource_limits::MAX_ERROR_MESSAGE_BYTES * 4))
                }),
                StubBehavior::Track { active, peak } => Box::pin(async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(json!({}))
                }),
            }
        }
    }

    fn test_policy() -> RuntimePolicy {
        RuntimePolicy {
            max_connections: 8,
            max_in_flight_requests: 2,
            max_in_flight_tools: 1,
            header_read_timeout: Duration::from_millis(100),
            request_body_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_millis(250),
            tool_timeout: Duration::from_millis(50),
            connection_timeout: Duration::from_millis(500),
            shutdown_grace: Duration::from_millis(100),
            ..RuntimePolicy::default()
        }
    }

    fn state_with(behavior: StubBehavior) -> HttpRuntimeState {
        HttpRuntimeState::with_dispatcher(Arc::new(StubDispatcher { behavior }), test_policy())
    }

    fn production_state() -> HttpRuntimeState {
        HttpRuntimeState::production(
            Arc::new(RwLock::new(PermissionGrantSet::all())),
            Arc::new(RwLock::new(Some("test-token".to_string()))),
            "127.0.0.1".to_string(),
            8787,
            CancellationToken::new(),
            test_policy(),
        )
    }

    fn rpc(method: &str, id: Option<Value>, params: Value) -> Value {
        let mut request = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        if let Some(id) = id {
            request["id"] = id;
        }
        request
    }

    async fn process(state: &HttpRuntimeState, payload: Value) -> Value {
        process_payload(state.clone(), payload).await.unwrap()
    }

    #[test]
    fn absent_and_exact_local_http_origins_are_allowed() {
        assert!(validate_origin(&HeaderMap::new(), "127.0.0.1", 8787).is_ok());
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("http://127.0.0.1:8787"));
        assert!(validate_origin(&headers, "127.0.0.1", 8787).is_ok());
    }

    #[test]
    fn unsafe_origin_and_bearer_matrices_fail_closed() {
        for origin in [
            "null",
            "file://localhost",
            "https://127.0.0.1:8787",
            "http://user:password@127.0.0.1:8787",
            "http://127.0.0.1:8787/path",
            "http://localhost:8787",
            "http://127.0.0.1:9999",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("origin", HeaderValue::from_str(origin).unwrap());
            assert!(validate_origin(&headers, "127.0.0.1", 8787).is_err());
        }
        for authorization in [
            "",
            "Bearer",
            "Bearer ",
            "Bearer  token",
            "Bearer token ",
            "Bearer token extra",
            "Basic token",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                "authorization",
                HeaderValue::from_str(authorization).unwrap(),
            );
            assert!(bearer_token(&headers).is_none(), "{authorization}");
        }
    }

    #[tokio::test]
    async fn batch_is_bounded_sequential_and_omits_notification_responses() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let state = state_with(StubBehavior::Track {
            active,
            peak: Arc::clone(&peak),
        });
        let call = |id| {
            rpc(
                "tools/call",
                id,
                json!({
                    "name": "dns_validate_record",
                    "arguments": {"record_type": "A", "content": "192.0.2.1"}
                }),
            )
        };
        let response = process(
            &state,
            json!([call(Some(json!(1))), call(None), call(Some(json!(2)))]),
        )
        .await;
        assert_eq!(response.as_array().unwrap().len(), 2);
        assert_eq!(peak.load(Ordering::SeqCst), 1);

        let oversized = Value::Array(
            (0..=state.policy.max_batch_items)
                .map(|index| rpc("ping", Some(json!(index)), json!({})))
                .collect(),
        );
        let response = process(&state, oversized).await;
        assert_eq!(
            response["error"]["code"],
            RpcErrorCode::InvalidRequest.code()
        );
        assert!(process_payload(
            state,
            json!([
                rpc("ping", None, json!({})),
                rpc("logging/setLevel", None, json!({}))
            ]),
        )
        .await
        .is_none());
    }

    #[tokio::test]
    async fn high_risk_confirmation_is_required_independently_per_batch_item() {
        let state = state_with(StubBehavior::Echo);
        let response = process(
            &state,
            json!([
                rpc(
                    "tools/call",
                    Some(json!(1)),
                    json!({
                        "name": "cf_delete_dns_record",
                        "arguments": {
                            "zone_id": "zone",
                            "record_id": "record",
                            "confirmHighRisk": true
                        }
                    }),
                ),
                rpc(
                    "tools/call",
                    Some(json!(2)),
                    json!({
                        "name": "cf_delete_dns_record",
                        "arguments": {
                            "zone_id": "zone",
                            "record_id": "record"
                        }
                    }),
                )
            ]),
        )
        .await;
        let items = response.as_array().unwrap();
        assert_eq!(
            items[0]["result"]["structuredContent"].get("confirmHighRisk"),
            None
        );
        assert_eq!(items[1]["result"]["isError"], true);
    }

    #[tokio::test]
    async fn hanging_tools_timeout_and_release_the_only_permit() {
        let entered = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let state = state_with(StubBehavior::Hang {
            entered,
            dropped: Arc::clone(&dropped),
        });
        let response = process(
            &state,
            rpc(
                "tools/call",
                Some(json!(1)),
                json!({
                    "name": "dns_validate_record",
                    "arguments": {"record_type": "A", "content": "192.0.2.1"}
                }),
            ),
        )
        .await;
        assert_eq!(
            response["error"]["code"],
            RpcErrorCode::RequestTimeout.code()
        );
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(state.tool_slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn concurrent_tool_flood_fails_fast_and_recovers_permits() {
        let entered = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let mut policy = test_policy();
        policy.tool_timeout = Duration::from_millis(150);
        let state = HttpRuntimeState::with_dispatcher(
            Arc::new(StubDispatcher {
                behavior: StubBehavior::Hang {
                    entered: Arc::clone(&entered),
                    dropped,
                },
            }),
            policy,
        );
        let first_state = state.clone();
        let first = tokio::spawn(async move {
            process(
                &first_state,
                rpc(
                    "tools/call",
                    Some(json!(1)),
                    json!({
                        "name": "dns_validate_record",
                        "arguments": {"record_type": "A", "content": "192.0.2.1"}
                    }),
                ),
            )
            .await
        });
        entered.notified().await;
        let second = process(
            &state,
            rpc(
                "tools/call",
                Some(json!(2)),
                json!({
                    "name": "dns_validate_record",
                    "arguments": {"record_type": "A", "content": "192.0.2.1"}
                }),
            ),
        )
        .await;
        assert_eq!(
            second["error"]["code"],
            RpcErrorCode::ServerOverloaded.code()
        );
        let _ = first.await.unwrap();
        assert_eq!(state.tool_slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn oversized_results_and_errors_are_replaced_with_bounded_responses() {
        let large = state_with(StubBehavior::Large);
        let response = process(
            &large,
            rpc(
                "tools/call",
                Some(json!(1)),
                json!({
                    "name": "dns_validate_record",
                    "arguments": {"record_type": "A", "content": "192.0.2.1"}
                }),
            ),
        )
        .await;
        assert_eq!(
            response["error"]["code"],
            RpcErrorCode::ResponseTooLarge.code()
        );

        let error = state_with(StubBehavior::Error);
        let response = process(
            &error,
            rpc(
                "tools/call",
                Some(json!(1)),
                json!({
                    "name": "dns_validate_record",
                    "arguments": {"record_type": "A", "content": "192.0.2.1"}
                }),
            ),
        )
        .await;
        let encoded = serialize_json_limited(&response, MAX_RESPONSE_BYTES).unwrap();
        assert!(encoded.len() < MAX_RESPONSE_BYTES);
    }

    #[tokio::test]
    async fn dns_failures_are_explicit_bounded_and_serializable() {
        let state = production_state();
        let oversized_bind = format!(
            "example.com 300 IN TXT {}",
            "x".repeat(bc_dns_tools::MAX_IMPORT_LINE_BYTES)
        );
        let invalid_csv = (0..=bc_dns_tools::MAX_IMPORT_FIELDS)
            .map(|index| format!("field-{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let oversized_record = json!({
            "id": "record-id",
            "type": "TXT",
            "name": "example.com",
            "content": "x".repeat(bc_dns_tools::MAX_EXPORT_FIELD_BYTES + 1),
            "comment": null,
            "ttl": 300,
            "priority": null,
            "proxied": false,
            "zone_id": "zone-id",
            "zone_name": "example.com",
            "created_on": "",
            "modified_on": ""
        });
        let cases = [
            ("dns_parse_bind", json!({ "text": oversized_bind })),
            ("dns_parse_csv", json!({ "text": invalid_csv })),
            (
                "dns_export_csv",
                json!({ "records": [oversized_record.clone()] }),
            ),
            (
                "dns_export_bind",
                json!({ "records": [oversized_record.clone()] }),
            ),
            ("dns_export_json", json!({ "records": [oversized_record] })),
        ];

        for (index, (name, arguments)) in cases.into_iter().enumerate() {
            let response = process(
                &state,
                rpc(
                    "tools/call",
                    Some(json!(index)),
                    json!({ "name": name, "arguments": arguments }),
                ),
            )
            .await;
            let result = &response["result"];
            assert_eq!(result["isError"], true, "{name}: {response}");
            assert!(
                result.get("structuredContent").is_none(),
                "{name}: {response}"
            );
            let message = result["content"][0]["text"]
                .as_str()
                .expect("tool failures return text diagnostics");
            assert!(!message.is_empty(), "{name}: {response}");
            assert!(
                message.len() <= crate::resource_limits::MAX_ERROR_MESSAGE_BYTES + 3,
                "{name}: diagnostic was not bounded"
            );
            assert!(
                message.contains("exceeds the safe"),
                "{name}: unexpected diagnostic: {message}"
            );
            let encoded = serialize_json_limited(&response, MAX_RESPONSE_BYTES)
                .expect("DNS error response must remain serializable");
            assert!(encoded.len() < MAX_RESPONSE_BYTES);
        }
    }

    #[tokio::test]
    async fn valid_dns_exports_and_imports_round_trip_through_json_rpc() {
        let state = production_state();
        let record = json!({
            "id": "record-id",
            "type": "TXT",
            "name": "example.com",
            "content": "a \"quoted\" value",
            "comment": null,
            "ttl": 300,
            "priority": null,
            "proxied": false,
            "zone_id": "zone-id",
            "zone_name": "example.com",
            "created_on": "",
            "modified_on": ""
        });

        for (index, (export_name, parse_name)) in [
            ("dns_export_csv", "dns_parse_csv"),
            ("dns_export_bind", "dns_parse_bind"),
        ]
        .into_iter()
        .enumerate()
        {
            let exported = process(
                &state,
                rpc(
                    "tools/call",
                    Some(json!(index)),
                    json!({
                        "name": export_name,
                        "arguments": { "records": [record.clone()] }
                    }),
                ),
            )
            .await;
            assert_ne!(exported["result"]["isError"], true, "{exported}");
            let text = exported["result"]["structuredContent"]["data"]
                .as_str()
                .expect("export returns text data");
            let imported = process(
                &state,
                rpc(
                    "tools/call",
                    Some(json!(index + 10)),
                    json!({
                        "name": parse_name,
                        "arguments": { "text": text }
                    }),
                ),
            )
            .await;
            assert_ne!(imported["result"]["isError"], true, "{imported}");
            let parsed = imported["result"]["structuredContent"]
                .as_array()
                .expect("parser returns records");
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0]["type"], "TXT");
            assert_eq!(parsed[0]["name"], "example.com");
            assert_eq!(parsed[0]["content"], "a \"quoted\" value");
        }

        let exported_json = process(
            &state,
            rpc(
                "tools/call",
                Some(json!(20)),
                json!({
                    "name": "dns_export_json",
                    "arguments": { "records": [record] }
                }),
            ),
        )
        .await;
        assert_ne!(exported_json["result"]["isError"], true, "{exported_json}");
        let text = exported_json["result"]["structuredContent"]["data"]
            .as_str()
            .expect("JSON export returns text data");
        let decoded: Value = serde_json::from_str(text).expect("JSON export remains valid JSON");
        assert_eq!(decoded[0]["type"], "TXT");
        assert_eq!(decoded[0]["content"], "a \"quoted\" value");
    }

    async fn spawn_test_server(
        state: HttpRuntimeState,
    ) -> (
        u16,
        CancellationToken,
        tokio::task::JoinHandle<Result<(), String>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let shutdown = state.shutdown.clone();
        let policy = state.policy;
        let app = router(state);
        let task_shutdown = shutdown.clone();
        let task = tokio::spawn(async move { serve(listener, app, task_shutdown, policy).await });
        (port, shutdown, task)
    }

    async fn raw_request(port: u16, headers: &str, body: &str) -> Vec<u8> {
        raw_request_with_length(port, headers, body, body.len()).await
    }

    async fn raw_request_with_length(
        port: u16,
        headers: &str,
        body: &str,
        content_length: usize,
    ) -> Vec<u8> {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            content_length
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response).await;
        response
    }

    async fn open_request(port: u16, body: &str) -> tokio::net::TcpStream {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        stream
    }

    fn status(response: &[u8]) -> u16 {
        let text = String::from_utf8_lossy(response);
        text.lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|status| status.parse().ok())
            .unwrap()
    }

    #[tokio::test]
    async fn http_boundary_rejects_oversized_bodies_headers_and_request_floods() {
        let entered = Arc::new(Notify::new());
        let mut policy = test_policy();
        policy.max_in_flight_tools = 2;
        policy.tool_timeout = Duration::from_secs(5);
        policy.request_timeout = Duration::from_secs(5);
        let state = HttpRuntimeState::with_dispatcher(
            Arc::new(StubDispatcher {
                behavior: StubBehavior::Hang {
                    entered: Arc::clone(&entered),
                    dropped: Arc::new(AtomicBool::new(false)),
                },
            }),
            policy,
        );
        let (port, shutdown, task) = spawn_test_server(state.clone()).await;

        let oversized =
            raw_request_with_length(port, "", "", state.policy.max_request_body_bytes + 1).await;
        assert_eq!(status(&oversized), 413);

        let large_header = format!("X-Large: {}\r\n", "x".repeat(MAX_HEADER_VALUE_BYTES + 1));
        let response = raw_request(
            port,
            &large_header,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        )
        .await;
        assert!(matches!(status(&response), 431 | 400));

        let mut deeply_nested = Value::Null;
        for _ in 0..=INBOUND_JSON_LIMITS.max_depth {
            deeply_nested = json!({ "v": deeply_nested });
        }
        let deeply_nested = serde_json::to_string(&deeply_nested).unwrap();
        let response = raw_request(port, "", &deeply_nested).await;
        assert_eq!(status(&response), 400);
        assert!(String::from_utf8_lossy(&response).contains("nesting is too deep"));

        let ambiguous = raw_request(
            port,
            "Content-Length: 1\r\n",
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        )
        .await;
        assert_eq!(status(&ambiguous), 400);

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dns_validate_record","arguments":{"record_type":"A","content":"192.0.2.1"}}}"#;
        let first = open_request(port, body).await;
        timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        let second = open_request(port, body).await;
        timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        let overload = raw_request(port, "", r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).await;
        assert_eq!(status(&overload), 429);
        drop(first);
        drop(second);

        shutdown.cancel();
        let _ = task.await.unwrap();
    }

    #[tokio::test]
    async fn slow_header_timeout_releases_the_connection_slot() {
        let mut policy = test_policy();
        policy.max_connections = 1;
        policy.header_read_timeout = Duration::from_millis(40);
        let state = HttpRuntimeState::with_dispatcher(
            Arc::new(StubDispatcher {
                behavior: StubBehavior::Echo,
            }),
            policy,
        );
        let (port, shutdown, task) = spawn_test_server(state).await;
        let mut slow = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        slow.write_all(b"POST /mcp HTTP/1.1\r\nHost: 127.")
            .await
            .unwrap();
        sleep(Duration::from_millis(100)).await;
        let mut buffer = [0u8; 1];
        let closed = slow.read(&mut buffer).await;
        assert!(matches!(closed, Ok(0) | Err(_)));

        let response = raw_request(port, "", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).await;
        assert_eq!(status(&response), 200);
        shutdown.cancel();
        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn disconnect_and_shutdown_cancel_hanging_dispatch_without_permit_leaks() {
        let entered = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let mut policy = test_policy();
        policy.tool_timeout = Duration::from_secs(5);
        policy.request_timeout = Duration::from_secs(5);
        policy.connection_timeout = Duration::from_secs(5);
        let state = HttpRuntimeState::with_dispatcher(
            Arc::new(StubDispatcher {
                behavior: StubBehavior::Hang {
                    entered: Arc::clone(&entered),
                    dropped: Arc::clone(&dropped),
                },
            }),
            policy,
        );
        let (port, shutdown, task) = spawn_test_server(state.clone()).await;
        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dns_validate_record","arguments":{"record_type":"A","content":"192.0.2.1"}}}"#;
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        client.write_all(request.as_bytes()).await.unwrap();
        timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        drop(client);
        timeout(Duration::from_secs(1), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(state.tool_slots.available_permits(), 1);
        assert_eq!(state.request_slots.available_permits(), 2);

        dropped.store(false, Ordering::SeqCst);
        let entered_shutdown = Arc::new(Notify::new());
        let shutdown_state = HttpRuntimeState::with_dispatcher(
            Arc::new(StubDispatcher {
                behavior: StubBehavior::Hang {
                    entered: Arc::clone(&entered_shutdown),
                    dropped: Arc::clone(&dropped),
                },
            }),
            policy,
        );
        let (shutdown_port, shutdown_token, shutdown_task) =
            spawn_test_server(shutdown_state.clone()).await;
        let request_task = tokio::spawn(raw_request(shutdown_port, "", body));
        timeout(Duration::from_secs(1), entered_shutdown.notified())
            .await
            .unwrap();
        shutdown_token.cancel();
        timeout(Duration::from_secs(1), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let _ = request_task.await;
        assert!(shutdown_task.await.unwrap().is_ok());
        assert_eq!(shutdown_state.tool_slots.available_permits(), 1);

        shutdown.cancel();
        let _ = task.await.unwrap();
    }

    #[tokio::test]
    async fn streaming_response_drop_cancels_work_even_without_a_socket() {
        let entered = Arc::new(Notify::new());
        let dropped = Arc::new(AtomicBool::new(false));
        let state = state_with(StubBehavior::Hang {
            entered: Arc::clone(&entered),
            dropped: Arc::clone(&dropped),
        });
        let admission = RequestAdmission {
            _permit: Arc::new(RequestPermit {
                permit: Arc::clone(&state.request_slots)
                    .try_acquire_owned()
                    .unwrap(),
            }),
        };
        let response = streaming_rpc_response(
            state.clone(),
            rpc(
                "tools/call",
                Some(json!(1)),
                json!({
                    "name": "dns_validate_record",
                    "arguments": {"record_type": "A", "content": "192.0.2.1"}
                }),
            ),
            admission,
        );
        let body_task = tokio::spawn(async move {
            let _ = to_bytes(response.into_body(), MAX_RESPONSE_BYTES).await;
        });
        entered.notified().await;
        body_task.abort();
        let _ = body_task.await;
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(state.tool_slots.available_permits(), 1);
        assert_eq!(state.request_slots.available_permits(), 2);
    }
}
