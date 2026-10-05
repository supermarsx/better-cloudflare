//! Authoritative AI tool permission model.
//!
//! The renderer renders these decisions; it never makes them. [`resolve`] is
//! the single algorithm that turns a configuration plus a tool name into a
//! decision, and [`crate::executor::ToolExecutor`] applies it at the dispatch
//! boundary so a permission cannot be bypassed by skipping the UI.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use bc_ai_provider::limits::MAX_TOOL_NAME_BYTES;

use crate::error::ToolExecutionError;
use crate::safety::is_read_only;

/// Maximum number of explicit per-tool overrides accepted from the renderer.
///
/// Overrides may only name registered tools, so a valid map is far smaller
/// than this; the cap bounds the work done before that check.
pub const MAX_TOOL_PERMISSION_OVERRIDES: usize = 128;

/// Prefix of every tool result that reports a refused call. Stable so the
/// agent loop and its tests can recognise a refusal without parsing prose.
pub const PERMISSION_REFUSAL_PREFIX: &str = "Tool call refused:";

/// Marker naming the assistant's own policy as the layer that refused. Stable
/// so a renderer can route the user to the right settings page.
pub const ASSISTANT_POLICY_REFUSAL_MARKER: &str =
    "the AI assistant's own tool permissions (AI assistant settings)";

/// Marker naming the application's MCP grants as the layer that refused.
pub const MCP_GRANT_REFUSAL_MARKER: &str =
    "the application's MCP tool permissions (MCP server settings)";

/// Which of the two permission layers refused a call.
///
/// The layers are composed as an intersection, so a refusal can come from
/// either, and a user who sees "refused" needs to know which switch to look
/// at: the assistant's own tool settings, or the application's MCP grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalSource {
    /// The assistant's mode plus per-tool overrides ([`resolve`]).
    AssistantPolicy,
    /// The application's canonical MCP permission grants.
    McpGrants,
}

impl RefusalSource {
    /// Human-readable name of the layer, for the refusal the model relays.
    pub const fn marker(self) -> &'static str {
        match self {
            Self::AssistantPolicy => ASSISTANT_POLICY_REFUSAL_MARKER,
            Self::McpGrants => MCP_GRANT_REFUSAL_MARKER,
        }
    }
}

/// What the assistant can actually dispatch right now.
///
/// The renderer cannot work this out for itself: it knows the assistant's
/// permissions but not the MCP grants the dispatch is also gated on, so
/// without this it has to guess whether tool use is possible at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAvailability {
    /// Whether any tool at all would pass both permission layers. False means
    /// the assistant has no tools, and a UI should stop advertising them.
    pub dispatch_available: bool,
    /// Registered tools the application's MCP grants currently cover.
    pub granted_tool_count: usize,
    /// Registered tools that pass both layers — granted by MCP and not denied
    /// by the assistant's policy. Never larger than `granted_tool_count`.
    pub usable_tool_count: usize,
    /// Every tool in the MCP catalogue, so a UI can say "3 of 48".
    pub registered_tool_count: usize,
}

/// How much freedom the assistant has when it wants to call a tool.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiPermissionMode {
    /// Read-only tools run; every other tool is refused outright, not asked.
    ReadOnly,
    /// Read-only tools run; writes require explicit user approval.
    #[default]
    Ask,
    /// Every tool runs without prompting.
    Autonomous,
}

/// Permission for one tool: either an explicit override or a resolved value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiToolPermission {
    Allow,
    Ask,
    Deny,
}

/// Read/write classification of a tool, read from the MCP permission
/// registry's effect tier by [`crate::safety::mutates`]. A tool the registry
/// does not define counts as a write, so an unclassified name is governed by
/// the stricter branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolClassification {
    Read,
    Write,
}

/// Persisted permission configuration: a mode plus explicit overrides.
///
/// `tools` holds only the tools the user has decided about individually, never
/// an entry per registered tool.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPermissions {
    #[serde(default)]
    pub mode: AiPermissionMode,
    #[serde(default)]
    pub tools: BTreeMap<String, AiToolPermission>,
}

/// One registered tool with its *effective* permission already resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolDescriptor {
    pub name: String,
    pub classification: ToolClassification,
    pub description: String,
    pub permission: AiToolPermission,
}

/// Outcome of the resolution algorithm for a single tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Run without prompting.
    Allow,
    /// Pause and ask the user first.
    Ask { reason: String },
    /// Refuse without prompting and without executing.
    Deny { reason: String },
}

impl PermissionDecision {
    /// The permission a UI should display for this decision.
    pub fn effective(&self) -> AiToolPermission {
        match self {
            Self::Allow => AiToolPermission::Allow,
            Self::Ask { .. } => AiToolPermission::Ask,
            Self::Deny { .. } => AiToolPermission::Deny,
        }
    }

    /// The reason a call was refused or paused, if any.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Allow => None,
            Self::Ask { reason } | Self::Deny { reason } => Some(reason),
        }
    }
}

/// Classify a tool by its registry entry. Only the `Read` and `Analysis`
/// effect tiers count as reads; everything else, including a name the
/// registry does not know, is a write.
pub fn classify(tool_name: &str) -> ToolClassification {
    if is_read_only(tool_name) {
        ToolClassification::Read
    } else {
        ToolClassification::Write
    }
}

/// The authoritative resolution algorithm.
///
/// 1. Tool use disabled in the agent configuration denies every tool.
/// 2. Otherwise an explicit per-tool override wins outright.
/// 3. Otherwise the mode decides, using the read/write classification.
pub fn resolve(
    tools_enabled: bool,
    permissions: &AiPermissions,
    tool_name: &str,
) -> PermissionDecision {
    if !tools_enabled {
        return PermissionDecision::Deny {
            reason: "tool use is disabled in the AI assistant configuration".into(),
        };
    }

    if let Some(override_permission) = permissions.tools.get(tool_name) {
        return match override_permission {
            AiToolPermission::Allow => PermissionDecision::Allow,
            AiToolPermission::Ask => PermissionDecision::Ask {
                reason: format!("tool '{tool_name}' is set to ask before running"),
            },
            AiToolPermission::Deny => PermissionDecision::Deny {
                reason: format!("tool '{tool_name}' is denied by an explicit per-tool setting"),
            },
        };
    }

    let classification = classify(tool_name);
    match (permissions.mode, classification) {
        (_, ToolClassification::Read) | (AiPermissionMode::Autonomous, _) => {
            PermissionDecision::Allow
        }
        (AiPermissionMode::ReadOnly, ToolClassification::Write) => PermissionDecision::Deny {
            reason: format!("tool '{tool_name}' writes, and the assistant is in read-only mode"),
        },
        (AiPermissionMode::Ask, ToolClassification::Write) => PermissionDecision::Ask {
            reason: format!("tool '{tool_name}' performs a write/delete operation"),
        },
    }
}

/// Body of the tool result that reports a refusal back to the model.
///
/// The model must learn that the call was refused — otherwise it retries or
/// stalls instead of answering the user — and it must be able to tell the user
/// *which* permission layer refused, because they are configured in two
/// different places.
pub fn refusal_text_from(source: RefusalSource, reason: &str) -> String {
    format!(
        "{PERMISSION_REFUSAL_PREFIX} {reason}. The tool was not executed. \
         The refusal came from {}. \
         Do not retry this call; tell the user it was refused and which permissions to change, \
         or continue without that tool.",
        source.marker()
    )
}

/// A refusal by the assistant's own policy, the layer [`resolve`] decides.
pub fn refusal_text(reason: &str) -> String {
    refusal_text_from(RefusalSource::AssistantPolicy, reason)
}

/// Reason for a tool the application's MCP grants do not cover.
pub fn ungranted_reason(tool_name: &str) -> String {
    format!("tool '{tool_name}' is not enabled in the application's MCP tool permissions")
}

/// Reason for a name that is not an MCP tool at all.
pub fn unregistered_reason(tool_name: &str) -> String {
    format!("'{tool_name}' is not a registered MCP tool")
}

/// Names of every tool registered in the MCP catalogue.
fn registered_tool_names() -> HashSet<String> {
    bc_mcp::available_tool_definitions()
        .into_iter()
        .map(|descriptor| descriptor.name)
        .collect()
}

impl AiPermissions {
    /// Bound and sanity-check a permission map arriving from the renderer.
    ///
    /// Unknown tool names are rejected rather than stored: a map that accrues
    /// typos silently stops describing what is actually enforced.
    pub fn validate(&self) -> Result<(), ToolExecutionError> {
        if self.tools.len() > MAX_TOOL_PERMISSION_OVERRIDES {
            return Err(ToolExecutionError::LimitExceeded {
                resource: "tool permission overrides",
                limit: MAX_TOOL_PERMISSION_OVERRIDES,
                actual: self.tools.len(),
            });
        }
        for name in self.tools.keys() {
            if name.len() > MAX_TOOL_NAME_BYTES {
                return Err(ToolExecutionError::LimitExceeded {
                    resource: "tool permission name",
                    limit: MAX_TOOL_NAME_BYTES,
                    actual: name.len(),
                });
            }
        }
        let registered = registered_tool_names();
        for name in self.tools.keys() {
            if !registered.contains(name) {
                return Err(ToolExecutionError::InvalidInput {
                    field: "permissions.tools",
                    message: "names a tool that is not registered",
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const READ_TOOL: &str = "cf_list_zones";
    const WRITE_TOOL: &str = "cf_delete_dns_record";

    fn permissions(mode: AiPermissionMode) -> AiPermissions {
        AiPermissions {
            mode,
            tools: BTreeMap::new(),
        }
    }

    fn with_override(
        mode: AiPermissionMode,
        name: &str,
        permission: AiToolPermission,
    ) -> AiPermissions {
        let mut permissions = permissions(mode);
        permissions.tools.insert(name.to_string(), permission);
        permissions
    }

    #[test]
    fn disabled_tool_use_denies_every_tool() {
        for mode in [
            AiPermissionMode::ReadOnly,
            AiPermissionMode::Ask,
            AiPermissionMode::Autonomous,
        ] {
            for tool in [READ_TOOL, WRITE_TOOL] {
                assert!(
                    matches!(
                        resolve(false, &permissions(mode), tool),
                        PermissionDecision::Deny { .. }
                    ),
                    "{mode:?} must deny {tool} when tool use is disabled"
                );
            }
        }
    }

    #[test]
    fn disabled_tool_use_outranks_an_allow_override() {
        let permissions = with_override(
            AiPermissionMode::Autonomous,
            WRITE_TOOL,
            AiToolPermission::Allow,
        );
        assert!(matches!(
            resolve(false, &permissions, WRITE_TOOL),
            PermissionDecision::Deny { .. }
        ));
    }

    #[test]
    fn an_explicit_override_wins_over_the_mode() {
        assert_eq!(
            resolve(
                true,
                &with_override(
                    AiPermissionMode::ReadOnly,
                    WRITE_TOOL,
                    AiToolPermission::Allow
                ),
                WRITE_TOOL,
            ),
            PermissionDecision::Allow,
        );
        assert!(matches!(
            resolve(
                true,
                &with_override(
                    AiPermissionMode::Autonomous,
                    READ_TOOL,
                    AiToolPermission::Deny
                ),
                READ_TOOL,
            ),
            PermissionDecision::Deny { .. }
        ));
        assert!(matches!(
            resolve(
                true,
                &with_override(
                    AiPermissionMode::Autonomous,
                    READ_TOOL,
                    AiToolPermission::Ask
                ),
                READ_TOOL,
            ),
            PermissionDecision::Ask { .. }
        ));
    }

    #[test]
    fn read_only_mode_denies_writes_instead_of_asking() {
        let permissions = permissions(AiPermissionMode::ReadOnly);
        assert_eq!(
            resolve(true, &permissions, READ_TOOL),
            PermissionDecision::Allow
        );
        assert!(
            matches!(
                resolve(true, &permissions, WRITE_TOOL),
                PermissionDecision::Deny { .. }
            ),
            "read-only mode must refuse writes outright, never prompt for them"
        );
    }

    #[test]
    fn ask_mode_allows_reads_and_asks_for_writes() {
        let permissions = permissions(AiPermissionMode::Ask);
        assert_eq!(
            resolve(true, &permissions, READ_TOOL),
            PermissionDecision::Allow
        );
        assert!(matches!(
            resolve(true, &permissions, WRITE_TOOL),
            PermissionDecision::Ask { .. }
        ));
    }

    #[test]
    fn autonomous_mode_allows_everything() {
        let permissions = permissions(AiPermissionMode::Autonomous);
        for tool in [READ_TOOL, WRITE_TOOL] {
            assert_eq!(resolve(true, &permissions, tool), PermissionDecision::Allow);
        }
    }

    #[test]
    fn an_unclassified_tool_name_is_treated_as_a_write() {
        assert_eq!(classify("totally_unknown_tool"), ToolClassification::Write);
        assert!(matches!(
            resolve(
                true,
                &permissions(AiPermissionMode::ReadOnly),
                "totally_unknown_tool"
            ),
            PermissionDecision::Deny { .. }
        ));
    }

    #[test]
    fn every_registered_tool_classifies_and_resolves() {
        for name in registered_tool_names() {
            let decision = resolve(true, &permissions(AiPermissionMode::Ask), &name);
            match classify(&name) {
                ToolClassification::Read => assert_eq!(decision, PermissionDecision::Allow),
                ToolClassification::Write => {
                    assert!(matches!(decision, PermissionDecision::Ask { .. }))
                }
            }
        }
    }

    #[test]
    fn the_wire_format_is_camel_case() {
        let value = serde_json::to_value(AiPermissions {
            mode: AiPermissionMode::ReadOnly,
            tools: BTreeMap::from([(WRITE_TOOL.to_string(), AiToolPermission::Deny)]),
        })
        .expect("serializes");
        assert_eq!(value["mode"], "readOnly");
        assert_eq!(value["tools"][WRITE_TOOL], "deny");

        let descriptor = serde_json::to_value(AiToolDescriptor {
            name: READ_TOOL.into(),
            classification: ToolClassification::Read,
            description: "List zones".into(),
            permission: AiToolPermission::Allow,
        })
        .expect("serializes");
        assert_eq!(descriptor["classification"], "read");
        assert_eq!(descriptor["permission"], "allow");
        assert_eq!(descriptor["name"], READ_TOOL);

        let decoded: AiPermissions =
            serde_json::from_value(serde_json::json!({ "mode": "autonomous" }))
                .expect("a mode alone deserializes");
        assert_eq!(decoded.mode, AiPermissionMode::Autonomous);
        assert!(decoded.tools.is_empty());
    }

    #[test]
    fn unknown_and_oversized_override_names_are_rejected() {
        let mut permissions = permissions(AiPermissionMode::Ask);
        permissions
            .tools
            .insert("cf_not_a_real_tool".into(), AiToolPermission::Allow);
        assert!(matches!(
            permissions.validate(),
            Err(ToolExecutionError::InvalidInput {
                field: "permissions.tools",
                ..
            })
        ));

        let mut permissions = permissions.clone();
        permissions.tools.clear();
        permissions
            .tools
            .insert("c".repeat(MAX_TOOL_NAME_BYTES + 1), AiToolPermission::Allow);
        assert!(matches!(
            permissions.validate(),
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool permission name",
                ..
            })
        ));

        let mut permissions = permissions.clone();
        permissions.tools.clear();
        for index in 0..=MAX_TOOL_PERMISSION_OVERRIDES {
            permissions
                .tools
                .insert(format!("tool-{index}"), AiToolPermission::Deny);
        }
        assert!(matches!(
            permissions.validate(),
            Err(ToolExecutionError::LimitExceeded {
                resource: "tool permission overrides",
                ..
            })
        ));
    }

    #[test]
    fn a_registered_override_map_validates() {
        let permissions = with_override(AiPermissionMode::Ask, WRITE_TOOL, AiToolPermission::Deny);
        permissions.validate().expect("registered tool name");
    }

    #[test]
    fn a_refusal_names_itself_and_tells_the_model_not_to_retry() {
        let text = refusal_text(
            "tool 'cf_delete_dns_record' writes, and the assistant is in read-only mode",
        );
        assert!(text.starts_with(PERMISSION_REFUSAL_PREFIX));
        assert!(text.contains("was not executed"));
        assert!(text.contains("Do not retry"));
    }
}
