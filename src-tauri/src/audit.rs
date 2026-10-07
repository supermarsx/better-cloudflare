//! **Not compiled.** `main.rs` does not list `mod audit`, and has not since
//! the audit log moved into the storage layer, so nothing in this file has ever
//! reached a build.
//!
//! It is kept as a signpost rather than deleted, because the path is the one a
//! reader looks under first. What used to be described here now lives in three
//! places:
//!
//! * [`bc_storage::audit`] — the entry shape, the actor and outcome
//!   vocabulary, the per-entry bounds, and the retention rule that keeps the
//!   log's three writers from crowding each other out.
//! * `crate::commands::trail` — how a **person's** action is described: the
//!   record fields an entry carries, the before-and-after change set, and the
//!   line around credentials and provider text.
//! * `bc_mcp::audit` — the same job for a tool call, whether it arrived over
//!   the MCP server's HTTP transport or from the in-app assistant.
//!
//! Start with the first of those. If this module is ever wanted as a real
//! module again, it needs a `mod audit;` in `main.rs` to exist at all.
