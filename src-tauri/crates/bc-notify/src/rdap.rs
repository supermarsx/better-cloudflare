//! RDAP lookup of a domain's expiration date (via the rdap.org redirector).

use std::time::Duration;

use chrono::{DateTime, Utc};
use thiserror::Error;

use crate::expiry::parse_rdap_expiry;

pub const RDAP_BASE_URL: &str = "https://rdap.org/domain/";
pub const RDAP_TIMEOUT: Duration = Duration::from_secs(10);
pub const RDAP_MAX_BODY_BYTES: usize = 256 * 1024;
pub const RDAP_MIN_INTERVAL: Duration = Duration::from_secs(1);
const MAX_HOSTNAME_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;

#[derive(Debug, Error)]
pub enum RdapError {
    #[error("invalid domain name")]
    InvalidDomain,
    #[error("RDAP request failed: {0}")]
    Http(String),
    #[error("RDAP returned HTTP {0}")]
    Status(u16),
    #[error("RDAP response exceeded {RDAP_MAX_BODY_BYTES} bytes")]
    TooLarge,
    #[error("RDAP response was not valid JSON: {0}")]
    Parse(String),
}

impl RdapError {
    /// 404 means "no RDAP data for this domain/TLD" — cache as unknown, do not retry eagerly.
    pub fn is_not_found(&self) -> bool {
        matches!(self, RdapError::Status(404))
    }
}

/// Strict hostname check: ASCII letters/digits/hyphens in 1–63 byte labels,
/// no leading/trailing hyphen, at least two labels, ≤ 253 bytes total.
pub fn is_valid_hostname(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > MAX_HOSTNAME_LEN {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= MAX_LABEL_LEN
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// Build the HTTP client used for RDAP (redirects followed, 10 s timeout).
pub fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(RDAP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("better-cloudflare-notify/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Fetch the expiry date for `domain` from the public rdap.org redirector.
pub async fn fetch_rdap_expiry(
    client: &reqwest::Client,
    domain: &str,
) -> Result<Option<DateTime<Utc>>, RdapError> {
    fetch_rdap_expiry_from(client, RDAP_BASE_URL, domain).await
}

/// Same as `fetch_rdap_expiry` with an explicit base URL (`…/domain/`).
pub async fn fetch_rdap_expiry_from(
    client: &reqwest::Client,
    base_url: &str,
    domain: &str,
) -> Result<Option<DateTime<Utc>>, RdapError> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if !is_valid_hostname(&domain) {
        return Err(RdapError::InvalidDomain);
    }
    let url = format!("{}{}", base_url, domain);
    let response = client
        .get(&url)
        .header("Accept", "application/rdap+json, application/json")
        .timeout(RDAP_TIMEOUT)
        .send()
        .await
        .map_err(|e| RdapError::Http(e.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(RdapError::Status(status.as_u16()));
    }
    if let Some(length) = response.content_length() {
        if length > RDAP_MAX_BODY_BYTES as u64 {
            return Err(RdapError::TooLarge);
        }
    }
    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| RdapError::Http(e.to_string()))?
    {
        if body.len() + chunk.len() > RDAP_MAX_BODY_BYTES {
            return Err(RdapError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| RdapError::Parse(e.to_string()))?;
    Ok(parse_rdap_expiry(&value))
}
