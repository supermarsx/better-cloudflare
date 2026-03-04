//! MCP resources — static and template-based reference data.
//!
//! Resources provide read-only contextual data to the LLM without tool
//! calls. They include DNS record type references, TTL presets, SPF syntax
//! guides, Cloudflare zone settings references, and firewall expression
//! syntax.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ─── Resource descriptor ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

/// URI template for dynamic resources.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    #[serde(rename = "uriTemplate")]
    pub uri_template: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

// ─── Static resources ──────────────────────────────────────────────────────

pub fn list_resources() -> Vec<McpResource> {
    vec![
        McpResource {
            uri: "dns://record-types".to_string(),
            name: "DNS Record Types".to_string(),
            description: "Reference of all supported DNS record types with descriptions and examples.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "dns://ttl-presets".to_string(),
            name: "TTL Presets".to_string(),
            description: "Common TTL values and their use cases.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "spf://syntax".to_string(),
            name: "SPF Syntax Reference".to_string(),
            description: "Complete SPF record syntax guide with mechanisms, qualifiers, and modifiers.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "cloudflare://zone-settings".to_string(),
            name: "Cloudflare Zone Settings".to_string(),
            description: "Reference of Cloudflare zone setting IDs and their descriptions.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "cloudflare://firewall-expressions".to_string(),
            name: "Firewall Expression Syntax".to_string(),
            description: "Cloudflare firewall expression language reference with fields and operators.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "dns://validation-rules".to_string(),
            name: "DNS Validation Rules".to_string(),
            description: "Record validation rules applied by the dns_validate_record tool.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "cloudflare://api-errors".to_string(),
            name: "Cloudflare API Error Codes".to_string(),
            description: "Common Cloudflare API error codes and their meanings.".to_string(),
            mime_type: "application/json".to_string(),
        },
        McpResource {
            uri: "dns://global-resolvers".to_string(),
            name: "Global DNS Resolvers".to_string(),
            description: "List of global DNS resolvers used by the propagation checker.".to_string(),
            mime_type: "application/json".to_string(),
        },
    ]
}

/// URI templates for dynamic/parameterised resources.
pub fn list_resource_templates() -> Vec<McpResourceTemplate> {
    vec![
        McpResourceTemplate {
            uri_template: "cloudflare://zone/{zone_id}/summary".to_string(),
            name: "Zone Summary".to_string(),
            description: "Summary information for a specific Cloudflare zone.".to_string(),
            mime_type: "application/json".to_string(),
        },
    ]
}

// ─── Resource content ──────────────────────────────────────────────────────

pub fn read_resource(uri: &str) -> Result<Value, String> {
    match uri {
        "dns://record-types" => Ok(dns_record_types_content()),
        "dns://ttl-presets" => Ok(ttl_presets_content()),
        "spf://syntax" => Ok(spf_syntax_content()),
        "cloudflare://zone-settings" => Ok(zone_settings_content()),
        "cloudflare://firewall-expressions" => Ok(firewall_expressions_content()),
        "dns://validation-rules" => Ok(validation_rules_content()),
        "cloudflare://api-errors" => Ok(api_errors_content()),
        "dns://global-resolvers" => Ok(global_resolvers_content()),
        _ => Err(format!("Resource not found: {}", uri)),
    }
}

// ─── Content generators ────────────────────────────────────────────────────

fn dns_record_types_content() -> Value {
    json!({
        "record_types": [
            { "type": "A", "description": "IPv4 address", "example": "192.0.2.1", "proxiable": true },
            { "type": "AAAA", "description": "IPv6 address", "example": "2001:db8::1", "proxiable": true },
            { "type": "CNAME", "description": "Canonical name alias", "example": "alias.example.com", "proxiable": true },
            { "type": "MX", "description": "Mail exchanger", "example": "10 mail.example.com", "proxiable": false, "has_priority": true },
            { "type": "TXT", "description": "Text record (SPF, DKIM, verification)", "example": "v=spf1 include:_spf.google.com ~all", "proxiable": false },
            { "type": "NS", "description": "Nameserver delegation", "example": "ns1.example.com", "proxiable": false },
            { "type": "SRV", "description": "Service locator", "example": "10 5 5060 sip.example.com", "proxiable": false, "has_priority": true },
            { "type": "CAA", "description": "Certification Authority Authorization", "example": "0 issue \"letsencrypt.org\"", "proxiable": false },
            { "type": "TLSA", "description": "TLS certificate association (DANE)", "example": "3 1 1 abc123...", "proxiable": false },
            { "type": "SSHFP", "description": "SSH fingerprint", "example": "1 2 abc123...", "proxiable": false },
            { "type": "NAPTR", "description": "Naming Authority Pointer (SIP, ENUM)", "example": "10 100 \"U\" \"E2U+sip\" \"!^.*$!sip:user@example.com!\" .", "proxiable": false },
            { "type": "PTR", "description": "Pointer / reverse DNS", "example": "host.example.com", "proxiable": false },
            { "type": "SOA", "description": "Start of Authority", "example": "ns1.example.com admin.example.com 2024010101 3600 900 604800 300", "proxiable": false },
            { "type": "DS", "description": "Delegation Signer (DNSSEC)", "example": "12345 13 2 abc123...", "proxiable": false },
            { "type": "DNSKEY", "description": "DNS public key (DNSSEC)", "proxiable": false },
            { "type": "LOC", "description": "Location", "example": "51 30 12.748 N 0 7 39.611 W 0m 0m 0m 0m", "proxiable": false },
            { "type": "CERT", "description": "Certificate record", "proxiable": false },
            { "type": "SMIMEA", "description": "S/MIME certificate association", "proxiable": false },
            { "type": "URI", "description": "Uniform Resource Identifier", "proxiable": false },
            { "type": "HTTPS", "description": "HTTPS service binding", "example": "1 . alpn=\"h2,h3\"", "proxiable": false },
            { "type": "SVCB", "description": "Service binding", "proxiable": false }
        ]
    })
}

fn ttl_presets_content() -> Value {
    json!({
        "presets": [
            { "value": 1, "label": "Auto", "description": "Cloudflare automatic TTL (proxied records)." },
            { "value": 60, "label": "1 minute", "description": "Very aggressive caching. Use for rapidly-changing records during migrations." },
            { "value": 120, "label": "2 minutes", "description": "Short TTL for records that change frequently." },
            { "value": 300, "label": "5 minutes", "description": "Good default for records that may need quick updates." },
            { "value": 600, "label": "10 minutes", "description": "Balanced between freshness and cache efficiency." },
            { "value": 1800, "label": "30 minutes", "description": "Suitable for moderately stable records." },
            { "value": 3600, "label": "1 hour", "description": "Standard TTL for most DNS records." },
            { "value": 7200, "label": "2 hours", "description": "Good for stable records." },
            { "value": 14400, "label": "4 hours", "description": "Long TTL for rarely-changing records." },
            { "value": 43200, "label": "12 hours", "description": "Very stable records." },
            { "value": 86400, "label": "1 day", "description": "Maximum practical TTL for standard records." }
        ],
        "recommendations": {
            "proxied_records": "Use Auto (1) — Cloudflare manages caching.",
            "active_migration": "Use 60-120 seconds for quick rollback capability.",
            "mx_records": "Use 3600 (1 hour) — mail servers cache aggressively anyway.",
            "ns_records": "Use 86400 (1 day) — nameserver changes are rare.",
            "cname_records": "Use 300-3600 depending on update frequency.",
            "txt_records": "Use 300-3600 — SPF/DKIM changes should propagate quickly."
        }
    })
}

fn spf_syntax_content() -> Value {
    json!({
        "version": "v=spf1",
        "qualifiers": [
            { "symbol": "+", "meaning": "Pass (default)", "description": "Sender is authorized." },
            { "symbol": "-", "meaning": "Fail", "description": "Sender is NOT authorized." },
            { "symbol": "~", "meaning": "SoftFail", "description": "Sender is probably not authorized (used for transition)." },
            { "symbol": "?", "meaning": "Neutral", "description": "No policy assertion." }
        ],
        "mechanisms": [
            { "name": "all", "syntax": "all", "description": "Matches all senders. Typically used as the last mechanism." },
            { "name": "ip4", "syntax": "ip4:<ip4-address>/<prefix-length>", "description": "Match sender IP against IPv4 address or CIDR range.", "example": "ip4:192.0.2.0/24" },
            { "name": "ip6", "syntax": "ip6:<ip6-address>/<prefix-length>", "description": "Match sender IP against IPv6 address or CIDR range.", "example": "ip6:2001:db8::/32" },
            { "name": "a", "syntax": "a[:<domain>][/<prefix-length>]", "description": "Match if sender IP is in the A/AAAA records of the domain.", "example": "a:mail.example.com" },
            { "name": "mx", "syntax": "mx[:<domain>][/<prefix-length>]", "description": "Match if sender IP is in the MX records of the domain.", "example": "mx" },
            { "name": "include", "syntax": "include:<domain>", "description": "Recursively evaluate the SPF record of another domain.", "example": "include:_spf.google.com" },
            { "name": "exists", "syntax": "exists:<domain>", "description": "Match if an A record exists for a macro-expanded domain.", "example": "exists:%{i}._spf.example.com" },
            { "name": "ptr", "syntax": "ptr[:<domain>]", "description": "Match via reverse DNS (deprecated, slow).", "example": "ptr:example.com" }
        ],
        "modifiers": [
            { "name": "redirect", "syntax": "redirect=<domain>", "description": "Replace with the SPF record of another domain (only if no match)." },
            { "name": "exp", "syntax": "exp=<domain>", "description": "TXT record to provide a human-readable explanation on failure." }
        ],
        "limits": {
            "dns_lookups": 10,
            "void_lookups": 2,
            "record_length": 450,
            "description": "SPF evaluations must not exceed 10 DNS lookups. Exceeding this causes PermError."
        },
        "best_practices": [
            "Always end with '-all' (hard fail) or '~all' (soft fail).",
            "Use 'include:' for third-party senders (Google, Microsoft, etc.).",
            "Keep DNS lookup count under 10 by flattening includes where possible.",
            "Use DMARC alongside SPF for full email authentication.",
            "Publish a DKIM record in addition to SPF."
        ]
    })
}

fn zone_settings_content() -> Value {
    json!({
        "settings": [
            { "id": "ssl", "description": "SSL/TLS encryption mode", "values": ["off", "flexible", "full", "strict"] },
            { "id": "always_use_https", "description": "Redirect HTTP to HTTPS", "values": ["on", "off"] },
            { "id": "min_tls_version", "description": "Minimum TLS version", "values": ["1.0", "1.1", "1.2", "1.3"] },
            { "id": "tls_1_3", "description": "TLS 1.3 support", "values": ["on", "off", "zrt"] },
            { "id": "automatic_https_rewrites", "description": "Rewrite HTTP links to HTTPS", "values": ["on", "off"] },
            { "id": "opportunistic_encryption", "description": "Opportunistic TLS encryption", "values": ["on", "off"] },
            { "id": "browser_cache_ttl", "description": "Browser cache TTL in seconds", "values": "integer (30-31536000)" },
            { "id": "cache_level", "description": "Caching level", "values": ["bypass", "basic", "simplified", "aggressive", "cache_everything"] },
            { "id": "development_mode", "description": "Bypass cache for development", "values": ["on", "off"] },
            { "id": "minify", "description": "Minification settings", "values": { "css": "on|off", "js": "on|off", "html": "on|off" } },
            { "id": "rocket_loader", "description": "Asynchronous JavaScript loading", "values": ["on", "off"] },
            { "id": "security_level", "description": "Security level", "values": ["off", "essentially_off", "low", "medium", "high", "under_attack"] },
            { "id": "challenge_ttl", "description": "Challenge passage TTL in seconds", "values": [300, 900, 1800, 2700, 3600, 7200, 10800, 14400, 28800, 57600, 86400, 604800, 2592000, 31536000] },
            { "id": "waf", "description": "Web Application Firewall", "values": ["on", "off"] },
            { "id": "always_online", "description": "Always Online mode", "values": ["on", "off"] },
            { "id": "ipv6", "description": "IPv6 compatibility", "values": ["on", "off"] },
            { "id": "websockets", "description": "WebSocket support", "values": ["on", "off"] },
            { "id": "pseudo_ipv4", "description": "Pseudo IPv4 addressing", "values": ["off", "add_header", "overwrite_header"] },
            { "id": "ip_geolocation", "description": "IP geolocation header", "values": ["on", "off"] },
            { "id": "email_obfuscation", "description": "Email address obfuscation", "values": ["on", "off"] },
            { "id": "hotlink_protection", "description": "Hotlink protection", "values": ["on", "off"] },
            { "id": "h2_prioritization", "description": "HTTP/2 prioritization", "values": ["on", "off", "custom"] },
            { "id": "early_hints", "description": "Early Hints (103)", "values": ["on", "off"] },
            { "id": "0rtt", "description": "0-RTT Connection Resumption", "values": ["on", "off"] }
        ]
    })
}

fn firewall_expressions_content() -> Value {
    json!({
        "fields": [
            { "name": "ip.src", "type": "IP", "description": "Source IP address of the request." },
            { "name": "ip.src.lat", "type": "String", "description": "Latitude of source IP." },
            { "name": "ip.src.lon", "type": "String", "description": "Longitude of source IP." },
            { "name": "ip.src.city", "type": "String", "description": "City of source IP." },
            { "name": "ip.src.postal_code", "type": "String", "description": "Postal code of source IP." },
            { "name": "ip.src.metro_code", "type": "String", "description": "Metro code of source IP." },
            { "name": "ip.src.region", "type": "String", "description": "Region of source IP." },
            { "name": "ip.src.country", "type": "String", "description": "Country code of source IP (ISO 3166-1 alpha-2)." },
            { "name": "ip.src.continent", "type": "String", "description": "Continent code (AF, AN, AS, EU, NA, OC, SA)." },
            { "name": "ip.geoip.asnum", "type": "Integer", "description": "ASN of source IP." },
            { "name": "http.host", "type": "String", "description": "HTTP Host header." },
            { "name": "http.request.uri", "type": "String", "description": "Full request URI including query string." },
            { "name": "http.request.uri.path", "type": "String", "description": "Request URI path." },
            { "name": "http.request.uri.query", "type": "String", "description": "Request query string." },
            { "name": "http.request.method", "type": "String", "description": "HTTP method (GET, POST, etc.)." },
            { "name": "http.request.version", "type": "String", "description": "HTTP version." },
            { "name": "http.referer", "type": "String", "description": "HTTP Referer header." },
            { "name": "http.user_agent", "type": "String", "description": "HTTP User-Agent header." },
            { "name": "http.cookie", "type": "String", "description": "HTTP Cookie header." },
            { "name": "http.x_forwarded_for", "type": "String", "description": "X-Forwarded-For header." },
            { "name": "ssl", "type": "Boolean", "description": "Whether connection uses SSL/TLS." },
            { "name": "cf.bot_management.score", "type": "Integer", "description": "Bot score (1=bot, 99=human)." },
            { "name": "cf.bot_management.verified_bot", "type": "Boolean", "description": "Whether request is from a verified bot." },
            { "name": "cf.threat_score", "type": "Integer", "description": "Cloudflare threat score (0-100)." },
            { "name": "cf.edge.server_port", "type": "Integer", "description": "Port number at edge server." }
        ],
        "operators": {
            "comparison": ["eq", "ne", "lt", "le", "gt", "ge"],
            "string": ["contains", "starts_with", "ends_with", "matches"],
            "set": ["in"],
            "logical": ["and", "or", "not"],
            "existence": ["is in", "not in"]
        },
        "examples": [
            { "expression": "ip.src eq 1.2.3.4", "description": "Block a specific IP." },
            { "expression": "ip.src.country eq \"CN\"", "description": "Match traffic from China." },
            { "expression": "http.request.uri.path contains \"/admin\"", "description": "Match admin paths." },
            { "expression": "http.request.method eq \"POST\" and http.request.uri.path eq \"/login\"", "description": "Match POST to login." },
            { "expression": "not ip.src in {10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}", "description": "Match non-RFC1918 IPs." },
            { "expression": "cf.bot_management.score lt 30", "description": "Match likely bots." },
            { "expression": "ssl and http.host eq \"secure.example.com\"", "description": "Match HTTPS to specific host." },
            { "expression": "http.user_agent contains \"curl\"", "description": "Match curl user agent." }
        ]
    })
}

fn validation_rules_content() -> Value {
    json!({
        "rules": [
            { "field": "type", "rule": "Required. Must be a valid DNS record type (A, AAAA, CNAME, MX, TXT, etc.)." },
            { "field": "name", "rule": "Required. Must be a valid hostname. Max 253 characters, labels max 63 chars." },
            { "field": "content", "rules": [
                { "type": "A", "rule": "Must be a valid IPv4 address." },
                { "type": "AAAA", "rule": "Must be a valid IPv6 address." },
                { "type": "CNAME", "rule": "Must be a valid hostname. Cannot coexist at zone apex with other records." },
                { "type": "MX", "rule": "Must be a valid hostname (not an IP). Priority required." },
                { "type": "TXT", "rule": "Any text. Max 2048 characters per chunk (can be split across 255-byte strings)." },
                { "type": "SRV", "rule": "Format: priority weight port target." },
                { "type": "CAA", "rule": "Format: flags tag value (e.g. '0 issue \"letsencrypt.org\"')." },
                { "type": "TLSA", "rule": "Format: usage selector matching_type certificate_data." },
                { "type": "SSHFP", "rule": "Format: algorithm fptype fingerprint." },
                { "type": "NAPTR", "rule": "Format: order preference flags service regexp replacement." }
            ]},
            { "field": "ttl", "rule": "Optional. Must be 1 (auto) or 60-86400 seconds." },
            { "field": "priority", "rule": "Required for MX and SRV. Integer 0-65535." },
            { "field": "proxied", "rule": "Only valid for A, AAAA, CNAME records. Enables Cloudflare reverse proxy." }
        ]
    })
}

fn api_errors_content() -> Value {
    json!({
        "common_errors": [
            { "code": 6003, "message": "Invalid request headers", "fix": "Check API key/token format." },
            { "code": 6111, "message": "Invalid format for Authorization header", "fix": "Use 'Bearer <token>' or 'X-Auth-Key' + 'X-Auth-Email'." },
            { "code": 7003, "message": "Could not route to /zones", "fix": "Verify zone ID is correct." },
            { "code": 7000, "message": "No route for that URI", "fix": "Check the API endpoint path." },
            { "code": 9103, "message": "DNS name cannot be empty", "fix": "Provide a record name." },
            { "code": 9104, "message": "DNS record type is invalid", "fix": "Use a supported record type." },
            { "code": 9109, "message": "Duplicate record", "fix": "A record with this type/name/content already exists." },
            { "code": 1001, "message": "Invalid zone ID", "fix": "Zone ID must be a 32-character hex string." },
            { "code": 1004, "message": "DNS validation error", "fix": "Check record content format." },
            { "code": 10000, "message": "Authentication error", "fix": "Verify API token permissions." },
            { "code": 81057, "message": "CNAME at apex", "fix": "Use Cloudflare CNAME flattening or an A record instead." }
        ],
        "rate_limits": {
            "api_v4": "1200 requests per 5 minutes per user",
            "zone_read": "5000 per 5 minutes",
            "retry_header": "Retry-After (seconds)"
        }
    })
}

fn global_resolvers_content() -> Value {
    json!({
        "resolvers": [
            { "ip": "8.8.8.8", "label": "Google (US)", "provider": "Google Public DNS" },
            { "ip": "8.8.4.4", "label": "Google Secondary (US)", "provider": "Google Public DNS" },
            { "ip": "1.1.1.1", "label": "Cloudflare (Global)", "provider": "Cloudflare" },
            { "ip": "1.0.0.1", "label": "Cloudflare Secondary (Global)", "provider": "Cloudflare" },
            { "ip": "9.9.9.9", "label": "Quad9 (Global)", "provider": "Quad9" },
            { "ip": "208.67.222.222", "label": "OpenDNS (US)", "provider": "Cisco OpenDNS" },
            { "ip": "208.67.220.220", "label": "OpenDNS Secondary (US)", "provider": "Cisco OpenDNS" },
            { "ip": "185.228.168.9", "label": "CleanBrowsing (EU)", "provider": "CleanBrowsing" },
            { "ip": "76.76.19.19", "label": "Alternate DNS (US)", "provider": "Alternate DNS" },
            { "ip": "94.140.14.14", "label": "AdGuard (EU)", "provider": "AdGuard DNS" },
            { "ip": "77.88.8.8", "label": "Yandex (RU)", "provider": "Yandex DNS" },
            { "ip": "119.29.29.29", "label": "DNSPod (CN)", "provider": "Tencent DNSPod" },
            { "ip": "223.5.5.5", "label": "AliDNS (CN)", "provider": "Alibaba" },
            { "ip": "168.126.63.1", "label": "KT (KR)", "provider": "Korea Telecom" },
            { "ip": "156.154.70.1", "label": "Neustar (US)", "provider": "Neustar UltraDNS" }
        ]
    })
}
