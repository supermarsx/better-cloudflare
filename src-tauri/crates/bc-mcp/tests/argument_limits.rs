//! Hostile-input behaviour of the MCP argument gate.
//!
//! `validate_arguments` is the only thing standing between a remote MCP client
//! and the tool handlers, and it is also the stated precondition for an
//! `expect()` on the dispatch path: after validation succeeds, the dispatcher
//! calls `as_object_mut().expect("argument validation requires an object")` to
//! strip `confirmHighRisk`. If validation ever admits a non-object, that unwrap
//! panics, and a panic in the Tauri backend takes the whole desktop app down.
//!
//! Nothing exercised this function. These tests pin the non-object refusal for
//! every permission in the registry, and pin each declared ceiling at exactly
//! the limit and one unit past it.

use bc_mcp::permissions::{
    permission_registry, validate_arguments, ArgumentProfile, PermissionDefinition,
};
use serde_json::{json, Map, Value};

/// One representative permission per distinct argument profile. The registry
/// has dozens of entries sharing a handful of profiles; the ceilings only vary
/// per profile, so this keeps the size-based tests proportionate while still
/// covering every profile the registry actually declares.
fn representative_permissions() -> Vec<&'static PermissionDefinition> {
    let mut seen: Vec<(usize, usize, usize)> = Vec::new();
    let mut representatives = Vec::new();
    for permission in permission_registry() {
        let profile = permission.argument_profile;
        let key = (
            profile.max_json_bytes,
            profile.max_collection_items,
            profile.max_string_bytes,
        );
        if !seen.contains(&key) {
            seen.push(key);
            representatives.push(permission);
        }
    }
    assert!(
        !representatives.is_empty(),
        "the permission registry must declare at least one argument profile"
    );
    representatives
}

/// Build a JSON object whose compact encoding is exactly `target` bytes, using
/// string members no longer than the profile allows.
///
/// Encoding arithmetic: the braces cost 2, each member `"kNNN":"…"` costs 9
/// plus its payload, and each member after the first costs one comma.
fn object_encoded_to_exactly(target: usize, profile: ArgumentProfile) -> Value {
    assert!(target >= 12, "target too small to express as an object");
    let mut map = Map::new();
    let mut remaining = target - 2;
    while remaining > 0 {
        let comma = usize::from(!map.is_empty());
        let budget = remaining - comma;
        assert!(budget >= 9, "member budget underflowed while padding");
        let payload = (budget - 9).min(profile.max_string_bytes);
        map.insert(format!("k{:03}", map.len()), json!("a".repeat(payload)));
        remaining -= comma + 9 + payload;
    }
    let value = Value::Object(map);
    let encoded = serde_json::to_vec(&value)
        .expect("padding object encodes")
        .len();
    assert_eq!(encoded, target, "padding helper produced the wrong size");
    value
}

// ── The precondition the dispatch unwrap depends on ─────────────────────────

#[test]
fn every_permission_refuses_arguments_that_are_not_a_json_object() {
    // Anything reaching the dispatcher as a non-object would panic on the
    // `as_object_mut()` unwrap, so the refusal must hold for the whole
    // registry, not just for the tools that happen to have a hand-written
    // schema.
    let non_objects = [
        json!(null),
        json!(true),
        json!(false),
        json!(0),
        json!(-1),
        json!(1.5),
        json!(""),
        json!("confirmHighRisk"),
        json!([]),
        json!([{ "confirmHighRisk": true }]),
        json!(["confirmHighRisk", true]),
    ];

    for permission in permission_registry() {
        for args in &non_objects {
            let result = validate_arguments(permission, args);
            assert!(
                result.is_err(),
                "'{}' accepted non-object arguments {args}",
                permission.invocation_name
            );
        }
    }

    // The empty object is the smallest thing that may pass, and it must, or
    // every zero-argument tool becomes uncallable.
    for permission in permission_registry() {
        assert!(
            validate_arguments(permission, &json!({})).is_ok(),
            "'{}' rejected empty arguments",
            permission.invocation_name
        );
    }
}

// ── Declared ceilings ───────────────────────────────────────────────────────

#[test]
fn the_total_argument_byte_ceiling_is_inclusive_and_one_byte_over_is_refused() {
    for permission in representative_permissions() {
        let profile = permission.argument_profile;
        let at_limit = object_encoded_to_exactly(profile.max_json_bytes, profile);
        assert!(
            validate_arguments(permission, &at_limit).is_ok(),
            "'{}' refused a payload at exactly its {} byte limit",
            permission.invocation_name,
            profile.max_json_bytes
        );

        let over_limit = object_encoded_to_exactly(profile.max_json_bytes + 1, profile);
        let error = validate_arguments(permission, &over_limit).expect_err(&format!(
            "'{}' accepted a payload one byte over its limit",
            permission.invocation_name
        ));
        assert!(
            error.contains(&profile.max_json_bytes.to_string()),
            "the refusal must name the limit it enforced: {error}"
        );
    }
}

#[test]
fn the_single_string_ceiling_is_inclusive_and_one_byte_over_is_refused() {
    for permission in representative_permissions() {
        let profile = permission.argument_profile;
        // A lone string member stays well inside the total byte budget, so this
        // isolates the per-string rule from the whole-payload rule.
        let at_limit = json!({ "k000": "a".repeat(profile.max_string_bytes) });
        assert!(
            validate_arguments(permission, &at_limit).is_ok(),
            "'{}' refused a string at exactly its {} byte limit",
            permission.invocation_name,
            profile.max_string_bytes
        );

        let over_limit = json!({ "k000": "a".repeat(profile.max_string_bytes + 1) });
        assert!(
            validate_arguments(permission, &over_limit).is_err(),
            "'{}' accepted a string one byte over its limit",
            permission.invocation_name
        );

        // The rule must apply to strings nested inside collections, not only to
        // the members of the top-level object.
        let nested = json!({ "k000": { "k001": ["a".repeat(profile.max_string_bytes + 1)] } });
        assert!(
            validate_arguments(permission, &nested).is_err(),
            "'{}' accepted an oversized string nested two levels down",
            permission.invocation_name
        );
    }
}

#[test]
fn the_collection_item_ceiling_is_inclusive_and_one_item_over_is_refused() {
    for permission in representative_permissions() {
        let profile = permission.argument_profile;
        let limit = profile.max_collection_items;

        let at_limit = json!({ "k000": vec![Value::Null; limit] });
        assert!(
            validate_arguments(permission, &at_limit).is_ok(),
            "'{}' refused an array of exactly {limit} items",
            permission.invocation_name
        );
        assert!(
            validate_arguments(permission, &json!({ "k000": vec![Value::Null; limit + 1] }))
                .is_err(),
            "'{}' accepted an array of {} items",
            permission.invocation_name,
            limit + 1
        );

        // Objects are bounded by member count under the same limit, including
        // when the oversized object is the top-level arguments value itself.
        let oversized_object: Map<String, Value> = (0..=limit)
            .map(|index| (format!("k{index:05}"), Value::Null))
            .collect();
        assert!(
            validate_arguments(permission, &Value::Object(oversized_object.clone())).is_err(),
            "'{}' accepted top-level arguments with {} members",
            permission.invocation_name,
            limit + 1
        );
        assert!(
            validate_arguments(
                permission,
                &json!({ "k000": Value::Object(oversized_object) })
            )
            .is_err(),
            "'{}' accepted a nested object with {} members",
            permission.invocation_name,
            limit + 1
        );
    }
}

// ── Recursion ───────────────────────────────────────────────────────────────

#[test]
fn deeply_nested_arguments_are_bounded_before_they_can_exhaust_the_stack() {
    // Argument validation walks the value tree recursively, so its safety
    // depends on the payload never being deeper than the parser will build.
    // Both halves of that composition are asserted here: the deepest payload a
    // parser will produce must validate without unwinding the process, and a
    // deeper wire payload must be refused at parse time rather than handed on.
    let permission = permission_registry()
        .first()
        .expect("the permission registry is not empty");

    let build = |depth: usize| {
        let mut text = String::from("{\"k000\":");
        text.push_str(&"[".repeat(depth));
        text.push_str(&"]".repeat(depth));
        text.push('}');
        text
    };

    let accepted: Value =
        serde_json::from_str(&build(120)).expect("a 120-deep payload is within the parser limit");
    // The assertion is that this call returns at all rather than aborting.
    let _ = validate_arguments(permission, &accepted);

    assert!(
        serde_json::from_str::<Value>(&build(2_000)).is_err(),
        "a 2000-deep payload must be refused before validation ever sees it"
    );
}

// ── Grant sanitisation bounds ───────────────────────────────────────────────

#[test]
fn stored_grant_lists_are_bounded_and_truncate_toward_denial() {
    // The enabled-tool list comes from user preferences, which are attacker
    // influenceable if secure storage is ever tampered with. Sanitisation is
    // bounded, and every bound must drop toward "not granted".
    let long_name = "c".repeat(4096);
    let noisy = vec![
        String::new(),
        " ".to_string(),
        "cf_verify_token\n".to_string(),
        "CF_VERIFY_TOKEN".to_string(),
        long_name,
        "\u{0}cf_verify_token".to_string(),
        "../../bc.mcp.v1.cf.verify_token".to_string(),
        "🙂".repeat(64),
    ];
    let sanitized = bc_mcp::sanitize_enabled_tools(&noisy);
    assert!(
        sanitized.is_empty(),
        "malformed grant names must not resolve to any permission"
    );

    // Truncation must lose grants rather than admit them: a valid name buried
    // past the bound is dropped, and the same name inside the bound is kept.
    let mut padded: Vec<String> = (0..200).map(|index| format!("filler_{index}")).collect();
    padded.push("cf_verify_token".to_string());
    assert!(
        bc_mcp::sanitize_enabled_tools(&padded).is_empty(),
        "a grant past the configured bound must fail closed"
    );

    assert!(
        bc_mcp::sanitize_enabled_tools(&["cf_verify_token".to_string()])
            .allows_id("bc.mcp.v1.cf.verify_token"),
        "a well-formed grant inside the bound must still be honoured"
    );
}
