//! DNS utility tool handlers.
//!
//! Covers validation, propagation, topology, CSV/BIND import/export,
//! and structured record parsing/composing (SRV, TLSA, SSHFP, NAPTR).

use serde_json::{json, Value};

use bc_cloudflare_api::DNSRecord;

use crate::protocol::*;

/// Execute a DNS utility tool.
pub async fn execute(name: &str, args: &Value) -> Result<Value, String> {
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
            let result = bc_topology::check_propagation(domain, record_type, extra)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
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
            let records = bc_dns_tools::parse_csv_records(&text);
            serde_json::to_value(records).map_err(|e| e.to_string())
        }

        "dns_parse_bind" => {
            let text = get_required_string(args, "text")?;
            let records = bc_dns_tools::parse_bind_zone(&text);
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
            let csv = bc_dns_tools::records_to_csv(&records);
            Ok(json!({ "format": "csv", "data": csv }))
        }

        "dns_export_bind" => {
            let records: Vec<DNSRecord> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records: {}", e))?;
            let bind = bc_dns_tools::records_to_bind(&records);
            Ok(json!({ "format": "bind", "data": bind }))
        }

        "dns_export_json" => {
            let records: Vec<DNSRecord> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records: {}", e))?;
            let j = bc_dns_tools::records_to_json(&records);
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
            let content =
                bc_dns_tools::compose_naptr(order, preference, &flags, &service, &regexp, &replacement);
            Ok(json!({ "content": content }))
        }

        _ => Err(format!("Unknown DNS tool '{}'", name)),
    }
}
