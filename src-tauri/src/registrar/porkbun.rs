/// Porkbun API client.
///
/// Porkbun uses a JSON REST API with `apikey` + `secretapikey` in the body
/// of every request. All endpoints are POST.
///
/// Reference: https://porkbun.com/api/json/v3/documentation

use reqwest::Client;
use serde_json::{json, Value};
use super::types::*;
use super::RegistrarClient;

const PORKBUN_API: &str = "https://api.porkbun.com/api/json/v3";

pub struct PorkbunClient {
    client: Client,
    api_key: String,
    secret_key: String,
}

impl PorkbunClient {
    pub fn new(api_key: &str, secret_key: &str) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            secret_key: secret_key.to_string(),
        }
    }

    fn auth_body(&self) -> Value {
        json!({
            "apikey": self.api_key,
            "secretapikey": self.secret_key
        })
    }

    fn parse_domain(d: &Value) -> DomainInfo {
        let status_str = d["status"].as_str().unwrap_or("unknown").to_lowercase();
        let status = if status_str.contains("active") {
            DomainStatus::Active
        } else if status_str.contains("expired") {
            DomainStatus::Expired
        } else {
            DomainStatus::Unknown
        };

        let ns: Vec<String> = d["nameservers"].as_array()
            .or_else(|| d["ns"].as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let auto_renew = d["autoRenew"].as_bool()
            .or_else(|| d["auto_renew"].as_bool())
            .unwrap_or(false);

        let whois_privacy = d["whoisPrivacy"].as_bool()
            .or_else(|| d["whois_privacy"].as_bool())
            .unwrap_or(false);

        DomainInfo {
            domain: d["domain"].as_str().unwrap_or("").to_string(),
            registrar: RegistrarProvider::Porkbun,
            status,
            created_at: d["createDate"].as_str()
                .or_else(|| d["create_date"].as_str())
                .unwrap_or("").to_string(),
            expires_at: d["expireDate"].as_str()
                .or_else(|| d["expire_date"].as_str())
                .unwrap_or("").to_string(),
            updated_at: None,
            nameservers: Nameservers { current: ns, is_custom: false },
            locks: DomainLocks {
                transfer_lock: d["locked"].as_bool().unwrap_or(false),
                auto_renew,
            },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus {
                enabled: whois_privacy,
                service_name: Some("Porkbun WHOIS Privacy".to_string()),
            },
            contact: None,
        }
    }
}

#[async_trait::async_trait]
impl RegistrarClient for PorkbunClient {
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String> {
        let url = format!("{}/domain/listAll", PORKBUN_API);
        let resp: Value = self.client
            .post(&url)
            .json(&self.auth_body())
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if resp["status"].as_str() != Some("SUCCESS") {
            let msg = resp["message"].as_str().unwrap_or("Porkbun API error");
            return Err(msg.to_string());
        }

        let domains = resp["domains"].as_array()
            .map(|arr| arr.iter().map(Self::parse_domain).collect())
            .unwrap_or_default();
        Ok(domains)
    }

    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String> {
        // Porkbun doesn't have a single-domain endpoint; list and filter
        let all = self.list_domains().await?;
        all.into_iter()
            .find(|d| d.domain == domain)
            .ok_or_else(|| format!("Domain {} not found in Porkbun account", domain))
    }

    async fn verify_credentials(&self) -> Result<bool, String> {
        let url = format!("{}/ping", PORKBUN_API);
        let resp: Value = self.client
            .post(&url)
            .json(&self.auth_body())
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        Ok(resp["status"].as_str() == Some("SUCCESS"))
    }
}
