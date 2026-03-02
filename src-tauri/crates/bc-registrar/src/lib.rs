//! Registrar API clients for domain monitoring.
//!
//! Provides a unified `RegistrarClient` trait and implementations for
//! Cloudflare, Porkbun, Namecheap, GoDaddy, Google Cloud Domains, and
//! Name.com. Includes domain health-check evaluation.

pub mod types;
pub mod cloudflare;
pub mod porkbun;
pub mod namecheap;
pub mod godaddy;
pub mod google;
pub mod namecom;

pub use types::*;
pub use cloudflare::CloudflareRegistrarClient;
pub use porkbun::PorkbunClient;
pub use namecheap::NamecheapClient;
pub use godaddy::GoDaddyClient;
pub use google::GoogleDomainsClient;
pub use namecom::NameComClient;

use chrono::Utc;
use std::collections::HashMap;

/// Trait that every registrar client must implement.
#[async_trait::async_trait]
pub trait RegistrarClient: Send + Sync {
    /// List all domains in the account.
    async fn list_domains(&self) -> Result<Vec<DomainInfo>, String>;

    /// Get detailed info for a single domain.
    async fn get_domain(&self, domain: &str) -> Result<DomainInfo, String>;

    /// Verify that credentials are valid.
    async fn verify_credentials(&self) -> Result<bool, String>;
}

/// Build the appropriate registrar client from a credential and its secrets.
///
/// The caller is responsible for retrieving the credential metadata and
/// secrets from storage before calling this function.
pub fn build_client(
    cred: &RegistrarCredential,
    secrets: &HashMap<String, String>,
) -> Result<Box<dyn RegistrarClient>, String> {
    let api_key = secrets.get("api_key").cloned().unwrap_or_default();
    let api_secret = secrets.get("api_secret").cloned().unwrap_or_default();

    match cred.provider {
        RegistrarProvider::Cloudflare => {
            let account_id = secrets.get("account_id").map(|s| s.as_str());
            Ok(Box::new(CloudflareRegistrarClient::new(
                &api_key,
                cred.email.as_deref(),
                account_id,
            )))
        }
        RegistrarProvider::Porkbun => {
            Ok(Box::new(PorkbunClient::new(&api_key, &api_secret)))
        }
        RegistrarProvider::Namecheap => {
            let username = cred.username.as_deref().unwrap_or("");
            let client_ip = secrets.get("client_ip").map(|s| s.as_str()).unwrap_or("127.0.0.1");
            let sandbox = secrets.get("sandbox").map(|s| s == "true").unwrap_or(false);
            Ok(Box::new(NamecheapClient::new(username, &api_key, client_ip, sandbox)))
        }
        RegistrarProvider::GoDaddy => {
            Ok(Box::new(GoDaddyClient::new(&api_key, &api_secret)))
        }
        RegistrarProvider::Google => {
            let project = secrets.get("project").cloned().unwrap_or_default();
            let location = secrets.get("location").cloned().unwrap_or_default();
            Ok(Box::new(GoogleDomainsClient::new(&api_key, &project, &location)))
        }
        RegistrarProvider::NameCom => {
            let username = cred.username.as_deref().unwrap_or("");
            Ok(Box::new(NameComClient::new(username, &api_key)))
        }
    }
}

/// Compute health checks for a normalised domain info.
pub fn compute_health_check(info: &DomainInfo) -> DomainHealthCheck {
    let mut checks = Vec::new();
    let now = Utc::now();

    // 1. Expiry check
    if let Ok(expires) = chrono::DateTime::parse_from_rfc3339(&info.expires_at) {
        let expires_utc = expires.with_timezone(&Utc);
        let days_until = (expires_utc - now).num_days();
        if days_until < 0 {
            checks.push(DomainCheck {
                name: "expiry".to_string(),
                passed: false,
                severity: CheckSeverity::Critical,
                message: format!("Domain expired {} days ago", -days_until),
            });
        } else if days_until < 30 {
            checks.push(DomainCheck {
                name: "expiry".to_string(),
                passed: false,
                severity: CheckSeverity::Warning,
                message: format!("Domain expires in {} days", days_until),
            });
        } else {
            checks.push(DomainCheck {
                name: "expiry".to_string(),
                passed: true,
                severity: CheckSeverity::Info,
                message: format!("Domain expires in {} days", days_until),
            });
        }
    }

    // 2. Auto-renew check
    checks.push(DomainCheck {
        name: "auto_renew".to_string(),
        passed: info.locks.auto_renew,
        severity: if info.locks.auto_renew { CheckSeverity::Info } else { CheckSeverity::Warning },
        message: if info.locks.auto_renew {
            "Auto-renew is enabled".to_string()
        } else {
            "Auto-renew is disabled – domain may expire unexpectedly".to_string()
        },
    });

    // 3. Transfer lock check
    checks.push(DomainCheck {
        name: "transfer_lock".to_string(),
        passed: info.locks.transfer_lock,
        severity: if info.locks.transfer_lock { CheckSeverity::Info } else { CheckSeverity::Warning },
        message: if info.locks.transfer_lock {
            "Transfer lock is enabled".to_string()
        } else {
            "Transfer lock is disabled – domain could be transferred away".to_string()
        },
    });

    // 4. WHOIS privacy check
    checks.push(DomainCheck {
        name: "privacy".to_string(),
        passed: info.privacy.enabled,
        severity: CheckSeverity::Info,
        message: if info.privacy.enabled {
            "WHOIS privacy is enabled".to_string()
        } else {
            "WHOIS privacy is not enabled".to_string()
        },
    });

    // 5. DNSSEC check
    checks.push(DomainCheck {
        name: "dnssec".to_string(),
        passed: info.dnssec.enabled,
        severity: CheckSeverity::Info,
        message: if info.dnssec.enabled {
            "DNSSEC is enabled".to_string()
        } else {
            "DNSSEC is not enabled".to_string()
        },
    });

    // 6. Nameserver check
    let has_ns = !info.nameservers.current.is_empty();
    checks.push(DomainCheck {
        name: "nameservers".to_string(),
        passed: has_ns,
        severity: if has_ns { CheckSeverity::Info } else { CheckSeverity::Warning },
        message: if has_ns {
            format!("Using {} nameservers", info.nameservers.current.len())
        } else {
            "No nameservers configured".to_string()
        },
    });

    // Determine overall status
    let has_critical = checks.iter().any(|c| !c.passed && matches!(c.severity, CheckSeverity::Critical));
    let has_warning = checks.iter().any(|c| !c.passed && matches!(c.severity, CheckSeverity::Warning));
    let overall = if has_critical {
        HealthStatus::Critical
    } else if has_warning {
        HealthStatus::Warning
    } else {
        HealthStatus::Healthy
    };

    DomainHealthCheck {
        domain: info.domain.clone(),
        status: overall,
        checks,
        checked_at: now.to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_check_healthy_domain() {
        let info = DomainInfo {
            domain: "example.com".to_string(),
            registrar: RegistrarProvider::Cloudflare,
            status: DomainStatus::Active,
            created_at: "2020-01-01T00:00:00Z".to_string(),
            expires_at: "2030-01-01T00:00:00Z".to_string(),
            updated_at: None,
            nameservers: Nameservers { current: vec!["ns1.example.com".to_string()], is_custom: false },
            locks: DomainLocks { transfer_lock: true, auto_renew: true },
            dnssec: DNSSECStatus { enabled: true, ds_records: None },
            privacy: PrivacyStatus { enabled: true, service_name: None },
            contact: None,
        };
        let hc = compute_health_check(&info);
        assert!(matches!(hc.status, HealthStatus::Healthy));
        assert!(hc.checks.iter().all(|c| c.passed));
    }

    #[test]
    fn health_check_expired_domain() {
        let info = DomainInfo {
            domain: "expired.com".to_string(),
            registrar: RegistrarProvider::Porkbun,
            status: DomainStatus::Expired,
            created_at: "2020-01-01T00:00:00Z".to_string(),
            expires_at: "2020-06-01T00:00:00Z".to_string(),
            updated_at: None,
            nameservers: Nameservers { current: vec![], is_custom: false },
            locks: DomainLocks { transfer_lock: false, auto_renew: false },
            dnssec: DNSSECStatus { enabled: false, ds_records: None },
            privacy: PrivacyStatus { enabled: false, service_name: None },
            contact: None,
        };
        let hc = compute_health_check(&info);
        assert!(matches!(hc.status, HealthStatus::Critical));
    }

    #[test]
    fn build_client_cloudflare() {
        let cred = RegistrarCredential {
            id: "reg_1".to_string(),
            provider: RegistrarProvider::Cloudflare,
            label: "test".to_string(),
            username: None,
            email: Some("test@example.com".to_string()),
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };
        let mut secrets = HashMap::new();
        secrets.insert("api_key".to_string(), "test_key".to_string());
        let client = build_client(&cred, &secrets);
        assert!(client.is_ok());
    }
}
