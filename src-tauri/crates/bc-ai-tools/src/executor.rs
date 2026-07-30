//! Tool execution: bridges AI tool calls to MCP `execute_tool`.

use serde_json::Value;

use bc_ai_provider::limits::{
    serialized_len_limited, validate_string, MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_MESSAGE,
    MAX_TOOL_CALL_ID_BYTES, MAX_TOOL_NAME_BYTES, MAX_TOOL_RESULT_BYTES,
};
use bc_ai_provider::{AiProviderError, ToolCall, ToolResult};
use bc_error::sanitize_error_text;
use bc_mcp::tools;

use crate::error::ToolExecutionError;
use crate::safety::{SafetyPolicy, ToolApproval};

const MAX_TOOL_VALUE_DEPTH: usize = 64;
const MAX_TOOL_VALUE_NODES: usize = 16_384;
const MAX_TOOL_COLLECTION_ITEMS: usize = 4_096;

/// Tool executor that runs tool calls through the MCP engine.
#[derive(Default)]
pub struct ToolExecutor {
    policy: SafetyPolicy,
}

/// Result of attempting to execute a tool call.
#[derive(Debug, Clone)]
pub enum ExecutionResult {
    /// Tool executed successfully.
    Success(ToolResult),
    /// Tool requires user approval first.
    NeedsApproval { tool_call: ToolCall, reason: String },
    /// Tool execution failed.
    Error(ToolResult),
    /// The call or result violated a local safety boundary.
    Rejected(ToolExecutionError),
}

impl ToolExecutor {
    /// Create with a specific safety policy.
    pub fn with_policy(policy: SafetyPolicy) -> Self {
        Self { policy }
    }

    /// Update the safety policy.
    pub fn set_policy(&mut self, policy: SafetyPolicy) {
        self.policy = policy;
    }

    /// Check approval for a tool call without executing.
    pub fn check_approval(&self, tool_call: &ToolCall) -> ToolApproval {
        self.policy.check(&tool_call.name)
    }

    /// Execute a single tool call. Returns `NeedsApproval` for destructive
    /// operations unless `force` is true.
    pub async fn execute(&self, tool_call: &ToolCall, force: bool) -> ExecutionResult {
        if let Err(error) = validate_tool_call(tool_call) {
            return ExecutionResult::Rejected(error);
        }

        // Check safety policy
        if !force {
            if let ToolApproval::RequiresApproval { reason } = self.policy.check(&tool_call.name) {
                return ExecutionResult::NeedsApproval {
                    tool_call: tool_call.clone(),
                    reason,
                };
            }
        }

        // Execute via MCP
        match tools::execute_tool(&tool_call.name, &tool_call.arguments).await {
            Ok(value) => match format_tool_output(&value) {
                Ok(content) => ExecutionResult::Success(ToolResult {
                    tool_call_id: tool_call.id.clone(),
                    content,
                    is_error: false,
                }),
                Err(error) => ExecutionResult::Rejected(error),
            },
            Err(error) => match bounded_tool_error(&error) {
                Ok(content) => ExecutionResult::Error(ToolResult {
                    tool_call_id: tool_call.id.clone(),
                    content,
                    is_error: true,
                }),
                Err(error) => ExecutionResult::Rejected(error),
            },
        }
    }

    /// Execute a tool call that has been explicitly approved by the user.
    pub async fn execute_approved(&self, tool_call: &ToolCall) -> ExecutionResult {
        self.execute(tool_call, true).await
    }

    /// Execute multiple tool calls, returning results for auto-approved
    /// ones and NeedsApproval for destructive ones.
    pub async fn execute_batch(
        &self,
        tool_calls: &[ToolCall],
    ) -> Result<Vec<ExecutionResult>, ToolExecutionError> {
        if tool_calls.len() > MAX_TOOL_CALLS_PER_MESSAGE {
            return Err(ToolExecutionError::LimitExceeded {
                resource: "tool-call batch",
                limit: MAX_TOOL_CALLS_PER_MESSAGE,
                actual: tool_calls.len(),
            });
        }
        let mut results = Vec::with_capacity(tool_calls.len());
        for tc in tool_calls {
            results.push(self.execute(tc, false).await);
        }
        Ok(results)
    }
}

fn map_provider_limit(error: AiProviderError) -> ToolExecutionError {
    match error {
        AiProviderError::LimitExceeded {
            resource,
            limit,
            actual,
        } => ToolExecutionError::LimitExceeded {
            resource,
            limit,
            actual,
        },
        _ => ToolExecutionError::InvalidInput {
            field: "toolCall",
            message: "failed bounded validation",
        },
    }
}

fn validate_tool_call(tool_call: &ToolCall) -> Result<(), ToolExecutionError> {
    validate_string("tool-call id", &tool_call.id, MAX_TOOL_CALL_ID_BYTES)
        .map_err(map_provider_limit)?;
    validate_string("tool name", &tool_call.name, MAX_TOOL_NAME_BYTES)
        .map_err(map_provider_limit)?;
    if !tool_call.arguments.is_object() {
        return Err(ToolExecutionError::InvalidInput {
            field: "arguments",
            message: "must be a JSON object",
        });
    }
    validate_value_shape(&tool_call.arguments, "tool-call arguments")?;
    serialized_len_limited(
        "tool-call arguments",
        &tool_call.arguments,
        MAX_TOOL_ARGUMENT_BYTES,
    )
    .map_err(map_provider_limit)?;
    Ok(())
}

fn validate_value_shape(root: &Value, resource: &'static str) -> Result<(), ToolExecutionError> {
    let mut stack = vec![(root, 0usize)];
    let mut nodes = 0usize;
    while let Some((value, depth)) = stack.pop() {
        nodes = nodes.saturating_add(1);
        if nodes > MAX_TOOL_VALUE_NODES {
            return Err(ToolExecutionError::LimitExceeded {
                resource,
                limit: MAX_TOOL_VALUE_NODES,
                actual: nodes,
            });
        }
        if depth > MAX_TOOL_VALUE_DEPTH {
            return Err(ToolExecutionError::LimitExceeded {
                resource: "tool value depth",
                limit: MAX_TOOL_VALUE_DEPTH,
                actual: depth,
            });
        }
        let children: Vec<&Value> = match value {
            Value::Array(values) => {
                if values.len() > MAX_TOOL_COLLECTION_ITEMS {
                    return Err(ToolExecutionError::LimitExceeded {
                        resource: "tool array items",
                        limit: MAX_TOOL_COLLECTION_ITEMS,
                        actual: values.len(),
                    });
                }
                values.iter().collect()
            }
            Value::Object(values) => {
                if values.len() > MAX_TOOL_COLLECTION_ITEMS {
                    return Err(ToolExecutionError::LimitExceeded {
                        resource: "tool object fields",
                        limit: MAX_TOOL_COLLECTION_ITEMS,
                        actual: values.len(),
                    });
                }
                values.values().collect()
            }
            _ => Vec::new(),
        };
        if stack.len().saturating_add(children.len()) > MAX_TOOL_VALUE_NODES {
            return Err(ToolExecutionError::LimitExceeded {
                resource,
                limit: MAX_TOOL_VALUE_NODES,
                actual: stack.len().saturating_add(children.len()),
            });
        }
        stack.extend(
            children
                .into_iter()
                .rev()
                .map(|child| (child, depth.saturating_add(1))),
        );
    }
    Ok(())
}

/// Format a tool output without creating an unrestricted second copy.
fn format_tool_output(value: &Value) -> Result<String, ToolExecutionError> {
    validate_value_shape(value, "tool result nodes")?;
    match value {
        Value::String(value) => {
            if value.len() > MAX_TOOL_RESULT_BYTES {
                return Err(ToolExecutionError::LimitExceeded {
                    resource: "tool result",
                    limit: MAX_TOOL_RESULT_BYTES,
                    actual: value.len(),
                });
            }
            Ok(value.clone())
        }
        other => {
            serialized_len_limited("tool result", other, MAX_TOOL_RESULT_BYTES)
                .map_err(map_provider_limit)?;
            serde_json::to_string(other).map_err(|_| ToolExecutionError::Serialization)
        }
    }
}

fn bounded_tool_error(error: &str) -> Result<String, ToolExecutionError> {
    if error.len() > MAX_TOOL_RESULT_BYTES {
        return Err(ToolExecutionError::LimitExceeded {
            resource: "tool error",
            limit: MAX_TOOL_RESULT_BYTES,
            actual: error.len(),
        });
    }
    Ok(sanitize_error_text(error))
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map};

    use super::*;

    #[test]
    fn oversized_tool_arguments_are_rejected_before_dispatch() {
        let call = ToolCall {
            id: "call-1".into(),
            name: "dns_parse_spf".into(),
            arguments: json!({"content": "x".repeat(MAX_TOOL_ARGUMENT_BYTES)}),
        };
        assert!(matches!(
            validate_tool_call(&call),
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool-call arguments",
                ..
            })
        ));
    }

    #[test]
    fn tool_output_is_bounded_before_secondary_materialization() {
        let value = Value::String("x".repeat(MAX_TOOL_RESULT_BYTES + 1));
        assert!(matches!(
            format_tool_output(&value),
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool result",
                ..
            })
        ));

        let mut object = Map::new();
        for index in 0..=MAX_TOOL_COLLECTION_ITEMS {
            object.insert(index.to_string(), Value::Null);
        }
        assert!(matches!(
            format_tool_output(&Value::Object(object)),
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool object fields",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn oversized_batch_is_rejected_before_result_allocation() {
        let executor = ToolExecutor::default();
        let calls = (0..=MAX_TOOL_CALLS_PER_MESSAGE)
            .map(|index| ToolCall {
                id: format!("call-{index}"),
                name: "dns_parse_spf".into(),
                arguments: json!({"content": "v=spf1 -all"}),
            })
            .collect::<Vec<_>>();
        assert!(matches!(
            executor.execute_batch(&calls).await,
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool-call batch",
                ..
            })
        ));
    }

    #[test]
    fn tool_errors_are_redacted_and_bounded() {
        let output = bounded_tool_error(
            "Authorization: Bearer super-secret token=also-secret ordinary context",
        )
        .expect("bounded error");
        assert!(!output.contains("super-secret"));
        assert!(!output.contains("also-secret"));
        assert!(output.contains("[redacted]"));

        assert!(matches!(
            bounded_tool_error(&"x".repeat(MAX_TOOL_RESULT_BYTES + 1)),
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool error",
                ..
            })
        ));
    }
}
