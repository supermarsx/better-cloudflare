/// Registrar API clients module.
///
/// Each sub-module implements an HTTP client for a specific domain registrar.
/// All clients normalise their API responses into the common `DomainInfo`
/// struct so the rest of the application can work with a single type.

pub mod types;
pub mod cloudflare;
pub mod porkbun;
pub mod namecheap;
pub mod godaddy;
pub mod google;
pub mod namecom;

use types::DomainInfo;

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
