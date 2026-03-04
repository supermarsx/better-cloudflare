//! Detailed JSON Schema definitions for every MCP tool.
//!
//! Each tool gets a proper `inputSchema` with typed properties, required
//! fields, and human-readable descriptions. This replaces the previous
//! generic `{ "type": "object" }` placeholder schemas.

use serde_json::{json, Value};

/// Shared schema fragment: Cloudflare authentication fields.
fn cf_auth_properties() -> Value {
    json!({
        "api_key": {
            "type": "string",
            "description": "Cloudflare API token or Global API key."
        },
        "email": {
            "type": "string",
            "description": "Account email (required for Global API key, omit for API token)."
        }
    })
}

/// Merge CF auth fields into a schema that also has zone_id + extra props.
fn cf_zone_schema(extra_props: Value, extra_required: &[&str]) -> Value {
    let mut props = serde_json::Map::new();
    // Auth
    if let Value::Object(auth) = cf_auth_properties() {
        for (k, v) in auth {
            props.insert(k, v);
        }
    }
    // zone_id
    props.insert(
        "zone_id".to_string(),
        json!({ "type": "string", "description": "Cloudflare zone ID." }),
    );
    // Extra
    if let Value::Object(extra) = extra_props {
        for (k, v) in extra {
            props.insert(k, v);
        }
    }
    let mut required = vec!["api_key".to_string(), "zone_id".to_string()];
    for r in extra_required {
        required.push(r.to_string());
    }
    json!({
        "type": "object",
        "properties": Value::Object(props),
        "required": required
    })
}

/// Auth-only schema (no zone_id).
fn cf_auth_only_schema(extra_props: Value, extra_required: &[&str]) -> Value {
    let mut props = serde_json::Map::new();
    if let Value::Object(auth) = cf_auth_properties() {
        for (k, v) in auth {
            props.insert(k, v);
        }
    }
    if let Value::Object(extra) = extra_props {
        for (k, v) in extra {
            props.insert(k, v);
        }
    }
    let mut required: Vec<String> = vec!["api_key".to_string()];
    for r in extra_required {
        required.push(r.to_string());
    }
    json!({
        "type": "object",
        "properties": Value::Object(props),
        "required": required
    })
}

/// Returns the input schema for a given tool name.
pub fn tool_input_schema(name: &str) -> Value {
    match name {
        // ── DNS Core ────────────────────────────────────────────────────
        "cf_verify_token" => cf_auth_only_schema(json!({}), &[]),

        "cf_list_zones" => cf_auth_only_schema(json!({}), &[]),

        "cf_list_dns_records" => cf_zone_schema(
            json!({
                "page": { "type": "integer", "description": "Page number (1-based).", "minimum": 1 },
                "per_page": { "type": "integer", "description": "Records per page (5-5000).", "minimum": 5, "maximum": 5000 },
                "type": { "type": "string", "description": "Filter by record type (A, AAAA, CNAME, etc.)." },
                "name": { "type": "string", "description": "Filter by record name." }
            }),
            &[],
        ),

        "cf_create_dns_record" => cf_zone_schema(
            json!({
                "record": {
                    "type": "object",
                    "description": "DNS record to create.",
                    "properties": {
                        "type": { "type": "string", "description": "Record type (A, AAAA, CNAME, MX, TXT, etc.)." },
                        "name": { "type": "string", "description": "Record name (e.g. 'example.com' or 'sub')." },
                        "content": { "type": "string", "description": "Record content (IP, hostname, text, etc.)." },
                        "ttl": { "type": "integer", "description": "TTL in seconds (1 = auto)." },
                        "priority": { "type": "integer", "description": "Priority (MX, SRV records)." },
                        "proxied": { "type": "boolean", "description": "Whether to proxy through Cloudflare." },
                        "comment": { "type": "string", "description": "Optional comment." }
                    },
                    "required": ["type", "name", "content"]
                }
            }),
            &["record"],
        ),

        "cf_update_dns_record" => cf_zone_schema(
            json!({
                "record_id": { "type": "string", "description": "ID of the record to update." },
                "record": {
                    "type": "object",
                    "description": "Updated DNS record fields.",
                    "properties": {
                        "type": { "type": "string" },
                        "name": { "type": "string" },
                        "content": { "type": "string" },
                        "ttl": { "type": "integer" },
                        "priority": { "type": "integer" },
                        "proxied": { "type": "boolean" },
                        "comment": { "type": "string" }
                    },
                    "required": ["type", "name", "content"]
                }
            }),
            &["record_id", "record"],
        ),

        "cf_delete_dns_record" => cf_zone_schema(
            json!({
                "record_id": { "type": "string", "description": "ID of the DNS record to delete." }
            }),
            &["record_id"],
        ),

        "cf_bulk_create_dns_records" => cf_zone_schema(
            json!({
                "records": {
                    "type": "array",
                    "description": "Array of DNS records to create.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string" },
                            "name": { "type": "string" },
                            "content": { "type": "string" },
                            "ttl": { "type": "integer" },
                            "priority": { "type": "integer" },
                            "proxied": { "type": "boolean" },
                            "comment": { "type": "string" }
                        },
                        "required": ["type", "name", "content"]
                    }
                },
                "dryrun": { "type": "boolean", "description": "If true, validate only without creating." }
            }),
            &["records"],
        ),

        "cf_bulk_delete_dns_records" => cf_zone_schema(
            json!({
                "record_ids": {
                    "type": "array",
                    "description": "Array of record IDs to delete.",
                    "items": { "type": "string" }
                }
            }),
            &["record_ids"],
        ),

        "cf_export_dns_records" => cf_zone_schema(
            json!({
                "format": {
                    "type": "string",
                    "description": "Export format: json, csv, or bind.",
                    "enum": ["json", "csv", "bind"]
                },
                "page": { "type": "integer", "minimum": 1 },
                "per_page": { "type": "integer", "minimum": 5, "maximum": 5000 }
            }),
            &[],
        ),

        // ── Cache ───────────────────────────────────────────────────────
        "cf_purge_cache" => cf_zone_schema(
            json!({
                "purge_everything": {
                    "type": "boolean",
                    "description": "If true, purge all cached files."
                },
                "files": {
                    "type": "array",
                    "description": "Specific URLs to purge.",
                    "items": { "type": "string", "format": "uri" }
                }
            }),
            &[],
        ),

        // ── Zone Settings ───────────────────────────────────────────────
        "cf_get_zone_setting" => cf_zone_schema(
            json!({
                "setting_id": {
                    "type": "string",
                    "description": "Setting identifier (e.g. 'ssl', 'always_use_https', 'min_tls_version')."
                }
            }),
            &["setting_id"],
        ),

        "cf_update_zone_setting" => cf_zone_schema(
            json!({
                "setting_id": { "type": "string", "description": "Setting identifier." },
                "value": { "description": "New setting value (type depends on the setting)." }
            }),
            &["setting_id", "value"],
        ),

        // ── DNSSEC ──────────────────────────────────────────────────────
        "cf_get_dnssec" => cf_zone_schema(json!({}), &[]),

        "cf_update_dnssec" => cf_zone_schema(
            json!({
                "payload": {
                    "type": "object",
                    "description": "DNSSEC configuration payload (e.g. { \"status\": \"active\" })."
                }
            }),
            &["payload"],
        ),

        // ── Analytics ───────────────────────────────────────────────────
        "cf_get_zone_analytics" => cf_zone_schema(
            json!({
                "since": { "type": "string", "description": "Start time (ISO 8601 or relative like '-6h')." },
                "until": { "type": "string", "description": "End time (ISO 8601 or relative like 'now')." },
                "continuous": { "type": "boolean", "description": "Whether to use continuous time series." }
            }),
            &["since", "until"],
        ),

        "cf_get_dns_analytics" => cf_zone_schema(
            json!({
                "since": { "type": "string", "description": "Start time." },
                "until": { "type": "string", "description": "End time." },
                "dimensions": {
                    "type": "array",
                    "description": "Dimensions to group by (e.g. ['queryType', 'responseCode']).",
                    "items": { "type": "string" }
                },
                "metrics": {
                    "type": "array",
                    "description": "Metrics to include (e.g. ['queryCount', 'responseTimeAvg']).",
                    "items": { "type": "string" }
                }
            }),
            &["since", "until"],
        ),

        // ── Firewall / WAF ─────────────────────────────────────────────
        "cf_list_firewall_rules" => cf_zone_schema(json!({}), &[]),

        "cf_create_firewall_rule" => cf_zone_schema(
            json!({
                "rule": {
                    "type": "object",
                    "description": "Firewall rule to create.",
                    "properties": {
                        "paused": { "type": "boolean" },
                        "description": { "type": "string" },
                        "action": {
                            "type": "string",
                            "enum": ["block", "challenge", "js_challenge", "managed_challenge", "allow", "log", "bypass"]
                        },
                        "priority": { "type": "integer" },
                        "filter": {
                            "type": "object",
                            "properties": {
                                "expression": { "type": "string", "description": "Firewall expression (e.g. 'ip.src eq 1.2.3.4')." },
                                "paused": { "type": "boolean" },
                                "description": { "type": "string" }
                            },
                            "required": ["expression"]
                        }
                    },
                    "required": ["description", "action", "filter"]
                }
            }),
            &["rule"],
        ),

        "cf_update_firewall_rule" => cf_zone_schema(
            json!({
                "rule_id": { "type": "string", "description": "ID of the rule to update." },
                "rule": {
                    "type": "object",
                    "description": "Updated firewall rule.",
                    "properties": {
                        "paused": { "type": "boolean" },
                        "description": { "type": "string" },
                        "action": { "type": "string" },
                        "priority": { "type": "integer" },
                        "filter": {
                            "type": "object",
                            "properties": {
                                "expression": { "type": "string" },
                                "paused": { "type": "boolean" },
                                "description": { "type": "string" }
                            },
                            "required": ["expression"]
                        }
                    },
                    "required": ["description", "action", "filter"]
                }
            }),
            &["rule_id", "rule"],
        ),

        "cf_delete_firewall_rule" => cf_zone_schema(
            json!({ "rule_id": { "type": "string", "description": "ID of the rule to delete." } }),
            &["rule_id"],
        ),

        "cf_list_ip_access_rules" => cf_zone_schema(json!({}), &[]),

        "cf_create_ip_access_rule" => cf_zone_schema(
            json!({
                "mode": {
                    "type": "string",
                    "description": "Access rule mode.",
                    "enum": ["block", "challenge", "whitelist", "js_challenge", "managed_challenge"]
                },
                "value": { "type": "string", "description": "IP address, range, CIDR, country code, or ASN." },
                "notes": { "type": "string", "description": "Optional note." }
            }),
            &["mode", "value"],
        ),

        "cf_delete_ip_access_rule" => cf_zone_schema(
            json!({ "rule_id": { "type": "string", "description": "ID of the IP access rule to delete." } }),
            &["rule_id"],
        ),

        "cf_list_waf_rulesets" => cf_zone_schema(json!({}), &[]),

        // ── Workers ─────────────────────────────────────────────────────
        "cf_list_worker_routes" => cf_zone_schema(json!({}), &[]),

        "cf_create_worker_route" => cf_zone_schema(
            json!({
                "pattern": { "type": "string", "description": "Route pattern (e.g. 'example.com/api/*')." },
                "script": { "type": "string", "description": "Worker script name." }
            }),
            &["pattern", "script"],
        ),

        "cf_delete_worker_route" => cf_zone_schema(
            json!({ "route_id": { "type": "string", "description": "ID of the route to delete." } }),
            &["route_id"],
        ),

        // ── Email Routing ───────────────────────────────────────────────
        "cf_get_email_routing_settings" => cf_zone_schema(json!({}), &[]),
        "cf_list_email_routing_rules" => cf_zone_schema(json!({}), &[]),

        "cf_create_email_routing_rule" => cf_zone_schema(
            json!({
                "rule": {
                    "type": "object",
                    "description": "Email routing rule.",
                    "properties": {
                        "name": { "type": "string" },
                        "enabled": { "type": "boolean" },
                        "priority": { "type": "integer" },
                        "matchers": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": { "type": "string" },
                                    "field": { "type": "string" },
                                    "value": { "type": "string" }
                                },
                                "required": ["type"]
                            }
                        },
                        "actions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": { "type": "string" },
                                    "value": { "type": "array", "items": { "type": "string" } }
                                },
                                "required": ["type"]
                            }
                        }
                    },
                    "required": ["name", "matchers", "actions"]
                }
            }),
            &["rule"],
        ),

        "cf_delete_email_routing_rule" => cf_zone_schema(
            json!({ "rule_id": { "type": "string", "description": "ID of the email routing rule to delete." } }),
            &["rule_id"],
        ),

        // ── Page Rules ──────────────────────────────────────────────────
        "cf_list_page_rules" => cf_zone_schema(json!({}), &[]),

        // ── SPF ─────────────────────────────────────────────────────────
        "spf_simulate" => json!({
            "type": "object",
            "properties": {
                "domain": { "type": "string", "description": "Domain to evaluate SPF for." },
                "ip": { "type": "string", "description": "IP address of the sending server." }
            },
            "required": ["domain", "ip"]
        }),

        "spf_graph" => json!({
            "type": "object",
            "properties": {
                "domain": { "type": "string", "description": "Domain to build SPF include/redirect graph for." }
            },
            "required": ["domain"]
        }),

        "spf_parse" => json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "SPF record content string (e.g. 'v=spf1 include:_spf.google.com ~all')."
                }
            },
            "required": ["content"]
        }),

        // ── DNS Tools ───────────────────────────────────────────────────
        "dns_validate_record" => json!({
            "type": "object",
            "properties": {
                "record": {
                    "type": "object",
                    "description": "DNS record to validate.",
                    "properties": {
                        "type": { "type": "string", "description": "Record type." },
                        "name": { "type": "string", "description": "Record name." },
                        "content": { "type": "string", "description": "Record content." },
                        "ttl": { "type": "integer", "description": "TTL in seconds." },
                        "priority": { "type": "integer", "description": "Priority (MX, SRV)." },
                        "proxied": { "type": "boolean", "description": "Whether proxied through Cloudflare." }
                    },
                    "required": ["type", "name", "content"]
                }
            },
            "required": ["record"]
        }),

        "dns_check_propagation" => json!({
            "type": "object",
            "properties": {
                "domain": { "type": "string", "description": "Domain to check propagation for." },
                "record_type": {
                    "type": "string",
                    "description": "DNS record type to query.",
                    "enum": ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV", "CAA"]
                },
                "extra_resolvers": {
                    "type": "array",
                    "description": "Additional DNS resolver IPs to check.",
                    "items": { "type": "string" }
                }
            },
            "required": ["domain", "record_type"]
        }),

        "dns_resolve_topology" => json!({
            "type": "object",
            "properties": {
                "hostnames": {
                    "type": "array",
                    "description": "Hostnames to resolve.",
                    "items": { "type": "string" }
                },
                "max_hops": { "type": "integer", "description": "Maximum CNAME chain hops.", "minimum": 1, "maximum": 20 },
                "doh_provider": { "type": "string", "description": "DoH provider (cloudflare, google, quad9)." },
                "dns_server": { "type": "string", "description": "DNS server IP to use." }
            },
            "required": ["hostnames"]
        }),

        // ── DNS Record Parsing/Composing ────────────────────────────────
        "dns_parse_csv" => json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "CSV text with DNS records (type,name,content,ttl,priority,proxied)." }
            },
            "required": ["text"]
        }),

        "dns_parse_bind" => json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "BIND zone file text." }
            },
            "required": ["text"]
        }),

        "dns_export_csv" => json!({
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "description": "DNS records to export as CSV.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string" },
                            "name": { "type": "string" },
                            "content": { "type": "string" },
                            "ttl": { "type": "integer" },
                            "priority": { "type": "integer" },
                            "proxied": { "type": "boolean" },
                            "zone_id": { "type": "string" },
                            "zone_name": { "type": "string" }
                        }
                    }
                }
            },
            "required": ["records"]
        }),

        "dns_export_bind" => json!({
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "description": "DNS records to export as BIND zone format.",
                    "items": { "type": "object" }
                }
            },
            "required": ["records"]
        }),

        "dns_export_json" => json!({
            "type": "object",
            "properties": {
                "records": {
                    "type": "array",
                    "description": "DNS records to export as pretty JSON.",
                    "items": { "type": "object" }
                }
            },
            "required": ["records"]
        }),

        "dns_parse_srv" => json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "SRV record content (priority weight port target)." }
            },
            "required": ["content"]
        }),

        "dns_compose_srv" => json!({
            "type": "object",
            "properties": {
                "priority": { "type": "integer", "description": "Service priority.", "minimum": 0, "maximum": 65535 },
                "weight": { "type": "integer", "description": "Service weight.", "minimum": 0, "maximum": 65535 },
                "port": { "type": "integer", "description": "Service port.", "minimum": 0, "maximum": 65535 },
                "target": { "type": "string", "description": "Target hostname." }
            },
            "required": ["target"]
        }),

        "dns_parse_tlsa" => json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "TLSA record content (usage selector matching_type data)." }
            },
            "required": ["content"]
        }),

        "dns_compose_tlsa" => json!({
            "type": "object",
            "properties": {
                "usage": { "type": "integer", "description": "Certificate usage (0-3).", "minimum": 0, "maximum": 3 },
                "selector": { "type": "integer", "description": "Selector (0-1).", "minimum": 0, "maximum": 1 },
                "matching_type": { "type": "integer", "description": "Matching type (0-2).", "minimum": 0, "maximum": 2 },
                "data": { "type": "string", "description": "Certificate association data (hex)." }
            },
            "required": ["data"]
        }),

        "dns_parse_sshfp" => json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "SSHFP record content (algorithm fptype fingerprint)." }
            },
            "required": ["content"]
        }),

        "dns_compose_sshfp" => json!({
            "type": "object",
            "properties": {
                "algorithm": { "type": "integer", "description": "Algorithm (1=RSA, 2=DSA, 3=ECDSA, 4=Ed25519).", "minimum": 1, "maximum": 4 },
                "fptype": { "type": "integer", "description": "Fingerprint type (1=SHA-1, 2=SHA-256).", "minimum": 1, "maximum": 2 },
                "fingerprint": { "type": "string", "description": "Hex-encoded fingerprint." }
            },
            "required": ["fingerprint"]
        }),

        "dns_parse_naptr" => json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "NAPTR record content." }
            },
            "required": ["content"]
        }),

        "dns_compose_naptr" => json!({
            "type": "object",
            "properties": {
                "order": { "type": "integer", "minimum": 0, "maximum": 65535 },
                "preference": { "type": "integer", "minimum": 0, "maximum": 65535 },
                "flags": { "type": "string", "description": "Flags (e.g. 'U', 'S', 'A', 'P')." },
                "service": { "type": "string", "description": "Service identifier." },
                "regexp": { "type": "string", "description": "Substitution expression." },
                "replacement": { "type": "string", "description": "Replacement domain name." }
            },
            "required": ["flags", "service", "replacement"]
        }),

        // ── Domain Audit ────────────────────────────────────────────────
        "audit_run_domain" => json!({
            "type": "object",
            "properties": {
                "zone_name": { "type": "string", "description": "Domain name to audit (e.g. 'example.com')." },
                "records": {
                    "type": "array",
                    "description": "DNS records for the domain.",
                    "items": { "type": "object" }
                },
                "options": {
                    "type": "object",
                    "description": "Audit options.",
                    "properties": {
                        "include_categories": {
                            "type": "object",
                            "properties": {
                                "email": { "type": "boolean", "description": "Check email (SPF, DKIM, DMARC)." },
                                "security": { "type": "boolean", "description": "Check security (DNSSEC, CAA, HTTPS)." },
                                "hygiene": { "type": "boolean", "description": "Check DNS hygiene (TTL, orphans, bogons)." }
                            }
                        },
                        "domain_expires_at": { "type": "string", "description": "Domain expiry date (ISO 8601)." }
                    }
                }
            },
            "required": ["zone_name", "records"]
        }),

        // Default fallback
        _ => json!({ "type": "object" }),
    }
}
