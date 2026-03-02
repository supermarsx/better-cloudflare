//! Tauri commands for the registrar monitoring feature.
//!
//! Delegates provider client construction to [`bc_registrar::build_client`]
//! and health-check logic to [`bc_registrar::compute_health_check`].

use chrono::Utc;
use tauri::State;

use bc_registrar::{
    compute_health_check, DomainHealthCheck, DomainInfo,
    RegistrarClient, RegistrarCredential, RegistrarProvider,
};
use crate::storage::Storage;

/// Build the appropriate registrar client from a credential ID.
async fn build_client_from_id(
    storage: &Storage,
    credential_id: &str,
) -> Result<Box<dyn RegistrarClient>, String> {
    let cred: RegistrarCredential = storage
        .get_registrar_credential(credential_id)
        .await
        .map_err(|e| e.to_string())?;
    let secrets = storage
        .get_registrar_secrets(credential_id)
        .await
        .map_err(|e| e.to_string())?;
    bc_registrar::build_client(&cred, &secrets)
}

// ─── Credential management ─────────────────────────────────────────────────

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
    storage
        .store_registrar_credential(&cred)
        .await
        .map_err(|e| e.to_string())?;

    let mut secrets = std::collections::HashMap::new();
    secrets.insert("api_key".to_string(), api_key);
    if let Some(secret) = api_secret {
        secrets.insert("api_secret".to_string(), secret);
    }
    if let Some(extra) = extra {
        secrets.extend(extra);
    }
    storage
        .store_registrar_secrets(&id, &secrets)
        .await
        .map_err(|e| e.to_string())?;

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:add_credential",
            "resource": id,
            "label": label,
        }))
        .await;

    Ok(id)
}

#[tauri::command]
pub async fn list_registrar_credentials(
    storage: State<'_, Storage>,
) -> Result<Vec<RegistrarCredential>, String> {
    storage
        .get_registrar_credentials()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_registrar_credential(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<(), String> {
    storage
        .delete_registrar_secrets(&credential_id)
        .await
        .map_err(|e| e.to_string())?;
    storage
        .delete_registrar_credential(&credential_id)
        .await
        .map_err(|e| e.to_string())?;

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:delete_credential",
            "resource": credential_id,
        }))
        .await;

    Ok(())
}

#[tauri::command]
pub async fn verify_registrar_credential(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<bool, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    client.verify_credentials().await
}

// ─── Domain operations ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn registrar_list_domains(
    storage: State<'_, Storage>,
    credential_id: String,
) -> Result<Vec<DomainInfo>, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    let domains = client.list_domains().await?;

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:list_domains",
            "resource": credential_id,
            "count": domains.len(),
        }))
        .await;

    Ok(domains)
}

#[tauri::command]
pub async fn registrar_get_domain(
    storage: State<'_, Storage>,
    credential_id: String,
    domain: String,
) -> Result<DomainInfo, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    client.get_domain(&domain).await
}

#[tauri::command]
pub async fn registrar_list_all_domains(
    storage: State<'_, Storage>,
) -> Result<Vec<DomainInfo>, String> {
    let creds: Vec<RegistrarCredential> = storage
        .get_registrar_credentials()
        .await
        .map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    for cred in &creds {
        match build_client_from_id(&storage, &cred.id).await {
            Ok(client) => match client.list_domains().await {
                Ok(domains) => all.extend(domains),
                Err(e) => eprintln!("Error listing domains for {}: {}", cred.label, e),
            },
            Err(e) => eprintln!("Error building client for {}: {}", cred.label, e),
        }
    }
    Ok(all)
}

// ─── Health checks ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn registrar_health_check(
    storage: State<'_, Storage>,
    credential_id: String,
    domain: String,
) -> Result<DomainHealthCheck, String> {
    let client = build_client_from_id(&storage, &credential_id).await?;
    let info = client.get_domain(&domain).await?;
    let health = compute_health_check(&info);

    let _ = storage
        .add_audit_entry(serde_json::json!({
            "timestamp": Utc::now().to_rfc3339(),
            "operation": "registrar:health_check",
            "resource": domain,
            "status": format!("{:?}", health.status),
        }))
        .await;

    Ok(health)
}

#[tauri::command]
pub async fn registrar_health_check_all(
    storage: State<'_, Storage>,
) -> Result<Vec<DomainHealthCheck>, String> {
    let creds: Vec<RegistrarCredential> = storage
        .get_registrar_credentials()
        .await
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for cred in &creds {
        if let Ok(client) = build_client_from_id(&storage, &cred.id).await {
            if let Ok(domains) = client.list_domains().await {
                for d in &domains {
                    results.push(compute_health_check(d));
                }
            }
        }
    }
    Ok(results)
}
