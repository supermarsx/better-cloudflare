use tauri::State;

use crate::cloudflare_api::{
    CloudflareClient, DNSRecord, DNSRecordInput, Zone,
};
use crate::storage::Storage;

use super::log_audit;

// ─── DNS Operations ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_zones(api_key: String, email: Option<String>) -> Result<Vec<Zone>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_zones().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_dns_records(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<Vec<DNSRecord>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_dns_records(&zone_id, page, per_page)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_dns_record(&zone_id, record)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
            "record_type": created.r#type,
            "record_name": created.name,
        }),
    )
    .await;
    Ok(created)
}

#[tauri::command]
pub async fn update_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let updated = client
        .update_dns_record(&zone_id, &record_id, record)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:update",
            "resource": record_id,
            "zone_id": zone_id,
            "record_type": updated.r#type,
            "record_name": updated.name,
        }),
    )
    .await;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .delete_dns_record(&zone_id, &record_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:delete",
            "resource": record_id,
            "zone_id": zone_id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn create_bulk_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    records: Vec<DNSRecordInput>,
    dryrun: Option<bool>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .create_bulk_dns_records(&zone_id, records, dryrun.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:bulk_create",
            "resource": zone_id,
            "dry_run": dryrun.unwrap_or(false),
            "created": result.get("created").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
            "skipped": result.get("skipped").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn export_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    format: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<String, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let data = client
        .export_dns_records(&zone_id, &format, page, per_page)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:export",
            "resource": zone_id,
            "format": format,
            "page": page,
            "per_page": per_page,
        }),
    )
    .await;
    Ok(data)
}

#[tauri::command]
pub async fn purge_cache(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    purge_everything: bool,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .purge_cache(&zone_id, purge_everything, files.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "cache:purge",
            "resource": zone_id,
            "purge_everything": purge_everything,
            "files_count": files.as_ref().map(|v| v.len()).unwrap_or(0),
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_zone_setting(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_zone_setting(&zone_id, &setting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_zone_setting(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .update_zone_setting(&zone_id, &setting_id, value.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "zone_setting:update",
            "resource": setting_id,
            "zone_id": zone_id,
            "value": value,
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_dnssec(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_dnssec(&zone_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_dnssec(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .update_dnssec(&zone_id, payload.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dnssec:update",
            "resource": zone_id,
            "payload": payload,
        }),
    )
    .await;
    Ok(result)
}

// ─── Bulk Operations ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn delete_bulk_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_ids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .delete_bulk_dns_records(&zone_id, &record_ids)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:bulk_delete",
            "resource": zone_id,
            "count": record_ids.len(),
        }),
    )
    .await;
    Ok(result)
}

// ─── SPF ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn simulate_spf(
    domain: String,
    ip: String,
) -> Result<bc_spf::SPFSimulation, String> {
    bc_spf::simulate_spf(&domain, &ip).await
}

#[tauri::command]
pub async fn spf_graph(domain: String) -> Result<bc_spf::SPFGraph, String> {
    bc_spf::build_spf_graph(&domain).await
}

// ─── Topology ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn resolve_topology_batch(
    hostnames: Vec<String>,
    max_hops: Option<u8>,
    service_hosts: Option<Vec<String>>,
    doh_provider: Option<String>,
    doh_custom_url: Option<String>,
    resolver_mode: Option<String>,
    dns_server: Option<String>,
    custom_dns_server: Option<String>,
    lookup_timeout_ms: Option<u32>,
    disable_ptr_lookups: Option<bool>,
    disable_geo_lookups: Option<bool>,
    geo_provider: Option<String>,
    scan_resolution_chain: Option<bool>,
    tcp_service_ports: Option<Vec<u16>>,
) -> Result<bc_topology::TopologyBatchResult, String> {
    bc_topology::resolve_topology_batch(
        hostnames,
        max_hops,
        service_hosts,
        doh_provider,
        doh_custom_url,
        resolver_mode,
        dns_server,
        custom_dns_server,
        lookup_timeout_ms,
        disable_ptr_lookups,
        disable_geo_lookups,
        geo_provider,
        scan_resolution_chain,
        tcp_service_ports,
    )
    .await
}

// ─── DNS Tools ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_csv_records(text: String) -> Vec<bc_dns_tools::PartialDNSRecord> {
    bc_dns_tools::parse_csv_records(&text)
}

#[tauri::command]
pub fn parse_bind_zone(text: String) -> Vec<bc_dns_tools::PartialDNSRecord> {
    bc_dns_tools::parse_bind_zone(&text)
}

#[tauri::command]
pub fn validate_dns_record(
    input: bc_dns_tools::DNSRecordValidationInput,
) -> bc_dns_tools::ValidationResult {
    bc_dns_tools::validate_dns_record(&input)
}

#[tauri::command]
pub fn parse_srv(content: String) -> bc_dns_tools::SRVFields {
    bc_dns_tools::parse_srv(&content)
}

#[tauri::command]
pub fn compose_srv(
    priority: Option<u16>,
    weight: Option<u16>,
    port: Option<u16>,
    target: String,
) -> String {
    bc_dns_tools::compose_srv(priority, weight, port, &target)
}

#[tauri::command]
pub fn parse_tlsa(content: String) -> bc_dns_tools::TLSAFields {
    bc_dns_tools::parse_tlsa(&content)
}

#[tauri::command]
pub fn compose_tlsa(
    usage: Option<u8>,
    selector: Option<u8>,
    matching_type: Option<u8>,
    data: String,
) -> String {
    bc_dns_tools::compose_tlsa(usage, selector, matching_type, &data)
}

#[tauri::command]
pub fn parse_sshfp(content: String) -> bc_dns_tools::SSHFPFields {
    bc_dns_tools::parse_sshfp(&content)
}

#[tauri::command]
pub fn compose_sshfp(algorithm: Option<u8>, fptype: Option<u8>, fingerprint: String) -> String {
    bc_dns_tools::compose_sshfp(algorithm, fptype, &fingerprint)
}

#[tauri::command]
pub fn parse_naptr(content: String) -> bc_dns_tools::NAPTRFields {
    bc_dns_tools::parse_naptr(&content)
}

#[tauri::command]
pub fn compose_naptr(
    order: Option<u16>,
    preference: Option<u16>,
    flags: String,
    service: String,
    regexp: String,
    replacement: String,
) -> String {
    bc_dns_tools::compose_naptr(order, preference, &flags, &service, &regexp, &replacement)
}

#[tauri::command]
pub fn records_to_csv(records: Vec<DNSRecord>) -> String {
    bc_dns_tools::records_to_csv(&records)
}

#[tauri::command]
pub fn records_to_bind(records: Vec<DNSRecord>) -> String {
    bc_dns_tools::records_to_bind(&records)
}

#[tauri::command]
pub fn records_to_json(records: Vec<DNSRecord>) -> String {
    bc_dns_tools::records_to_json(&records)
}

#[tauri::command]
pub fn parse_spf(content: String) -> Option<bc_spf::SPFRecord> {
    bc_spf::parse_spf(&content)
}

// ─── Domain Audit ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn run_domain_audit(
    zone_name: String,
    records: Vec<DNSRecord>,
    options: bc_domain_audit::AuditOptions,
) -> Vec<bc_domain_audit::AuditItem> {
    bc_domain_audit::run_domain_audit(&zone_name, &records, &options)
}

// ─── DNS Propagation ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_dns_propagation(
    domain: String,
    record_type: String,
    extra_resolvers: Option<Vec<String>>,
) -> Result<bc_topology::PropagationResult, String> {
    bc_topology::check_propagation(domain, record_type, extra_resolvers).await
}
