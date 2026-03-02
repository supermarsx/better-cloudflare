//! Shared Cloudflare data types.

use serde::{Deserialize, Serialize};

/// A Cloudflare zone.
#[derive(Debug, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub name_servers: Vec<String>,
    pub status: String,
    pub paused: bool,
    pub r#type: String,
    pub development_mode: u32,
}

/// A DNS record as returned by the Cloudflare API.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DNSRecord {
    pub id: Option<String>,
    pub r#type: String,
    pub name: String,
    pub content: String,
    pub comment: Option<String>,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
    pub zone_id: String,
    pub zone_name: String,
    pub created_on: String,
    pub modified_on: String,
}

/// Paginated DNS record response.
#[derive(Debug, Serialize, Deserialize)]
pub struct DNSRecordPage {
    pub records: Vec<DNSRecord>,
    pub page: u32,
    pub per_page: u32,
    pub total_count: u32,
    pub total_pages: u32,
    pub cached: bool,
}

/// Input for creating / updating a DNS record.
#[derive(Debug, Serialize, Deserialize)]
pub struct DNSRecordInput {
    pub r#type: String,
    pub name: String,
    pub content: String,
    pub comment: Option<String>,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
}

/// Cache control configuration.
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheControl {
    pub mode: Option<String>,
    pub ttl_seconds: Option<u32>,
}
