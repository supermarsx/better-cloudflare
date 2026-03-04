//! Domain audit tool handler.

use serde_json::Value;

use bc_cloudflare_api::DNSRecord;

use crate::protocol::*;

/// Execute the domain audit tool.
pub async fn execute(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "audit_run_domain" => {
            let zone_name = get_required_string(args, "zone_name")?;
            let records: Vec<DNSRecord> = serde_json::from_value(
                args.get("records")
                    .cloned()
                    .ok_or("Missing required argument 'records'")?,
            )
            .map_err(|e| format!("Invalid records: {}", e))?;

            let options: bc_domain_audit::AuditOptions = if let Some(opts) = args.get("options") {
                serde_json::from_value(opts.clone())
                    .map_err(|e| format!("Invalid audit options: {}", e))?
            } else {
                bc_domain_audit::AuditOptions::default()
            };

            let items = bc_domain_audit::run_domain_audit(&zone_name, &records, &options);
            serde_json::to_value(items).map_err(|e| e.to_string())
        }

        _ => Err(format!("Unknown audit tool '{}'", name)),
    }
}
