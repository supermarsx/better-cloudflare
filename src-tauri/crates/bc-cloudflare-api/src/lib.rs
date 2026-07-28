//! # bc-cloudflare-api
//!
//! Typed Cloudflare REST API client: zones, DNS record CRUD, bulk create,
//! export (JSON / CSV / BIND), cache purge, zone settings, and DNSSEC.

mod types;

pub use types::*;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use thiserror::Error;

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_RETRIES: u32 = 3;
const INITIAL_BACKOFF_MS: u64 = 1000;
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CLOUDFLARE_API_BASE: &str = "https://api.cloudflare.com/client/v4";
const AUTH_OPERATION: &str = "auth:verify_token";
const MAX_PROVIDER_ERRORS: usize = 5;
const MAX_PROVIDER_MESSAGE_LENGTH: usize = 240;

// ── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationFailureKind {
    Authentication,
    RateLimited,
    Provider,
    Network,
    Timeout,
    MalformedResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationErrorSource {
    Network,
    Cloudflare,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudflareProviderError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

/// Secret-safe structured failure from Cloudflare token verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudflareRequestError {
    pub kind: VerificationFailureKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub source: VerificationErrorSource,
    pub operation: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_errors: Vec<CloudflareProviderError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
    pub remediation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl std::fmt::Display for CloudflareRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

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
    #[error("{0}")]
    Verification(Box<CloudflareRequestError>),
}

// ── Client ──────────────────────────────────────────────────────────────────

pub struct CloudflareClient {
    client: Client,
    api_key: String,
    email: Option<String>,
    max_retries: u32,
    api_base: String,
    request_timeout: Duration,
}

impl CloudflareClient {
    pub fn new(api_key: &str, email: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
            max_retries: MAX_RETRIES,
            api_base: CLOUDFLARE_API_BASE.to_string(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    /// Create a client sharing an existing `reqwest::Client` for connection pooling.
    pub fn with_client(client: Client, api_key: &str, email: Option<&str>) -> Self {
        Self {
            client,
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
            max_retries: MAX_RETRIES,
            api_base: CLOUDFLARE_API_BASE.to_string(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    /// Set the maximum number of retries for rate-limited or server-error responses.
    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    #[cfg(test)]
    fn with_api_base(mut self, api_base: impl Into<String>) -> Self {
        self.api_base = api_base.into().trim_end_matches('/').to_string();
        self
    }

    #[cfg(test)]
    fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let req = req.timeout(self.request_timeout);
        if let Some(email) = &self.email {
            req.header("X-Auth-Email", email)
                .header("X-Auth-Key", &self.api_key)
        } else {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        }
    }

    // ── Retry with exponential backoff ──────────────────────────────────

    /// Execute a request-building closure with retry on 429 and 5xx responses.
    /// Uses capped exponential backoff, respecting bounded Retry-After headers.
    async fn request_with_retry<F>(
        &self,
        build_request: F,
    ) -> Result<reqwest::Response, CloudflareError>
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
            let retry_after_secs = parse_retry_after_secs(response.headers());
            tokio::time::sleep(retry_delay(attempt, retry_after_secs)).await;
        }
    }

    // ── Token verification ──────────────────────────────────────────────

    pub async fn verify_token(&self) -> Result<bool, CloudflareError> {
        let use_email = self.email.is_some();
        let endpoint = if use_email {
            "/user"
        } else {
            "/user/tokens/verify"
        };
        let url = format!("{}{}", self.api_base, endpoint);
        let mut attempt = 0u32;

        loop {
            let response = self
                .apply_auth(self.client.get(&url))
                .send()
                .await
                .map_err(|error| {
                    CloudflareError::Verification(Box::new(self.transport_error(&error)))
                })?;
            let status = response.status().as_u16();
            let retry_after_secs = parse_retry_after_secs(response.headers());
            let request_id = response
                .headers()
                .get("cf-ray")
                .and_then(|value| value.to_str().ok())
                .and_then(sanitize_request_id);
            let retryable_status = status == 408 || status == 429 || status >= 500;

            if retryable_status && attempt < self.max_retries {
                attempt += 1;
                tokio::time::sleep(retry_delay(attempt, retry_after_secs)).await;
                continue;
            }

            let body = response.text().await.map_err(|error| {
                CloudflareError::Verification(Box::new(self.transport_error(&error)))
            })?;
            return self.parse_verification_response(status, &body, retry_after_secs, request_id);
        }
    }

    fn parse_verification_response(
        &self,
        status: u16,
        body: &str,
        retry_after_secs: Option<u64>,
        request_id: Option<String>,
    ) -> Result<bool, CloudflareError> {
        let payload = serde_json::from_str::<Value>(body);
        if status < 400 {
            let payload = payload.map_err(|_| {
                CloudflareError::Verification(Box::new(CloudflareRequestError {
                    kind: VerificationFailureKind::MalformedResponse,
                    message: "Cloudflare returned an unreadable token verification response."
                        .to_string(),
                    status: Some(status),
                    source: VerificationErrorSource::Cloudflare,
                    operation: AUTH_OPERATION.to_string(),
                    retryable: true,
                    provider_errors: Vec::new(),
                    retry_after_secs,
                    remediation:
                        "Retry the request. If it continues, check Cloudflare service status."
                            .to_string(),
                    request_id: request_id.clone(),
                }))
            })?;
            match payload.get("success").and_then(Value::as_bool) {
                Some(true) => return Ok(true),
                Some(false) => {
                    return Err(CloudflareError::Verification(Box::new(
                        self.response_error(
                            VerificationFailureKind::Authentication,
                            status,
                            &payload,
                            retry_after_secs,
                            request_id,
                        ),
                    )));
                }
                None => {
                    return Err(CloudflareError::Verification(Box::new(
                        CloudflareRequestError {
                        kind: VerificationFailureKind::MalformedResponse,
                        message:
                            "Cloudflare token verification omitted the required success result."
                                .to_string(),
                        status: Some(status),
                        source: VerificationErrorSource::Cloudflare,
                        operation: AUTH_OPERATION.to_string(),
                        retryable: true,
                        provider_errors: Vec::new(),
                        retry_after_secs,
                        remediation:
                            "Retry the request. If it continues, check Cloudflare service status."
                                .to_string(),
                            request_id,
                        },
                    )));
                }
            }
        }

        let kind = match status {
            401 | 403 => VerificationFailureKind::Authentication,
            408 => VerificationFailureKind::Timeout,
            429 => VerificationFailureKind::RateLimited,
            500..=599 => VerificationFailureKind::Provider,
            _ => VerificationFailureKind::MalformedResponse,
        };
        let payload = payload.unwrap_or(Value::Null);
        Err(CloudflareError::Verification(Box::new(
            self.response_error(kind, status, &payload, retry_after_secs, request_id),
        )))
    }

    fn response_error(
        &self,
        kind: VerificationFailureKind,
        status: u16,
        payload: &Value,
        retry_after_secs: Option<u64>,
        request_id: Option<String>,
    ) -> CloudflareRequestError {
        let provider_errors = self.provider_errors(payload);
        let (message, retryable, remediation) = match (kind, status) {
            (VerificationFailureKind::Authentication, _) => (
                format!("Cloudflare rejected the supplied credentials (HTTP {status})."),
                false,
                "Check the API token or global API key, the account email when required, and the credential permissions.",
            ),
            (VerificationFailureKind::RateLimited, _) => (
                "Cloudflare rate-limited token verification.".to_string(),
                true,
                "Wait for the retry interval before trying again.",
            ),
            (VerificationFailureKind::Provider, _) => (
                format!("Cloudflare could not verify the credentials (HTTP {status})."),
                true,
                "Retry shortly and check Cloudflare service status if the failure continues.",
            ),
            (VerificationFailureKind::Timeout, 408) => (
                "Cloudflare timed out while processing token verification (HTTP 408).".to_string(),
                true,
                "Retry the request. If it continues, check the connection and Cloudflare service status.",
            ),
            (VerificationFailureKind::MalformedResponse, 400) => (
                "Cloudflare rejected token verification as an invalid request (HTTP 400)."
                    .to_string(),
                false,
                "Check that the selected credential type and account email match the supplied credential.",
            ),
            (VerificationFailureKind::MalformedResponse, 404 | 405) => (
                format!(
                    "Cloudflare did not accept the token verification endpoint or method (HTTP {status})."
                ),
                false,
                "Check for a Cloudflare API compatibility change and update the application before retrying.",
            ),
            (VerificationFailureKind::MalformedResponse, _) => (
                format!("Cloudflare rejected token verification (HTTP {status})."),
                false,
                "Check the request details and Cloudflare API compatibility before retrying.",
            ),
            _ => unreachable!("response errors are classified before construction"),
        };

        CloudflareRequestError {
            kind,
            message,
            status: Some(status),
            source: VerificationErrorSource::Cloudflare,
            operation: AUTH_OPERATION.to_string(),
            retryable,
            provider_errors,
            retry_after_secs,
            remediation: remediation.to_string(),
            request_id,
        }
    }

    fn provider_errors(&self, payload: &Value) -> Vec<CloudflareProviderError> {
        ["errors", "messages"]
            .into_iter()
            .filter_map(|field| payload.get(field).and_then(Value::as_array))
            .flatten()
            .filter_map(|item| {
                let code = item.get("code").and_then(|value| match value {
                    Value::Number(number) => Some(number.to_string()),
                    Value::String(string) => sanitize_provider_code(string),
                    _ => None,
                });
                let message = item
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|message| self.sanitize_provider_message(message));
                if code.is_none() && message.is_none() {
                    return None;
                }
                Some(CloudflareProviderError {
                    code,
                    message: message.unwrap_or_else(|| "Cloudflare reported an error.".to_string()),
                })
            })
            .take(MAX_PROVIDER_ERRORS)
            .collect()
    }

    fn sanitize_provider_message(&self, message: &str) -> String {
        let mut sanitized = sanitize_error_text(message);
        for secret in std::iter::once(self.api_key.as_str()).chain(self.email.as_deref()) {
            if secret.is_empty() {
                continue;
            }
            sanitized = sanitized.replace(secret, "[redacted]");
        }
        sanitized
            .chars()
            .take(MAX_PROVIDER_MESSAGE_LENGTH)
            .collect()
    }

    fn transport_error(&self, error: &reqwest::Error) -> CloudflareRequestError {
        let (kind, message, remediation) = if error.is_timeout() {
            (
                VerificationFailureKind::Timeout,
                "Cloudflare token verification timed out.",
                "Check the connection, proxy, DNS, and TLS settings, then retry.",
            )
        } else {
            (
                VerificationFailureKind::Network,
                "Could not reach Cloudflare to verify the credentials.",
                "Check the internet connection, proxy, DNS, and TLS settings, then retry.",
            )
        };
        CloudflareRequestError {
            kind,
            message: message.to_string(),
            status: error.status().map(|status| status.as_u16()),
            source: VerificationErrorSource::Network,
            operation: AUTH_OPERATION.to_string(),
            retryable: true,
            provider_errors: Vec::new(),
            retry_after_secs: None,
            remediation: remediation.to_string(),
            request_id: None,
        }
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
            .request_with_retry(move |s| s.apply_auth(s.client.get(&url_owned)))
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
            .request_with_retry(|s| s.apply_auth(s.client.post(&url).json(&record)))
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
            .request_with_retry(|s| s.apply_auth(s.client.put(&url).json(&record)))
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

        self.request_with_retry(|s| s.apply_auth(s.client.delete(&url)))
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
                .and_then(|a| a.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Analytics error");
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
                .and_then(|a| a.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("DNS analytics error");
            return Err(CloudflareError::ApiError(err.to_string()));
        }
        Ok(json["result"].clone())
    }

    // ── Firewall / WAF ─────────────────────────────────────────────────

    pub async fn get_firewall_rules(
        &self,
        zone_id: &str,
    ) -> Result<Vec<FirewallRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules",
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
        let rules: Vec<FirewallRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_firewall_rule(
        &self,
        zone_id: &str,
        rule: FirewallRuleInput,
    ) -> Result<FirewallRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules",
            zone_id
        );
        let body = json!([{
            "paused": rule.paused, "description": rule.description, "action": rule.action,
            "priority": rule.priority,
            "filter": { "expression": rule.filter.expression, "paused": rule.filter.paused, "description": rule.filter.description }
        }]);
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rules: Vec<FirewallRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        rules
            .into_iter()
            .next()
            .ok_or_else(|| CloudflareError::ApiError("No rule returned".to_string()))
    }

    pub async fn update_firewall_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
        rule: FirewallRuleInput,
    ) -> Result<FirewallRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules/{}",
            zone_id, rule_id
        );
        let body = json!({
            "paused": rule.paused, "description": rule.description, "action": rule.action,
            "priority": rule.priority,
            "filter": { "expression": rule.filter.expression, "paused": rule.filter.paused, "description": rule.filter.description }
        });
        let req = self.apply_auth(self.client.put(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rule: FirewallRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rule)
    }

    pub async fn delete_firewall_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/rules/{}",
            zone_id, rule_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    pub async fn get_ip_access_rules(
        &self,
        zone_id: &str,
    ) -> Result<Vec<IpAccessRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules",
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
        let rules: Vec<IpAccessRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_ip_access_rule(
        &self,
        zone_id: &str,
        mode: &str,
        value: &str,
        notes: &str,
    ) -> Result<IpAccessRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules",
            zone_id
        );
        let body = json!({ "mode": mode, "configuration": { "target": "ip", "value": value }, "notes": notes });
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let rule: IpAccessRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rule)
    }

    pub async fn delete_ip_access_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/firewall/access_rules/rules/{}",
            zone_id, rule_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    pub async fn get_waf_rulesets(
        &self,
        zone_id: &str,
    ) -> Result<Vec<WafRuleset>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/rulesets",
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
        let rulesets: Vec<WafRuleset> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rulesets)
    }

    // ── Workers ─────────────────────────────────────────────────────────

    pub async fn get_worker_routes(
        &self,
        zone_id: &str,
    ) -> Result<Vec<WorkerRoute>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/workers/routes",
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
        let routes: Vec<WorkerRoute> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(routes)
    }

    pub async fn create_worker_route(
        &self,
        zone_id: &str,
        pattern: &str,
        script: &str,
    ) -> Result<WorkerRoute, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/workers/routes",
            zone_id
        );
        let body = json!({ "pattern": pattern, "script": script });
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let route: WorkerRoute = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(route)
    }

    pub async fn delete_worker_route(
        &self,
        zone_id: &str,
        route_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/workers/routes/{}",
            zone_id, route_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    // ── Email Routing ───────────────────────────────────────────────────

    pub async fn get_email_routing_settings(
        &self,
        zone_id: &str,
    ) -> Result<EmailRoutingSettings, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing",
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
        let settings: EmailRoutingSettings = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(settings)
    }

    pub async fn get_email_routing_rules(
        &self,
        zone_id: &str,
    ) -> Result<Vec<EmailRoutingRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules",
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
        let rules: Vec<EmailRoutingRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    pub async fn create_email_routing_rule(
        &self,
        zone_id: &str,
        rule: &EmailRoutingRule,
    ) -> Result<EmailRoutingRule, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules",
            zone_id
        );
        let body =
            serde_json::to_value(rule).map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let req = self.apply_auth(self.client.post(&url).json(&body));
        let response = req
            .send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let json: Value = response
            .json()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        let created: EmailRoutingRule = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(created)
    }

    pub async fn delete_email_routing_rule(
        &self,
        zone_id: &str,
        rule_id: &str,
    ) -> Result<(), CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/email/routing/rules/{}",
            zone_id, rule_id
        );
        let req = self.apply_auth(self.client.delete(&url));
        req.send()
            .await
            .map_err(|e| CloudflareError::HttpError(e.to_string()))?;
        Ok(())
    }

    // ── Page Rules ──────────────────────────────────────────────────────

    pub async fn get_page_rules(&self, zone_id: &str) -> Result<Vec<PageRule>, CloudflareError> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/pagerules",
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
        let rules: Vec<PageRule> = serde_json::from_value(json["result"].clone())
            .map_err(|e| CloudflareError::ApiError(e.to_string()))?;
        Ok(rules)
    }

    // ── Bulk deletion ───────────────────────────────────────────────────

    pub async fn delete_bulk_dns_records(
        &self,
        zone_id: &str,
        record_ids: &[String],
    ) -> Result<Value, CloudflareError> {
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

fn parse_retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_DELAY.as_secs()))
}

fn retry_delay(attempt: u32, retry_after_secs: Option<u64>) -> Duration {
    let maximum_ms = MAX_RETRY_DELAY.as_millis() as u64;
    let delay_ms = retry_after_secs
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or_else(|| {
            2u64.checked_pow(attempt.saturating_sub(1))
                .and_then(|multiplier| INITIAL_BACKOFF_MS.checked_mul(multiplier))
                .unwrap_or(u64::MAX)
        })
        .min(maximum_ms);
    Duration::from_millis(delay_ms)
}

fn sanitize_provider_code(code: &str) -> Option<String> {
    let code = code.trim();
    if code.is_empty()
        || code.len() > 32
        || !code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return None;
    }
    Some(code.to_string())
}

fn sanitize_request_id(request_id: &str) -> Option<String> {
    let request_id = request_id.trim();
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return None;
    }
    Some(request_id.to_string())
}

fn sanitize_error_text(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut words = collapsed.split(' ').peekable();
    let mut sanitized = Vec::new();
    let sensitive_names = [
        "authorization",
        "api_key",
        "api-key",
        "apikey",
        "api_token",
        "api-token",
        "token",
        "secret",
        "password",
        "cookie",
        "set-cookie",
        "x-auth-key",
    ];

    while let Some(word) = words.next() {
        let lowercase = word.to_ascii_lowercase();
        if lowercase == "bearer" {
            sanitized.push("Bearer".to_string());
            if words.peek().is_some() {
                let _ = words.next();
                sanitized.push("[redacted]".to_string());
            }
            continue;
        }
        let sensitive_assignment = sensitive_names.iter().any(|name| {
            lowercase == *name
                || lowercase.starts_with(&format!("{name}="))
                || lowercase.starts_with(&format!("{name}:"))
        });
        if sensitive_assignment {
            if let Some((name, _)) = word.split_once('=') {
                sanitized.push(format!("{name}=[redacted]"));
            } else if let Some((name, _)) = word.split_once(':') {
                sanitized.push(format!("{name}=[redacted]"));
            } else {
                sanitized.push(word.to_string());
                if words.peek().is_some() {
                    let _ = words.next();
                    sanitized.push("[redacted]".to_string());
                }
            }
            continue;
        }
        sanitized.push(word.to_string());
    }
    sanitized.join(" ")
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

#[cfg(test)]
mod auth_verification_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn spawn_response(
        status: u16,
        extra_headers: &[(&str, &str)],
        body: &str,
        delay: Duration,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            _ => "Test Response",
        };
        let body = body.as_bytes().to_vec();
        let headers = extra_headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect::<String>();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            if !delay.is_zero() {
                thread::sleep(delay);
            }
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
                body.len(),
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
        });
        format!("http://{address}")
    }

    fn test_client(base: String, api_key: &str) -> CloudflareClient {
        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("test reqwest client");
        CloudflareClient::with_client(client, api_key, None)
            .with_max_retries(0)
            .with_api_base(base)
    }

    fn request_context(error: &CloudflareError) -> &CloudflareRequestError {
        match error {
            CloudflareError::Verification(context) => context,
            other => panic!("expected structured verification error, got {other:?}"),
        }
    }

    #[test]
    fn production_clients_have_an_explicit_request_timeout() {
        assert!(!REQUEST_TIMEOUT.is_zero());
        assert_eq!(
            CloudflareClient::new("token", None).request_timeout,
            REQUEST_TIMEOUT
        );
        assert_eq!(
            CloudflareClient::with_client(Client::new(), "token", None).request_timeout,
            REQUEST_TIMEOUT
        );
    }

    #[test]
    fn retry_delays_and_retry_after_values_are_capped() {
        assert_eq!(retry_delay(1, Some(u64::MAX)), MAX_RETRY_DELAY);
        assert_eq!(retry_delay(62, None), MAX_RETRY_DELAY);
        assert_eq!(retry_delay(u32::MAX, None), MAX_RETRY_DELAY);

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("999999"),
        );
        assert_eq!(
            parse_retry_after_secs(&headers),
            Some(MAX_RETRY_DELAY.as_secs())
        );
    }

    #[tokio::test]
    async fn verification_success_returns_true() {
        let base = spawn_response(
            200,
            &[],
            r#"{"success":true,"result":{"status":"active"}}"#,
            Duration::ZERO,
        );
        assert!(test_client(base, "valid-token")
            .verify_token()
            .await
            .expect("verification succeeds"));
    }

    #[tokio::test]
    async fn rejected_credentials_preserve_401_and_403_provider_details() {
        for status in [401, 403] {
            let base = spawn_response(
                status,
                &[("cf-ray", "abc123-LHR")],
                r#"{"success":false,"errors":[{"code":9109,"message":"Invalid access token"},{"code":10000,"message":"Authentication error"}]}"#,
                Duration::ZERO,
            );
            let error = test_client(base, "rejected-token")
                .verify_token()
                .await
                .expect_err("credentials must be rejected");
            let context = request_context(&error);
            assert_eq!(context.kind, VerificationFailureKind::Authentication);
            assert_eq!(context.status, Some(status));
            assert_eq!(context.source, VerificationErrorSource::Cloudflare);
            assert_eq!(context.operation, AUTH_OPERATION);
            assert!(!context.retryable);
            assert_eq!(context.request_id.as_deref(), Some("abc123-LHR"));
            assert_eq!(
                context
                    .provider_errors
                    .iter()
                    .filter_map(|detail| detail.code.as_deref())
                    .collect::<Vec<_>>(),
                ["9109", "10000"]
            );
            assert_eq!(
                context
                    .provider_errors
                    .iter()
                    .map(|detail| detail.message.as_str())
                    .collect::<Vec<_>>(),
                ["Invalid access token", "Authentication error"]
            );
        }
    }

    #[tokio::test]
    async fn validation_and_protocol_failures_are_not_credential_rejections() {
        let cases = [
            (
                400,
                "invalid request",
                "selected credential type and account email",
            ),
            (
                404,
                "endpoint or method",
                "Cloudflare API compatibility change",
            ),
            (
                405,
                "endpoint or method",
                "Cloudflare API compatibility change",
            ),
        ];

        for (status, message_fragment, remediation_fragment) in cases {
            let base = spawn_response(
                status,
                &[("cf-ray", "protocol123-LHR")],
                r#"{"success":false,"errors":[{"code":1000,"message":"Request rejected"}]}"#,
                Duration::ZERO,
            );
            let error = test_client(base, "protocol-token")
                .verify_token()
                .await
                .expect_err("validation and protocol failures must fail closed");
            let context = request_context(&error);
            assert_eq!(context.kind, VerificationFailureKind::MalformedResponse);
            assert_eq!(context.status, Some(status));
            assert_eq!(context.source, VerificationErrorSource::Cloudflare);
            assert!(!context.retryable);
            assert!(context.message.contains(message_fragment));
            assert!(context.remediation.contains(remediation_fragment));
            assert!(!context.message.contains("credentials"));
        }
    }

    #[tokio::test]
    async fn http_408_is_a_retryable_provider_timeout() {
        let base = spawn_response(
            408,
            &[("cf-ray", "timeout408-LHR")],
            r#"{"success":false,"errors":[{"code":408,"message":"Request timeout"}]}"#,
            Duration::ZERO,
        );
        let error = test_client(base, "timeout-token")
            .verify_token()
            .await
            .expect_err("HTTP 408 must fail as a timeout");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::Timeout);
        assert_eq!(context.status, Some(408));
        assert_eq!(context.source, VerificationErrorSource::Cloudflare);
        assert!(context.retryable);
        assert!(context.message.contains("HTTP 408"));
        assert_eq!(context.request_id.as_deref(), Some("timeout408-LHR"));
    }

    #[tokio::test]
    async fn rate_limit_preserves_retry_after_and_request_id() {
        let base = spawn_response(
            429,
            &[("retry-after", "17"), ("cf-ray", "rate123-LHR")],
            r#"{"success":false,"errors":[{"code":1015,"message":"Rate limited"}]}"#,
            Duration::ZERO,
        );
        let error = test_client(base, "rate-limited-token")
            .verify_token()
            .await
            .expect_err("rate limit must not become false");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::RateLimited);
        assert_eq!(context.status, Some(429));
        assert!(context.retryable);
        assert_eq!(context.retry_after_secs, Some(17));
        assert_eq!(context.request_id.as_deref(), Some("rate123-LHR"));
        assert_eq!(context.provider_errors[0].code.as_deref(), Some("1015"));
    }

    #[tokio::test]
    async fn rate_limit_caps_retry_after_in_error_context() {
        let base = spawn_response(
            429,
            &[("retry-after", "999999")],
            r#"{"success":false,"errors":[{"code":1015,"message":"Rate limited"}]}"#,
            Duration::ZERO,
        );
        let error = test_client(base, "rate-limited-token")
            .verify_token()
            .await
            .expect_err("rate limit must fail closed");
        let context = request_context(&error);
        assert_eq!(context.retry_after_secs, Some(MAX_RETRY_DELAY.as_secs()));
    }

    #[tokio::test]
    async fn provider_failure_preserves_status_and_safe_detail() {
        for status in [500, 503] {
            let base = spawn_response(
                status,
                &[("cf-ray", "provider123-LHR")],
                r#"{"success":false,"errors":[{"code":1001,"message":"Provider unavailable"}]}"#,
                Duration::ZERO,
            );
            let error = test_client(base, "provider-token")
                .verify_token()
                .await
                .expect_err("provider error must not become false");
            let context = request_context(&error);
            assert_eq!(context.kind, VerificationFailureKind::Provider);
            assert_eq!(context.status, Some(status));
            assert!(context.retryable);
            assert_eq!(context.provider_errors[0].message, "Provider unavailable");
        }
    }

    #[tokio::test]
    async fn malformed_success_body_is_not_treated_as_verified() {
        let base = spawn_response(200, &[], "not-json", Duration::ZERO);
        let error = test_client(base, "malformed-token")
            .verify_token()
            .await
            .expect_err("malformed success must fail closed");
        let context = request_context(&error);
        assert_eq!(context.kind, VerificationFailureKind::MalformedResponse);
        assert_eq!(context.status, Some(200));
        assert!(context.retryable);
        assert!(context.provider_errors.is_empty());
    }

    #[tokio::test]
    async fn network_and_timeout_failures_are_distinct() {
        let network_error = test_client("not-a-valid-url".to_string(), "network-token")
            .verify_token()
            .await
            .expect_err("invalid provider address must fail");
        let network = request_context(&network_error);
        assert_eq!(network.kind, VerificationFailureKind::Network);
        assert_eq!(network.source, VerificationErrorSource::Network);
        assert!(network.retryable);

        let base = spawn_response(200, &[], r#"{"success":true}"#, Duration::from_millis(250));
        let timeout_error = CloudflareClient::with_client(Client::new(), "timeout-token", None)
            .with_request_timeout(Duration::from_millis(30))
            .with_max_retries(0)
            .with_api_base(base)
            .verify_token()
            .await
            .expect_err("slow response must time out");
        let timeout = request_context(&timeout_error);
        assert_eq!(timeout.kind, VerificationFailureKind::Timeout);
        assert_eq!(timeout.source, VerificationErrorSource::Network);
        assert!(timeout.retryable);
    }

    #[tokio::test]
    async fn provider_errors_redact_exact_credentials_from_all_outputs() {
        let secret = "secret-token-value";
        let body = format!(
            r#"{{"success":false,"errors":[{{"code":9109,"message":"Provided {secret} via Authorization: Bearer {secret} token={secret}"}}]}}"#
        );
        let base = spawn_response(401, &[], &body, Duration::ZERO);
        let error = test_client(base, secret)
            .verify_token()
            .await
            .expect_err("secret-bearing rejection must fail");
        let context = request_context(&error);
        let serialized = serde_json::to_string(context).expect("serialize context");
        let display = error.to_string();
        let debug = format!("{error:?}");
        for output in [serialized, display, debug] {
            assert!(!output.contains(secret), "secret leaked in {output}");
        }
        assert!(context.provider_errors[0].message.contains("[redacted]"));
    }
}
