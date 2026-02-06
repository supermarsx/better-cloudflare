/// Google Domains API client.
///
/// Google Domains migrated most customers to Squarespace; this client
/// targets the Google Domains API that remains available for Google
/// Workspace / Cloud customers.
///
/// Note: The actual Google Domains API was deprecated in favour of
/// Squarespace, but for accounts still on Google Cloud Domains we use
/// the Cloud Domains API.
///
/// Reference: https://cloud.google.com/domains/docs/reference/rest

use reqwest::Client;
use serde_json::Value;
use super::types::*;
use super::RegistrarClient;

const GOOGLE_DOMAINS_API: &str = "https://domains.googleapis.com/v1";

pub struct GoogleDomainsClient {
    client: Client,
    /// OAuth2 Bearer token or API key
    access_token: String,
    project: String,
    location: String,
}

impl GoogleDomainsClient {
    pub fn new(access_token: &str, project: &str, location: &str) -> Self {
        Self {
            client: Client::new(),
            access_token: access_token.to_string(),
            project: project.to_string(),
            location: if location.is_empty() { "global".to_string() } else { location.to_string() },
        }
    }

    fn parse_registration(r: &Value) -> DomainInfo {
        let domain = r["domainName"].as_str().unwrap_or("").to_string();
        let state = r["state"].as_str().unwrap_or("REGISTRATION_STATE_UNSPECIFIED");
        let status = match state {
            "ACTIVE" => DomainStatus::Active,
            "EXPIRED" => DomainStatus::Expired,
            "SUSPENDED" => DomainStatus::Locked,
            s if s.contains("PENDING") => DomainStatus::Pending,
            s if s.contains("TRANSFER") => DomainStatus::PendingTransfer,
            _ => DomainStatus::Unknown,
        };

        let ns: Vec<String> = r["dnsSettings"]["customDns"]["nameServers"].as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let is_custom = !ns.is_empty();

        let privacy_enabled = r["contactSettings"]["privacy"].as_str()
            .map(|p| p != "PUBLIC_CONTACT_DATA")
            .unwrap_or(false);

        DomainInfo {
            domain,
            registrar: RegistrarProvider::Google,
            status,
            created_at: r["createTime"].as_str().unwrap_or("").to_string(),
            expires_at: r["expireTime"].as_str().unwrap_or("").to_string(),
            updated_at: r["updateTime"].as_str().map(String::from),
            nameservers: Nameservers { current: ns, is_custom },
            locks: DomainLocks {
                transfer_lock: r["transferLockState"].as_str() == Some("LOCKED"),
                auto_renew: r["managementSettings"]["renewalMethod"].as_str() == Some("AUTOMATIC_RENEWAL"),
            },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus { enabled: privacy_enabled, service_name: None },
            contact: None,
        }
    }
}

#[async_trait::async_trait]
impl RegistrarClient for GoogleDomainsClient {
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String> {
        let url = format!(
            "{}/projects/{}/locations/{}/registrations",
            GOOGLE_DOMAINS_API, self.project, self.location
        );
        let resp: Value = self.client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if let Some(err) = resp.get("error") {
            let msg = err["message"].as_str().unwrap_or("Google Domains API error");
            return Err(msg.to_string());
        }

        let domains = resp["registrations"].as_array()
            .map(|arr| arr.iter().map(Self::parse_registration).collect())
            .unwrap_or_default();
        Ok(domains)
    }

    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String> {
        let url = format!(
            "{}/projects/{}/locations/{}/registrations/{}",
            GOOGLE_DOMAINS_API, self.project, self.location, domain
        );
        let resp: Value = self.client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if let Some(err) = resp.get("error") {
            let msg = err["message"].as_str().unwrap_or("Domain not found");
            return Err(msg.to_string());
        }

        Ok(Self::parse_registration(&resp))
    }

    async fn verify_credentials(&self) -> Result<bool, String> {
        let url = format!(
            "{}/projects/{}/locations/{}/registrations?pageSize=1",
            GOOGLE_DOMAINS_API, self.project, self.location
        );
        let resp = self.client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send().await.map_err(|e| e.to_string())?;
        Ok(resp.status().is_success())
    }
}
