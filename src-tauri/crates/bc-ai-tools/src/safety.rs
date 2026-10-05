//! Tool classification, and the pre-permission safety policy.
//!
//! A tool is classified by looking it up in the MCP permission registry,
//! which is the authoritative record of what each tool does: `bc_mcp` names
//! an effect tier for every registered tool, and exactly two of those tiers
//! mutate. That classification is what [`crate::permissions`] resolves a mode
//! against.
//!
//! This used to be a hardcoded prefix allowlist — `dns_check_`, `cf_list_`,
//! `audit_`, and so on — and that was a trap rather than a shortcut.
//! `dns_check_registration` was very nearly named `dns_lookup_registration`,
//! which matches nothing on such a list and would therefore have been
//! classified a **write**: refused outright in `readOnly` mode and prompting
//! in `ask` mode, for a read-only RDAP lookup. The registry cannot drift from
//! the tool it describes, because it is the same table dispatch, argument
//! bounds and the high-risk acknowledgement are all read from. There is
//! deliberately no prefix fallback, because a fallback is where that drift
//! would hide again.
//!
//! [`SafetyPolicy`] is the older two-flag policy. It is kept for callers that
//! only need its yes/no answer; the executor resolves
//! [`crate::permissions::AiPermissions`] instead, because a mode plus explicit
//! per-tool overrides expresses everything this policy could and adds
//! outright denial, which [`ToolApproval`] cannot represent.

use serde::{Deserialize, Serialize};

use bc_mcp::permissions::{permission_for_invocation, PermissionEffect};

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

        if mutates(tool_name) {
            return ToolApproval::RequiresApproval {
                reason: format!("Tool '{}' performs a write/delete operation", tool_name),
            };
        }

        // Default: auto-approve a tool that changes nothing.
        ToolApproval::AutoApprove
    }
}

/// Whether an effect tier changes anything.
///
/// The one place the tier → read/write mapping is written down, and the whole
/// of it: `Read` and `Analysis` observe, `Write` and `Destructive` change
/// something. Spelled as an exhaustive `match` with no wildcard arm, so a new
/// tier in `bc_mcp` is a compile error here rather than a silent read.
pub const fn effect_mutates(effect: PermissionEffect) -> bool {
    match effect {
        PermissionEffect::Read | PermissionEffect::Analysis => false,
        PermissionEffect::Write | PermissionEffect::Destructive => true,
    }
}

/// Whether a tool changes anything, read from its registry entry.
///
/// Fail-closed: a name the registry does not define mutates. Such a name
/// cannot be dispatched at all — [`crate::executor`] refuses an unregistered
/// tool before any permission layer runs — so this only decides how the call
/// is *described*, and describing an unknown tool as a read is the one
/// mistake here worth ruling out.
pub fn mutates(name: &str) -> bool {
    permission_for_invocation(name).is_none_or(|permission| effect_mutates(permission.effect))
}

/// Whether a tool only observes. The exact complement of [`mutates`].
pub fn is_read_only(name: &str) -> bool {
    !mutates(name)
}

#[cfg(test)]
mod tests {
    use bc_mcp::permissions::{
        permission_registry, ArgumentProfile, PermissionCategory, PermissionDefinition,
        PermissionRisk,
    };

    use super::*;

    /// The deleted prefix allowlist, kept *only* so the tests below can state
    /// the trap it was. Nothing in the crate consults it.
    const DELETED_READ_PREFIXES: &[&str] = &[
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

    fn matches_a_deleted_prefix(name: &str) -> bool {
        DELETED_READ_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
    }

    #[test]
    fn test_read_only_auto_approved() {
        let policy = SafetyPolicy::default();
        assert_eq!(policy.check("cf_list_zones"), ToolApproval::AutoApprove);
        assert_eq!(
            policy.check("dns_validate_record"),
            ToolApproval::AutoApprove
        );
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

    /// Every registered tool is classified by its own registry entry, and by
    /// nothing else. This is the property the deleted prefix list could only
    /// approximate.
    #[test]
    fn every_registered_tool_is_classified_by_its_registry_tier() {
        for permission in permission_registry() {
            let name = permission.invocation_name;
            assert_eq!(
                mutates(name),
                effect_mutates(permission.effect),
                "{name} ({:?}) is not classified by its tier",
                permission.effect
            );
            assert_eq!(is_read_only(name), !mutates(name), "{name}");
        }
    }

    /// Fail-closed, and the sharpest disagreement with the deleted allowlist:
    /// a name shaped like a read is still a write unless the registry says
    /// otherwise. The old list answered "read" for anything beginning
    /// `dns_check_`, whether or not such a tool existed.
    #[test]
    fn a_tool_the_registry_does_not_know_is_a_write() {
        for name in [
            "dns_check_whatever_the_model_invented",
            "cf_list_everything",
            "audit_the_whole_account",
            "totally_unknown_tool",
        ] {
            assert!(
                mutates(name),
                "{name} must classify as a write: the registry does not define it"
            );
            assert!(!is_read_only(name), "{name}");
        }
        // The first three would have been read-only under the deleted list,
        // which is the whole reason it is gone.
        for name in [
            "dns_check_whatever_the_model_invented",
            "cf_list_everything",
            "audit_the_whole_account",
        ] {
            assert!(matches_a_deleted_prefix(name), "{name}");
        }
    }

    /// The case the prefix list would have got wrong, as a registry entry.
    ///
    /// `dns_check_registration` was nearly called `dns_lookup_registration`.
    /// No registered tool is spelled that way today, so the entry is built
    /// here rather than added to the real registry: the point is that the
    /// *tier* decides, so a read-only tool whose name matches no prefix rule
    /// still classifies as a read.
    #[test]
    fn a_read_only_tool_whose_name_matches_no_old_prefix_classifies_as_read() {
        const RENAMED: &str = "dns_lookup_registration";
        assert!(
            !matches_a_deleted_prefix(RENAMED),
            "the premise of this test is that the deleted list had no rule for this name"
        );

        let hypothetical = PermissionDefinition {
            id: "bc.mcp.v1.dns.lookup_registration",
            invocation_name: RENAMED,
            legacy_aliases: &[],
            category: PermissionCategory::Dns,
            effect: PermissionEffect::Read,
            risk: PermissionRisk::Low,
            network_access: true,
            credential_access: false,
            argument_profile: ArgumentProfile {
                max_json_bytes: 64 * 1024,
                max_collection_items: 100,
                max_string_bytes: 32 * 1024,
            },
        };
        assert!(
            !effect_mutates(hypothetical.effect),
            "an RDAP lookup is a read whatever it is called"
        );

        // And the tool as it was actually named classifies the same way, for
        // the same reason — its tier, not its spelling.
        let registered =
            permission_for_invocation("dns_check_registration").expect("registered tool");
        assert!(!effect_mutates(registered.effect));
        assert!(is_read_only("dns_check_registration"));
    }
}
