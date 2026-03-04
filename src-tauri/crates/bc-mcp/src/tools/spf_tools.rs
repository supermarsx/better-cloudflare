//! SPF tool handlers.

use serde_json::Value;

use crate::protocol::*;

/// Execute an SPF tool.
pub async fn execute(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "spf_simulate" => {
            let domain = get_required_string(args, "domain")?;
            let ip = get_required_string(args, "ip")?;
            let simulation = bc_spf::simulate_spf(&domain, &ip).await?;
            serde_json::to_value(simulation).map_err(|e| e.to_string())
        }

        "spf_graph" => {
            let domain = get_required_string(args, "domain")?;
            let graph = bc_spf::build_spf_graph(&domain).await?;
            serde_json::to_value(graph).map_err(|e| e.to_string())
        }

        "spf_parse" => {
            let content = get_required_string(args, "content")?;
            match bc_spf::parse_spf(&content) {
                Some(record) => serde_json::to_value(record).map_err(|e| e.to_string()),
                None => Err("Failed to parse SPF record. Ensure it starts with 'v=spf1'.".to_string()),
            }
        }

        _ => Err(format!("Unknown SPF tool '{}'", name)),
    }
}
