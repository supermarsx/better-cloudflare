//! DNS utility tool handlers.
//!
//! Covers validation, propagation, topology, registry (RDAP) lookup,
//! CSV/BIND import/export, and structured record parsing/composing
//! (SRV, TLSA, SSHFP, NAPTR).

use std::sync::OnceLock;

use serde_json::{json, Value};

use bc_cloudflare_api::DNSRecord;

use crate::protocol::*;

/// One RDAP client for the process.
///
/// It owns a connection pool, the 10 s request timeout and the HTTPS-only,
/// depth-bounded redirect policy that `bc-notify` defines; rebuilding it per
/// call would throw the pool away and risk a second, divergent definition of
/// those bounds.
fn rdap_client() -> &'static bc_notify::RdapClient {
    static CLIENT: OnceLock<bc_notify::RdapClient> = OnceLock::new();
    CLIENT.get_or_init(bc_notify::RdapClient::default)
}

/// Turn an RDAP failure into something a model can act on rather than retry.
fn describe_rdap_error(error: bc_notify::RdapError) -> String {
    match error {
        bc_notify::RdapError::InvalidDomain => "Invalid domain: expected a bare registrable \
             hostname such as 'example.com' — no scheme, path, port, query, or credentials, and \
             internationalised names must be in punycode."
            .to_string(),
        error if error.is_not_found() => "No registry record: this domain or its TLD has no RDAP \
             data. Some ccTLDs publish none, and internal or unregistered names never will."
            .to_string(),
        error => error.to_string(),
    }
}

/// Execute a DNS utility tool.
pub(super) async fn execute(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "dns_validate_record" => {
            let input: bc_dns_tools::DNSRecordValidationInput = serde_json::from_value(
                args.get("record")
                    .cloned()
                    .ok_or("Missing required argument 'record'")?,
            )
            .map_err(|e| format!("Invalid record: {}", e))?;
            let result = bc_dns_tools::validate_dns_record(&input);
            serde_json::to_value(result).map_err(|e| e.to_string())
        }

        "dns_check_propagation" => {
            let domain = get_required_string(args, "domain")?;
            let record_type = get_required_string(args, "record_type")?;
            let extra = get_string_array(args, "extra_resolvers");
            let options = bc_topology::PropagationOptions {
                resolvers: get_string_array(args, "resolvers"),
                timeout_ms: get_optional_u32(args, "timeout_ms"),
                attempts: get_optional_u8(args, "attempts"),
                consensus_percent: get_optional_u8(args, "consensus_percent"),
            };
            let result =
                bc_topology::check_propagation_with_options(domain, record_type, extra, options)
                    .await
                    .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }

        "dns_check_registration" => {
            // The domain is model-supplied and ends up in a URL; validation,
            // percent-encoding, the timeout and the response bound all live in
            // `bc_notify::rdap`, which is the only thing that builds the
            // request. Nothing here reassembles a URL of its own.
            let domain = get_required_string(args, "domain")?;
            let registration = rdap_client()
                .lookup_registration(&domain)
                .await
                .map_err(describe_rdap_error)?;
            serde_json::to_value(registration).map_err(|e| e.to_string())
        }

        "dns_resolve_topology" => {
            let hostnames: Vec<String> = serde_json::from_value(
                args.get("hostnames")
                    .cloned()
                    .ok_or("Missing required argument 'hostnames'")?,
            )
            .map_err(|e| format!("Invalid hostnames: {}", e))?;
            let max_hops = get_optional_u8(args, "max_hops");
            let doh_provider = get_optional_string(args, "doh_provider");
            let dns_server = get_optional_string(args, "dns_server");
            let result = bc_topology::resolve_topology_batch(
                hostnames,
                max_hops,
                None, // service_hosts
                doh_provider,
                None, // doh_custom_url
                None, // resolver_mode
                dns_server,
                None, // custom_dns_server
                None, // lookup_timeout_ms
                None, // disable_ptr_lookups
                None, // disable_geo_lookups
                None, // geo_provider
                None, // scan_resolution_chain
                None, // tcp_service_ports
            )
            .await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }

        // ── Import / Parse ──────────────────────────────────────────────
        "dns_parse_csv" => {
            let text = get_required_string(args, "text")?;
            let records =
                bc_dns_tools::try_parse_csv_records(&text).map_err(|error| error.to_string())?;
            serde_json::to_value(records).map_err(|e| e.to_string())
        }

        "dns_parse_bind" => {
            let text = get_required_string(args, "text")?;
            let records =
                bc_dns_tools::try_parse_bind_zone(&text).map_err(|error| error.to_string())?;
            serde_json::to_value(records).map_err(|e| e.to_string())
        }

        // ── Export ──────────────────────────────────────────────────────
        "dns_export_csv" => {
            let records: Vec<DNSRecord> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records: {}", e))?;
            let csv =
                bc_dns_tools::try_records_to_csv(&records).map_err(|error| error.to_string())?;
            Ok(json!({ "format": "csv", "data": csv }))
        }

        "dns_export_bind" => {
            let records: Vec<DNSRecord> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records: {}", e))?;
            let bind =
                bc_dns_tools::try_records_to_bind(&records).map_err(|error| error.to_string())?;
            Ok(json!({ "format": "bind", "data": bind }))
        }

        "dns_export_json" => {
            let records: Vec<DNSRecord> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records: {}", e))?;
            let j =
                bc_dns_tools::try_records_to_json(&records).map_err(|error| error.to_string())?;
            Ok(json!({ "format": "json", "data": j }))
        }

        // ── Structured Record Tools ─────────────────────────────────────
        "dns_parse_srv" => {
            let content = get_required_string(args, "content")?;
            let fields = bc_dns_tools::parse_srv(&content);
            serde_json::to_value(fields).map_err(|e| e.to_string())
        }

        "dns_compose_srv" => {
            let priority = get_optional_u16(args, "priority");
            let weight = get_optional_u16(args, "weight");
            let port = get_optional_u16(args, "port");
            let target = get_required_string(args, "target")?;
            let content = bc_dns_tools::compose_srv(priority, weight, port, &target);
            Ok(json!({ "content": content }))
        }

        "dns_parse_tlsa" => {
            let content = get_required_string(args, "content")?;
            let fields = bc_dns_tools::parse_tlsa(&content);
            serde_json::to_value(fields).map_err(|e| e.to_string())
        }

        "dns_compose_tlsa" => {
            let usage = get_optional_u8(args, "usage");
            let selector = get_optional_u8(args, "selector");
            let matching_type = get_optional_u8(args, "matching_type");
            let data = get_required_string(args, "data")?;
            let content = bc_dns_tools::compose_tlsa(usage, selector, matching_type, &data);
            Ok(json!({ "content": content }))
        }

        "dns_parse_sshfp" => {
            let content = get_required_string(args, "content")?;
            let fields = bc_dns_tools::parse_sshfp(&content);
            serde_json::to_value(fields).map_err(|e| e.to_string())
        }

        "dns_compose_sshfp" => {
            let algorithm = get_optional_u8(args, "algorithm");
            let fptype = get_optional_u8(args, "fptype");
            let fingerprint = get_required_string(args, "fingerprint")?;
            let content = bc_dns_tools::compose_sshfp(algorithm, fptype, &fingerprint);
            Ok(json!({ "content": content }))
        }

        "dns_parse_naptr" => {
            let content = get_required_string(args, "content")?;
            let fields = bc_dns_tools::parse_naptr(&content);
            serde_json::to_value(fields).map_err(|e| e.to_string())
        }

        "dns_compose_naptr" => {
            let order = get_optional_u16(args, "order");
            let preference = get_optional_u16(args, "preference");
            let flags = get_required_string(args, "flags")?;
            let service = get_required_string(args, "service")?;
            let regexp = get_optional_string(args, "regexp").unwrap_or_default();
            let replacement = get_required_string(args, "replacement")?;
            let content = bc_dns_tools::compose_naptr(
                order,
                preference,
                &flags,
                &service,
                &regexp,
                &replacement,
            );
            Ok(json!({ "content": content }))
        }

        _ => Err(format!("Unknown DNS tool '{}'", name)),
    }
}
