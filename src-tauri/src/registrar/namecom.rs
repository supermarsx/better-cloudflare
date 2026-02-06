/// Name.com API client.
///
/// Uses the Name.com REST API v4 with HTTP Basic Auth (username + API token).
///
/// Reference: https://www.name.com/api-docs

use reqwest::Client;
use serde_json::Value;
use super::types::*;
use super::RegistrarClient;

const NAMECOM_API: &str = "https://api.name.com/v4";

pub struct NameComClient {
    client: Client,
    username: String,
    api_token: String,
}

impl NameComClient {
    pub fn new(username: &str, api_token: &str) -> Self {
        Self {
            client: Client::new(),
            username: username.to_string(),
            api_token: api_token.to_string(),
        }
    }

    fn parse_domain(d: &Value) -> DomainInfo {
        let locked = d["locked"].as_bool().unwrap_or(false);
        let auto_renew = d["autorenewEnabled"].as_bool().unwrap_or(false);
        let privacy_enabled = d["privacyEnabled"].as_bool().unwrap_or(false);

        let ns: Vec<String> = d["nameservers"].as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let expire_date = d["expireDate"].as_str().unwrap_or("").to_string();

        // Determine status from the response
        let expired = chrono::DateTime::parse_from_rfc3339(&expire_date)
            .map(|dt| dt < chrono::Utc::now())
            .unwrap_or(false);
        let status = if expired {
            DomainStatus::Expired
        } else if locked {
            DomainStatus::Locked
        } else {
            DomainStatus::Active
        };

        let contact = d.get("contacts").and_then(|c| c.get("registrant")).and_then(|r| {
            Some(DomainContact {
                first_name: r["firstName"].as_str().map(String::from),
                last_name: r["lastName"].as_str().map(String::from),
                organization: r["companyName"].as_str().map(String::from),
                email: r["email"].as_str().map(String::from),
                phone: r["phone"].as_str().map(String::from),
                city: r["city"].as_str().map(String::from),
                state: r["state"].as_str().map(String::from),
                country: r["country"].as_str().map(String::from),
            })
        });

        DomainInfo {
            domain: d["domainName"].as_str().unwrap_or("").to_string(),
            registrar: RegistrarProvider::NameCom,
            status,
            created_at: d["createDate"].as_str().unwrap_or("").to_string(),
            expires_at: expire_date,
            updated_at: None,
            nameservers: Nameservers { current: ns, is_custom: false },
            locks: DomainLocks { transfer_lock: locked, auto_renew },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus {
                enabled: privacy_enabled,
                service_name: Some("Name.com Privacy".to_string()),
            },
            contact,
        }
    }
}

#[async_trait::async_trait]
impl RegistrarClient for NameComClient {
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String> {
        let mut all_domains = Vec::new();
        let mut page = 1;

        loop {
            let url = format!("{}/domains?page={}&perPage=100", NAMECOM_API, page);
            let resp: Value = self.client
                .get(&url)
                .basic_auth(&self.username, Some(&self.api_token))
                .send().await.map_err(|e| e.to_string())?
                .json().await.map_err(|e| e.to_string())?;

            if let Some(msg) = resp["message"].as_str() {
                if resp["domains"].is_null() {
                    return Err(msg.to_string());
                }
            }

            let domains: Vec<DomainInfo> = resp["domains"].as_array()
                .map(|arr| arr.iter().map(Self::parse_domain).collect())
                .unwrap_or_default();

            let count = domains.len();
            all_domains.extend(domains);

            // Check if there's a next page
            if resp["nextPage"].as_u64().is_none() || count == 0 {
                break;
            }
            page += 1;
        }

        Ok(all_domains)
    }

    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String> {
        let url = format!("{}/domains/{}", NAMECOM_API, domain);
        let resp: Value = self.client
            .get(&url)
            .basic_auth(&self.username, Some(&self.api_token))
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if resp["domainName"].as_str().is_some() {
            Ok(Self::parse_domain(&resp))
        } else {
            let msg = resp["message"].as_str().unwrap_or("Domain not found");
            Err(msg.to_string())
        }
    }

    async fn verify_credentials(&self) -> Result<bool, String> {
        let resp = self.client
            .get(format!("{}/hello", NAMECOM_API))
            .basic_auth(&self.username, Some(&self.api_token))
            .send().await.map_err(|e| e.to_string())?;
        Ok(resp.status().is_success())
    }
}
