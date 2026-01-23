use serde_json::Value;

pub fn log_audit(entry: Value) {
    // In a full implementation, this would write to a persistent audit log
    // For now, we'll just print to console in debug mode
    #[cfg(debug_assertions)]
    println!("[AUDIT] {}", serde_json::to_string(&entry).unwrap_or_default());
}
