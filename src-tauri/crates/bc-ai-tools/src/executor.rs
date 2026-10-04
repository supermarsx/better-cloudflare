//! Tool execution: bridges AI tool calls to MCP `execute_tool`.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

use bc_ai_provider::limits::{
    serialized_len_limited, validate_string, MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_MESSAGE,
    MAX_TOOL_CALL_ID_BYTES, MAX_TOOL_NAME_BYTES, MAX_TOOL_RESULT_BYTES,
};
use bc_ai_provider::{AiProviderError, ToolCall, ToolResult};
use bc_error::sanitize_error_text;
use bc_mcp::tools;

use crate::error::ToolExecutionError;
use crate::permissions::{self, AiPermissions, AiToolDescriptor, PermissionDecision};
use crate::registry::ToolRegistry;

const MAX_TOOL_VALUE_DEPTH: usize = 64;
const MAX_TOOL_VALUE_NODES: usize = 16_384;
const MAX_TOOL_COLLECTION_ITEMS: usize = 4_096;

/// Permission state consulted on every dispatch.
///
/// `tools_enabled` mirrors the agent configuration flag of the same name; the
/// agent manager pushes it here because enforcement has to happen next to the
/// dispatch, and the configuration lives a crate above.
#[derive(Debug, Clone)]
struct PermissionState {
    tools_enabled: bool,
    permissions: AiPermissions,
}

impl Default for PermissionState {
    fn default() -> Self {
        Self {
            tools_enabled: true,
            permissions: AiPermissions::default(),
        }
    }
}

/// Tool executor that runs tool calls through the MCP engine.
///
/// This is the authoritative permission boundary: every path that can run a
/// tool goes through [`ToolExecutor::execute`], so a renderer that skips its
/// own checks — or is bypassed entirely — still cannot run a denied tool.
pub struct ToolExecutor {
    registry: Arc<ToolRegistry>,
    state: RwLock<PermissionState>,
}

impl Default for ToolExecutor {
    fn default() -> Self {
        Self::with_registry(Arc::new(ToolRegistry::default()))
    }
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
    /// The permission policy refused the call. Nothing was dispatched, and the
    /// carried result is the refusal the model must be told about.
    Denied(ToolResult),
    /// The call or result violated a local safety boundary.
    Rejected(ToolExecutionError),
}

impl ToolExecutor {
    /// Create an executor that shares the given registry's enabled tool set.
    pub fn with_registry(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            state: RwLock::new(PermissionState::default()),
        }
    }

    /// Current permission configuration.
    pub async fn permissions(&self) -> AiPermissions {
        self.state.read().await.permissions.clone()
    }

    /// Validate and store a permission configuration, returning what was
    /// stored. An invalid map is never retained.
    pub async fn try_set_permissions(
        &self,
        permissions: AiPermissions,
    ) -> Result<AiPermissions, ToolExecutionError> {
        permissions.validate()?;
        let mut state = self.state.write().await;
        state.permissions = permissions;
        Ok(state.permissions.clone())
    }

    /// Mirror the agent configuration's `tools_enabled` flag.
    pub async fn set_tools_enabled(&self, enabled: bool) {
        self.state.write().await.tools_enabled = enabled;
    }

    /// Whether tool use is currently enabled at all.
    pub async fn tools_enabled(&self) -> bool {
        self.state.read().await.tools_enabled
    }

    /// Resolve the decision for one tool name.
    ///
    /// A tool outside the registry's enabled set is denied before the
    /// configured algorithm runs. That gate only ever refuses more, so it
    /// cannot turn a deny into an allow.
    pub async fn decision(&self, tool_name: &str) -> PermissionDecision {
        if !self.registry.is_enabled(tool_name).await {
            return PermissionDecision::Deny {
                reason: format!("tool '{tool_name}' is not in the enabled tool set"),
            };
        }
        let state = self.state.read().await;
        permissions::resolve(state.tools_enabled, &state.permissions, tool_name)
    }

    /// Every registered tool with its effective permission resolved.
    pub async fn catalog(&self) -> Vec<AiToolDescriptor> {
        let mut catalog = Vec::new();
        for descriptor in self.registry.available_descriptors() {
            let permission = self.decision(&descriptor.name).await.effective();
            catalog.push(AiToolDescriptor {
                classification: permissions::classify(&descriptor.name),
                name: descriptor.name,
                description: descriptor.description,
                permission,
            });
        }
        catalog
    }

    /// Execute a single tool call. Returns `NeedsApproval` for calls the
    /// policy wants confirmed unless `force` is true, and `Denied` for calls
    /// the policy refuses — `force` cannot override a denial.
    pub async fn execute(&self, tool_call: &ToolCall, force: bool) -> ExecutionResult {
        if let Err(error) = validate_tool_call(tool_call) {
            return ExecutionResult::Rejected(error);
        }

        // Authoritative permission gate, applied at the dispatch boundary.
        match self.decision(&tool_call.name).await {
            PermissionDecision::Deny { reason } => {
                return ExecutionResult::Denied(ToolResult {
                    tool_call_id: tool_call.id.clone(),
                    content: permissions::refusal_text(&reason),
                    is_error: true,
                });
            }
            PermissionDecision::Ask { reason } if !force => {
                return ExecutionResult::NeedsApproval {
                    tool_call: tool_call.clone(),
                    reason,
                };
            }
            PermissionDecision::Ask { .. } | PermissionDecision::Allow => {}
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
    ///
    /// Approval satisfies an `ask`; it does not override a `deny`, so a
    /// permission that changed while the call was pending is still honoured.
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
    use std::collections::{BTreeMap, HashSet};

    use serde_json::{json, Map};

    use crate::permissions::{AiPermissionMode, AiToolPermission, PERMISSION_REFUSAL_PREFIX};

    use super::*;

    const READ_TOOL: &str = "cf_list_zones";
    const WRITE_TOOL: &str = "cf_delete_dns_record";

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments: json!({}),
        }
    }

    async fn executor_with(mode: AiPermissionMode) -> ToolExecutor {
        let registry = Arc::new(ToolRegistry::default());
        registry.init_all().await;
        let executor = ToolExecutor::with_registry(registry);
        executor
            .try_set_permissions(AiPermissions {
                mode,
                tools: BTreeMap::new(),
            })
            .await
            .expect("valid permissions");
        executor
    }

    fn refusal(result: &ExecutionResult) -> &str {
        match result {
            ExecutionResult::Denied(result) => &result.content,
            other => panic!("expected a denial, got {other:?}"),
        }
    }

    /// In-process MCP dispatch is itself denied without canonical grants, so a
    /// permitted call cannot be observed as `Success` here. What it *can* be
    /// observed as is "not refused by us" — the permission gate let it reach
    /// the dispatch boundary.
    fn assert_reached_dispatch(result: &ExecutionResult) {
        match result {
            ExecutionResult::Success(result) | ExecutionResult::Error(result) => assert!(
                !result.content.starts_with(PERMISSION_REFUSAL_PREFIX),
                "a permitted call must not be refused: {}",
                result.content
            ),
            other => panic!("expected the call to reach dispatch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_only_mode_refuses_a_write_without_dispatching_it() {
        let executor = executor_with(AiPermissionMode::ReadOnly).await;
        let result = executor.execute(&call(WRITE_TOOL), false).await;
        let content = refusal(&result);
        assert!(content.starts_with(PERMISSION_REFUSAL_PREFIX));
        assert!(content.contains("read-only"));
    }

    #[tokio::test]
    async fn approval_cannot_override_a_denial() {
        let executor = executor_with(AiPermissionMode::ReadOnly).await;
        let forced = executor.execute(&call(WRITE_TOOL), true).await;
        assert!(refusal(&forced).starts_with(PERMISSION_REFUSAL_PREFIX));
        let approved = executor.execute_approved(&call(WRITE_TOOL)).await;
        assert!(refusal(&approved).starts_with(PERMISSION_REFUSAL_PREFIX));
    }

    #[tokio::test]
    async fn disabling_tool_use_refuses_even_read_only_tools() {
        let executor = executor_with(AiPermissionMode::Autonomous).await;
        assert_reached_dispatch(&executor.execute(&call(READ_TOOL), false).await);

        executor.set_tools_enabled(false).await;
        let result = executor.execute(&call(READ_TOOL), false).await;
        assert!(refusal(&result).contains("disabled"));
    }

    #[tokio::test]
    async fn an_explicit_deny_outranks_autonomous_mode() {
        let executor = executor_with(AiPermissionMode::Autonomous).await;
        assert_reached_dispatch(&executor.execute(&call(READ_TOOL), false).await);

        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([(READ_TOOL.to_string(), AiToolPermission::Deny)]),
            })
            .await
            .expect("valid permissions");
        assert!(refusal(&executor.execute(&call(READ_TOOL), false).await)
            .starts_with(PERMISSION_REFUSAL_PREFIX));
    }

    #[tokio::test]
    async fn ask_mode_pauses_writes_and_runs_reads() {
        let executor = executor_with(AiPermissionMode::Ask).await;
        assert!(matches!(
            executor.execute(&call(WRITE_TOOL), false).await,
            ExecutionResult::NeedsApproval { .. }
        ));
        assert_reached_dispatch(&executor.execute(&call(READ_TOOL), false).await);
        // An approved ask does run.
        assert_reached_dispatch(&executor.execute_approved(&call(WRITE_TOOL)).await);
    }

    #[tokio::test]
    async fn a_tool_outside_the_enabled_set_is_refused() {
        let registry = Arc::new(ToolRegistry::default());
        registry
            .set_enabled(HashSet::from([READ_TOOL.to_string()]))
            .await;
        let executor = ToolExecutor::with_registry(registry);
        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([(WRITE_TOOL.to_string(), AiToolPermission::Allow)]),
            })
            .await
            .expect("valid permissions");

        assert_reached_dispatch(&executor.execute(&call(READ_TOOL), false).await);
        assert!(refusal(&executor.execute(&call(WRITE_TOOL), false).await).contains("enabled"));
    }

    #[tokio::test]
    async fn an_invalid_permission_map_is_not_retained() {
        let executor = executor_with(AiPermissionMode::ReadOnly).await;
        let error = executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([("cf_not_a_tool".to_string(), AiToolPermission::Allow)]),
            })
            .await
            .expect_err("unknown tool names must be rejected");
        assert!(matches!(
            error,
            ToolExecutionError::InvalidInput {
                field: "permissions.tools",
                ..
            }
        ));
        assert_eq!(
            executor.permissions().await.mode,
            AiPermissionMode::ReadOnly
        );
        assert!(executor.permissions().await.tools.is_empty());
    }

    #[tokio::test]
    async fn the_catalog_resolves_every_registered_tool_the_way_dispatch_does() {
        let executor = executor_with(AiPermissionMode::ReadOnly).await;
        let catalog = executor.catalog().await;
        assert_eq!(catalog.len(), bc_mcp::available_tool_definitions().len());
        for descriptor in &catalog {
            assert_eq!(
                descriptor.permission,
                executor.decision(&descriptor.name).await.effective(),
                "catalog and dispatch disagree about {}",
                descriptor.name
            );
        }
        let read = catalog
            .iter()
            .find(|descriptor| descriptor.name == READ_TOOL)
            .expect("read tool is registered");
        assert_eq!(read.permission, AiToolPermission::Allow);
        let write = catalog
            .iter()
            .find(|descriptor| descriptor.name == WRITE_TOOL)
            .expect("write tool is registered");
        assert_eq!(write.permission, AiToolPermission::Deny);
        assert!(!write.description.is_empty());
    }

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
