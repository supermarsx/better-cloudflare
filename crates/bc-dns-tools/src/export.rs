//! DNS record export: CSV, BIND zone, and JSON formatters.

use bc_cloudflare_api::DNSRecord;

/// Convert DNS records into CSV format.
///
/// The CSV contains header fields: Type, Name, Content, TTL, Priority, Proxied.
pub fn records_to_csv(records: &[DNSRecord]) -> String {
    let escape = |val: &str| -> String {
        format!("\"{}\"", val.replace('"', "\"\""))
    };

    let headers = ["Type", "Name", "Content", "TTL", "Priority", "Proxied"]
        .iter()
        .map(|h| escape(h))
        .collect::<Vec<_>>()
        .join(",");

    let mut rows = Vec::with_capacity(records.len());
    for r in records {
        let ttl_str = r.ttl.map(|t| t.to_string()).unwrap_or_default();
        let priority_str = r.priority.map(|p| p.to_string()).unwrap_or_default();
        let proxied_str = r.proxied.map(|p| p.to_string()).unwrap_or_else(|| "false".to_string());

        let row = [
            escape(&r.r#type),
            escape(&r.name),
            escape(&r.content),
            escape(&ttl_str),
            escape(&priority_str),
            escape(&proxied_str),
        ]
        .join(",");
        rows.push(row);
    }

    format!("{}\n{}", headers, rows.join("\n"))
}

/// Convert DNS records into a BIND-style zone file snippet.
pub fn records_to_bind(records: &[DNSRecord]) -> String {
    records
        .iter()
        .map(|r| {
            let ttl = r.ttl.unwrap_or(300);
            let priority = r
                .priority
                .map(|p| format!("{} ", p))
                .unwrap_or_default();
            format!("{}\t{}\tIN\t{}\t{}{}", r.name, ttl, r.r#type, priority, r.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Convert DNS records into formatted JSON.
pub fn records_to_json(records: &[DNSRecord]) -> String {
    serde_json::to_string_pretty(records).unwrap_or_else(|_| "[]".to_string())
}
