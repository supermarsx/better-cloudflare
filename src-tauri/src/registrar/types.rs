/// Shared types for the registrar monitoring feature.
///
/// Every registrar client normalises its API responses into `DomainInfo`.
/// These types are serialised to the frontend via Tauri commands.

use serde::{Deserialize, Serialize};

/// Supported registrar providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RegistrarProvider {
    Cloudflare,
    Porkbun,
    Namecheap,
    #[serde(rename = "godaddy")]
    GoDaddy,
    Google,
    #[serde(rename = "namecom")]
    NameCom,
}

impl std::fmt::Display for RegistrarProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cloudflare => write!(f, "cloudflare"),
            Self::Porkbun => write!(f, "porkbun"),
            Self::Namecheap => write!(f, "namecheap"),
            Self::GoDaddy => write!(f, "godaddy"),
            Self::Google => write!(f, "google"),
            Self::NameCom => write!(f, "namecom"),
        }
    }
}

/// Domain lifecycle status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainStatus {
    Active,
    Expired,
    Pending,
    PendingTransfer,
    Redemption,
    Locked,
    Unknown,
}

/// Nameserver configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Nameservers {
    pub current: Vec<String>,
    pub is_custom: bool,
}

/// DNSSEC status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DNSSECStatus {
    pub enabled: bool,
    pub ds_records: Option<Vec<DSRecord>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DSRecord {
    pub key_tag: u32,
    pub algorithm: u32,
    pub digest_type: u32,
    pub digest: String,
}

/// Lock / auto-renew flags.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainLocks {
    pub transfer_lock: bool,
    pub auto_renew: bool,
}

/// WHOIS privacy status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyStatus {
    pub enabled: bool,
    pub service_name: Option<String>,
}

/// Contact information (may be redacted).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainContact {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub organization: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
}

/// Normalised domain info returned from every registrar client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainInfo {
    pub domain: String,
    pub registrar: RegistrarProvider,
    pub status: DomainStatus,
    pub created_at: String,
    pub expires_at: String,
    pub updated_at: Option<String>,
    pub nameservers: Nameservers,
    pub locks: DomainLocks,
    pub dnssec: DNSSECStatus,
    pub privacy: PrivacyStatus,
    pub contact: Option<DomainContact>,
}

/// Stored registrar credential (metadata only – secrets stored separately).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrarCredential {
    pub id: String,
    pub provider: RegistrarProvider,
    pub label: String,
    pub username: Option<String>,
    pub email: Option<String>,
    pub created_at: String,
}

/// Health-check result for a single domain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainHealthCheck {
    pub domain: String,
    pub status: HealthStatus,
    pub checks: Vec<DomainCheck>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Healthy,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainCheck {
    pub name: String,
    pub passed: bool,
    pub severity: CheckSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckSeverity {
    Info,
    Warning,
    Critical,
}
