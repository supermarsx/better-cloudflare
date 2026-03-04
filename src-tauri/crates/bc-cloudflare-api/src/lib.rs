//! # bc-cloudflare-api
//!
//! Typed Cloudflare REST API client: zones, DNS record CRUD, bulk create,
//! export (JSON / CSV / BIND), cache purge, zone settings, and DNSSEC.

mod types;

pub use types::*;

use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use thiserror::Error;

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRIES: u32 = 3;
const INITIAL_BACKOFF_MS: u64 = 1000;
const MAX_BACKOFF_MS: u64 = 30_000;

// ── Error ───────────────────────────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum CloudflareError {
    #[error("HTTP error: {0}")]
    HttpError(String),
    #[error("API error: {0}")]
    ApiError(String),
    #[error("Authentication failed")]
    AuthFailed,
    #[error("Rate limited after {0} retries")]
    RateLimited(u32),
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct CloudflareClient {
    client: Client,
    api_key: String,
    email: Option<String>,
    max_retries: u32,
}

impl CloudflareClient {
    pub fn new(api_key: &str, email: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
            max_retries: MAX_RETRIES,
        }
    }

    /// Set the maximum number of retries for rate-limited or server-error responses.
    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(email) = &self.email {
            req.header("X-Auth-Email", email)
                .header("X-Auth-Key", &self.api_key)
        } else {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        }
    }

    // ── Retry with exponential backoff ──────────────────────────────────

    /// Execute a request-building closure with retry on 429 and 5xx responses.
    /// Uses exponential backoff with jitter, respecting Retry-After headers.
    async fn request_with_retry<F>(&self, build_request: F) -> Result<reqwest::Response, CloudflareError>
    where
        F: Fn(&Self) -> reqwest::RequestBuilder,
    {
        let mut attempt = 0u32;
        loop {
            let req = build_request(self);
            let response = req
                .send()
                .await
                .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

            let status = response.status();

            // Success or client error (not 429) → return immediately
            if status.is_success() || (status.is_client_error() && status.as_u16() != 429) {
                return Ok(response);
            }

            // Retryable: 429 (rate limit) or 5xx (server error)
            attempt += 1;
            if attempt > self.max_retries {
                if status.as_u16() == 429 {
                    return Err(CloudflareError::RateLimited(self.max_retries));
                }
                return Err(CloudflareError::HttpError(format!(
                    "Server error {} after {} retries",
                    status.as_u16(),
                    self.max_retries
                )));
            }

            // Calculate backoff: prefer Retry-After header, else exponential
            let backoff_ms = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .map(|secs| secs * 1000)
                .unwrap_or_else(|| {
                    let base = INITIAL_BACKOFF_MS * 2u64.pow(attempt - 1);
                    base.min(MAX_BACKOFF_MS)
                });

            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        }
    }

    // ── Token verification ──────────────────────────────────────────────

    pub async fn verify_token(&self) -> Result<bool, CloudflareError> {
        let use_email = self.email.is_some();
        let response = self
            .request_with_retry(|s| {
                let url = if use_email {
                    "https://api.cloudflare.com/client/v4/user"
                } else {
                    "https://api.cloudflare.com/client/v4/user/tokens/verify"
                };
                s.apply_auth(s.client.get(url))
            })
            .await?;

        Ok(response.status().is_success())
    }

    // ── Zones ───────────────────────────────────────────────────────────

    pub async fn get_zones(&self) -> Result<Vec<Zone>, CloudflareError> {
        let response = self
            .request_with_retry(|s| {
                s.apply_auth(s.client.get("https://api.cloudflare.com/client/v4/zones"))
            })
            .await?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let zones = json["result"]
            .as_array()
            .ok_or(CloudflareError::ApiError(
                "Invalid response format".to_string(),
            ))?
            .iter()
            .filter_map(|z| {
                let name_servers = z["name_servers"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                Some(Zone {
                    id: z["id"].as_str()?.to_string(),
                    name: z["name"].as_str()?.to_string(),
                    name_servers,
                    status: z["status"].as_str().unwrap_or("unknown").to_string(),
                    paused: z["paused"].as_bool().unwrap_or(false),
                    r#type: z["type"].as_str().unwrap_or("").to_string(),
                    development_mode: z["development_mode"].as_u64().unwrap_or(0) as u32,
                })
            })
            .collect();

        Ok(zones)
    }

    // ── DNS Records ─────────────────────────────────────────────────────

    pub async fn get_dns_records(
        &self,
        zone_id: &str,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<Vec<DNSRecord>, CloudflareError> {
        let mut url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records",
            zone_id
        );
        let mut params = Vec::new();
        if let Some(page) = page {
            params.push(format!("page={}", page));
        }
        if let Some(per_page) = per_page {
            params.push(format!("per_page={}", per_page));
        }
        if !params.is_empty() {
            url.push('?');
            url.push_str(&params.join("&"));
        }

        let url_owned = url.clone();
        let response = self
            .request_with_retry(move |s| {
                s.apply_auth(s.client.get(&url_owned))
            })
            .await?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let records = json["result"]
            .as_array()
            .ok_or(CloudflareError::ApiError(
                "Invalid response format".to_string(),
            ))?
            .iter()
            .filter_map(parse_dns_record)
            .collect();

        Ok(records)
    }

    pub async fn create_dns_record(
        &self,
        zone_id: &str,
        record: DNSRecordInput,
    ) -> Result<DNSRecord, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records",
            zone_id
        );

        let response = self
            .request_with_retry(|s| {
                s.apply_auth(s.client.post(&url).json(&record))
            })
            .await?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        parse_dns_record(&json["result"])
            .ok_or_else(|| CloudflareError::ApiError("Invalid response format".to_string()))
    }

    pub async fn update_dns_record(
        &self,
        zone_id: &str,
        record_id: &str,
        record: DNSRecordInput,
    ) -> Result<DNSRecord, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}",
            zone_id, record_id
        );

        let response = self
            .request_with_retry(|s| {
                s.apply_auth(s.client.put(&url).json(&record))
            })
            .await?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        parse_dns_record(&json["result"])
            .ok_or_else(|| CloudflareError::ApiError("Invalid response format".to_string()))
    }

    pub async fn delete_dns_record(
        &self,
        zone_id: &str,
        record_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}",
            zone_id, record_id
        );

        self.request_with_retry(|s| {
            s.apply_auth(s.client.delete(&url))
        })
        .await?;
        Ok(())
    }

    pub async fn create_bulk_dns_records(
        &self,
        zone_id: &str,
        records: Vec<DNSRecordInput>,
        dryrun: bool,
    ) -> Result<Value, CloudflareError> {
        if dryrun {
            let created = records
                .into_iter()
                .map(|r| {
                    json!({
                        "type": r.r#type,
                        "name": r.name,
                        "content": r.content,
                        "comment": r.comment,
                        "ttl": r.ttl,
                        "priority": r.priority,
                        "proxied": r.proxied
                    })
                })
                .collect::<Vec<_>>();
            return Ok(json!({ "created": created, "skipped": [] }));
        }

        let mut created = Vec::new();
        let mut skipped = Vec::new();

        for (idx, record) in records.into_iter().enumerate() {
            match self.create_dns_record(zone_id, record).await {
                Ok(rec) => created.push(rec),
                Err(e) => skipped.push(json!({
                    "index": idx,
                    "error": e.to_string()
                })),
            }
        }

        Ok(json!({ "created": created, "skipped": skipped }))
    }

    pub async fn export_dns_records(
        &self,
        zone_id: &str,
        format: &str,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<String, CloudflareError> {
        let records = self.get_dns_records(zone_id, page, per_page).await?;

        match format {
            "json" => serde_json::to_string_pretty(&records)
                .map_err(|e| CloudflareError::ApiError(e.to_string())),
            "csv" => {
                let mut csv = "Type,Name,Content,TTL,Priority,Proxied\n".to_string();
                for record in records {
                    csv.push_str(&format!(
                        "{},{},{},{},{},{}\n",
                        record.r#type,
                        record.name,
                        record.content,
                        record.ttl.unwrap_or(1),
                        record.priority.unwrap_or(0),
                        record.proxied.unwrap_or(false)
                    ));
                }
                Ok(csv)
            }
            "bind" => {
                let mut bind = String::new();
                for record in records {
                    let ttl = record.ttl.unwrap_or(1);
                    let ttl = if ttl == 1 { 300 } else { ttl };
                    let priority = record
                        .priority
                        .map(|p| format!("{} ", p))
                        .unwrap_or_default();
                    bind.push_str(&format!(
                        "{}\t{}\tIN\t{}\t{}{}\n",
                        record.name, ttl, record.r#type, priority, record.content
                    ));
                }
                Ok(bind)
            }
            _ => Err(CloudflareError::ApiError("Unsupported format".to_string())),
        }
    }

    // ── Cache ───────────────────────────────────────────────────────────

    pub async fn purge_cache(
        &self,
        zone_id: &str,
        purge_everything: bool,
        files: Option<Vec<String>>,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/purge_cache",
            zone_id
        );
        let body = if purge_everything {
            json!({ "purge_everything": true })
        } else {
            json!({ "files": files.unwrap_or_default() })
        };

        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to purge cache");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Zone settings ───────────────────────────────────────────────────

    pub async fn get_zone_setting(
        &self,
        zone_id: &str,
        setting_id: &str,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/settings/{}",
            zone_id, setting_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to get zone setting");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    pub async fn update_zone_setting(
        &self,
        zone_id: &str,
        setting_id: &str,
        value: Value,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/settings/{}",
            zone_id, setting_id
        );
        let body = json!({ "value": value });
        let req = self.apply_auth(self.client.patch(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to update zone setting");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── DNSSEC ──────────────────────────────────────────────────────────

    pub async fn get_dnssec(&self, zone_id: &str) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dnssec",
            zone_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to get DNSSEC");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    pub async fn update_dnssec(
        &self,
        zone_id: &str,
        payload: Value,
    ) -> Result<Value, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dnssec",
            zone_id
        );
        let req = self.apply_auth(self.client.patch(&url).json(&payload));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;

        if json["success"].as_bool() != Some(true) {
            let err = json["errors"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Failed to update DNSSEC");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Analytics ───────────────────────────────────────────────────────

    /// Zone analytics dashboard (requests, bandwidth, threats, etc.).
    pub async fn get_zone_analytics(
        &self,
        zone_id: &str,
        since: &str,
        until: &str,
        continuous: Option<bool>,
    ) -> Result<Value, CloudflareError> {
        let mut url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/analytics/dashboard?since={}&until={}",
            zone_id, since, until
        );
        if let Some(true) = continuous {
            url.push_str("&continuous=true");
        }
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        if json["success"].as_bool() != Some(true) {
            let err = json["errors"].as_array().and_then(|a| a.first()).and_then(|e| e["message"].as_str()).unwrap_or("Analytics error");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    /// DNS analytics report.
    pub async fn get_dns_analytics(
        &self,
        zone_id: &str,
        since: &str,
        until: &str,
        dimensions: Option<Vec<String>>,
        metrics: Option<Vec<String>>,
    ) -> Result<Value, CloudflareError> {
        let mut url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_analytics/report?since={}&until={}",
            zone_id, since, until
        );
        if let Some(dims) = dimensions {
            url.push_str(&format!("&dimensions={}", dims.join(",")));
        }
        if let Some(mets) = metrics {
            url.push_str(&format!("&metrics={}", mets.join(",")));
        }
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        if json["success"].as_bool() != Some(true) {
            let err = json["errors"].as_array().and_then(|a| a.first()).and_then(|e| e["message"].as_str()).unwrap_or("DNS analytics error");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Firewall / WAF ─────────────────────────────────────────────────

    pub async fn get_firewall_rules(&self, zone_id: &str) -> Result<Vec<FirewallRule>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/rules", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rules: Vec<FirewallRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_firewall_rule(&self, zone_id: &str, rule: FirewallRuleInput) -> Result<FirewallRule, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/rules", zone_id);
        let body = json!([{
            "paused": rule.paused, "description": rule.description, "action": rule.action,
            "priority": rule.priority,
            "filter": { "expression": rule.filter.expression, "paused": rule.filter.paused, "description": rule.filter.description }
        }]);
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rules: Vec<FirewallRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        rules.into_iter().next().ok_or_else(|| CloudflareError::ApiError("No rule returned".to_string()))
    }

    pub async fn update_firewall_rule(&self, zone_id: &str, rule_id: &str, rule: FirewallRuleInput) -> Result<FirewallRule, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/rules/{}", zone_id, rule_id);
        let body = json!({
            "paused": rule.paused, "description": rule.description, "action": rule.action,
            "priority": rule.priority,
            "filter": { "expression": rule.filter.expression, "paused": rule.filter.paused, "description": rule.filter.description }
        });
        let req = self.apply_auth(self.client.put(&url).json(&body));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rule: FirewallRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rule)
    }

    pub async fn delete_firewall_rule(&self, zone_id: &str, rule_id: &str) -> Result<(), CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/rules/{}", zone_id, rule_id);
        let req = self.apply_auth(self.client.delete(&url));
        req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    pub async fn get_ip_access_rules(&self, zone_id: &str) -> Result<Vec<IpAccessRule>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rules: Vec<IpAccessRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_ip_access_rule(&self, zone_id: &str, mode: &str, value: &str, notes: &str) -> Result<IpAccessRule, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules", zone_id);
        let body = json!({ "mode": mode, "configuration": { "target": "ip", "value": value }, "notes": notes });
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rule: IpAccessRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rule)
    }

    pub async fn delete_ip_access_rule(&self, zone_id: &str, rule_id: &str) -> Result<(), CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules/{}", zone_id, rule_id);
        let req = self.apply_auth(self.client.delete(&url));
        req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    pub async fn get_waf_rulesets(&self, zone_id: &str) -> Result<Vec<WafRuleset>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/rulesets", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rulesets: Vec<WafRuleset> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rulesets)
    }

    // ── Workers ─────────────────────────────────────────────────────────

    pub async fn get_worker_routes(&self, zone_id: &str) -> Result<Vec<WorkerRoute>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/workers/routes", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let routes: Vec<WorkerRoute> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(routes)
    }

    pub async fn create_worker_route(&self, zone_id: &str, pattern: &str, script: &str) -> Result<WorkerRoute, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/workers/routes", zone_id);
        let body = json!({ "pattern": pattern, "script": script });
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let route: WorkerRoute = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(route)
    }

    pub async fn delete_worker_route(&self, zone_id: &str, route_id: &str) -> Result<(), CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/workers/routes/{}", zone_id, route_id);
        let req = self.apply_auth(self.client.delete(&url));
        req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    // ── Email Routing ───────────────────────────────────────────────────

    pub async fn get_email_routing_settings(&self, zone_id: &str) -> Result<EmailRoutingSettings, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/email/routing", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let settings: EmailRoutingSettings = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(settings)
    }

    pub async fn get_email_routing_rules(&self, zone_id: &str) -> Result<Vec<EmailRoutingRule>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rules: Vec<EmailRoutingRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_email_routing_rule(&self, zone_id: &str, rule: &EmailRoutingRule) -> Result<EmailRoutingRule, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules", zone_id);
        let body = serde_json::to_value(rule).map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let created: EmailRoutingRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(created)
    }

    pub async fn delete_email_routing_rule(&self, zone_id: &str, rule_id: &str) -> Result<(), CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules/{}", zone_id, rule_id);
        let req = self.apply_auth(self.client.delete(&url));
        req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    // ── Page Rules ──────────────────────────────────────────────────────

    pub async fn get_page_rules(&self, zone_id: &str) -> Result<Vec<PageRule>, CloudflareError> {
        let url = format!("https://api.cloudflare.com/client/v4/zones/{}/pagerules", zone_id);
        let req = self.apply_auth(self.client.get(&url));
        let response = req.send().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response.json().await.map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rules: Vec<PageRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    // ── Bulk deletion ───────────────────────────────────────────────────

    pub async fn delete_bulk_dns_records(&self, zone_id: &str, record_ids: &[String]) -> Result<Value, CloudflareError> {
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        for id in record_ids {
            match self.delete_dns_record(zone_id, id).await {
                Ok(()) => deleted.push(id.clone()),
                Err(e) => failed.push(json!({ "id": id, "error": e.to_string() })),
            }
        }
        Ok(json!({ "deleted": deleted, "failed": failed }))
    }
}

// ── Parsing helper ──────────────────────────────────────────────────────────

fn parse_dns_record(value: &Value) -> Option<DNSRecord> {
    Some(DNSRecord {
        id: value["id"].as_str().map(|s| s.to_string()),
        r#type: value["type"].as_str()?.to_string(),
        name: value["name"].as_str()?.to_string(),
        content: value["content"].as_str()?.to_string(),
        comment: value["comment"].as_str().map(|s| s.to_string()),
        ttl: value["ttl"].as_u64().map(|n| n as u32),
        priority: value["priority"].as_u64().map(|n| n as u16),
        proxied: value["proxied"].as_bool(),
        zone_id: value["zone_id"].as_str().unwrap_or("").to_string(),
        zone_name: value["zone_name"].as_str().unwrap_or("").to_string(),
        created_on: value["created_on"].as_str().unwrap_or("").to_string(),
        modified_on: value["modified_on"].as_str().unwrap_or("").to_string(),
    })
}
