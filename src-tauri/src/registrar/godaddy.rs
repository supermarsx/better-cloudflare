/// GoDaddy API client.
///
/// Uses the GoDaddy REST API with an `Authorization: sso-key` header.
///
/// Reference: https://developer.godaddy.com/doc/endpoint/domains

use reqwest::Client;
use serde_json::Value;
use super::types::*;
use super::RegistrarClient;

const GODADDY_API: &str = "https://api.godaddy.com/v1";

pub struct GoDaddyClient {
    client: Client,
    api_key: String,
    api_secret: String,
}

impl GoDaddyClient {
    pub fn new(api_key: &str, api_secret: &str) -> Self {
        Self {
            client: Client::new(),
            api_key: api_key.to_string(),
            api_secret: api_secret.to_string(),
        }
    }

    fn auth_header(&self) -> String {
        format!("sso-key {}:{}", self.api_key, self.api_secret)
    }

    fn parse_domain(d: &Value) -> DomainInfo {
        let status_str = d["status"].as_str().unwrap_or("unknown").to_lowercase();
        let status = match status_str.as_str() {
            "active" => DomainStatus::Active,
            "expired" => DomainStatus::Expired,
            s if s.contains("transfer") => DomainStatus::PendingTransfer,
            s if s.contains("pending") => DomainStatus::Pending,
            _ => DomainStatus::Unknown,
        };

        let ns: Vec<String> = d["nameServers"].as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let locked = d["locked"].as_bool().unwrap_or(false);
        let auto_renew = d["renewAuto"].as_bool().unwrap_or(false);
        let privacy = d["privacy"].as_bool().unwrap_or(false);

        let contact = d.get("contactRegistrant").and_then(|c| {
            Some(DomainContact {
                first_name: c["nameFirst"].as_str().map(String::from),
                last_name: c["nameLast"].as_str().map(String::from),
                organization: c["organization"].as_str().map(String::from),
                email: c["email"].as_str().map(String::from),
                phone: c["phone"].as_str().map(String::from),
                city: c["addressMailing"].get("city").and_then(|v| v.as_str()).map(String::from),
                state: c["addressMailing"].get("state").and_then(|v| v.as_str()).map(String::from),
                country: c["addressMailing"].get("country").and_then(|v| v.as_str()).map(String::from),
            })
        });

        DomainInfo {
            domain: d["domain"].as_str().unwrap_or("").to_string(),
            registrar: RegistrarProvider::GoDaddy,
            status,
            created_at: d["createdAt"].as_str().unwrap_or("").to_string(),
            expires_at: d["expires"].as_str().unwrap_or("").to_string(),
            updated_at: d["modifiedAt"].as_str().map(String::from),
            nameservers: Nameservers { current: ns, is_custom: false },
            locks: DomainLocks { transfer_lock: locked, auto_renew },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus { enabled: privacy, service_name: None },
            contact,
        }
    }
}

#[async_trait::async_trait]
impl RegistrarClient for GoDaddyClient {
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String> {
        let resp: Value = self.client
            .get(format!("{}/domains", GODADDY_API))
            .header("Authorization", self.auth_header())
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if let Some(arr) = resp.as_array() {
            Ok(arr.iter().map(Self::parse_domain).collect())
        } else if let Some(msg) = resp["message"].as_str() {
            Err(msg.to_string())
        } else {
            Err("Unexpected GoDaddy API response".to_string())
        }
    }

    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String> {
        let resp: Value = self.client
            .get(format!("{}/domains/{}", GODADDY_API, domain))
            .header("Authorization", self.auth_header())
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if resp["domain"].as_str().is_some() {
            Ok(Self::parse_domain(&resp))
        } else {
            let msg = resp["message"].as_str().unwrap_or("Domain not found");
            Err(msg.to_string())
        }
    }

    async fn verify_credentials(&self) -> Result<bool, String> {
        let resp = self.client
            .get(format!("{}/domains?limit=1", GODADDY_API))
            .header("Authorization", self.auth_header())
            .send().await.map_err(|e| e.to_string())?;
        Ok(resp.status().is_success())
    }
}
