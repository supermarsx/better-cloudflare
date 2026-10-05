//! How a tool call is written into the application's audit trail.
//!
//! Two actors dispatch MCP tools — a client of the local HTTP server, and the
//! in-app AI assistant — and both are described here, by one function, so a
//! user comparing the two halves of the trail is comparing like with like.
//! The assistant's own crate adds the conversation it came from and nothing
//! else about the call.
//!
//! ## What an entry carries, and what it never carries
//!
//! The arguments of a tool call are **not** recorded. Every Cloudflare tool
//! takes an `api_key` and some take an `email`; record `content` can be a DKIM
//! key or a service verification token; a firewall `expression` and an SPF
//! `txt` can be long enough to be a payload in their own right. So instead of
//! redacting a copy of the call, [`describe_target`] lifts a short allowlist of
//! identifying fields out of it — the zone, the record, the name, the domain.
//! An allowlist and not a denylist, because a tool added later would be covered
//! by neither and a denylist would let its arguments straight through.
//!
//! The effect tier comes from the permission registry rather than from the
//! tool's name, for the same reason the registry exists: security metadata must
//! never be inferred from a spelling.

use bc_storage::{AuditActor, AuditEntry, AuditOutcome};
use serde_json::Value;

use crate::permissions::permission_for_invocation;

/// Operation name for a tool call that arrived over the MCP HTTP transport.
pub const MCP_TOOL_CALL_OPERATION: &str = "mcp:tool_call";

/// Operation name for a tool call the AI assistant dispatched in-process.
pub const ASSISTANT_TOOL_CALL_OPERATION: &str = "assistant:tool_call";

/// Operation names for the MCP server's own control plane.
///
/// These are recorded as [`AuditActor::User`] actions: starting a server that
/// lets other programs reach the user's zones, and changing which tools they
/// may reach, are things a person does in settings. A trail that showed the
/// tool calls but not the moment the door was opened would answer "what was
/// done" without answering "how was it allowed".
pub const MCP_SERVER_START_OPERATION: &str = "mcp:server_start";
pub const MCP_SERVER_STOP_OPERATION: &str = "mcp:server_stop";
pub const MCP_GRANTS_CHANGED_OPERATION: &str = "mcp:grants_changed";

/// Why a tool call never reached a handler.
///
/// Carried as a value rather than recovered from the refusal message. The
/// messages are written for the caller that was refused; a trail that
/// string-matched them would quietly mis-file an entry the first time one was
/// reworded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DenialReason {
    /// The name is not in the permission registry at all.
    UnregisteredTool,
    /// Registered, but the application's MCP grants do not cover it.
    McpGrants,
    /// The assistant's own mode or per-tool overrides refused it. Only the
    /// assistant can be refused this way.
    AssistantPolicy,
    /// The arguments failed the permission's bounds.
    ArgumentBounds,
    /// A high-risk or destructive tool was called without the per-call
    /// acknowledgement.
    HighRiskConfirmation,
    /// A local safety check refused the call before either permission layer.
    LocalSafetyBounds,
}

impl DenialReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnregisteredTool => "unregistered_tool",
            Self::McpGrants => "mcp_grants",
            Self::AssistantPolicy => "assistant_policy",
            Self::ArgumentBounds => "argument_bounds",
            Self::HighRiskConfirmation => "high_risk_confirmation",
            Self::LocalSafetyBounds => "local_safety_bounds",
        }
    }
}

/// Why a dispatched call did not come back with a result.
///
/// The failure *reason* is deliberately not recorded. What comes back from a
/// handler is provider text the application did not write, and a trail is the
/// wrong place to accumulate text of unknown provenance; the caller is told the
/// reason, and the trail records that there was one. These four values are the
/// application's own classification of where the call stopped.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    /// The handler returned an error.
    ToolError,
    /// The call exceeded its execution deadline, and may have landed.
    Timeout,
    /// The call was cancelled or the server shut down under it, and may have
    /// landed.
    Cancelled,
    /// The result came back but was too large to return.
    ResultTooLarge,
    /// The dispatch did not succeed and the recording site cannot say more.
    ///
    /// The plan path records this: a step the assistant ran is marked
    /// `failed` whether the handler returned an error, the user cancelled the
    /// turn, or the deadline passed, and the step's status cannot tell the
    /// three apart. The call left the application either way, so a write may
    /// have landed — which is the part a reader of the trail acts on.
    Unreported,
}

impl FailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ToolError => "tool_error",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::ResultTooLarge => "result_too_large",
            Self::Unreported => "unreported",
        }
    }
}

/// What a tool call did, as the trail records it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolCallVerdict {
    /// Dispatched, and returned a result.
    Succeeded,
    /// Dispatched, and did not.
    Failed(FailureKind),
    /// Refused. Nothing was dispatched.
    Denied(DenialReason),
}

impl ToolCallVerdict {
    const fn outcome(self) -> AuditOutcome {
        match self {
            Self::Succeeded => AuditOutcome::Succeeded,
            Self::Failed(_) => AuditOutcome::Failed,
            Self::Denied(_) => AuditOutcome::Denied,
        }
    }
}

/// Describe one tool call for the trail.
///
/// `operation` says which door the call came through — [`MCP_TOOL_CALL_OPERATION`]
/// or [`ASSISTANT_TOOL_CALL_OPERATION`] — and `actor` says who was behind it.
/// The two are separate because the actor is what a reader filters on and the
/// operation is what they read; keeping them in step is the caller's job and is
/// pinned by this crate's tests.
///
/// The returned entry is open: the assistant adds its conversation to it before
/// recording.
pub fn tool_call_entry(
    actor: AuditActor,
    operation: &str,
    tool: &str,
    verdict: ToolCallVerdict,
    arguments: &Value,
) -> AuditEntry {
    let permission = permission_for_invocation(tool);
    let entry = AuditEntry::new(actor, operation, verdict.outcome())
        .resource(tool)
        .optional_detail(
            "effect",
            permission.map(|permission| permission.effect.as_str()),
        );
    // The reason a call was refused or failed is the first thing a reader of a
    // non-success entry wants, so it is spent out of the detail budget before
    // the target fields.
    let entry = match verdict {
        ToolCallVerdict::Succeeded => entry,
        ToolCallVerdict::Failed(kind) => entry.detail("failure", kind.as_str()),
        ToolCallVerdict::Denied(reason) => entry.detail("denied_by", reason.as_str()),
    };
    describe_target(entry, arguments)
}

/// Lift the identifying fields of a call out of its arguments.
///
/// The allowlist, in the order the detail budget is spent on it: the zone, then
/// the record, then what the record is, then the domain or other named target,
/// then the scale of a bulk operation. Nothing else from the call is read, and
/// a key not named here cannot reach the trail however a future tool spells it.
fn describe_target(entry: AuditEntry, arguments: &Value) -> AuditEntry {
    let record = arguments.get("record");
    let entry = entry
        .optional_detail("zone_id", text(arguments, "zone_id"))
        .optional_detail("record_id", text(arguments, "record_id"))
        .optional_detail(
            "record_name",
            record.and_then(|record| text(record, "name")),
        )
        .optional_detail(
            "record_type",
            record.and_then(|record| text(record, "type")),
        )
        .optional_detail("domain", text(arguments, "domain"))
        .optional_detail("zone_name", text(arguments, "zone_name"))
        .optional_detail(
            "target_id",
            text(arguments, "setting_id")
                .or_else(|| text(arguments, "rule_id"))
                .or_else(|| text(arguments, "route_id")),
        );
    let entry = match arguments.get("purge_everything").and_then(Value::as_bool) {
        Some(true) => entry.detail("purge_everything", true),
        _ => entry,
    };
    entry.optional_detail(
        "record_count",
        arguments
            .get("record_ids")
            .and_then(Value::as_array)
            .map(|ids| ids.len() as u64),
    )
}

/// Read one allowlisted string argument, ignoring blanks so an empty field
/// does not become a detail key that says nothing.
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Arguments as credential-laden as the catalogue allows: both auth
    /// fields, record content, a comment, and a firewall expression.
    fn loaded_arguments() -> Value {
        json!({
            "api_key": "cf-token-must-never-be-recorded",
            "email": "person@example.com",
            "zone_id": "zone-123",
            "record_id": "record-456",
            "record": {
                "type": "TXT",
                "name": "selector._domainkey.example.com",
                "content": "v=DKIM1; p=MIIBIjANBgkqhkiG9w0-secret-key-material",
                "comment": "rotation note",
            },
            "expression": "(http.request.uri.path contains \"/admin\")",
        })
    }

    #[test]
    fn an_entry_names_the_tool_its_effect_and_its_target() {
        let entry = tool_call_entry(
            AuditActor::McpClient,
            MCP_TOOL_CALL_OPERATION,
            "cf_update_dns_record",
            ToolCallVerdict::Succeeded,
            &loaded_arguments(),
        );
        let value = entry.into_value();

        assert_eq!(value["operation"], json!("mcp:tool_call"));
        assert_eq!(value["resource"], json!("cf_update_dns_record"));
        assert_eq!(value["actor"], json!("mcp_client"));
        assert_eq!(value["outcome"], json!("succeeded"));
        assert_eq!(
            value["effect"],
            json!("write"),
            "the effect tier is the registry's, not a guess from the name"
        );
        assert_eq!(value["zone_id"], json!("zone-123"));
        assert_eq!(value["record_id"], json!("record-456"));
        assert_eq!(value["record_type"], json!("TXT"));
        assert_eq!(
            value["record_name"],
            json!("selector._domainkey.example.com")
        );
    }

    #[test]
    fn no_credential_or_content_field_reaches_the_trail() {
        // One entry per actor and per verdict, so a leak on any branch fails
        // here rather than on whichever branch happened to be tested.
        let verdicts = [
            ToolCallVerdict::Succeeded,
            ToolCallVerdict::Failed(FailureKind::ToolError),
            ToolCallVerdict::Denied(DenialReason::McpGrants),
            ToolCallVerdict::Denied(DenialReason::UnregisteredTool),
        ];
        for actor in AuditActor::ALL {
            for verdict in verdicts {
                let serialized = tool_call_entry(
                    actor,
                    MCP_TOOL_CALL_OPERATION,
                    "cf_update_dns_record",
                    verdict,
                    &loaded_arguments(),
                )
                .into_value()
                .to_string();
                for forbidden in [
                    "cf-token-must-never-be-recorded",
                    "person@example.com",
                    "MIIBIjANBgkqhkiG9w0-secret-key-material",
                    "rotation note",
                    "http.request.uri.path",
                    "api_key",
                    "email",
                    "content",
                    "expression",
                ] {
                    assert!(
                        !serialized.contains(forbidden),
                        "{forbidden:?} reached the trail for {actor:?} / {verdict:?}: {serialized}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_refusal_records_which_layer_refused_it() {
        for (reason, expected) in [
            (DenialReason::UnregisteredTool, "unregistered_tool"),
            (DenialReason::McpGrants, "mcp_grants"),
            (DenialReason::AssistantPolicy, "assistant_policy"),
            (DenialReason::ArgumentBounds, "argument_bounds"),
            (DenialReason::HighRiskConfirmation, "high_risk_confirmation"),
            (DenialReason::LocalSafetyBounds, "local_safety_bounds"),
        ] {
            let value = tool_call_entry(
                AuditActor::Assistant,
                ASSISTANT_TOOL_CALL_OPERATION,
                "cf_delete_dns_record",
                ToolCallVerdict::Denied(reason),
                &json!({ "zone_id": "zone-1", "record_id": "record-1" }),
            )
            .into_value();
            assert_eq!(value["outcome"], json!("denied"));
            assert_eq!(value["denied_by"], json!(expected));
        }
    }

    #[test]
    fn a_dispatch_that_did_not_return_records_where_it_stopped() {
        for (kind, expected) in [
            (FailureKind::ToolError, "tool_error"),
            (FailureKind::Timeout, "timeout"),
            (FailureKind::Cancelled, "cancelled"),
            (FailureKind::ResultTooLarge, "result_too_large"),
            (FailureKind::Unreported, "unreported"),
        ] {
            let value = tool_call_entry(
                AuditActor::McpClient,
                MCP_TOOL_CALL_OPERATION,
                "cf_delete_dns_record",
                ToolCallVerdict::Failed(kind),
                &json!({}),
            )
            .into_value();
            assert_eq!(value["outcome"], json!("failed"));
            assert_eq!(value["failure"], json!(expected));
        }
    }

    #[test]
    fn an_unregistered_tool_still_produces_an_entry_without_an_effect() {
        let value = tool_call_entry(
            AuditActor::McpClient,
            MCP_TOOL_CALL_OPERATION,
            "cf_future_write",
            ToolCallVerdict::Denied(DenialReason::UnregisteredTool),
            &json!({ "zone_id": "zone-1" }),
        )
        .into_value();
        assert_eq!(value["resource"], json!("cf_future_write"));
        assert!(
            value.get("effect").is_none(),
            "an unregistered tool has no effect tier to claim"
        );
        assert_eq!(value["zone_id"], json!("zone-1"));
    }

    #[test]
    fn bulk_and_cache_operations_record_their_scale_rather_than_their_payload() {
        let bulk = tool_call_entry(
            AuditActor::McpClient,
            MCP_TOOL_CALL_OPERATION,
            "cf_bulk_delete_dns_records",
            ToolCallVerdict::Succeeded,
            &json!({ "zone_id": "z", "record_ids": ["a", "b", "c"] }),
        )
        .into_value();
        assert_eq!(bulk["record_count"], json!(3));

        let purge = tool_call_entry(
            AuditActor::McpClient,
            MCP_TOOL_CALL_OPERATION,
            "cf_purge_cache",
            ToolCallVerdict::Succeeded,
            &json!({ "zone_id": "z", "purge_everything": true, "files": ["https://x/y"] }),
        )
        .into_value();
        assert_eq!(purge["purge_everything"], json!(true));
        assert!(
            !purge.to_string().contains("https://x/y"),
            "the file list is a payload, not a target"
        );
    }

    #[test]
    fn blank_and_absent_targets_add_no_keys() {
        let value = tool_call_entry(
            AuditActor::Assistant,
            ASSISTANT_TOOL_CALL_OPERATION,
            "dns_parse_spf",
            ToolCallVerdict::Succeeded,
            &json!({ "zone_id": "   ", "content": "v=spf1 -all" }),
        )
        .into_value();
        assert!(
            value.get("zone_id").is_none(),
            "a blank argument is not a target"
        );
    }
}
