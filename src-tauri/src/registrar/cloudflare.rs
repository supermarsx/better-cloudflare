/// Cloudflare Registrar API client.
///
/// Uses the Cloudflare v4 REST API to list domains managed through
/// Cloudflare Registrar and normalises responses into `DomainInfo`.

use reqwest::Client;
use serde_json::Value;
use super::types::*;
use super::RegistrarClient;

pub struct CloudflareRegistrarClient {
    client: Client,
    api_key: String,
    email: Option<String>,
    account_id: Option<String>,
}

impl CloudflareRegistrarClient {
    pub fn new(api_key: &str, email: Option<&str>, account_id: Option<&str>) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            email: email.map(|s| s.to_string()),
            account_id: account_id.map(|s| s.to_string()),
        }
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(email) = &self.email {
            req.header("X-Auth-Email", email)
                .header("X-Auth-Key", &self.api_key)
        } else {
            req.header("Authorization", format!("Bearer {}", self.api_key))
        }
    }

    async fn resolve_account_id(&self) -> Result<String, String> {
        if let Some(ref id) = self.account_id {
            return Ok(id.clone());
        }
        let req = self.apply_auth(
            self.client.get("https://api.cloudflare.com/client/v4/accounts?per_page=1"),
        );
        let resp: Value = req.send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        resp["result"].as_array()
            .and_then(|arr| arr.first())
            .and_then(|a| a["id"].as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "Failed to resolve Cloudflare account ID".to_string())
    }

    fn parse_domain(d: &Value) -> DomainInfo {
        let status_str = d["status"].as_str().unwrap_or("unknown").to_lowercase();
        let status = match status_str.as_str() {
            "active" => DomainStatus::Active,
            s if s.contains("expired") => DomainStatus::Expired,
            s if s.contains("transfer") => DomainStatus::PendingTransfer,
            s if s.contains("pending") => DomainStatus::Pending,
            s if s.contains("redemption") => DomainStatus::Redemption,
            s if s.contains("lock") => DomainStatus::Locked,
            _ => DomainStatus::Unknown,
        };

        let ns: Vec<String> = d["name_servers"].as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        DomainInfo {
            domain: d["name"].as_str().unwrap_or("").to_string(),
            registrar: RegistrarProvider::Cloudflare,
            status,
            created_at: d["created_at"].as_str().unwrap_or("").to_string(),
            expires_at: d["expires_at"].as_str().unwrap_or("").to_string(),
            updated_at: d["updated_at"].as_str().map(String::from),
            nameservers: Nameservers { current: ns, is_custom: false },
            locks: DomainLocks {
                transfer_lock: d["locked"].as_bool().unwrap_or(false),
                auto_renew: d["auto_renew"].as_bool().unwrap_or(false),
            },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus {
                enabled: d["privacy"].as_bool().unwrap_or(false),
                service_name: None,
            },
            contact: None,
        }
    }
}

#[async_trait::async_trait]
impl RegistrarClient for CloudflareRegistrarClient {
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String> {
        let account_id = self.resolve_account_id().await?;
        let url = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/registrar/domains",
            account_id
        );
        let req = self.apply_auth(self.client.get(&url));
        let resp: Value = req.send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if resp["success"].as_bool() != Some(true) {
            let msg = resp["errors"].as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Unknown Cloudflare Registrar error");
            return Err(msg.to_string());
        }

        let domains = resp["result"].as_array()
            .map(|arr| arr.iter().map(Self::parse_domain).collect())
            .unwrap_or_default();
        Ok(domains)
    }

    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String> {
        let account_id = self.resolve_account_id().await?;
        let url = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/registrar/domains/{}",
            account_id, domain
        );
        let req = self.apply_auth(self.client.get(&url));
        let resp: Value = req.send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if resp["success"].as_bool() != Some(true) {
            let msg = resp["errors"].as_array()
                .and_then(|arr| arr.first())
                .and_then(|e| e["message"].as_str())
                .unwrap_or("Unknown error");
            return Err(msg.to_string());
        }
        Ok(Self::parse_domain(&resp["result"]))
    }

    async fn verify_credentials(&self) -> Result<bool, String> {
        self.resolve_account_id().await.map(|_| true)
    }
}
