//! Tool execution: bridges AI tool calls to MCP `execute_tool`.

use serde_json::Value;

use bc_ai_provider::{ToolCall, ToolResult};
use bc_mcp::tools;

use crate::safety::{SafetyPolicy, ToolApproval};

/// Tool executor that runs tool calls through the MCP engine.
pub struct ToolExecutor {
    policy: SafetyPolicy,
}

impl Default for ToolExecutor {
    fn default() -> Self {
        Self {
            policy: SafetyPolicy::default(),
        }
    }
}

/// Result of attempting to execute a tool call.
#[derive(Debug, Clone)]
pub enum ExecutionResult {
    /// Tool executed successfully.
    Success(ToolResult),
    /// Tool requires user approval first.
    NeedsApproval {
        tool_call: ToolCall,
        reason: String,
    },
    /// Tool execution failed.
    Error(ToolResult),
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
            Ok(value) => ExecutionResult::Success(ToolResult {
                tool_call_id: tool_call.id.clone(),
                content: format_tool_output(&value),
                is_error: false,
            }),
            Err(err) => ExecutionResult::Error(ToolResult {
                tool_call_id: tool_call.id.clone(),
                content: err,
                is_error: true,
            }),
        }
    }

    /// Execute a tool call that has been explicitly approved by the user.
    pub async fn execute_approved(&self, tool_call: &ToolCall) -> ExecutionResult {
        self.execute(tool_call, true).await
    }

    /// Execute multiple tool calls, returning results for auto-approved
    /// ones and NeedsApproval for destructive ones.
    pub async fn execute_batch(&self, tool_calls: &[ToolCall]) -> Vec<ExecutionResult> {
        let mut results = Vec::with_capacity(tool_calls.len());
        for tc in tool_calls {
            results.push(self.execute(tc, false).await);
        }
        results
    }
}

/// Format a tool output Value into a string for the AI.
fn format_tool_output(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}
