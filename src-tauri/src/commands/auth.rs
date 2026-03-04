use tauri::State;

use crate::cloudflare_api::CloudflareClient;
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::passkey::PasskeyManager;
use crate::session::SessionManager;
use crate::storage::{ApiKey, Storage};

use super::log_audit;

// ─── Authentication & Key Management ────────────────────────────────────────

#[tauri::command]
pub async fn verify_token(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
) -> Result<bool, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    match client.verify_token().await {
        Ok(ok) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:verify_token",
                    "resource": "api_token",
                    "success": ok
                }),
            )
            .await;
            Ok(ok)
        }
        Err(err) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:verify_token",
                    "resource": "api_token",
                    "success": false,
                    "error": err.to_string()
                }),
            )
            .await;
            Err(err.to_string())
        }
    }
}

#[tauri::command]
pub async fn get_api_keys(storage: State<'_, Storage>) -> Result<Vec<ApiKey>, String> {
    storage.get_api_keys().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_api_key(
    storage: State<'_, Storage>,
    label: String,
    api_key: String,
    email: Option<String>,
    password: String,
) -> Result<String, String> {
    let config = match storage.get_encryption_settings().await {
        Ok(config) => config,
        Err(bc_storage::StorageError::NotFound) => CryptoManager::default().get_config(),
        Err(e) => return Err(e.to_string()),
    };
    let crypto = CryptoManager::new(config.clone());
    let encrypted = crypto.encrypt(&api_key, &password).map_err(|e| e.to_string())?;

    let id = storage
        .add_api_key(label.clone(), encrypted, email.clone(), config)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "api_key:add",
            "resource": id,
            "label": label,
            "email": email,
        }),
    )
    .await;
    Ok(id)
}

#[tauri::command]
pub async fn update_api_key(
    storage: State<'_, Storage>,
    id: String,
    label: Option<String>,
    email: Option<String>,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<(), String> {
    let mut encrypted_key: Option<String> = None;
    let mut iterations: Option<u32> = None;
    let mut key_length: Option<usize> = None;
    let mut algorithm: Option<String> = None;
    if let Some(new_password) = new_password {
        let current_password = current_password.ok_or("Current password required")?;
        let existing = storage.get_api_key(&id).await.map_err(|e| e.to_string())?;
        let crypto = CryptoManager::new(EncryptionConfig {
            iterations: existing.iterations,
            key_length: existing.key_length,
            algorithm: existing.algorithm.clone(),
        });
        let decrypted = crypto
            .decrypt(&existing.encrypted_key, &current_password)
            .map_err(|e| e.to_string())?;
        let updated_config = match storage.get_encryption_settings().await {
            Ok(config) => config,
            Err(bc_storage::StorageError::NotFound) => crypto.get_config(),
            Err(e) => return Err(e.to_string()),
        };
        let updated_crypto = CryptoManager::new(updated_config.clone());
        encrypted_key = Some(
            updated_crypto
                .encrypt(&decrypted, &new_password)
                .map_err(|e| e.to_string())?,
        );
        iterations = Some(updated_config.iterations);
        key_length = Some(updated_config.key_length);
        algorithm = Some(updated_config.algorithm);
    }
    storage
        .update_api_key(
            id.clone(),
            label.clone(),
            email.clone(),
            encrypted_key,
            iterations,
            key_length,
            algorithm,
        )
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "api_key:update",
            "resource": id,
            "label": label,
            "email": email,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(storage: State<'_, Storage>, id: String) -> Result<(), String> {
    storage
        .delete_api_key(id.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "api_key:delete",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn decrypt_api_key(
    storage: State<'_, Storage>,
    id: String,
    password: String,
) -> Result<String, String> {
    let encrypted = storage.get_api_key(&id).await.map_err(|e| e.to_string())?;
    let crypto = CryptoManager::new(EncryptionConfig {
        iterations: encrypted.iterations,
        key_length: encrypted.key_length,
        algorithm: encrypted.algorithm,
    });
    match crypto.decrypt(&encrypted.encrypted_key, &password) {
        Ok(value) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:decrypt_api_key",
                    "resource": id,
                    "success": true
                }),
            )
            .await;
            Ok(value)
        }
        Err(err) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:decrypt_api_key",
                    "resource": id,
                    "success": false,
                    "error": err.to_string()
                }),
            )
            .await;
            Err(err.to_string())
        }
    }
}

// ─── Vault Operations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn store_vault_secret(
    storage: State<'_, Storage>,
    id: String,
    secret: String,
) -> Result<(), String> {
    storage
        .store_vault_secret(&id, &secret)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "vault:store",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn get_vault_secret(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    token: Option<String>,
) -> Result<String, String> {
    let token = token.ok_or("Passkey token required")?;
    let ok = passkey_mgr
        .verify_token(&id, &token, true)
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err("Invalid passkey token".to_string());
    }
    storage
        .get_vault_secret(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vault_secret(storage: State<'_, Storage>, id: String) -> Result<(), String> {
    storage
        .delete_vault_secret(&id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "vault:delete",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

// ─── Passkey Operations ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_passkey_registration_options(
    _storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr
        .get_registration_options(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_passkey(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    attestation: serde_json::Value,
) -> Result<(), String> {
    passkey_mgr
        .register_passkey(&storage, &id, attestation)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "passkey:register",
            "resource": id,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn get_passkey_auth_options(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr
        .get_auth_options(&storage, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn authenticate_passkey(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    assertion: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match passkey_mgr
        .authenticate_passkey(&storage, &id, assertion)
        .await
    {
        Ok(result) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "passkey:authenticate",
                    "resource": id,
                    "success": true
                }),
            )
            .await;
            Ok(result)
        }
        Err(err) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "passkey:authenticate",
                    "resource": id,
                    "success": false,
                    "error": err.to_string()
                }),
            )
            .await;
            Err(err.to_string())
        }
    }
}

#[tauri::command]
pub async fn list_passkeys(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<Vec<serde_json::Value>, String> {
    passkey_mgr
        .list_passkeys(&storage, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_passkey(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    credential_id: String,
) -> Result<(), String> {
    passkey_mgr
        .delete_passkey(&storage, &id, &credential_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "passkey:delete",
            "resource": id,
            "credential_id": credential_id,
        }),
    )
    .await;
    Ok(())
}

// ─── Encryption Settings ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_encryption_settings(
    storage: State<'_, Storage>,
) -> Result<EncryptionConfig, String> {
    match storage.get_encryption_settings().await {
        Ok(config) => Ok(config),
        Err(bc_storage::StorageError::NotFound) => Ok(CryptoManager::default().get_config()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn update_encryption_settings(
    storage: State<'_, Storage>,
    config: EncryptionConfig,
) -> Result<(), String> {
    storage
        .set_encryption_settings(&config)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "encryption:update",
            "resource": "encryption_settings",
            "iterations": config.iterations,
            "key_length": config.key_length,
            "algorithm": config.algorithm,
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn benchmark_encryption(iterations: u32) -> Result<f64, String> {
    let crypto = CryptoManager::default();
    crypto.benchmark(iterations).await.map_err(|e| e.to_string())
}

// ─── Biometric Authentication ───────────────────────────────────────────────

#[tauri::command]
pub fn biometric_status() -> Result<serde_json::Value, String> {
    serde_json::to_value(bc_biometrics::BiometricAuth::status()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_authenticate(reason: String) -> Result<(), String> {
    bc_biometrics::BiometricAuth::authenticate(&reason).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_store_secret(key: String, secret: String) -> Result<(), String> {
    bc_biometrics::BiometricAuth::store_protected_secret(
        bc_biometrics::DEFAULT_SERVICE,
        &key,
        secret.as_bytes(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_get_secret(key: String, reason: String) -> Result<String, String> {
    let data = bc_biometrics::BiometricAuth::get_protected_secret(
        bc_biometrics::DEFAULT_SERVICE,
        &key,
        &reason,
    )
    .map_err(|e| e.to_string())?;
    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_delete_secret(key: String) -> Result<(), String> {
    bc_biometrics::BiometricAuth::delete_protected_secret(bc_biometrics::DEFAULT_SERVICE, &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_has_secret(key: String) -> Result<bool, String> {
    bc_biometrics::BiometricAuth::has_protected_secret(bc_biometrics::DEFAULT_SERVICE, &key)
        .map_err(|e| e.to_string())
}

// ─── Session Management ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_login(
    session: State<'_, SessionManager>,
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    label: String,
) -> Result<serde_json::Value, String> {
    let cred = session
        .login(api_key, email, label)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "session:login",
            "resource": cred.label,
        }),
    )
    .await;
    Ok(serde_json::json!({
        "label": cred.label,
        "email": cred.email,
        "authenticated_at": cred.authenticated_at.to_rfc3339(),
    }))
}

#[tauri::command]
pub async fn session_logout(
    session: State<'_, SessionManager>,
    storage: State<'_, Storage>,
) -> Result<(), String> {
    session.logout().await;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "session:logout",
            "resource": "session",
        }),
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn session_status(
    session: State<'_, SessionManager>,
) -> Result<serde_json::Value, String> {
    let active = session.is_active().await;
    let expired = session.is_expired().await;
    let credential = session.credential().await;
    Ok(serde_json::json!({
        "active": active,
        "expired": expired,
        "label": credential.as_ref().map(|c| c.label.clone()),
        "email": credential.as_ref().and_then(|c| c.email.clone()),
        "authenticated_at": credential.as_ref().map(|c| c.authenticated_at.to_rfc3339()),
        "idle_timeout_secs": session.get_idle_timeout_secs().await,
    }))
}

#[tauri::command]
pub async fn session_touch(
    session: State<'_, SessionManager>,
) -> Result<(), String> {
    session.touch().await;
    Ok(())
}

#[tauri::command]
pub async fn session_set_idle_timeout(
    session: State<'_, SessionManager>,
    secs: u64,
) -> Result<(), String> {
    session.set_idle_timeout(secs).await;
    Ok(())
}
