use std::sync::{Arc, OnceLock};

use tauri::State;
use tokio::sync::Semaphore;

use crate::cloudflare_api::CloudflareClient;
use crate::crypto::{CryptoManager, EncryptionConfig};
use crate::passkey::PasskeyManager;
use crate::session::SessionManager;
use crate::storage::{ApiKey, Storage};
use bc_cloudflare_api::{CloudflareError, VerificationErrorSource, VerificationFailureKind};
use bc_error::{AppError, ProviderErrorDetail, RequestErrorSource, RequestFailureKind};

use super::log_audit;

// ─── Authentication & Key Management ────────────────────────────────────────

const MAX_CONCURRENT_CRYPTO_JOBS: usize = 2;

fn crypto_job_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_CRYPTO_JOBS)))
}

async fn run_crypto_job<T, F>(job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit = crypto_job_semaphore()
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Encryption is busy; wait for the active operation to finish.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        job()
    })
    .await
    .map_err(|e| format!("Encryption worker failed: {e}"))?
}

#[tauri::command]
pub async fn verify_token(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
) -> Result<bool, AppError> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    match client.verify_token().await {
        Ok(true) => {
            log_audit(
                &storage,
                serde_json::json!({
                    "operation": "auth:verify_token",
                    "resource": "api_token",
                    "success": true
                }),
            )
            .await;
            Ok(true)
        }
        Ok(false) => {
            let error = AppError::auth_request_failed(
                RequestFailureKind::MalformedResponse,
                "Token verification returned an invalid result.",
                None,
                RequestErrorSource::Client,
                "auth:verify_token",
                true,
                vec![],
                None,
                "Retry the request. If it continues, restart the application.",
                None,
            );
            log_auth_failure(&storage, &error).await;
            Err(error)
        }
        Err(error) => {
            let error = map_verification_error(error);
            log_auth_failure(&storage, &error).await;
            Err(error)
        }
    }
}

async fn log_auth_failure(storage: &Storage, error: &AppError) {
    let (code, status, request_id) = match error {
        AppError::AuthRequestFailed {
            status, request_id, ..
        } => (error.code(), *status, request_id.as_deref()),
        _ => (error.code(), None, None),
    };
    log_audit(
        storage,
        serde_json::json!({
            "operation": "auth:verify_token",
            "resource": "api_token",
            "success": false,
            "error_code": code,
            "status": status,
            "request_id": request_id,
        }),
    )
    .await;
}

fn request_failure_kind(kind: VerificationFailureKind) -> RequestFailureKind {
    match kind {
        VerificationFailureKind::Authentication => RequestFailureKind::Authentication,
        VerificationFailureKind::RateLimited => RequestFailureKind::RateLimited,
        VerificationFailureKind::Provider => RequestFailureKind::Provider,
        VerificationFailureKind::Network => RequestFailureKind::Network,
        VerificationFailureKind::Timeout => RequestFailureKind::Timeout,
        VerificationFailureKind::MalformedResponse => RequestFailureKind::MalformedResponse,
    }
}

fn request_error_source(source: VerificationErrorSource) -> RequestErrorSource {
    match source {
        VerificationErrorSource::Network => RequestErrorSource::Network,
        VerificationErrorSource::Cloudflare => RequestErrorSource::Cloudflare,
    }
}

fn auth_request_text(kind: VerificationFailureKind) -> (&'static str, &'static str) {
    match kind {
        VerificationFailureKind::Authentication => (
            "Cloudflare rejected token verification.",
            "Check the saved credentials and token permissions before trying again.",
        ),
        VerificationFailureKind::RateLimited => (
            "Cloudflare rate-limited token verification.",
            "Wait for the retry interval before verifying the token again.",
        ),
        VerificationFailureKind::Provider => (
            "Cloudflare could not complete token verification.",
            "Retry shortly and check Cloudflare service status if the failure continues.",
        ),
        VerificationFailureKind::Network => (
            "Token verification failed because of a network error.",
            "Check network, VPN, and proxy connectivity before trying again.",
        ),
        VerificationFailureKind::Timeout => (
            "Token verification timed out.",
            "Retry when network and Cloudflare connectivity are stable.",
        ),
        VerificationFailureKind::MalformedResponse => (
            "Cloudflare returned a malformed token verification response.",
            "Retry once and check Cloudflare service status if the response remains invalid.",
        ),
    }
}

fn map_structured_auth_request(context: bc_cloudflare_api::CloudflareRequestError) -> AppError {
    let (message, remediation) = auth_request_text(context.kind);
    AppError::auth_request_failed(
        request_failure_kind(context.kind),
        message,
        context.status,
        request_error_source(context.source),
        "auth:verify_token",
        context.retryable,
        context
            .provider_errors
            .into_iter()
            .map(|detail| ProviderErrorDetail {
                code: detail.code,
                message: detail.message,
            })
            .collect(),
        context.retry_after_secs,
        remediation,
        context.request_id,
    )
}

fn resource_limit_kind_name(kind: bc_cloudflare_api::ResourceLimitKind) -> &'static str {
    match kind {
        bc_cloudflare_api::ResourceLimitKind::ContentLength => "content_length",
        bc_cloudflare_api::ResourceLimitKind::StreamedBody => "streamed_body",
        bc_cloudflare_api::ResourceLimitKind::Collection => "collection",
        bc_cloudflare_api::ResourceLimitKind::Allocation => "allocation",
    }
}

fn resource_limit_details(
    limit: &bc_cloudflare_api::ResourceLimitError,
) -> Vec<ProviderErrorDetail> {
    let mut details = vec![
        ProviderErrorDetail {
            code: Some("resource_limit_kind".to_string()),
            message: resource_limit_kind_name(limit.kind).to_string(),
        },
        ProviderErrorDetail {
            code: Some("resource".to_string()),
            message: limit.resource.to_string(),
        },
        ProviderErrorDetail {
            code: Some("limit".to_string()),
            message: limit.limit.to_string(),
        },
    ];
    if let Some(actual) = limit.actual {
        details.push(ProviderErrorDetail {
            code: Some("actual".to_string()),
            message: actual.to_string(),
        });
    }
    details
}

fn map_structured_auth_resource_limit(
    context: bc_cloudflare_api::CloudflareResourceLimitContext,
) -> AppError {
    let provider_errors = resource_limit_details(&context.limit);
    AppError::auth_request_failed(
        RequestFailureKind::MalformedResponse,
        "Cloudflare token verification response exceeded a local safety limit.",
        context.status,
        request_error_source(context.source),
        "auth:verify_token",
        context.retryable,
        provider_errors,
        None,
        "Retry token verification once. If it persists, restart or update the application and check Cloudflare service status.",
        context.request_id,
    )
}

fn map_legacy_auth_resource_limit(limit: bc_cloudflare_api::ResourceLimitError) -> AppError {
    AppError::auth_request_failed(
        RequestFailureKind::MalformedResponse,
        "Cloudflare token verification response exceeded a local safety limit.",
        None,
        RequestErrorSource::Cloudflare,
        "auth:verify_token",
        false,
        resource_limit_details(&limit),
        None,
        "Retry token verification once. If it persists, restart or update the application and check Cloudflare service status.",
        None,
    )
}

fn map_verification_error(error: CloudflareError) -> AppError {
    match error {
        CloudflareError::Verification(context) => {
            let kind = match context.kind {
                VerificationFailureKind::Authentication => RequestFailureKind::Authentication,
                VerificationFailureKind::RateLimited => RequestFailureKind::RateLimited,
                VerificationFailureKind::Provider => RequestFailureKind::Provider,
                VerificationFailureKind::Network => RequestFailureKind::Network,
                VerificationFailureKind::Timeout => RequestFailureKind::Timeout,
                VerificationFailureKind::MalformedResponse => RequestFailureKind::MalformedResponse,
            };
            let source = match context.source {
                VerificationErrorSource::Network => RequestErrorSource::Network,
                VerificationErrorSource::Cloudflare => RequestErrorSource::Cloudflare,
            };
            AppError::auth_request_failed(
                kind,
                context.message,
                context.status,
                source,
                context.operation,
                context.retryable,
                context
                    .provider_errors
                    .into_iter()
                    .map(|detail| ProviderErrorDetail {
                        code: detail.code,
                        message: detail.message,
                    })
                    .collect(),
                context.retry_after_secs,
                context.remediation,
                context.request_id,
            )
        }
        CloudflareError::Request(context) => map_structured_auth_request(*context),
        CloudflareError::ResourceLimit(context) => map_structured_auth_resource_limit(*context),
        CloudflareError::Validation(_) => AppError::validation_with_issues(
            "Token verification request parameters failed local validation.",
            ["The token verification request parameters are not valid."],
        ),
        CloudflareError::AuthFailed => AppError::auth_request_failed(
            RequestFailureKind::Authentication,
            "Cloudflare rejected the supplied credentials.",
            None,
            RequestErrorSource::Cloudflare,
            "auth:verify_token",
            false,
            vec![],
            None,
            "Check the API token or global API key, account email, and permissions.",
            None,
        ),
        CloudflareError::RateLimited(_) => AppError::auth_request_failed(
            RequestFailureKind::RateLimited,
            "Cloudflare rate-limited token verification.",
            Some(429),
            RequestErrorSource::Cloudflare,
            "auth:verify_token",
            true,
            vec![],
            None,
            "Wait before trying again.",
            None,
        ),
        CloudflareError::HttpError(bc_cloudflare_api::CloudflareHttpError::ResourceLimit(
            limit,
        )) => map_legacy_auth_resource_limit(limit),
        CloudflareError::HttpError(bc_cloudflare_api::CloudflareHttpError::Transport(_))
        | CloudflareError::ApiError(_) => AppError::auth_request_failed(
            RequestFailureKind::Provider,
            "Cloudflare could not complete token verification.",
            None,
            RequestErrorSource::Cloudflare,
            "auth:verify_token",
            true,
            vec![],
            None,
            "Retry shortly and check Cloudflare service status if the failure continues.",
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn serialize_mapped_error(error: CloudflareError) -> (String, Value) {
        let serialized: String = map_verification_error(error).into();
        let value = serde_json::from_str(&serialized).expect("AppError must serialize as JSON");
        (serialized, value)
    }

    #[test]
    fn structured_request_preserves_safe_auth_context_and_suppresses_dns_text() {
        let error = CloudflareError::Request(Box::new(bc_cloudflare_api::CloudflareRequestError {
            kind: VerificationFailureKind::Authentication,
            message: "https://proxy.internal/zones/zone-secret/dns_records?api_token=token-secret"
                .to_string(),
            status: Some(403),
            source: VerificationErrorSource::Cloudflare,
            operation: "dns:list".to_string(),
            retryable: false,
            provider_errors: vec![bc_cloudflare_api::CloudflareProviderError {
                code: Some("10000".to_string()),
                message: "Cloudflare reported an authorization error.".to_string(),
            }],
            retry_after_secs: Some(12),
            remediation: "Retry DNS access with token-secret.".to_string(),
            request_id: Some("safe-ray-id".to_string()),
        }));

        let (serialized, value) = serialize_mapped_error(error);

        assert_eq!(value["kind"], "authentication");
        assert_eq!(value["status"], 403);
        assert_eq!(value["source"], "cloudflare");
        assert_eq!(value["operation"], "auth:verify_token");
        assert_eq!(value["retryable"], false);
        assert_eq!(value["retry_after"], "12");
        assert_eq!(value["request_id"], "safe-ray-id");
        assert_eq!(value["details"]["provider_errors"][0]["code"], "10000");
        for forbidden in [
            "proxy.internal",
            "zone-secret",
            "token-secret",
            "dns:list",
            "dns_records",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn structured_resource_limit_preserves_only_safe_numeric_context() {
        let error = CloudflareError::ResourceLimit(Box::new(
            bc_cloudflare_api::CloudflareResourceLimitContext {
                limit: bc_cloudflare_api::ResourceLimitError {
                    resource: "Cloudflare HTTP response body",
                    limit: 1024,
                    actual: Some(2048),
                    kind: bc_cloudflare_api::ResourceLimitKind::ContentLength,
                },
                status: Some(200),
                source: VerificationErrorSource::Cloudflare,
                operation: "dns:list".to_string(),
                retryable: false,
                message: "zone-secret token-secret".to_string(),
                remediation: "https://proxy.internal/dns_records".to_string(),
                request_id: Some("safe-ray-id".to_string()),
            },
        ));

        let (serialized, value) = serialize_mapped_error(error);

        assert_eq!(value["kind"], "malformed_response");
        assert_eq!(value["status"], 200);
        assert_eq!(value["operation"], "auth:verify_token");
        assert_eq!(value["request_id"], "safe-ray-id");
        let details = value["details"]["provider_errors"]
            .as_array()
            .expect("resource details must be an array");
        for (code, message) in [
            ("resource_limit_kind", "content_length"),
            ("resource", "Cloudflare HTTP response body"),
            ("limit", "1024"),
            ("actual", "2048"),
        ] {
            assert!(details
                .iter()
                .any(|detail| detail["code"] == code && detail["message"] == message));
        }
        for forbidden in [
            "zone-secret",
            "token-secret",
            "proxy.internal",
            "dns:list",
            "dns_records",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn validation_uses_fixed_auth_text_without_native_dns_context() {
        let error =
            CloudflareError::Validation(Box::new(bc_cloudflare_api::CloudflareValidationError {
                field: "zone-secret".to_string(),
                limit: 100,
                actual: Some(101),
                operation: "dns:list".to_string(),
                message: "token-secret".to_string(),
                remediation: "https://proxy.internal/dns_records".to_string(),
            }));

        let (serialized, value) = serialize_mapped_error(error);

        assert_eq!(value["code"], "VALIDATION");
        assert_eq!(
            value["message"],
            "Token verification request parameters failed local validation."
        );
        for forbidden in [
            "zone-secret",
            "token-secret",
            "proxy.internal",
            "dns:list",
            "dns_records",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn legacy_resource_limit_maps_to_malformed_auth_response() {
        let error =
            CloudflareError::HttpError(bc_cloudflare_api::CloudflareHttpError::ResourceLimit(
                bc_cloudflare_api::ResourceLimitError {
                    resource: "Cloudflare HTTP response body",
                    limit: 1024,
                    actual: None,
                    kind: bc_cloudflare_api::ResourceLimitKind::StreamedBody,
                },
            ));

        let (_, value) = serialize_mapped_error(error);

        assert_eq!(value["kind"], "malformed_response");
        assert_eq!(value["status"], Value::Null);
        assert_eq!(value["source"], "cloudflare");
        assert_eq!(value["operation"], "auth:verify_token");
        assert_eq!(value["retryable"], false);
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
    let config = config
        .validated_for_encryption()
        .map_err(|e| e.to_string())?;
    let encryption_config = config.clone();
    let encrypted = run_crypto_job(move || {
        let crypto =
            CryptoManager::new_for_encryption(encryption_config).map_err(|e| e.to_string())?;
        crypto
            .encrypt(&api_key, &password)
            .map_err(|e| e.to_string())
    })
    .await?;

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
        let existing_config = EncryptionConfig {
            iterations: existing.iterations,
            key_length: existing.key_length,
            algorithm: existing.algorithm.clone(),
        };
        let existing_ciphertext = existing.encrypted_key.clone();
        let decrypted = run_crypto_job(move || {
            let crypto = CryptoManager::new(existing_config).map_err(|e| e.to_string())?;
            crypto
                .decrypt(&existing_ciphertext, &current_password)
                .map_err(|e| e.to_string())
        })
        .await?;
        let updated_config = match storage.get_encryption_settings().await {
            Ok(config) => config,
            Err(bc_storage::StorageError::NotFound) => CryptoManager::default().get_config(),
            Err(e) => return Err(e.to_string()),
        }
        .validated_for_encryption()
        .map_err(|e| e.to_string())?;
        let encryption_config = updated_config.clone();
        encrypted_key = Some(
            run_crypto_job(move || {
                let updated_crypto = CryptoManager::new_for_encryption(encryption_config)
                    .map_err(|e| e.to_string())?;
                updated_crypto
                    .encrypt(&decrypted, &new_password)
                    .map_err(|e| e.to_string())
            })
            .await?,
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
    let config = EncryptionConfig {
        iterations: encrypted.iterations,
        key_length: encrypted.key_length,
        algorithm: encrypted.algorithm,
    };
    let ciphertext = encrypted.encrypted_key;
    let result = run_crypto_job(move || {
        let crypto = CryptoManager::new(config).map_err(|e| e.to_string())?;
        crypto
            .decrypt(&ciphertext, &password)
            .map_err(|e| e.to_string())
    })
    .await;
    match result {
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
pub fn get_passkey_status(passkey_mgr: State<'_, PasskeyManager>) -> bc_passkey::PasskeyStatus {
    passkey_mgr.status()
}

#[tauri::command]
pub async fn get_passkey_registration_options(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
) -> Result<serde_json::Value, String> {
    passkey_mgr
        .get_registration_options(&storage, &id)
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
        Ok(config) => CryptoManager::new(config)
            .map(|crypto| crypto.get_config())
            .map_err(|e| e.to_string()),
        Err(bc_storage::StorageError::NotFound) => Ok(CryptoManager::default().get_config()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn update_encryption_settings(
    storage: State<'_, Storage>,
    config: EncryptionConfig,
) -> Result<(), String> {
    let config = config
        .validated_for_encryption()
        .map_err(|e| e.to_string())?;
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
    bc_crypto::validate_benchmark_iterations(iterations).map_err(|e| e.to_string())?;
    run_crypto_job(move || {
        CryptoManager::default()
            .benchmark(iterations)
            .map_err(|e| e.to_string())
    })
    .await
}

// ─── Biometric Authentication ───────────────────────────────────────────────

/// Namespace prefix for all biometric keychain entries to prevent
/// arbitrary keychain access via crafted key names from the frontend.
const BIOMETRIC_KEY_PREFIX: &str = "com.bettercloudflare.";

/// Validate and namespace a biometric key. Rejects empty keys and keys
/// containing path separators or other dangerous characters.
fn sanitize_biometric_key(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("Biometric key must not be empty".to_string());
    }
    // Only allow alphanumeric, dash, underscore, and dot
    if !trimmed
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("Biometric key contains invalid characters".to_string());
    }
    // Prevent keys that already have the prefix (double-prefixing)
    if trimmed.starts_with(BIOMETRIC_KEY_PREFIX) {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{}{}", BIOMETRIC_KEY_PREFIX, trimmed))
    }
}

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
    let safe_key = sanitize_biometric_key(&key)?;
    bc_biometrics::BiometricAuth::store_protected_secret(
        bc_biometrics::DEFAULT_SERVICE,
        &safe_key,
        secret.as_bytes(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_get_secret(key: String, reason: String) -> Result<String, String> {
    let safe_key = sanitize_biometric_key(&key)?;
    let data = bc_biometrics::BiometricAuth::get_protected_secret(
        bc_biometrics::DEFAULT_SERVICE,
        &safe_key,
        &reason,
    )
    .map_err(|e| e.to_string())?;
    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_delete_secret(key: String) -> Result<(), String> {
    let safe_key = sanitize_biometric_key(&key)?;
    bc_biometrics::BiometricAuth::delete_protected_secret(bc_biometrics::DEFAULT_SERVICE, &safe_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn biometric_has_secret(key: String) -> Result<bool, String> {
    let safe_key = sanitize_biometric_key(&key)?;
    bc_biometrics::BiometricAuth::has_protected_secret(bc_biometrics::DEFAULT_SERVICE, &safe_key)
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
pub async fn session_touch(session: State<'_, SessionManager>) -> Result<(), String> {
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
