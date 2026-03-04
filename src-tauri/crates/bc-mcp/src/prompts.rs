//! MCP prompts — structured prompt templates for common workflows.
//!
//! Prompts guide the LLM through multi-step tasks like DNS troubleshooting,
//! SPF debugging, security audits, zone migrations, and firewall setup.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── Prompt descriptor ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPrompt {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<PromptArgument>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptArgument {
    pub name: String,
    pub description: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMessage {
    pub role: String,
    pub content: PromptContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

// ─── Prompt catalogue ──────────────────────────────────────────────────────

pub fn list_prompts() -> Vec<McpPrompt> {
    vec![
        McpPrompt {
            name: "dns-troubleshoot".to_string(),
            description: "Troubleshoot DNS resolution issues for a domain. Guides through checking propagation, validating records, and identifying common problems.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "domain".to_string(),
                    description: "The domain to troubleshoot.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "record_type".to_string(),
                    description: "DNS record type to check (A, AAAA, CNAME, MX, TXT).".to_string(),
                    required: false,
                },
                PromptArgument {
                    name: "issue".to_string(),
                    description: "Description of the issue (e.g. 'website not loading', 'email not delivered').".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "spf-debug".to_string(),
            description: "Debug SPF configuration for a domain. Checks SPF record syntax, DNS lookup count, include chain, and simulates delivery from a specific IP.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "domain".to_string(),
                    description: "The domain to check SPF for.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "sender_ip".to_string(),
                    description: "IP address to simulate sending from.".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "domain-security-audit".to_string(),
            description: "Run a comprehensive security audit on a domain's DNS configuration. Checks email authentication (SPF, DKIM, DMARC), DNSSEC, CAA, HTTPS, and hygiene issues.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "domain".to_string(),
                    description: "The domain to audit.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "zone_id".to_string(),
                    description: "Cloudflare zone ID (to fetch live records).".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "zone-migration".to_string(),
            description: "Guide through migrating DNS records from one provider to Cloudflare. Helps export, validate, and import records with pre-flight checks.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "domain".to_string(),
                    description: "The domain being migrated.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "source_format".to_string(),
                    description: "Source format of records to import (csv, bind, json).".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "firewall-setup".to_string(),
            description: "Help set up Cloudflare firewall rules. Guides through common patterns: geo-blocking, rate limiting, bot protection, path protection, and WAF configuration.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "zone_id".to_string(),
                    description: "Cloudflare zone ID.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "goal".to_string(),
                    description: "What to protect against (e.g. 'block specific countries', 'protect admin panel', 'stop bots').".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "email-setup".to_string(),
            description: "Set up complete email authentication for a domain. Guides through SPF, DKIM, DMARC, and Cloudflare Email Routing configuration.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "domain".to_string(),
                    description: "The domain to configure email for.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "provider".to_string(),
                    description: "Email provider (google, microsoft, zoho, fastmail, custom).".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "ssl-setup".to_string(),
            description: "Configure SSL/TLS settings for a Cloudflare zone. Guides through SSL mode selection, HSTS, minimum TLS version, and certificate management.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "zone_id".to_string(),
                    description: "Cloudflare zone ID.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "current_ssl".to_string(),
                    description: "Current SSL mode if known (off, flexible, full, strict).".to_string(),
                    required: false,
                },
            ]),
        },
        McpPrompt {
            name: "performance-optimize".to_string(),
            description: "Optimize Cloudflare zone performance settings. Reviews and recommends caching, minification, HTTP/2, early hints, Rocket Loader, and image optimization settings.".to_string(),
            arguments: Some(vec![
                PromptArgument {
                    name: "zone_id".to_string(),
                    description: "Cloudflare zone ID.".to_string(),
                    required: true,
                },
                PromptArgument {
                    name: "site_type".to_string(),
                    description: "Type of site (static, blog, ecommerce, api, spa).".to_string(),
                    required: false,
                },
            ]),
        },
    ]
}

// ─── Prompt messages ───────────────────────────────────────────────────────

pub fn get_prompt(name: &str, args: &Value) -> Result<Vec<PromptMessage>, String> {
    match name {
        "dns-troubleshoot" => Ok(dns_troubleshoot_messages(args)),
        "spf-debug" => Ok(spf_debug_messages(args)),
        "domain-security-audit" => Ok(domain_audit_messages(args)),
        "zone-migration" => Ok(zone_migration_messages(args)),
        "firewall-setup" => Ok(firewall_setup_messages(args)),
        "email-setup" => Ok(email_setup_messages(args)),
        "ssl-setup" => Ok(ssl_setup_messages(args)),
        "performance-optimize" => Ok(performance_optimize_messages(args)),
        _ => Err(format!("Prompt '{}' not found", name)),
    }
}

fn msg(role: &str, text: &str) -> PromptMessage {
    PromptMessage {
        role: role.to_string(),
        content: PromptContent {
            content_type: "text".to_string(),
            text: text.to_string(),
        },
    }
}

fn get_arg(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn dns_troubleshoot_messages(args: &Value) -> Vec<PromptMessage> {
    let domain = get_arg(args, "domain");
    let record_type = get_arg(args, "record_type");
    let issue = get_arg(args, "issue");

    let rt = if record_type.is_empty() { "A".to_string() } else { record_type };
    let issue_ctx = if issue.is_empty() {
        String::new()
    } else {
        format!("\nThe user reports: {}", issue)
    };

    vec![
        msg("user", &format!(
            "I need help troubleshooting DNS for the domain '{domain}'.{issue_ctx}\n\n\
            Please follow these steps:\n\
            1. Use `dns_check_propagation` with domain='{domain}' and record_type='{rt}' to check propagation across global resolvers.\n\
            2. If the domain uses Cloudflare, use `cf_list_dns_records` to fetch the actual records.\n\
            3. Use `dns_validate_record` on each record to check for issues.\n\
            4. Compare propagated values vs. configured values.\n\
            5. Check for common issues: wrong IP, missing records, CNAME at apex, TTL too low/high.\n\
            6. Provide a summary of findings and recommended fixes."
        )),
    ]
}

fn spf_debug_messages(args: &Value) -> Vec<PromptMessage> {
    let domain = get_arg(args, "domain");
    let sender_ip = get_arg(args, "sender_ip");

    let sim_step = if sender_ip.is_empty() {
        "3. If the user provides a sender IP, use `spf_simulate` to test delivery.".to_string()
    } else {
        format!("3. Use `spf_simulate` with domain='{domain}' and ip='{sender_ip}' to test delivery from that IP.")
    };

    vec![
        msg("user", &format!(
            "Debug the SPF configuration for '{domain}'.\n\n\
            Steps:\n\
            1. Use `spf_parse` or `spf_graph` to analyze the SPF record structure.\n\
            2. Check the include chain depth. SPF allows max 10 DNS lookups.\n\
            {sim_step}\n\
            4. Check for common issues: missing 'v=spf1', too many includes, wrong IP ranges, missing '-all' or '~all'.\n\
            5. If there's a DMARC record, check alignment.\n\
            6. Provide a summary with the verdict and fix recommendations."
        )),
    ]
}

fn domain_audit_messages(args: &Value) -> Vec<PromptMessage> {
    let domain = get_arg(args, "domain");
    let zone_id = get_arg(args, "zone_id");

    let fetch_step = if zone_id.is_empty() {
        format!("1. First, try to identify the zone for '{domain}'. Ask the user for the zone_id if needed.")
    } else {
        format!("1. Use `cf_list_dns_records` with zone_id='{zone_id}' to fetch all records.")
    };

    vec![
        msg("user", &format!(
            "Run a comprehensive security and configuration audit for '{domain}'.\n\n\
            Steps:\n\
            {fetch_step}\n\
            2. Use `audit_run_domain` with the zone name and records to run the automated audit.\n\
            3. Review each finding (Pass/Info/Warn/Fail) by category (Email, Security, Hygiene).\n\
            4. For any Fail or Warn items, explain the risk and how to fix it.\n\
            5. Check SPF, DKIM, DMARC, DNSSEC, CAA, HTTPS redirect, and record hygiene.\n\
            6. Provide a scorecard summary and prioritized action items."
        )),
    ]
}

fn zone_migration_messages(args: &Value) -> Vec<PromptMessage> {
    let domain = get_arg(args, "domain");
    let source_format = get_arg(args, "source_format");

    let import_step = if source_format.is_empty() {
        "2. Parse the records using `dns_parse_csv` or `dns_parse_bind` depending on format.".to_string()
    } else {
        let tool = if source_format == "bind" { "dns_parse_bind" } else { "dns_parse_csv" };
        format!("2. Parse the records using `{tool}`.")
    };

    vec![
        msg("user", &format!(
            "Help me migrate the DNS records for '{domain}' to Cloudflare.\n\n\
            Steps:\n\
            1. Ask the user to provide their current DNS records (as CSV, BIND zone file, or JSON).\n\
            {import_step}\n\
            3. Validate each parsed record using `dns_validate_record`.\n\
            4. Review for any issues: unsupported record types, CNAME conflicts, bogon IPs.\n\
            5. Use `cf_bulk_create_dns_records` with dryrun=true first to validate.\n\
            6. If dry-run passes, create the records.\n\
            7. Use `dns_check_propagation` to verify records are live.\n\
            8. Remind about nameserver changes and TTL propagation delay."
        )),
    ]
}

fn firewall_setup_messages(args: &Value) -> Vec<PromptMessage> {
    let zone_id = get_arg(args, "zone_id");
    let goal = get_arg(args, "goal");

    let goal_ctx = if goal.is_empty() {
        String::new()
    } else {
        format!("\nThe user's goal: {}", goal)
    };

    vec![
        msg("user", &format!(
            "Help me set up firewall rules for zone '{zone_id}'.{goal_ctx}\n\n\
            Steps:\n\
            1. Use `cf_list_firewall_rules` to see existing rules.\n\
            2. Use `cf_list_ip_access_rules` to see existing IP rules.\n\
            3. Based on the goal, suggest appropriate rules using the firewall expression syntax.\n\
            4. Common patterns:\n\
               - Geo-block: `ip.src.country in {{\"CN\" \"RU\"}}`\n\
               - Protect admin: `http.request.uri.path contains \"/admin\" and not ip.src in {{office_ip}}`\n\
               - Challenge bots: `cf.bot_management.score lt 30`\n\
               - Rate limit login: `http.request.uri.path eq \"/login\" and http.request.method eq \"POST\"`\n\
            5. Create the rules using `cf_create_firewall_rule`.\n\
            6. Verify with `cf_list_firewall_rules`."
        )),
    ]
}

fn email_setup_messages(args: &Value) -> Vec<PromptMessage> {
    let domain = get_arg(args, "domain");
    let provider = get_arg(args, "provider");

    let provider_ctx = if provider.is_empty() {
        String::new()
    } else {
        format!("\nEmail provider: {}", provider)
    };

    vec![
        msg("user", &format!(
            "Set up complete email authentication for '{domain}'.{provider_ctx}\n\n\
            Steps:\n\
            1. Check existing email records: MX, SPF (TXT), DKIM (TXT), DMARC (TXT).\n\
            2. Configure SPF:\n\
               - Google: `v=spf1 include:_spf.google.com ~all`\n\
               - Microsoft: `v=spf1 include:spf.protection.outlook.com ~all`\n\
               - Generic: `v=spf1 ip4:<server_ip> ~all`\n\
            3. Verify SPF with `spf_parse` and `spf_simulate`.\n\
            4. Guide DKIM setup (provider-specific selector records).\n\
            5. Set up DMARC: `v=DMARC1; p=quarantine; rua=mailto:dmarc@{domain}`\n\
            6. Optionally configure Cloudflare Email Routing with `cf_create_email_routing_rule`.\n\
            7. Run `audit_run_domain` to verify the complete setup.\n\
            8. Test with `spf_simulate` from the mail server IP."
        )),
    ]
}

fn ssl_setup_messages(args: &Value) -> Vec<PromptMessage> {
    let zone_id = get_arg(args, "zone_id");
    let current_ssl = get_arg(args, "current_ssl");

    let current_ctx = if current_ssl.is_empty() {
        String::new()
    } else {
        format!("\nCurrent SSL mode: {}", current_ssl)
    };

    vec![
        msg("user", &format!(
            "Configure SSL/TLS for zone '{zone_id}'.{current_ctx}\n\n\
            Steps:\n\
            1. Use `cf_get_zone_setting` with setting_id='ssl' to check current SSL mode.\n\
            2. Recommend 'strict' (Full Strict) for best security.\n\
            3. Configure related settings:\n\
               - `always_use_https` → 'on'\n\
               - `min_tls_version` → '1.2'\n\
               - `tls_1_3` → 'on'\n\
               - `automatic_https_rewrites` → 'on'\n\
               - `opportunistic_encryption` → 'on'\n\
            4. Apply each setting with `cf_update_zone_setting`.\n\
            5. Check HSTS headers if applicable.\n\
            6. Verify DNSSEC with `cf_get_dnssec`."
        )),
    ]
}

fn performance_optimize_messages(args: &Value) -> Vec<PromptMessage> {
    let zone_id = get_arg(args, "zone_id");
    let site_type = get_arg(args, "site_type");

    let type_ctx = if site_type.is_empty() {
        String::new()
    } else {
        format!("\nSite type: {}", site_type)
    };

    vec![
        msg("user", &format!(
            "Optimize performance settings for zone '{zone_id}'.{type_ctx}\n\n\
            Steps:\n\
            1. Check current zone analytics with `cf_get_zone_analytics` (last 24h).\n\
            2. Review current settings with `cf_get_zone_setting` for these IDs:\n\
               - cache_level, browser_cache_ttl, development_mode\n\
               - minify (css/js/html), rocket_loader\n\
               - h2_prioritization, early_hints, 0rtt\n\
            3. Recommend settings based on site type:\n\
               - Static: aggressive caching, long TTL, minify all\n\
               - SPA: cache static assets, short HTML TTL\n\
               - API: minimal caching, no minify, HTTP/2\n\
               - E-commerce: balanced caching, Rocket Loader off\n\
            4. Apply optimizations with `cf_update_zone_setting`.\n\
            5. Suggest Worker routes for advanced caching if applicable.\n\
            6. Review after changes with analytics."
        )),
    ]
}
