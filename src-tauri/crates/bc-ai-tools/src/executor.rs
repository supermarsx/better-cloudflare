//! Tool execution: bridges AI tool calls to MCP `execute_tool_with_grants`,
//! presenting the application's canonical permission grants on every call.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

use bc_ai_provider::limits::{
    serialized_len_limited, validate_string, MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_MESSAGE,
    MAX_TOOL_CALL_ID_BYTES, MAX_TOOL_NAME_BYTES, MAX_TOOL_RESULT_BYTES,
};
use bc_ai_provider::{AiProviderError, ToolCall, ToolDefinition, ToolResult};
use bc_error::sanitize_error_text;
use bc_mcp::permissions::{permission_for_invocation, PermissionGrantSet};
use bc_mcp::tools;
use bc_mcp::McpGrantHandle;

use crate::error::ToolExecutionError;
use crate::permissions::{
    self, AiPermissions, AiToolDescriptor, PermissionDecision, RefusalSource, ToolAvailability,
};
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
///
/// Two permission layers govern a call, and they compose as an *intersection*:
///
/// 1. `grants` — the application's canonical MCP permissions, read live from
///    [`bc_mcp::McpServerManager`]. This is what the application may do at all.
/// 2. `state` — the assistant's own mode plus per-tool overrides. This is what
///    the assistant may use, and it can only ever narrow layer 1.
///
/// Layer 1 is checked first, so an `allow` override or `autonomous` mode cannot
/// make an ungranted tool run, and the user is never prompted to approve a call
/// the application could not perform anyway.
pub struct ToolExecutor {
    registry: Arc<ToolRegistry>,
    /// Live view of the MCP grants. Default is an empty set: an executor built
    /// without a handle dispatches nothing, rather than everything.
    grants: McpGrantHandle,
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
    /// Create an executor that shares the given registry's enabled tool set
    /// and holds no MCP grants, so every dispatch is refused by the
    /// application layer until a grant handle is supplied.
    pub fn with_registry(registry: Arc<ToolRegistry>) -> Self {
        Self::with_registry_and_grants(registry, McpGrantHandle::default())
    }

    /// Create an executor governed by a live view of the application's MCP
    /// grants, obtained from `McpServerManager::grant_handle`.
    ///
    /// The handle is read-only, so the executor can observe the user's grants
    /// but never widen them.
    pub fn with_registry_and_grants(registry: Arc<ToolRegistry>, grants: McpGrantHandle) -> Self {
        Self {
            registry,
            grants,
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

    /// What the assistant can actually dispatch right now, across both layers.
    ///
    /// A renderer needs this to stop advertising tool use when the answer is
    /// "nothing": the assistant's own permissions alone cannot tell it,
    /// because dispatch is also gated on the application's MCP grants.
    ///
    /// Resolving availability dispatches nothing: it reads the registry, the
    /// grant set and the stored policy only.
    pub async fn availability(&self) -> ToolAvailability {
        let grants = self.grants.snapshot().await;
        let descriptors = self.registry.available_descriptors();
        let mut granted_tool_count = 0usize;
        let mut usable_tool_count = 0usize;
        for descriptor in &descriptors {
            if granted(&grants, &descriptor.name).is_err() {
                continue;
            }
            granted_tool_count = granted_tool_count.saturating_add(1);
            if !matches!(
                self.decision(&descriptor.name).await,
                PermissionDecision::Deny { .. }
            ) {
                usable_tool_count = usable_tool_count.saturating_add(1);
            }
        }
        ToolAvailability {
            dispatch_available: usable_tool_count > 0,
            granted_tool_count,
            usable_tool_count,
            registered_tool_count: descriptors.len(),
        }
    }

    /// Narrow a provider tool list to the tools that could actually run.
    ///
    /// Advertising a tool both layers would refuse only buys a refused round:
    /// the model calls it, is told no, and spends a turn on nothing. This is a
    /// presentation filter — enforcement still happens in [`Self::execute`].
    pub async fn usable_definitions(
        &self,
        definitions: Vec<ToolDefinition>,
    ) -> Vec<ToolDefinition> {
        let grants = self.grants.snapshot().await;
        let mut usable = Vec::with_capacity(definitions.len());
        for definition in definitions {
            if granted(&grants, &definition.name).is_ok()
                && !matches!(
                    self.decision(&definition.name).await,
                    PermissionDecision::Deny { .. }
                )
            {
                usable.push(definition);
            }
        }
        usable
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
    /// either permission layer refuses — `force` cannot override a denial.
    pub async fn execute(&self, tool_call: &ToolCall, force: bool) -> ExecutionResult {
        if let Err(error) = validate_tool_call(tool_call) {
            return ExecutionResult::Rejected(error);
        }

        // Layer 1: the application's MCP grants, read live. Checked first so a
        // tool the application cannot perform is refused outright rather than
        // offered to the user for approval. The same snapshot is handed to the
        // dispatcher below, which re-checks it authoritatively.
        let grants = self.grants.snapshot().await;
        if let Err(reason) = granted(&grants, &tool_call.name) {
            return ExecutionResult::Denied(ToolResult {
                tool_call_id: tool_call.id.clone(),
                content: permissions::refusal_text_from(RefusalSource::McpGrants, &reason),
                is_error: true,
            });
        }

        // Layer 2: the assistant's own policy, which may only narrow layer 1.
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

        // Dispatch through the single MCP boundary that enforces the grant,
        // the argument bounds and the high-risk acknowledgement. Presenting
        // the grants is the only way in; there is no ungated variant.
        match tools::execute_tool_with_grants(&grants, &tool_call.name, &tool_call.arguments).await
        {
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

/// Resolve one tool name against the application's MCP grants.
///
/// Fail-closed in both directions: a name the MCP registry does not define is
/// refused, and so is a registered tool the grant set does not cover. The
/// returned string is the reason, for the refusal the model is told about.
fn granted(grants: &PermissionGrantSet, tool_name: &str) -> Result<(), String> {
    match permission_for_invocation(tool_name) {
        None => Err(permissions::unregistered_reason(tool_name)),
        Some(permission) if !grants.allows(permission) => {
            Err(permissions::ungranted_reason(tool_name))
        }
        Some(_) => Ok(()),
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

    use crate::permissions::{
        AiPermissionMode, AiToolPermission, ASSISTANT_POLICY_REFUSAL_MARKER,
        MCP_GRANT_REFUSAL_MARKER, PERMISSION_REFUSAL_PREFIX,
    };

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

    /// A grant handle standing in for a user who enabled everything in the MCP
    /// tool permissions UI. Tests of the *assistant* layer need the outer layer
    /// open, or they would all be measuring the same MCP refusal.
    fn all_granted() -> McpGrantHandle {
        McpGrantHandle::new(PermissionGrantSet::all())
    }

    fn granting(names: &[&str]) -> McpGrantHandle {
        McpGrantHandle::new(PermissionGrantSet::from_requested(
            &names
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>(),
        ))
    }

    async fn executor_with(mode: AiPermissionMode) -> ToolExecutor {
        executor_with_grants(mode, all_granted()).await
    }

    async fn executor_with_grants(mode: AiPermissionMode, grants: McpGrantHandle) -> ToolExecutor {
        let registry = Arc::new(ToolRegistry::default());
        registry.init_all().await;
        let executor = ToolExecutor::with_registry_and_grants(registry, grants);
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

    /// A permitted call reaches the MCP dispatcher. The tools used here are
    /// called with empty arguments, so dispatch fails fast on a missing
    /// argument instead of touching the network — what this pins is that both
    /// permission layers passed the call through.
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
        let executor = ToolExecutor::with_registry_and_grants(registry, all_granted());
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

    /// The single most important property of the two-layer composition: the
    /// assistant's permissions can only *narrow* the application's MCP grants.
    /// The most permissive assistant configuration there is — `allow` override
    /// in `autonomous` mode — must not run a tool MCP has not granted.
    #[tokio::test]
    async fn an_allow_override_in_autonomous_mode_cannot_run_an_ungranted_tool() {
        let executor = executor_with_grants(
            AiPermissionMode::Autonomous,
            // The user granted one unrelated read tool, and nothing else.
            granting(&[READ_TOOL]),
        )
        .await;
        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::from([(WRITE_TOOL.to_string(), AiToolPermission::Allow)]),
            })
            .await
            .expect("valid permissions");

        assert_eq!(
            executor.decision(WRITE_TOOL).await,
            PermissionDecision::Allow,
            "the assistant layer must really be saying allow, or this proves nothing"
        );

        let denied = executor.execute(&call(WRITE_TOOL), false).await;
        let content = refusal(&denied);
        assert!(content.starts_with(PERMISSION_REFUSAL_PREFIX));
        assert!(
            content.contains(MCP_GRANT_REFUSAL_MARKER),
            "the refusal must name the MCP grants as the layer that refused: {content}"
        );
        // Approval cannot buy it either.
        assert!(refusal(&executor.execute_approved(&call(WRITE_TOOL)).await)
            .contains(MCP_GRANT_REFUSAL_MARKER));
        // The granted tool still runs, so the executor is not refusing wholesale.
        assert_reached_dispatch(&executor.execute(&call(READ_TOOL), false).await);
    }

    /// An executor with no grant handle at all holds an empty grant set, and
    /// an empty set grants nothing — the fail-closed default.
    #[tokio::test]
    async fn an_executor_without_a_grant_handle_dispatches_nothing() {
        let registry = Arc::new(ToolRegistry::default());
        registry.init_all().await;
        let executor = ToolExecutor::with_registry(registry);
        executor
            .try_set_permissions(AiPermissions {
                mode: AiPermissionMode::Autonomous,
                tools: BTreeMap::new(),
            })
            .await
            .expect("valid permissions");

        assert!(refusal(&executor.execute(&call(READ_TOOL), false).await)
            .contains(MCP_GRANT_REFUSAL_MARKER));
        let availability = executor.availability().await;
        assert!(!availability.dispatch_available);
        assert_eq!(availability.granted_tool_count, 0);
        assert_eq!(availability.usable_tool_count, 0);
    }

    /// A user who sees "refused" has to know which of the two permission lists
    /// to go and change.
    #[tokio::test]
    async fn a_refusal_names_the_layer_that_refused_it() {
        let executor =
            executor_with_grants(AiPermissionMode::ReadOnly, granting(&[WRITE_TOOL])).await;

        let own_policy = refusal(&executor.execute(&call(WRITE_TOOL), false).await).to_string();
        assert!(own_policy.contains("read-only"));
        assert!(own_policy.contains(ASSISTANT_POLICY_REFUSAL_MARKER));
        assert!(!own_policy.contains(MCP_GRANT_REFUSAL_MARKER));

        // The same tool, refused by the other layer instead.
        let ungranted = executor_with_grants(AiPermissionMode::Autonomous, granting(&[])).await;
        let mcp = refusal(&ungranted.execute(&call(WRITE_TOOL), false).await).to_string();
        assert!(mcp.contains(MCP_GRANT_REFUSAL_MARKER));
        assert!(!mcp.contains(ASSISTANT_POLICY_REFUSAL_MARKER));
    }

    /// A name no MCP permission defines is refused before anything else looks
    /// at it, even in the most permissive assistant configuration.
    #[tokio::test]
    async fn an_unregistered_tool_name_is_refused_by_the_mcp_layer() {
        let executor = executor_with(AiPermissionMode::Autonomous).await;
        let denied = executor.execute(&call("cf_not_a_tool_at_all"), false).await;
        let content = refusal(&denied);
        assert!(content.contains("not a registered MCP tool"));
        assert!(content.contains(MCP_GRANT_REFUSAL_MARKER));
    }

    /// An assistant-originated call is not a way around the argument bounds or
    /// the high-risk acknowledgement the MCP boundary enforces.
    #[tokio::test]
    async fn assistant_calls_still_face_mcp_argument_and_acknowledgement_checks() {
        let executor = executor_with(AiPermissionMode::Autonomous).await;

        let unacknowledged = executor.execute(&call(WRITE_TOOL), false).await;
        match &unacknowledged {
            ExecutionResult::Error(result) => assert!(
                result.content.contains("confirmHighRisk: true"),
                "a destructive tool must still demand acknowledgement: {}",
                result.content
            ),
            other => panic!("expected the acknowledgement error, got {other:?}"),
        }

        let oversized = ToolCall {
            id: "call-2".into(),
            name: "cf_bulk_delete_dns_records".into(),
            arguments: json!({
                "confirmHighRisk": true,
                "record_ids": (0..101).map(|index| format!("id-{index}")).collect::<Vec<_>>(),
            }),
        };
        match &executor.execute(&oversized, false).await {
            ExecutionResult::Error(result) => assert!(
                result.content.contains("100 item"),
                "the MCP argument profile must still bound the call: {}",
                result.content
            ),
            other => panic!("expected the argument-bound error, got {other:?}"),
        }
    }

    /// Availability is the intersection too, and reading it runs nothing.
    #[tokio::test]
    async fn availability_counts_both_layers() {
        let executor = executor_with_grants(
            AiPermissionMode::ReadOnly,
            granting(&[READ_TOOL, WRITE_TOOL]),
        )
        .await;
        let availability = executor.availability().await;
        assert_eq!(availability.granted_tool_count, 2);
        assert_eq!(
            availability.usable_tool_count, 1,
            "read-only mode denies the write, so only the read is usable"
        );
        assert!(availability.dispatch_available);
        assert_eq!(
            availability.registered_tool_count,
            bc_mcp::available_tool_definitions().len()
        );

        let definitions = executor
            .usable_definitions(
                [READ_TOOL, WRITE_TOOL, "dns_parse_spf"]
                    .into_iter()
                    .map(|name| ToolDefinition {
                        name: name.to_string(),
                        description: String::new(),
                        input_schema: json!({}),
                    })
                    .collect(),
            )
            .await;
        assert_eq!(
            definitions
                .iter()
                .map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            vec![READ_TOOL],
            "only the granted, non-denied tool is worth advertising"
        );
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
