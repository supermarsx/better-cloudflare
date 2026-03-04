//! Integration tests for bc-mcp crate.
//!
//! Tests tool definitions, sanitisation, status builder, and JSON-RPC
//! message handling without starting a real server.

use bc_mcp::{
    available_tool_definitions, build_status, default_enabled_tool_set,
    sanitize_enabled_tools,
};

// ── Tool definitions ───────────────────────────────────────────────────────

#[test]
fn tool_definitions_are_non_empty() {
    let defs = available_tool_definitions();
    assert!(!defs.is_empty(), "Must have at least one tool");
}

#[test]
fn all_tool_names_are_unique() {
    let defs = available_tool_definitions();
    let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    let unique: std::collections::HashSet<&&str> = names.iter().collect();
    assert_eq!(names.len(), unique.len(), "Duplicate tool names detected");
}

#[test]
fn all_tools_have_descriptions() {
    for tool in available_tool_definitions() {
        assert!(!tool.description.is_empty(), "Tool {} has no description", tool.name);
    }
}

#[test]
fn default_tool_set_matches_definitions() {
    let defs = available_tool_definitions();
    let enabled = default_enabled_tool_set();
    assert_eq!(defs.len(), enabled.len());
    for tool in &defs {
        assert!(
            enabled.contains(&tool.name),
            "Tool {} missing from default set",
            tool.name,
        );
    }
}

// ── Tool count ─────────────────────────────────────────────────────────────

#[test]
fn has_at_least_36_tools() {
    let defs = available_tool_definitions();
    assert!(
        defs.len() >= 36,
        "Expected >= 36 tools, got {}",
        defs.len(),
    );
}

// ── Sanitisation ───────────────────────────────────────────────────────────

#[test]
fn sanitize_filters_invalid_tools() {
    let input = vec![
        "cf_verify_token".to_string(),
        "nonexistent_tool".to_string(),
        "".to_string(),
    ];
    let result = sanitize_enabled_tools(&input);
    assert!(result.contains("cf_verify_token"));
    assert!(!result.contains("nonexistent_tool"));
    assert!(!result.contains(""));
    assert_eq!(result.len(), 1);
}

#[test]
fn sanitize_empty_returns_empty() {
    let result = sanitize_enabled_tools(&[]);
    assert!(result.is_empty());
}

#[test]
fn sanitize_preserves_all_valid() {
    let enabled = default_enabled_tool_set();
    let input: Vec<String> = enabled.iter().cloned().collect();
    let result = sanitize_enabled_tools(&input);
    assert_eq!(result.len(), enabled.len());
}

#[test]
fn sanitize_deduplicates() {
    let input = vec![
        "cf_verify_token".to_string(),
        "cf_verify_token".to_string(),
    ];
    let result = sanitize_enabled_tools(&input);
    assert_eq!(result.len(), 1);
}

// ── Status builder ─────────────────────────────────────────────────────────

#[test]
fn status_shows_url() {
    let enabled = default_enabled_tool_set();
    let status = build_status(false, "127.0.0.1".to_string(), 8787, &enabled, None);
    assert_eq!(status.url, "http://127.0.0.1:8787/mcp");
    assert!(!status.running);
}

#[test]
fn status_running_flag() {
    let enabled = default_enabled_tool_set();
    let running = build_status(true, "0.0.0.0".to_string(), 9090, &enabled, None);
    assert!(running.running);
    assert_eq!(running.url, "http://0.0.0.0:9090/mcp");

    let stopped = build_status(false, "0.0.0.0".to_string(), 9090, &enabled, None);
    assert!(!stopped.running);
}

#[test]
fn status_includes_tool_count() {
    let enabled = default_enabled_tool_set();
    let status = build_status(true, "localhost".to_string(), 8787, &enabled, None);
    assert_eq!(status.enabled_tools.len(), enabled.len());
}

#[test]
fn status_with_error() {
    let enabled = default_enabled_tool_set();
    let status = build_status(
        false,
        "127.0.0.1".to_string(),
        8787,
        &enabled,
        Some("bind failed".to_string()),
    );
    assert!(!status.running);
    assert_eq!(status.last_error.as_deref(), Some("bind failed"));
}

// ── Tool names follow convention ───────────────────────────────────────────

#[test]
fn all_tool_names_have_valid_prefix() {
    let valid_prefixes = ["cf_", "spf_", "dns_"];
    for tool in available_tool_definitions() {
        assert!(
            valid_prefixes.iter().any(|p| tool.name.starts_with(p)),
            "Tool name '{}' does not start with a valid prefix ({:?})",
            tool.name,
            valid_prefixes,
        );
    }
}

#[test]
fn tool_names_are_snake_case() {
    for tool in available_tool_definitions() {
        assert!(
            tool.name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
            "Tool name '{}' is not snake_case",
            tool.name,
        );
    }
}
