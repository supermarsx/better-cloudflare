//! Fail-closed resource budgets for the MCP transport and JSON-RPC boundary.
//!
//! These limits are deliberately independent from per-tool permission profiles.
//! The transport budget protects parsing and dispatch; the narrower permission
//! profiles continue to protect each registered tool contract.

use std::io::{self, Write};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub(crate) const MAX_CONNECTIONS: usize = 64;
pub(crate) const MAX_IN_FLIGHT_REQUESTS: usize = 16;
pub(crate) const MAX_IN_FLIGHT_TOOLS: usize = 8;
pub(crate) const MAX_HEADER_COUNT: usize = 48;
pub(crate) const MAX_HEADER_BYTES: usize = 16 * 1024;
pub(crate) const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 512 * 1024;
pub(crate) const MAX_BATCH_ITEMS: usize = 16;
pub(crate) const MAX_METHOD_BYTES: usize = 128;
pub(crate) const MAX_ID_STRING_BYTES: usize = 256;
pub(crate) const MAX_ERROR_MESSAGE_BYTES: usize = 4 * 1024;
pub(crate) const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_TOOL_RESULT_BYTES: usize = 384 * 1024;
pub(crate) const MAX_AUTH_TOKEN_BYTES: usize = 256;
pub(crate) const MAX_CONFIGURED_GRANTS: usize = 128;

#[derive(Debug, Clone, Copy)]
pub(crate) struct RuntimePolicy {
    pub(crate) max_connections: usize,
    pub(crate) max_in_flight_requests: usize,
    pub(crate) max_in_flight_tools: usize,
    pub(crate) max_request_body_bytes: usize,
    pub(crate) max_batch_items: usize,
    pub(crate) max_response_bytes: usize,
    pub(crate) max_tool_result_bytes: usize,
    pub(crate) header_read_timeout: Duration,
    pub(crate) request_body_timeout: Duration,
    pub(crate) request_timeout: Duration,
    pub(crate) tool_timeout: Duration,
    pub(crate) connection_timeout: Duration,
    pub(crate) shutdown_grace: Duration,
}

impl Default for RuntimePolicy {
    fn default() -> Self {
        Self {
            max_connections: MAX_CONNECTIONS,
            max_in_flight_requests: MAX_IN_FLIGHT_REQUESTS,
            max_in_flight_tools: MAX_IN_FLIGHT_TOOLS,
            max_request_body_bytes: MAX_REQUEST_BODY_BYTES,
            max_batch_items: MAX_BATCH_ITEMS,
            max_response_bytes: MAX_RESPONSE_BYTES,
            max_tool_result_bytes: MAX_TOOL_RESULT_BYTES,
            header_read_timeout: Duration::from_secs(5),
            request_body_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(65),
            tool_timeout: Duration::from_secs(60),
            connection_timeout: Duration::from_secs(120),
            shutdown_grace: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct JsonLimits {
    pub(crate) max_depth: usize,
    pub(crate) max_nodes: usize,
    pub(crate) max_string_bytes: usize,
    pub(crate) max_total_string_bytes: usize,
    pub(crate) max_array_items: usize,
    pub(crate) max_object_members: usize,
}

pub(crate) const INBOUND_JSON_LIMITS: JsonLimits = JsonLimits {
    max_depth: 32,
    max_nodes: 12_000,
    max_string_bytes: 192 * 1024,
    max_total_string_bytes: 384 * 1024,
    max_array_items: 1_024,
    max_object_members: 256,
};

pub(crate) const TOOL_RESULT_JSON_LIMITS: JsonLimits = JsonLimits {
    max_depth: 32,
    max_nodes: 20_000,
    max_string_bytes: 320 * 1024,
    max_total_string_bytes: 384 * 1024,
    max_array_items: 5_000,
    max_object_members: 512,
};

pub(crate) const RESPONSE_JSON_LIMITS: JsonLimits = JsonLimits {
    max_depth: 36,
    max_nodes: 40_000,
    max_string_bytes: 768 * 1024,
    max_total_string_bytes: 896 * 1024,
    max_array_items: 10_000,
    max_object_members: 512,
};

/// Validate a parsed JSON tree without recursion so adversarial nesting cannot
/// consume the Rust call stack.
pub(crate) fn validate_json(value: &Value, limits: JsonLimits) -> Result<(), &'static str> {
    let mut stack = Vec::with_capacity(limits.max_depth.min(64));
    stack.push((value, 1usize));
    let mut nodes = 0usize;
    let mut string_bytes = 0usize;

    while let Some((next, depth)) = stack.pop() {
        nodes = nodes.checked_add(1).ok_or("JSON node budget overflowed")?;
        if nodes > limits.max_nodes {
            return Err("JSON contains too many values");
        }
        if depth > limits.max_depth {
            return Err("JSON nesting is too deep");
        }

        match next {
            Value::String(text) => {
                if text.len() > limits.max_string_bytes {
                    return Err("JSON string is too large");
                }
                string_bytes = string_bytes
                    .checked_add(text.len())
                    .ok_or("JSON string budget overflowed")?;
            }
            Value::Array(items) => {
                if items.len() > limits.max_array_items {
                    return Err("JSON array contains too many items");
                }
                stack.reserve(items.len().min(limits.max_nodes.saturating_sub(nodes)));
                for item in items {
                    stack.push((item, depth + 1));
                }
            }
            Value::Object(entries) => {
                if entries.len() > limits.max_object_members {
                    return Err("JSON object contains too many members");
                }
                stack.reserve(entries.len().min(limits.max_nodes.saturating_sub(nodes)));
                for (key, item) in entries {
                    if key.len() > limits.max_string_bytes {
                        return Err("JSON object key is too large");
                    }
                    string_bytes = string_bytes
                        .checked_add(key.len())
                        .ok_or("JSON string budget overflowed")?;
                    stack.push((item, depth + 1));
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
        if string_bytes > limits.max_total_string_bytes {
            return Err("JSON contains too much string data");
        }
    }
    Ok(())
}

/// Bound an untrusted error or diagnostic string while preserving UTF-8.
pub(crate) fn bounded_message(message: &str) -> String {
    let mut bounded = String::with_capacity(message.len().min(MAX_ERROR_MESSAGE_BYTES));
    for character in message.chars() {
        let next_len = bounded.len() + character.len_utf8();
        if next_len > MAX_ERROR_MESSAGE_BYTES {
            bounded.push_str("...");
            break;
        }
        if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
            bounded.push('\u{fffd}');
        } else {
            bounded.push(character);
        }
    }
    bounded
}

#[derive(Debug)]
struct LimitedWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl LimitedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(8 * 1024)),
            limit,
        }
    }
}

impl Write for LimitedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let remaining = self.limit.saturating_sub(self.bytes.len());
        if buffer.len() > remaining {
            return Err(io::Error::other("serialized JSON exceeds its byte budget"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Serialize once into a writer that refuses to grow past the configured cap.
pub(crate) fn serialize_json_limited<T: Serialize>(
    value: &T,
    limit: usize,
) -> Result<Vec<u8>, &'static str> {
    let mut writer = LimitedWriter::new(limit);
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| "JSON response exceeds its byte budget")?;
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn iterative_json_validation_rejects_depth_counts_and_string_budgets() {
        let limits = JsonLimits {
            max_depth: 3,
            max_nodes: 6,
            max_string_bytes: 4,
            max_total_string_bytes: 6,
            max_array_items: 2,
            max_object_members: 2,
        };

        assert!(validate_json(&json!({"ok": ["a", "b"]}), limits).is_ok());
        assert_eq!(
            validate_json(&json!({"a": {"b": {"c": null}}}), limits),
            Err("JSON nesting is too deep")
        );
        assert_eq!(
            validate_json(&json!([1, 2, 3]), limits),
            Err("JSON array contains too many items")
        );
        assert_eq!(
            validate_json(&json!({"v": "12345"}), limits),
            Err("JSON string is too large")
        );
    }

    #[test]
    fn inbound_depth_and_collection_boundaries_are_exact() {
        let mut at_depth_limit = Value::Null;
        for _ in 1..INBOUND_JSON_LIMITS.max_depth {
            at_depth_limit = json!({ "v": at_depth_limit });
        }
        assert!(validate_json(&at_depth_limit, INBOUND_JSON_LIMITS).is_ok());
        let above_depth_limit = json!({ "v": at_depth_limit });
        assert_eq!(
            validate_json(&above_depth_limit, INBOUND_JSON_LIMITS),
            Err("JSON nesting is too deep")
        );

        let at_array_limit = Value::Array(vec![Value::Null; INBOUND_JSON_LIMITS.max_array_items]);
        assert!(validate_json(&at_array_limit, INBOUND_JSON_LIMITS).is_ok());
        let above_array_limit =
            Value::Array(vec![Value::Null; INBOUND_JSON_LIMITS.max_array_items + 1]);
        assert_eq!(
            validate_json(&above_array_limit, INBOUND_JSON_LIMITS),
            Err("JSON array contains too many items")
        );
    }

    #[test]
    fn limited_serializer_never_crosses_the_requested_cap() {
        let value = json!({"payload": "x".repeat(512)});
        assert!(serialize_json_limited(&value, 128).is_err());
        let encoded = serialize_json_limited(&value, 1024).unwrap();
        assert!(encoded.len() <= 1024);
    }

    #[test]
    fn bounded_messages_preserve_utf8_and_strip_controls() {
        let message = format!("start\u{0001}{}", "é".repeat(MAX_ERROR_MESSAGE_BYTES));
        let bounded = bounded_message(&message);
        assert!(bounded.len() <= MAX_ERROR_MESSAGE_BYTES + 3);
        assert!(bounded.contains('\u{fffd}'));
        assert!(bounded.ends_with("..."));
    }
}
