//! Safety policies for tool execution.
//!
//! Classifies tools as read-only (auto-approve) or destructive (require
//! user confirmation before execution).

use serde::{Deserialize, Serialize};

/// Whether a tool call requires user approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolApproval {
    /// Auto-approved: safe, read-only operations.
    AutoApprove,
    /// Requires explicit user confirmation before execution.
    RequiresApproval { reason: String },
}

/// Safety policy configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyPolicy {
    /// If true, require approval for ALL tool calls.
    pub require_all_approval: bool,
    /// If true, auto-approve read-only tools.
    pub auto_approve_reads: bool,
}

impl Default for SafetyPolicy {
    fn default() -> Self {
        Self {
            require_all_approval: false,
            auto_approve_reads: true,
        }
    }
}

impl SafetyPolicy {
    /// Determine if a tool call requires user approval.
    pub fn check(&self, tool_name: &str) -> ToolApproval {
        if self.require_all_approval {
            return ToolApproval::RequiresApproval {
                reason: "All tool calls require approval per policy".into(),
            };
        }

        if self.auto_approve_reads && is_read_only(tool_name) {
            return ToolApproval::AutoApprove;
        }

        if is_destructive(tool_name) {
            return ToolApproval::RequiresApproval {
                reason: format!(
                    "Tool '{}' performs a write/delete operation",
                    tool_name
                ),
            };
        }

        // Default: auto-approve non-destructive, non-write tools
        ToolApproval::AutoApprove
    }
}

/// Categorise a tool as read-only by name prefix/pattern.
fn is_read_only(name: &str) -> bool {
    // Read patterns: list, get, export, parse, compose, check, resolve, simulate, validate
    let read_prefixes = [
        "cf_list_",
        "cf_get_",
        "cf_export_",
        "dns_check_",
        "dns_resolve_",
        "dns_validate_",
        "dns_parse_",
        "dns_compose_",
        "dns_export_",
        "spf_simulate",
        "spf_graph",
        "spf_parse",
        "audit_",
        "cf_verify_",
    ];
    read_prefixes.iter().any(|p| name.starts_with(p))
}

/// Categorise a tool as destructive (creates, updates, or deletes resources).
fn is_destructive(name: &str) -> bool {
    let write_patterns = [
        "cf_create_",
        "cf_update_",
        "cf_delete_",
        "cf_bulk_create_",
        "cf_bulk_delete_",
        "cf_purge_",
    ];
    write_patterns.iter().any(|p| name.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_only_auto_approved() {
        let policy = SafetyPolicy::default();
        assert_eq!(policy.check("cf_list_zones"), ToolApproval::AutoApprove);
        assert_eq!(policy.check("dns_validate_record"), ToolApproval::AutoApprove);
        assert_eq!(policy.check("spf_parse"), ToolApproval::AutoApprove);
    }

    #[test]
    fn test_destructive_requires_approval() {
        let policy = SafetyPolicy::default();
        match policy.check("cf_create_dns_record") {
            ToolApproval::RequiresApproval { .. } => {}
            other => panic!("Expected RequiresApproval, got {:?}", other),
        }
        match policy.check("cf_delete_dns_record") {
            ToolApproval::RequiresApproval { .. } => {}
            other => panic!("Expected RequiresApproval, got {:?}", other),
        }
    }

    #[test]
    fn test_require_all_approval() {
        let policy = SafetyPolicy {
            require_all_approval: true,
            auto_approve_reads: true,
        };
        match policy.check("cf_list_zones") {
            ToolApproval::RequiresApproval { .. } => {}
            other => panic!("Expected RequiresApproval, got {:?}", other),
        }
    }
}
