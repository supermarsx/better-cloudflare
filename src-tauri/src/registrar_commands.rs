/// Tauri commands for the registrar monitoring feature.
///
/// These commands are the ONLY interface the frontend uses. The frontend sends
/// commands, the backend performs all HTTP requests to registrar APIs, stores
/// credentials securely, and returns normalised data.

use tauri::State;
use chrono::Utc;
use crate::storage::Storage;
use crate::registrar::types::*;
use crate::registrar::RegistrarClient;
use crate::registrar::cloudflare::CloudflareRegistrarClient;
use crate::registrar::porkbun::PorkbunClient;
use crate::registrar::namecheap::NamecheapClient;
use crate::registrar::godaddy::GoDaddyClient;
use crate::registrar::google::GoogleDomainsClient;
use crate::registrar::namecom::NameComClient;

/// Build the appropriate registrar client from a credential ID.
/// Retrieves secrets from storage and constructs the client.
async fn build_client(
    storage: &Storage,
    credential_id: &str,
) -> Result<Box<dyn RegistrarClient>, String> {
    let cred = storage.get_registrar_credential(credential_id).await
        .map_err(|e| e.to_string())?;
    let secrets = storage.get_registrar_secrets(credential_id).await
        .map_err(|e| e.to_string())?;

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

// ─── Credential management ─────────────────────────────────────────────────

/// Add a new registrar credential. Secrets are stored securely in the backend.
#[tauri::command]
pub async fn add_registrar_credential(
    storage: State<'_, Storage>,
    provider: RegistrarProvider,
    label: String,
    username: Option<String>,
    email: Option<String>,
    api_key: String,
    api_secret: Option<String>,
    extra: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let id = format!("reg_{}", uuid::Uuid::new_v4());
    let cred = RegistrarCredential {
        id: id.clone(),
        provider,
        label: label.clone(),
        username,
        email,
        created_at: Utc::now().to_rfc3339(),
    };
    storage.store_registrar_credential(&cred).await.map_err(|e| e.to_string())?;

    // Store secrets separately
    let mut secrets = std::collections::HashMap::new();
    secrets.insert("api_key".to_string(), api_key);
    if let Some(secret) = api_secret {
        secrets.insert("api_secret".to_string(), secret);
    }
    if let Some(extra) = extra {
        secrets.extend(extra);
    }
    storage.store_registrar_secrets(&id, &secrets).await.map_err(|e| e.to_string())?;

    // Audit
    let _ = storage.add_audit_entry(serde_json::json!({
        "timestamp": Utc::now().to_rfc3339(),
        "operation": "registrar:add_credential",
        "resource": id,
        "label": label,
    })).await;

    Ok(id)
}

/// List all stored registrar credentials (metadata only, no secrets).
#[tauri::command]
pub async fn list_registrar_credentials(
    storage: State<'_, Storage>,
) -> Result<Vec<RegistrarCredential>, String> {
    storage.get_registrar_credentials().await.map_err(|e| e.to_string())
}

/// Delete a registrar credential and its secrets.
#[tauri::command]
pub async fn delete_registrar_credential(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<(), String> {
    storage.delete_registrar_secrets(&credential_id).await.map_err(|e| e.to_string())?;
    storage.delete_registrar_credential(&credential_id).await.map_err(|e| e.to_string())?;

    let _ = storage.add_audit_entry(serde_json::json!({
        "timestamp": Utc::now().to_rfc3339(),
        "operation": "registrar:delete_credential",
        "resource": credential_id,
    })).await;

    Ok(())
}

/// Verify that stored credentials are accepted by the registrar.
#[tauri::command]
pub async fn verify_registrar_credential(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<bool, String> {
    let client = build_client(&storage, &credential_id).await?;
    client.verify_credentials().await
}

// ─── Domain operations ─────────────────────────────────────────────────────

/// List all domains for a registrar credential.
#[tauri::command]
pub async fn registrar_list_domains(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<Vec<DomainInfo>, String> {
    let client = build_client(&storage, &credential_id).await?;
    let domains = client.list_domains().await?;

    let _ = storage.add_audit_entry(serde_json::json!({
        "timestamp": Utc::now().to_rfc3339(),
        "operation": "registrar:list_domains",
        "resource": credential_id,
        "count": domains.len(),
    })).await;

    Ok(domains)
}

/// Get detailed info for a single domain.
#[tauri::command]
pub async fn registrar_get_domain(
    storage: State<'_, Storage>,
    credential_id: String,
    domain: String,
) -> Result<DomainInfo, String> {
    let client = build_client(&storage, &credential_id).await?;
    client.get_domain(&domain).await
}

/// List domains from ALL configured registrar credentials at once.
#[tauri::command]
pub async fn registrar_list_all_domains(
    storage: State<'_, Storage>,
) -> Result<Vec<DomainInfo>, String> {
    let creds = storage.get_registrar_credentials().await.map_err(|e| e.to_string())?;
    let mut all_domains = Vec::new();

    for cred in &creds {
        match build_client(&storage, &cred.id).await {
            Ok(client) => {
                match client.list_domains().await {
                    Ok(domains) => all_domains.extend(domains),
                    Err(e) => {
                        eprintln!("Error listing domains for {}: {}", cred.label, e);
                    }
                }
            }
            Err(e) => {
                eprintln!("Error building client for {}: {}", cred.label, e);
            }
        }
    }

    Ok(all_domains)
}

// ─── Health checks ─────────────────────────────────────────────────────────

/// Run health checks for a domain.
#[tauri::command]
pub async fn registrar_health_check(
    storage: State<'_, Storage>,
    credential_id: String,
    domain: String,
) -> Result<DomainHealthCheck, String> {
    let client = build_client(&storage, &credential_id).await?;
    let info = client.get_domain(&domain).await?;
    let health = compute_health_check(&info);

    let _ = storage.add_audit_entry(serde_json::json!({
        "timestamp": Utc::now().to_rfc3339(),
        "operation": "registrar:health_check",
        "resource": domain,
        "status": format!("{:?}", health.status),
    })).await;

    Ok(health)
}

/// Run health checks for ALL domains from all credentials.
#[tauri::command]
pub async fn registrar_health_check_all(
    storage: State<'_, Storage>,
) -> Result<Vec<DomainHealthCheck>, String> {
    let creds = storage.get_registrar_credentials().await.map_err(|e| e.to_string())?;
    let mut results = Vec::new();

    for cred in &creds {
        if let Ok(client) = build_client(&storage, &cred.id).await {
            if let Ok(domains) = client.list_domains().await {
                for d in &domains {
                    results.push(compute_health_check(d));
                }
            }
        }
    }

    Ok(results)
}

/// Compute health checks for a normalised domain info.
fn compute_health_check(info: &DomainInfo) -> DomainHealthCheck {
    let mut checks = Vec::new();
    let now = Utc::now();

    // 1. Expiry check
    if let Ok(expires) = chrono::DateTime::parse_from_rfc3339(&info.expires_at) {
        let days_until = (expires - now).num_days();
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
        severity: if info.privacy.enabled { CheckSeverity::Info } else { CheckSeverity::Info },
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
        severity: if info.dnssec.enabled { CheckSeverity::Info } else { CheckSeverity::Info },
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
