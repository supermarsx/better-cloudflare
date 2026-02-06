/// Namecheap API client.
///
/// Namecheap uses an XML-based API. We parse the XML responses into our
/// normalised `DomainInfo` type.
///
/// Reference: https://www.namecheap.com/support/api/methods/

use reqwest::Client;
use super::types::*;
use super::RegistrarClient;

const NAMECHEAP_API: &str = "https://api.namecheap.com/xml.response";
const NAMECHEAP_SANDBOX: &str = "https://api.sandbox.namecheap.com/xml.response";

pub struct NamecheapClient {
    client: Client,
    api_user: String,
    api_key: String,
    client_ip: String,
    sandbox: bool,
}

impl NamecheapClient {
    pub fn new(api_user: &str, api_key: &str, client_ip: &str, sandbox: bool) -> Self {
        Self {
            client: Client::new(),
            api_user: api_user.to_string(),
            api_key: api_key.to_string(),
            client_ip: client_ip.to_string(),
            sandbox,
        }
    }

    fn base_url(&self) -> &str {
        if self.sandbox { NAMECHEAP_SANDBOX } else { NAMECHEAP_API }
    }

    fn base_params(&self, command: &str) -> Vec<(&str, String)> {
        vec![
            ("ApiUser", self.api_user.clone()),
            ("ApiKey", self.api_key.clone()),
            ("UserName", self.api_user.clone()),
            ("ClientIp", self.client_ip.clone()),
            ("Command", command.to_string()),
        ]
    }

    /// Extract a simple value between XML tags (very minimal parser).
    fn extract_tag(xml: &str, tag: &str) -> Option<String> {
        let open = format!("<{}", tag);
        let close = format!("</{}>", tag);
        if let Some(start) = xml.find(&open) {
            // Find the > closing the opening tag
            let after_open = &xml[start..];
            if let Some(gt) = after_open.find('>') {
                let content_start = start + gt + 1;
                if let Some(end) = xml[content_start..].find(&close) {
                    return Some(xml[content_start..content_start + end].to_string());
                }
            }
        }
        None
    }

    /// Extract an attribute value from an XML tag fragment.
    fn extract_attr(tag_fragment: &str, attr: &str) -> Option<String> {
        let needle = format!("{}=\"", attr);
        if let Some(start) = tag_fragment.find(&needle) {
            let val_start = start + needle.len();
            if let Some(end) = tag_fragment[val_start..].find('"') {
                return Some(tag_fragment[val_start..val_start + end].to_string());
            }
        }
        None
    }

    fn parse_domain_list(xml: &str) -> Vec<DomainInfo> {
        let mut domains = Vec::new();
        let mut search_from = 0;

        while let Some(start) = xml[search_from..].find("<Domain ") {
            let abs_start = search_from + start;
            let tag_end = match xml[abs_start..].find("/>") {
                Some(e) => abs_start + e + 2,
                None => match xml[abs_start..].find('>') {
                    Some(e) => abs_start + e + 1,
                    None => break,
                },
            };
            let tag = &xml[abs_start..tag_end];

            let name = Self::extract_attr(tag, "Name").unwrap_or_default();
            let expires = Self::extract_attr(tag, "Expires").unwrap_or_default();
            let created = Self::extract_attr(tag, "Created").unwrap_or_default();
            let is_expired = Self::extract_attr(tag, "IsExpired")
                .map(|v| v == "true")
                .unwrap_or(false);
            let is_locked = Self::extract_attr(tag, "IsLocked")
                .map(|v| v == "true")
                .unwrap_or(false);
            let auto_renew = Self::extract_attr(tag, "AutoRenew")
                .map(|v| v == "true")
                .unwrap_or(false);
            let whois_guard = Self::extract_attr(tag, "WhoisGuard")
                .map(|v| v.to_lowercase() == "enabled" || v == "true")
                .unwrap_or(false);

            let status = if is_expired {
                DomainStatus::Expired
            } else if is_locked {
                DomainStatus::Locked
            } else {
                DomainStatus::Active
            };

            domains.push(DomainInfo {
                domain: name,
                registrar: RegistrarProvider::Namecheap,
                status,
                created_at: created,
                expires_at: expires,
                updated_at: None,
                nameservers: Nameservers { current: vec![], is_custom: false },
                locks: DomainLocks {
                    transfer_lock: is_locked,
                    auto_renew,
                },
                dnssec: DNSSECStatus { enabled: false, ds_records: None },
                privacy: PrivacyStatus {
                    enabled: whois_guard,
                    service_name: Some("WhoisGuard".to_string()),
                },
                contact: None,
            });

            search_from = tag_end;
        }

        domains
    }
}

#[async_trait::async_trait]
impl RegistrarClient for NamecheapClient {
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String> {
        let params = self.base_params("namecheap.domains.getList");
        let resp = self.client
            .get(self.base_url())
            .query(&params)
            .send().await.map_err(|e| e.to_string())?;
        let xml = resp.text().await.map_err(|e| e.to_string())?;

        if xml.contains("Status=\"ERROR\"") {
            let msg = Self::extract_tag(&xml, "Message")
                .unwrap_or_else(|| "Namecheap API error".to_string());
            return Err(msg);
        }

        Ok(Self::parse_domain_list(&xml))
    }

    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String> {
        let parts: Vec<&str> = domain.splitn(2, '.').collect();
        if parts.len() != 2 {
            return Err("Invalid domain format".to_string());
        }
        let mut params = self.base_params("namecheap.domains.getInfo");
        params.push(("DomainName", domain.to_string()));
        let resp = self.client
            .get(self.base_url())
            .query(&params)
            .send().await.map_err(|e| e.to_string())?;
        let xml = resp.text().await.map_err(|e| e.to_string())?;

        if xml.contains("Status=\"ERROR\"") {
            let msg = Self::extract_tag(&xml, "Message")
                .unwrap_or_else(|| "Namecheap API error".to_string());
            return Err(msg);
        }

        // Parse the DomainGetInfoResult
        let status_str = Self::extract_attr(&xml, "Status").unwrap_or_default();
        let status = match status_str.to_lowercase().as_str() {
            "ok" | "active" => DomainStatus::Active,
            "expired" => DomainStatus::Expired,
            "locked" => DomainStatus::Locked,
            _ => DomainStatus::Unknown,
        };

        let created = Self::extract_tag(&xml, "CreatedDate").unwrap_or_default();
        let expires = Self::extract_tag(&xml, "ExpiredDate").unwrap_or_default();

        Ok(DomainInfo {
            domain: domain.to_string(),
            registrar: RegistrarProvider::Namecheap,
            status,
            created_at: created,
            expires_at: expires,
            updated_at: None,
            nameservers: Nameservers { current: vec![], is_custom: false },
            locks: DomainLocks { transfer_lock: false, auto_renew: false },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus { enabled: false, service_name: None },
            contact: None,
        })
    }

    async fn verify_credentials(&self) -> Result<bool, String> {
        // Cheapest call: list domains page 1 with 1 result
        let mut params = self.base_params("namecheap.domains.getList");
        params.push(("PageSize", "1".to_string()));
        let resp = self.client
            .get(self.base_url())
            .query(&params)
            .send().await.map_err(|e| e.to_string())?;
        let xml = resp.text().await.map_err(|e| e.to_string())?;
        Ok(!xml.contains("Status=\"ERROR\""))
    }
}
