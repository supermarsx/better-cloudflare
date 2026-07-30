//! Integration tests for bc-mcp crate.
//!
//! Tests tool definitions, sanitisation, status builder, resources, prompts,
//! protocol helpers, schema generation and JSON-RPC handling without starting
//! a real server.

#[allow(unused_imports)]
use bc_mcp::{
    available_tool_definitions, build_status, default_enabled_tool_set, sanitize_enabled_tools,
    McpPrompt, McpResource, McpResourceTemplate, McpToolDescriptor,
};

// ═══════════════════════════════════════════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════════════════════════════════════════

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
        assert!(
            !tool.description.is_empty(),
            "Tool {} has no description",
            tool.name
        );
    }
}

#[test]
fn all_tools_have_titles() {
    for tool in available_tool_definitions() {
        assert!(!tool.title.is_empty(), "Tool {} has no title", tool.name);
    }
}

#[test]
fn all_tools_have_categories() {
    let valid_categories = ["cloudflare", "dns", "spf", "audit"];
    for tool in available_tool_definitions() {
        assert!(
            valid_categories.contains(&tool.category.as_str()),
            "Tool '{}' has invalid category '{}'",
            tool.name,
            tool.category,
        );
    }
}

#[test]
fn default_tool_set_is_empty_and_least_privilege() {
    let defaults = default_enabled_tool_set();
    assert!(defaults.is_empty());
    for permission in bc_mcp::permissions::permission_registry() {
        assert!(
            !defaults.allows(permission),
            "{} unexpectedly enabled by default",
            permission.invocation_name
        );
    }
}

// ── Tool count ─────────────────────────────────────────────────────────────

#[test]
fn preserves_exactly_53_tool_contracts() {
    let defs = available_tool_definitions();
    assert_eq!(defs.len(), 53, "The MCP tool contract count changed");
}

#[test]
fn tool_count_matches_definitions() {
    let defs = available_tool_definitions();
    assert_eq!(defs.len(), bc_mcp::tools::tool_count());
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
    assert!(result.allows_id("bc.mcp.v1.cf.verify_token"));
    assert!(!result.allows_id("nonexistent_tool"));
    assert_eq!(result.len(), 1);
}

#[test]
fn sanitize_empty_returns_empty() {
    let result = sanitize_enabled_tools(&[]);
    assert!(result.is_empty());
}

#[test]
fn sanitize_preserves_all_valid() {
    let input: Vec<String> = bc_mcp::permissions::permission_registry()
        .iter()
        .map(|permission| permission.id.to_string())
        .collect();
    let result = sanitize_enabled_tools(&input);
    assert_eq!(
        result.len(),
        bc_mcp::permissions::permission_registry().len()
    );
}

#[test]
fn sanitize_deduplicates() {
    let input = vec!["cf_verify_token".to_string(), "cf_verify_token".to_string()];
    let result = sanitize_enabled_tools(&input);
    assert_eq!(result.len(), 1);
}

#[test]
fn stable_permission_ids_and_invocations_are_complete_and_unique() {
    let definitions = available_tool_definitions();
    let registry = bc_mcp::permissions::permission_registry();
    assert_eq!(definitions.len(), registry.len());
    assert_eq!(bc_mcp::tools::tool_count(), registry.len());

    let mut ids = std::collections::HashSet::new();
    let mut invocations = std::collections::HashSet::new();
    for permission in registry {
        assert!(
            ids.insert(permission.id),
            "duplicate stable permission ID: {}",
            permission.id
        );
        assert!(
            invocations.insert(permission.invocation_name),
            "duplicate invocation name: {}",
            permission.invocation_name
        );
        assert!(!permission.category.as_str().is_empty());
        match permission.effect {
            bc_mcp::permissions::PermissionEffect::Read
            | bc_mcp::permissions::PermissionEffect::Analysis => {
                assert_eq!(permission.risk, bc_mcp::permissions::PermissionRisk::Low);
            }
            bc_mcp::permissions::PermissionEffect::Write
            | bc_mcp::permissions::PermissionEffect::Destructive => {
                assert_eq!(permission.risk, bc_mcp::permissions::PermissionRisk::High);
            }
        }
        if permission.credential_access {
            assert!(permission.network_access);
            assert_eq!(
                permission.category,
                bc_mcp::permissions::PermissionCategory::Cloudflare
            );
        }
    }

    for tool in definitions {
        let permission = bc_mcp::permissions::permission_for_invocation(&tool.name)
            .expect("catalogue tool must resolve exactly once");
        assert_eq!(tool.permission_id, permission.id);
        assert_eq!(tool.category, permission.category.as_str());
        assert_eq!(tool.effect, permission.effect.as_str());
        assert_eq!(tool.risk, permission.risk.as_str());
    }
}

#[test]
fn unknown_aliases_and_malformed_grant_values_default_deny() {
    let grants = sanitize_enabled_tools(&[
        "cf_delete_dns_record ".to_string(),
        "CF_DELETE_DNS_RECORD".to_string(),
        "delete_dns_record".to_string(),
        "bc.mcp.v1.cf.unknown".to_string(),
    ]);
    assert!(grants.is_empty());
}

#[test]
fn stable_ids_and_legacy_invocation_names_canonicalize_to_same_grant() {
    let by_name = sanitize_enabled_tools(&["cf_delete_dns_record".to_string()]);
    let by_id = sanitize_enabled_tools(&["bc.mcp.v1.cf.delete_dns_record".to_string()]);
    assert!(by_name.allows_id("bc.mcp.v1.cf.delete_dns_record"));
    assert!(by_id.allows_id("bc.mcp.v1.cf.delete_dns_record"));
    assert_eq!(by_name.len(), by_id.len());
}

// ── Status builder ─────────────────────────────────────────────────────────

#[test]
fn status_shows_url() {
    let enabled = default_enabled_tool_set();
    let status = build_status(false, "127.0.0.1".to_string(), 8787, &enabled, None, None);
    assert_eq!(status.url, "http://127.0.0.1:8787/mcp");
    assert!(!status.running);
}

#[test]
fn status_running_flag() {
    let enabled = default_enabled_tool_set();
    let running = build_status(true, "0.0.0.0".to_string(), 9090, &enabled, None, None);
    assert!(running.running);
    assert_eq!(running.url, "http://0.0.0.0:9090/mcp");

    let stopped = build_status(false, "0.0.0.0".to_string(), 9090, &enabled, None, None);
    assert!(!stopped.running);
}

#[test]
fn status_includes_tool_count() {
    let enabled = default_enabled_tool_set();
    let status = build_status(true, "localhost".to_string(), 8787, &enabled, None, None);
    assert_eq!(status.enabled_tools.len(), enabled.len());
    assert!(status.tool_count >= 50);
}

#[test]
fn status_includes_resource_and_prompt_counts() {
    let enabled = default_enabled_tool_set();
    let status = build_status(true, "localhost".to_string(), 8787, &enabled, None, None);
    assert!(
        status.resource_count >= 8,
        "Expected >= 8 resources, got {}",
        status.resource_count
    );
    assert!(
        status.prompt_count >= 8,
        "Expected >= 8 prompts, got {}",
        status.prompt_count
    );
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
        None,
    );
    assert!(!status.running);
    assert_eq!(status.last_error.as_deref(), Some("bind failed"));
}

// ── Tool names follow convention ───────────────────────────────────────────

#[test]
fn all_tool_names_have_valid_prefix() {
    let valid_prefixes = ["cf_", "spf_", "dns_", "audit_"];
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
            tool.name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_'),
            "Tool name '{}' is not snake_case",
            tool.name,
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn every_tool_has_schema() {
    for tool in available_tool_definitions() {
        let schema = &tool.input_schema;
        assert!(
            schema.is_object(),
            "Schema for tool '{}' must be a JSON object",
            tool.name,
        );
        let obj = schema.as_object().unwrap();
        assert!(
            obj.contains_key("type"),
            "Schema for tool '{}' must have a 'type' key",
            tool.name,
        );
        assert_eq!(
            obj.get("type").unwrap().as_str().unwrap(),
            "object",
            "Schema for tool '{}' must have type=object",
            tool.name,
        );
    }
}

#[test]
fn cf_tools_require_auth_fields() {
    for tool in available_tool_definitions() {
        if tool.name.starts_with("cf_") {
            let props = tool.input_schema.get("properties");
            assert!(
                props.is_some(),
                "cf_ tool '{}' must have properties",
                tool.name,
            );
            let obj = props.unwrap().as_object().unwrap();
            assert!(
                obj.contains_key("api_key"),
                "cf_ tool '{}' must have api_key property in schema",
                tool.name,
            );
        }
    }
}

#[test]
fn schema_standalone_function() {
    let schema = bc_mcp::schemas::tool_input_schema("cf_verify_token");
    assert!(schema.is_object());
    let obj = schema.as_object().unwrap();
    assert_eq!(obj.get("type").unwrap().as_str().unwrap(), "object");
    assert!(obj
        .get("properties")
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("api_key"));
}

#[test]
fn high_risk_schemas_require_exact_boolean_confirmation() {
    for tool in available_tool_definitions() {
        let permission =
            bc_mcp::permissions::permission_for_invocation(&tool.name).expect("registered tool");
        let requires_confirmation =
            bc_mcp::permissions::requires_high_risk_confirmation(permission);
        let properties = tool.input_schema["properties"].as_object();
        let required = tool.input_schema["required"].as_array();
        let confirmation = properties.and_then(|properties| properties.get("confirmHighRisk"));

        if requires_confirmation {
            let confirmation =
                confirmation.unwrap_or_else(|| panic!("{} is missing confirmHighRisk", tool.name));
            assert_eq!(confirmation["type"], "boolean", "{}", tool.name);
            assert_eq!(confirmation["const"], true, "{}", tool.name);
            assert!(
                required
                    .expect("high-risk schemas expose required fields")
                    .iter()
                    .any(|field| field.as_str() == Some("confirmHighRisk")),
                "{} does not require confirmHighRisk",
                tool.name
            );
        } else {
            assert!(
                confirmation.is_none(),
                "{} unexpectedly exposes high-risk confirmation",
                tool.name
            );
        }
    }
}

#[test]
fn unknown_tool_schema_is_empty_object() {
    let schema = bc_mcp::schemas::tool_input_schema("nonexistent_tool_xyz");
    let obj = schema.as_object().unwrap();
    assert_eq!(obj.get("type").unwrap().as_str().unwrap(), "object");
}

// ═══════════════════════════════════════════════════════════════════════════
// Resources
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn resources_are_non_empty() {
    let resources = bc_mcp::resources::list_resources();
    assert!(
        resources.len() >= 8,
        "Expected >= 8 resources, got {}",
        resources.len()
    );
}

#[test]
fn resource_uris_are_unique() {
    let resources = bc_mcp::resources::list_resources();
    let uris: Vec<&str> = resources.iter().map(|r| r.uri.as_str()).collect();
    let unique: std::collections::HashSet<&&str> = uris.iter().collect();
    assert_eq!(uris.len(), unique.len(), "Duplicate resource URIs detected");
}

#[test]
fn all_resources_have_descriptions() {
    for resource in bc_mcp::resources::list_resources() {
        assert!(
            !resource.description.is_empty(),
            "Resource '{}' has no description",
            resource.uri
        );
    }
}

#[test]
fn all_resources_have_mime_type() {
    for resource in bc_mcp::resources::list_resources() {
        assert!(
            !resource.mime_type.is_empty(),
            "Resource '{}' has no mime_type",
            resource.uri
        );
    }
}

#[test]
fn can_read_all_static_resources() {
    for resource in bc_mcp::resources::list_resources() {
        let content = bc_mcp::resources::read_resource(&resource.uri);
        assert!(
            content.is_ok(),
            "Could not read resource '{}': {:?}",
            resource.uri,
            content.err(),
        );
        let val = content.unwrap();
        let text = serde_json::to_string(&val).unwrap();
        assert!(
            text.len() > 10,
            "Resource '{}' content too short",
            resource.uri,
        );
    }
}

#[test]
fn reading_unknown_resource_returns_err() {
    let content = bc_mcp::resources::read_resource("nonexistent://resource");
    assert!(content.is_err());
}

#[test]
fn resource_templates_non_empty() {
    let templates = bc_mcp::resources::list_resource_templates();
    assert!(
        !templates.is_empty(),
        "Expected at least one resource template"
    );
}

#[test]
fn resource_template_uris_are_valid() {
    for template in bc_mcp::resources::list_resource_templates() {
        assert!(
            template.uri_template.contains('{'),
            "Template URI '{}' must contain a placeholder",
            template.uri_template,
        );
        assert!(!template.name.is_empty());
        assert!(!template.description.is_empty());
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn prompts_are_non_empty() {
    let prompts = bc_mcp::prompts::list_prompts();
    assert!(
        prompts.len() >= 8,
        "Expected >= 8 prompts, got {}",
        prompts.len()
    );
}

#[test]
fn prompt_names_are_unique() {
    let prompts = bc_mcp::prompts::list_prompts();
    let names: Vec<&str> = prompts.iter().map(|p| p.name.as_str()).collect();
    let unique: std::collections::HashSet<&&str> = names.iter().collect();
    assert_eq!(names.len(), unique.len(), "Duplicate prompt names detected");
}

#[test]
fn all_prompts_have_descriptions() {
    for prompt in bc_mcp::prompts::list_prompts() {
        assert!(
            !prompt.description.is_empty(),
            "Prompt '{}' has no description",
            prompt.name
        );
    }
}

#[test]
fn all_prompts_have_arguments() {
    for prompt in bc_mcp::prompts::list_prompts() {
        let args = prompt
            .arguments
            .as_ref()
            .unwrap_or_else(|| panic!("Prompt '{}' has no arguments", prompt.name));
        assert!(
            !args.is_empty(),
            "Prompt '{}' has empty arguments",
            prompt.name
        );
        for arg in args {
            assert!(
                !arg.name.is_empty(),
                "Prompt '{}' has args with no name",
                prompt.name
            );
            assert!(
                !arg.description.is_empty(),
                "Prompt '{}' arg '{}' has no description",
                prompt.name,
                arg.name
            );
        }
    }
}

#[test]
fn can_get_known_prompts() {
    let known = [
        "dns-troubleshoot",
        "spf-debug",
        "domain-security-audit",
        "zone-migration",
        "firewall-setup",
        "email-setup",
        "ssl-setup",
        "performance-optimize",
    ];
    for name in &known {
        let args = serde_json::json!({});
        let messages = bc_mcp::prompts::get_prompt(name, &args);
        assert!(
            messages.is_ok(),
            "Prompt '{}' should be gettable: {:?}",
            name,
            messages.err(),
        );
        let msgs = messages.unwrap();
        assert!(!msgs.is_empty(), "Prompt '{}' returned no messages", name,);
        for msg in &msgs {
            assert!(
                !msg.role.is_empty(),
                "Message in prompt '{}' has no role",
                name
            );
        }
    }
}

#[test]
fn unknown_prompt_returns_err() {
    let args = serde_json::json!({});
    let result = bc_mcp::prompts::get_prompt("nonexistent_prompt", &args);
    assert!(result.is_err());
}

// ═══════════════════════════════════════════════════════════════════════════
// Protocol helpers
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn success_response_format() {
    let resp =
        bc_mcp::protocol::success_response(serde_json::json!(42), serde_json::json!("hello"));
    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 42);
    assert_eq!(resp["result"], "hello");
    assert!(resp.get("error").is_none());
}

#[test]
fn error_response_format() {
    use bc_mcp::protocol::RpcErrorCode;
    let resp = bc_mcp::protocol::error_response(
        Some(serde_json::json!(7)),
        RpcErrorCode::MethodNotFound.code(),
        "no such method".to_string(),
    );
    assert_eq!(resp["jsonrpc"], "2.0");
    assert_eq!(resp["id"], 7);
    let err = resp.get("error").expect("must have error field");
    assert_eq!(err["code"], -32601);
    assert!(err["message"].as_str().unwrap().contains("no such method"));
}

#[test]
fn error_response_with_data() {
    use bc_mcp::protocol::RpcErrorCode;
    let resp = bc_mcp::protocol::error_response_with_data(
        Some(serde_json::json!(1)),
        RpcErrorCode::InternalError.code(),
        "oops".to_string(),
        serde_json::json!({"detail": "stack trace"}),
    );
    let err = resp.get("error").unwrap();
    assert_eq!(err["code"], -32603);
    assert_eq!(err["data"]["detail"], "stack trace");
}

#[test]
fn null_id_response() {
    let resp = bc_mcp::protocol::success_response(serde_json::Value::Null, serde_json::json!("ok"));
    assert!(resp["id"].is_null());
}

#[test]
fn tool_success_content_block() {
    let val = serde_json::json!("hello world");
    let result = bc_mcp::protocol::tool_success(&val);
    assert!(result.is_object());
    let content = result["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["type"], "text");
}

#[test]
fn tool_error_content_block() {
    let result = bc_mcp::protocol::tool_error("something failed");
    assert!(result.is_object());
    assert_eq!(result["isError"], true);
    let content = result["content"].as_array().unwrap();
    assert_eq!(content[0]["text"], "something failed");
}

#[test]
fn tool_disabled_content_block() {
    let result = bc_mcp::protocol::tool_disabled("my_tool");
    assert!(result.is_object());
    assert_eq!(result["isError"], true);
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("my_tool"));
    assert!(text.contains("disabled"));
}

#[test]
fn initialize_response_contains_capabilities() {
    let resp = bc_mcp::protocol::initialize_response();
    assert!(resp.get("capabilities").is_some());
    let caps = resp.get("capabilities").unwrap();
    assert!(caps.get("tools").is_some());
    assert!(caps.get("resources").is_some());
    assert!(caps.get("prompts").is_some());
    assert!(caps.get("logging").is_some());
    assert_eq!(resp["protocolVersion"], "2024-11-05");
}

#[test]
fn rpc_error_codes_are_correct() {
    use bc_mcp::protocol::RpcErrorCode;
    assert_eq!(RpcErrorCode::ParseError as i32, -32700);
    assert_eq!(RpcErrorCode::InvalidRequest as i32, -32600);
    assert_eq!(RpcErrorCode::MethodNotFound as i32, -32601);
    assert_eq!(RpcErrorCode::InvalidParams as i32, -32602);
    assert_eq!(RpcErrorCode::InternalError as i32, -32603);
}

// ═══════════════════════════════════════════════════════════════════════════
// Protocol argument helpers
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn get_required_string_present() {
    let args = serde_json::json!({"name": "Alice"});
    let result = bc_mcp::protocol::get_required_string(&args, "name");
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), "Alice");
}

#[test]
fn get_required_string_missing() {
    let args = serde_json::json!({});
    let result = bc_mcp::protocol::get_required_string(&args, "name");
    assert!(result.is_err());
}

#[test]
fn get_optional_string() {
    let args = serde_json::json!({"key": "value"});
    assert_eq!(
        bc_mcp::protocol::get_optional_string(&args, "key"),
        Some("value".to_string()),
    );
    assert_eq!(
        bc_mcp::protocol::get_optional_string(&args, "missing"),
        None,
    );
}

#[test]
fn get_optional_bool() {
    let args = serde_json::json!({"flag": true});
    assert_eq!(
        bc_mcp::protocol::get_optional_bool(&args, "flag"),
        Some(true)
    );
    assert_eq!(bc_mcp::protocol::get_optional_bool(&args, "nope"), None);
}

#[test]
fn get_optional_u32() {
    let args = serde_json::json!({"count": 42});
    assert_eq!(bc_mcp::protocol::get_optional_u32(&args, "count"), Some(42));
    assert_eq!(bc_mcp::protocol::get_optional_u32(&args, "nope"), None);
}

#[test]
fn get_string_array() {
    let args = serde_json::json!({"items": ["a", "b", "c"]});
    let arr = bc_mcp::protocol::get_string_array(&args, "items");
    assert_eq!(
        arr,
        Some(vec!["a".to_string(), "b".to_string(), "c".to_string()])
    );
    let empty = bc_mcp::protocol::get_string_array(&args, "missing");
    assert!(empty.is_none());
}

// ═══════════════════════════════════════════════════════════════════════════
// Category distribution
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn each_category_has_tools() {
    let defs = available_tool_definitions();
    let categories = ["cloudflare", "dns", "spf", "audit"];
    for cat in &categories {
        let count = defs.iter().filter(|t| t.category == *cat).count();
        assert!(count >= 1, "Category '{}' has no tools", cat);
    }
}

#[test]
fn cloudflare_category_has_most_tools() {
    let defs = available_tool_definitions();
    let cf = defs.iter().filter(|t| t.category == "cloudflare").count();
    let dns = defs.iter().filter(|t| t.category == "dns").count();
    assert!(cf > dns, "Cloudflare should have more tools than DNS");
}

// ═══════════════════════════════════════════════════════════════════════════
// Known tools exist
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn key_cloudflare_tools_exist() {
    let names = bc_mcp::tools::all_tool_names();
    let required = [
        "cf_verify_token",
        "cf_list_zones",
        "cf_list_dns_records",
        "cf_create_dns_record",
        "cf_update_dns_record",
        "cf_delete_dns_record",
        "cf_get_zone_setting",
        "cf_update_zone_setting",
    ];
    for name in &required {
        assert!(names.contains(&name.to_string()), "Missing tool: {}", name);
    }
}

#[test]
fn key_dns_tools_exist() {
    let names = bc_mcp::tools::all_tool_names();
    let required = [
        "dns_validate_record",
        "dns_check_propagation",
        "dns_parse_csv",
        "dns_export_csv",
        "dns_parse_srv",
        "dns_compose_srv",
    ];
    for name in &required {
        assert!(names.contains(&name.to_string()), "Missing tool: {}", name);
    }
}

#[test]
fn key_spf_tools_exist() {
    let names = bc_mcp::tools::all_tool_names();
    let required = ["spf_simulate", "spf_graph", "dns_parse_spf"];
    for name in &required {
        assert!(names.contains(&name.to_string()), "Missing tool: {}", name);
    }
}

#[test]
fn audit_tool_exists() {
    let names = bc_mcp::tools::all_tool_names();
    assert!(names.contains(&"audit_run_domain".to_string()));
}

// ═══════════════════════════════════════════════════════════════════════════
// Known resources exist
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn key_resources_exist() {
    let resources = bc_mcp::resources::list_resources();
    let uris: Vec<&str> = resources.iter().map(|r| r.uri.as_str()).collect();
    let required = [
        "dns://record-types",
        "dns://ttl-presets",
        "spf://syntax",
        "cloudflare://zone-settings",
        "cloudflare://firewall-expressions",
        "dns://validation-rules",
        "cloudflare://api-errors",
        "dns://global-resolvers",
    ];
    for uri in &required {
        assert!(uris.contains(uri), "Missing resource: {}", uri);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Known prompts exist
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn key_prompts_exist() {
    let prompts = bc_mcp::prompts::list_prompts();
    let names: Vec<&str> = prompts.iter().map(|p| p.name.as_str()).collect();
    let required = [
        "dns-troubleshoot",
        "spf-debug",
        "domain-security-audit",
        "zone-migration",
        "firewall-setup",
        "email-setup",
        "ssl-setup",
        "performance-optimize",
    ];
    for name in &required {
        assert!(names.contains(name), "Missing prompt: {}", name);
    }
}
