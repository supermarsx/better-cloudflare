//! Audit logging – now handled by `bc_storage::Storage::add_audit_entry`.
//!
//! This module is kept for backward compatibility but all persistence
//! is delegated to the storage layer.
//!
//! The log has three writers, and [`bc_storage::audit`] is where their shared
//! entry shape and the retention rule that keeps them from crowding each other
//! out both live:
//!
//! * **A person in the app.** The commands in `crate::commands` write through
//!   `log_audit`, which still appends a plain JSON object; the storage layer
//!   labels those entries `actor: "user"`, which is what they have always been.
//! * **A client of the local MCP server.** Recorded in `bc_mcp`'s HTTP
//!   transport, one entry per tool call including the ones it refuses, plus the
//!   server's own start, stop and permission edits.
//! * **The AI assistant.** Recorded in `bc_ai_agent`'s run ledger, one entry
//!   per settled tool call — free-turn and plan step alike — plus the user's
//!   approval of a plan.
//!
//! The two new writers reach the log through [`bc_storage::AuditTrail`], which
//! makes the actor a required argument rather than something a caller can
//! forget. `Storage::audit_trail` hands out the handle; the MCP commands in
//! `crate::mcp_server` and the AI commands in `crate::ai_commands` pass it
//! down, because the managers that need it are built in `main` before the
//! managed `Storage` exists.
