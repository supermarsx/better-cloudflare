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

// ── Analytics types ─────────────────────────────────────────────────────────

/// Zone analytics dashboard data (from /zones/{id}/analytics/dashboard).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ZoneAnalytics {
    pub requests: AnalyticsTimeseries,
    pub bandwidth: AnalyticsTimeseries,
    pub threats: AnalyticsTimeseries,
    pub pageviews: AnalyticsTimeseries,
    pub uniques: AnalyticsTimeseries,
}

/// A time-series data set with total and per-interval values.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnalyticsTimeseries {
    pub total: i64,
    #[serde(default)]
    pub timeseries: Vec<AnalyticsDataPoint>,
}

/// A single data point in a time-series.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AnalyticsDataPoint {
    pub since: String,
    pub until: String,
    pub value: i64,
}

/// DNS analytics query result (from /zones/{id}/dns_analytics/report).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DnsAnalytics {
    pub rows: Vec<DnsAnalyticsRow>,
    pub totals: serde_json::Value,
    pub min: serde_json::Value,
    pub max: serde_json::Value,
    pub data_lag: Option<u32>,
}

/// A single row in a DNS analytics report.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DnsAnalyticsRow {
    pub dimensions: Vec<String>,
    pub metrics: Vec<serde_json::Value>,
}

// ── Firewall / WAF types ────────────────────────────────────────────────────

/// Firewall rule (from /zones/{id}/firewall/rules).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FirewallRule {
    pub id: Option<String>,
    pub paused: bool,
    pub description: String,
    pub action: String,
    pub priority: Option<i32>,
    pub filter: FirewallFilter,
}

/// Firewall filter expression.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FirewallFilter {
    pub id: Option<String>,
    pub expression: String,
    pub paused: bool,
    pub description: Option<String>,
}

/// Input for creating / updating a firewall rule.
#[derive(Debug, Serialize, Deserialize)]
pub struct FirewallRuleInput {
    pub paused: bool,
    pub description: String,
    pub action: String,
    pub priority: Option<i32>,
    pub filter: FirewallFilterInput,
}

/// Firewall filter input.
#[derive(Debug, Serialize, Deserialize)]
pub struct FirewallFilterInput {
    pub expression: String,
    pub paused: bool,
    pub description: Option<String>,
}

/// IP access rule (from /zones/{id}/firewall/access_rules/rules).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IpAccessRule {
    pub id: Option<String>,
    pub mode: String,
    pub notes: String,
    pub configuration: IpAccessRuleConfig,
    pub scope: Option<serde_json::Value>,
}

/// IP access rule configuration.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IpAccessRuleConfig {
    pub target: String,
    pub value: String,
}

/// WAF managed ruleset metadata.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WafRuleset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub phase: String,
    pub version: Option<String>,
}

// ── Workers / Pages types ───────────────────────────────────────────────────

/// Worker script metadata (from /accounts/{id}/workers/scripts).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkerScript {
    pub id: String,
    pub etag: Option<String>,
    pub created_on: Option<String>,
    pub modified_on: Option<String>,
    #[serde(default)]
    pub handlers: Vec<String>,
    #[serde(default)]
    pub routes: Vec<String>,
}

/// Worker route binding (from /zones/{id}/workers/routes).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkerRoute {
    pub id: Option<String>,
    pub pattern: String,
    pub script: Option<String>,
}

// ── Email Routing types ─────────────────────────────────────────────────────

/// Email routing rule (from /zones/{id}/email/routing/rules).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailRoutingRule {
    pub id: Option<String>,
    pub tag: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub matchers: Vec<EmailRoutingMatcher>,
    pub actions: Vec<EmailRoutingAction>,
}

/// Email routing matcher (part of a rule).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailRoutingMatcher {
    pub r#type: String,
    pub field: Option<String>,
    pub value: Option<String>,
}

/// Email routing action (part of a rule).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailRoutingAction {
    pub r#type: String,
    pub value: Option<Vec<String>>,
}

/// Email routing settings (from /zones/{id}/email/routing).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmailRoutingSettings {
    pub enabled: bool,
    pub name: Option<String>,
    pub tag: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub skip_wizard: Option<bool>,
    pub status: Option<String>,
}

// ── Page Rules ──────────────────────────────────────────────────────────────

/// Page rule (from /zones/{id}/pagerules).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageRule {
    pub id: Option<String>,
    pub targets: Vec<PageRuleTarget>,
    pub actions: Vec<PageRuleAction>,
    pub priority: Option<i32>,
    pub status: String,
}

/// Page rule target pattern.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageRuleTarget {
    pub target: String,
    pub constraint: PageRuleConstraint,
}

/// Page rule target constraint.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageRuleConstraint {
    pub operator: String,
    pub value: String,
}

/// Page rule action.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageRuleAction {
    pub id: String,
    pub value: Option<serde_json::Value>,
}

// ── Rate-limit types ────────────────────────────────────────────────────────

/// Cloudflare rate-limit response headers.
#[derive(Debug, Clone, Default)]
pub struct RateLimitInfo {
    pub retry_after: Option<u64>,
    pub remaining: Option<u32>,
    pub reset: Option<u64>,
}
