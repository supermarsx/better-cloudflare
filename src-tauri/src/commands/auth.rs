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

    // ─── Biometric audit surface ────────────────────────────────────────────
    //
    // These exercise the real command bodies with the platform entry point
    // substituted. Calling the genuine `BiometricAuth` functions from a test
    // would touch the OS keychain — and on macOS raise a Touch ID prompt — so
    // the commands take the platform call as a function pointer instead.

    use bc_biometrics::BiometricError;

    /// Stand-in for a released Cloudflare API token. Must never reach the log.
    const TEST_SECRET: &str = "cf-token-do-not-log-3f9a2b";

    fn memory_storage() -> Storage {
        Storage::new(false)
    }

    async fn audit_entries(storage: &Storage) -> Vec<Value> {
        storage
            .get_audit_entries()
            .await
            .expect("audit entries must be readable")
    }

    async fn single_audit_entry(storage: &Storage) -> Value {
        let mut entries = audit_entries(storage).await;
        assert_eq!(entries.len(), 1, "expected exactly one audit entry");
        entries.remove(0)
    }

    /// Every biometric entry must name the operation, carry a timestamp, and
    /// contain nothing derived from the protected secret.
    fn assert_entry_is_clean(entry: &Value, operation: &str, resource: &str) {
        assert_eq!(entry["operation"], operation);
        assert_eq!(entry["resource"], resource);
        assert!(
            entry["timestamp"].is_string(),
            "audit entry must be timestamped: {entry}"
        );
        let serialized = serde_json::to_string(entry).expect("entry must serialize");
        for forbidden in [TEST_SECRET, "do-not-log", "3f9a2b"] {
            assert!(
                !serialized.contains(forbidden),
                "audit entry leaked secret material: {serialized}"
            );
        }
    }

    fn assert_success(entry: &Value) {
        assert_eq!(entry["success"], Value::Bool(true));
        assert_eq!(
            entry.get("error"),
            None,
            "successful entries must not carry an error field"
        );
    }

    fn assert_failure(entry: &Value, expected_error: &str) {
        assert_eq!(entry["success"], Value::Bool(false));
        assert_eq!(entry["error"], expected_error);
    }

    fn fake_authenticate_ok(_reason: &str) -> Result<(), BiometricError> {
        Ok(())
    }

    fn fake_authenticate_cancelled(_reason: &str) -> Result<(), BiometricError> {
        Err(BiometricError::UserCancelled)
    }

    fn fake_store_ok(_service: &str, _account: &str, _secret: &[u8]) -> Result<(), BiometricError> {
        Ok(())
    }

    fn fake_store_refused(
        _service: &str,
        _account: &str,
        _secret: &[u8],
    ) -> Result<(), BiometricError> {
        Err(BiometricError::StoreError(
            "keychain refused the item".into(),
        ))
    }

    fn fake_get_ok(
        _service: &str,
        _account: &str,
        _reason: &str,
    ) -> Result<Vec<u8>, BiometricError> {
        Ok(TEST_SECRET.as_bytes().to_vec())
    }

    fn fake_get_denied(
        _service: &str,
        _account: &str,
        _reason: &str,
    ) -> Result<Vec<u8>, BiometricError> {
        Err(BiometricError::AuthenticationFailed(
            "gesture not recognised".into(),
        ))
    }

    fn fake_get_non_utf8(
        _service: &str,
        _account: &str,
        _reason: &str,
    ) -> Result<Vec<u8>, BiometricError> {
        // A stored blob whose first invalid byte sits at a secret-dependent
        // offset. `FromUtf8Error` would report that offset; we must not.
        Ok(vec![b'c', b'f', 0xff, 0xfe])
    }

    fn fake_delete_ok(_service: &str, _account: &str) -> Result<(), BiometricError> {
        Ok(())
    }

    fn fake_delete_missing(_service: &str, _account: &str) -> Result<(), BiometricError> {
        Err(BiometricError::NotFound)
    }

    #[test]
    fn biometric_audit_operations_are_distinct_and_namespaced() {
        let operations = [
            BIOMETRIC_OP_AUTHENTICATE,
            BIOMETRIC_OP_STORE,
            BIOMETRIC_OP_GET,
            BIOMETRIC_OP_DELETE,
        ];
        for operation in operations {
            assert!(operation.starts_with("biometric:"), "{operation}");
        }
        let unique: std::collections::BTreeSet<_> = operations.iter().collect();
        assert_eq!(unique.len(), operations.len());
    }

    #[tokio::test]
    async fn biometric_authenticate_audits_a_successful_gesture() {
        let storage = memory_storage();
        biometric_authenticate_with(&storage, "Unlock".into(), fake_authenticate_ok)
            .await
            .expect("authentication must succeed");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_AUTHENTICATE, "biometric");
        assert_success(&entry);
    }

    #[tokio::test]
    async fn biometric_authenticate_audits_a_refused_gesture() {
        let storage = memory_storage();
        let error =
            biometric_authenticate_with(&storage, "Unlock".into(), fake_authenticate_cancelled)
                .await
                .expect_err("cancellation must propagate");
        assert_eq!(error, "User cancelled biometric authentication");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_AUTHENTICATE, "biometric");
        assert_failure(&entry, "User cancelled biometric authentication");
    }

    #[tokio::test]
    async fn biometric_store_secret_audits_enrolment_without_the_secret() {
        let storage = memory_storage();
        biometric_store_secret_with(
            &storage,
            "key-1".into(),
            TEST_SECRET.to_string(),
            fake_store_ok,
        )
        .await
        .expect("enrolment must succeed");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_STORE, "com.bettercloudflare.key-1");
        assert_success(&entry);
    }

    #[tokio::test]
    async fn biometric_store_secret_audits_a_failed_enrolment() {
        let storage = memory_storage();
        biometric_store_secret_with(
            &storage,
            "key-1".into(),
            TEST_SECRET.to_string(),
            fake_store_refused,
        )
        .await
        .expect_err("store failure must propagate");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_STORE, "com.bettercloudflare.key-1");
        assert_failure(
            &entry,
            "Keychain/credential store error: keychain refused the item",
        );
    }

    #[tokio::test]
    async fn biometric_get_secret_audits_the_release_without_the_secret() {
        let storage = memory_storage();
        let released =
            biometric_get_secret_with(&storage, "key-1".into(), "Unlock key-1".into(), fake_get_ok)
                .await
                .expect("release must succeed");
        assert_eq!(released, TEST_SECRET, "the caller still receives the token");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_GET, "com.bettercloudflare.key-1");
        assert_success(&entry);
    }

    #[tokio::test]
    async fn biometric_get_secret_audits_a_denied_release() {
        let storage = memory_storage();
        biometric_get_secret_with(
            &storage,
            "key-1".into(),
            "Unlock key-1".into(),
            fake_get_denied,
        )
        .await
        .expect_err("a denied gesture must propagate");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_GET, "com.bettercloudflare.key-1");
        assert_failure(
            &entry,
            "Biometric authentication failed: gesture not recognised",
        );
    }

    #[tokio::test]
    async fn biometric_get_secret_utf8_failure_discloses_no_offset() {
        let storage = memory_storage();
        biometric_get_secret_with(
            &storage,
            "key-1".into(),
            "Unlock key-1".into(),
            fake_get_non_utf8,
        )
        .await
        .expect_err("a non-UTF-8 blob must propagate");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_GET, "com.bettercloudflare.key-1");
        assert_failure(&entry, "Stored biometric secret is not valid UTF-8");
        let serialized = serde_json::to_string(&entry).expect("entry must serialize");
        for forbidden in ["index", "invalid utf-8 sequence"] {
            assert!(
                !serialized.contains(forbidden),
                "audit entry described the stored bytes: {serialized}"
            );
        }
    }

    #[tokio::test]
    async fn biometric_delete_secret_audits_removal() {
        let storage = memory_storage();
        biometric_delete_secret_with(&storage, "key-1".into(), fake_delete_ok)
            .await
            .expect("removal must succeed");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_DELETE, "com.bettercloudflare.key-1");
        assert_success(&entry);
    }

    #[tokio::test]
    async fn biometric_delete_secret_audits_a_failed_removal() {
        let storage = memory_storage();
        biometric_delete_secret_with(&storage, "key-1".into(), fake_delete_missing)
            .await
            .expect_err("a missing record must propagate");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_DELETE, "com.bettercloudflare.key-1");
        assert_failure(&entry, "Secret not found");
    }

    #[tokio::test]
    async fn biometric_rejected_key_is_audited_without_echoing_the_key() {
        let storage = memory_storage();
        let probe = "../../../Login/some-other-app";
        biometric_get_secret_with(&storage, probe.into(), "Unlock".into(), fake_get_ok)
            .await
            .expect_err("an invalid key must be rejected");

        let entry = single_audit_entry(&storage).await;
        assert_entry_is_clean(&entry, BIOMETRIC_OP_GET, "<rejected-key>");
        assert_failure(&entry, "Biometric key contains invalid characters");
        let serialized = serde_json::to_string(&entry).expect("entry must serialize");
        assert!(
            !serialized.contains("some-other-app"),
            "rejected input was echoed into the audit log: {serialized}"
        );
    }

    #[tokio::test]
    async fn biometric_operations_accumulate_in_order() {
        let storage = memory_storage();
        biometric_store_secret_with(
            &storage,
            "key-1".into(),
            TEST_SECRET.to_string(),
            fake_store_ok,
        )
        .await
        .expect("enrolment must succeed");
        biometric_get_secret_with(&storage, "key-1".into(), "Unlock".into(), fake_get_ok)
            .await
            .expect("release must succeed");
        biometric_delete_secret_with(&storage, "key-1".into(), fake_delete_ok)
            .await
            .expect("removal must succeed");

        let entries = audit_entries(&storage).await;
        let operations: Vec<_> = entries
            .iter()
            .map(|entry| entry["operation"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            operations,
            vec![BIOMETRIC_OP_STORE, BIOMETRIC_OP_GET, BIOMETRIC_OP_DELETE]
        );
        for entry in &entries {
            assert_entry_is_clean(
                entry,
                entry["operation"].as_str().unwrap_or_default(),
                "com.bettercloudflare.key-1",
            );
            assert_success(entry);
        }
    }

    // ─── Vault audit surface ────────────────────────────────────────────────
    //
    // `get_vault_secret` is the passkey-gated release path for a decrypted
    // Cloudflare API key. Until the change that added these tests it wrote no
    // audit entry on any branch — not on success, and not on the three refusal
    // branches that are the interesting ones, because reaching them means
    // something called the IPC surface directly.
    //
    // The tests below deliberately assert on the *refusals*, and on what the
    // entries do **not** contain.

    /// Stand-in for a passkey unlock token. Must never reach the log.
    const TEST_TOKEN: &str = "unlock-token-do-not-log-91c4de";

    /// A fail-closed manager: `verify_token` returns `Ok(false)` for every
    /// input, which is the state on `main` today. Every `get_vault_secret` call
    /// therefore takes a refusal branch, which is exactly what needs auditing.
    fn fail_closed_passkeys() -> PasskeyManager {
        PasskeyManager::default()
    }

    fn assert_vault_entry_is_clean(entry: &Value, operation: &str, resource: &str) {
        assert_eq!(entry["operation"], operation);
        assert_eq!(entry["resource"], resource);
        assert!(
            entry["timestamp"].is_string(),
            "audit entry must be timestamped: {entry}"
        );
        let serialized = serde_json::to_string(entry).expect("entry must serialize");
        for forbidden in [TEST_SECRET, TEST_TOKEN, "do-not-log", "3f9a2b", "91c4de"] {
            assert!(
                !serialized.contains(forbidden),
                "audit entry leaked protected material: {serialized}"
            );
        }
    }

    /// The invariant that actually protects the API keys. It has been true
    /// structurally — `verify_token` cannot return `true` — but it was never a
    /// named test, so nothing would fail if that stopped being so by accident.
    #[tokio::test]
    async fn get_vault_secret_refuses_an_attacker_supplied_token_and_audits_it() {
        let storage = memory_storage();
        storage
            .store_vault_secret("key-1", TEST_SECRET)
            .await
            .expect("seed a vault secret");
        // Seeded through `bc_storage` directly, which writes no audit entry —
        // only the command wrappers do — so the log starts empty.

        let error = get_vault_secret_with(
            &storage,
            &fail_closed_passkeys(),
            "key-1".into(),
            Some(TEST_TOKEN.into()),
        )
        .await
        .expect_err("a forged token must not release the secret");
        assert_eq!(error, "Invalid passkey token");

        let entry = single_audit_entry(&storage).await;
        assert_vault_entry_is_clean(&entry, VAULT_OP_GET, "key-1");
        assert_failure(&entry, "Invalid passkey token");
    }

    #[tokio::test]
    async fn get_vault_secret_refuses_a_missing_token_and_audits_it() {
        let storage = memory_storage();
        storage
            .store_vault_secret("key-1", TEST_SECRET)
            .await
            .expect("seed a vault secret");
        // Seeded through `bc_storage` directly, which writes no audit entry —
        // only the command wrappers do — so the log starts empty.

        let error = get_vault_secret_with(&storage, &fail_closed_passkeys(), "key-1".into(), None)
            .await
            .expect_err("a request with no token must be refused");
        assert_eq!(error, "Passkey token required");

        let entry = single_audit_entry(&storage).await;
        assert_vault_entry_is_clean(&entry, VAULT_OP_GET, "key-1");
        assert_failure(&entry, "Passkey token required");
    }

    /// A failure inside storage is audited too, and its message must not carry
    /// anything about the value it failed to read.
    #[tokio::test]
    async fn a_failed_vault_read_is_audited_without_describing_the_secret() {
        let storage = memory_storage();
        let error = get_vault_secret_with(
            &storage,
            &fail_closed_passkeys(),
            "never-stored".into(),
            Some(TEST_TOKEN.into()),
        )
        .await
        .expect_err("an unknown id must fail");
        // The token gate refuses first, so storage is never consulted — which
        // is itself the correct ordering and worth pinning.
        assert_eq!(error, "Invalid passkey token");

        let entry = single_audit_entry(&storage).await;
        assert_vault_entry_is_clean(&entry, VAULT_OP_GET, "never-stored");
        assert_failure(&entry, "Invalid passkey token");
    }

    #[tokio::test]
    async fn vault_writes_and_removals_are_audited_on_both_outcomes() {
        let storage = memory_storage();

        store_vault_secret_with(&storage, "key-1".into(), TEST_SECRET.into())
            .await
            .expect("store must succeed");
        delete_vault_secret_with(&storage, "key-1".into())
            .await
            .expect("delete must succeed");
        // A rejected key is the failure branch, which previously returned early
        // and logged nothing at all — so a caller probing the IPC surface with
        // chunk-addressing ids left no trace.
        let error = store_vault_secret_with(
            &storage,
            "key-1::chunk:0".into(),
            "chunk-addressing-probe".into(),
        )
        .await
        .expect_err("a chunk-addressing id must be rejected");

        let entries = audit_entries(&storage).await;
        let operations: Vec<_> = entries
            .iter()
            .map(|entry| entry["operation"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            operations,
            vec![VAULT_OP_STORE, VAULT_OP_DELETE, VAULT_OP_STORE]
        );

        assert_vault_entry_is_clean(&entries[0], VAULT_OP_STORE, "key-1");
        assert_success(&entries[0]);
        assert_vault_entry_is_clean(&entries[1], VAULT_OP_DELETE, "key-1");
        assert_success(&entries[1]);
        assert_vault_entry_is_clean(&entries[2], VAULT_OP_STORE, "key-1::chunk:0");
        assert_failure(&entries[2], &error);
        assert!(
            !serde_json::to_string(&entries[2])
                .expect("entry must serialize")
                .contains("chunk-addressing-probe"),
            "the rejected value was echoed into the audit log"
        );
    }

    /// The audit helper is generic over the success value and never inspects
    /// it, so a released secret cannot reach an entry even on the success path.
    #[tokio::test]
    async fn a_successful_vault_release_is_audited_without_the_released_value() {
        let storage = memory_storage();
        let released = audited_vault_op(
            &storage,
            VAULT_OP_GET,
            "key-1",
            Ok::<String, String>(TEST_SECRET.to_string()),
        )
        .await
        .expect("the caller still receives the secret");
        assert_eq!(released, TEST_SECRET);

        let entry = single_audit_entry(&storage).await;
        assert_vault_entry_is_clean(&entry, VAULT_OP_GET, "key-1");
        assert_success(&entry);
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
//
// `get_vault_secret` releases a decrypted Cloudflare API key. It is the second
// such release path in the app — `biometric_get_secret` is the first — and
// until now it was the only one that wrote **no audit entry at all**, while its
// own siblings `store_vault_secret` and `delete_vault_secret` did.
//
// That was harmless only for as long as the command could never succeed:
// `bc_passkey::PasskeyManager::verify_token` returns `Ok(false)` unconditionally
// while the passkey gate is shut, so every call failed closed. The moment that
// gate opens, an unaudited plaintext-key release path goes live. The audit is
// added here, in the same change that builds the ceremony layer behind that
// gate, so that it cannot be forgotten at the moment it starts mattering.
//
// Naming, decided deliberately rather than by accident: the operation names
// keep the existing `vault:` prefix (`vault:store`, `vault:delete`, and now
// `vault:get`), and the *field shape* is the newer one PR #160 established for
// the biometric commands — `success` on every entry, `error` on failures only.
// `vault:store` and `vault:delete` are brought onto that shape too, and now
// record their failures as well as their successes; they previously returned
// early on error and logged nothing, so a failed vault write left no trace.
//
// Nothing derived from the secret or the passkey token may appear in an entry.
// The only variable-length input is a `StorageError` rendering; a test asserts
// that neither the secret nor the token reaches the log on any branch.

const VAULT_OP_STORE: &str = "vault:store";
const VAULT_OP_GET: &str = "vault:get";
const VAULT_OP_DELETE: &str = "vault:delete";

/// Build the audit entry for one vault operation.
///
/// The secret is not a parameter and cannot become one: the callers pass only
/// the resource id and an error rendering, and the released value never enters
/// this function.
fn vault_audit_entry(operation: &str, resource: &str, error: Option<&str>) -> serde_json::Value {
    match error {
        None => serde_json::json!({
            "operation": operation,
            "resource": resource,
            "success": true,
        }),
        Some(error) => serde_json::json!({
            "operation": operation,
            "resource": resource,
            "success": false,
            "error": error,
        }),
    }
}

/// Record the outcome of a vault operation, then hand the result back
/// unchanged.
///
/// Generic over the success value and never inspecting it, so no caller can
/// route a released secret into the log by accident.
async fn audited_vault_op<T>(
    storage: &Storage,
    operation: &str,
    resource: &str,
    result: Result<T, String>,
) -> Result<T, String> {
    log_audit(
        storage,
        vault_audit_entry(
            operation,
            resource,
            result.as_ref().err().map(String::as_str),
        ),
    )
    .await;
    result
}

#[tauri::command]
pub async fn store_vault_secret(
    storage: State<'_, Storage>,
    id: String,
    secret: String,
) -> Result<(), String> {
    store_vault_secret_with(&storage, id, secret).await
}

async fn store_vault_secret_with(
    storage: &Storage,
    id: String,
    secret: String,
) -> Result<(), String> {
    let result = storage
        .store_vault_secret(&id, &secret)
        .await
        .map_err(|e| e.to_string());
    audited_vault_op(storage, VAULT_OP_STORE, &id, result).await
}

#[tauri::command]
pub async fn get_vault_secret(
    storage: State<'_, Storage>,
    passkey_mgr: State<'_, PasskeyManager>,
    id: String,
    token: Option<String>,
) -> Result<String, String> {
    get_vault_secret_with(&storage, &passkey_mgr, id, token).await
}

/// The body of [`get_vault_secret`], taking plain references so it is callable
/// from tests without a Tauri runtime.
async fn get_vault_secret_with(
    storage: &Storage,
    passkey_mgr: &PasskeyManager,
    id: String,
    token: Option<String>,
) -> Result<String, String> {
    let result = release_vault_secret(storage, passkey_mgr, &id, token).await;
    audited_vault_op(storage, VAULT_OP_GET, &id, result).await
}

/// Every rejection branch here is audited by the caller. The refusals are the
/// interesting entries: reaching them at all means something called the IPC
/// surface directly, since the UI only asks for a secret with a token it has
/// just been handed.
async fn release_vault_secret(
    storage: &Storage,
    passkey_mgr: &PasskeyManager,
    id: &str,
    token: Option<String>,
) -> Result<String, String> {
    let token = token.ok_or("Passkey token required")?;
    // `consume = true`: the token is spent by this check, so a rejection here
    // has already burned it.
    let ok = passkey_mgr
        .verify_token(id, &token, true)
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err("Invalid passkey token".to_string());
    }
    storage
        .get_vault_secret(id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_vault_secret(storage: State<'_, Storage>, id: String) -> Result<(), String> {
    delete_vault_secret_with(&storage, id).await
}

async fn delete_vault_secret_with(storage: &Storage, id: String) -> Result<(), String> {
    let result = storage
        .delete_vault_secret(&id)
        .await
        .map_err(|e| e.to_string());
    audited_vault_op(storage, VAULT_OP_DELETE, &id, result).await
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

// ─── Biometric audit surface ────────────────────────────────────────────────
//
// Biometric unlock is a *parallel credential path*: a successful gesture
// releases the plaintext Cloudflare API token without the vault password, by
// design (the OS keychain ACL is the access control). The three operations
// that create, use, or destroy that path — and the bare gesture prompt — are
// therefore audited exactly like `session_login` and `auth:decrypt_api_key`.
//
// `biometric_status` and `biometric_has_secret` are deliberately *not* audited:
// neither prompts, releases, or mutates anything, and both are polled on every
// render of the login screen. Auditing them would evict real security events
// from `bc_storage`'s `MAX_AUDIT_ENTRIES`-capped ring buffer, which would make
// the audit log worse, not better.

const BIOMETRIC_OP_AUTHENTICATE: &str = "biometric:authenticate";
const BIOMETRIC_OP_STORE: &str = "biometric:store_secret";
const BIOMETRIC_OP_GET: &str = "biometric:get_secret";
const BIOMETRIC_OP_DELETE: &str = "biometric:delete_secret";

/// Resource recorded for a gesture that names no stored key.
const BIOMETRIC_RESOURCE_DEVICE: &str = "biometric";

/// Resource recorded when the requested key failed [`sanitize_biometric_key`].
///
/// The raw key is rejected, attacker-controlled, unbounded input, so it is not
/// echoed into the audit log; the rejection reason is recorded instead.
const BIOMETRIC_RESOURCE_REJECTED: &str = "<rejected-key>";

/// Platform entry points, taken as function pointers so tests can substitute
/// them. The commands always pass the real [`bc_biometrics::BiometricAuth`]
/// functions; nothing else in the process may.
type BiometricAuthenticateFn = fn(&str) -> Result<(), bc_biometrics::BiometricError>;
type BiometricStoreFn = fn(&str, &str, &[u8]) -> Result<(), bc_biometrics::BiometricError>;
type BiometricGetFn = fn(&str, &str, &str) -> Result<Vec<u8>, bc_biometrics::BiometricError>;
type BiometricDeleteFn = fn(&str, &str) -> Result<(), bc_biometrics::BiometricError>;

/// Build the audit entry for one biometric operation.
///
/// The only variable-length input is `error`, which is always a
/// [`bc_biometrics::BiometricError`] rendering — an OS status description, never
/// key material. The secret is not a parameter and cannot become one:
/// [`audited_biometric_op`] is generic over the success value `T` and never
/// inspects it, so no caller can route a released token here by accident.
fn biometric_audit_entry(
    operation: &str,
    resource: &str,
    error: Option<&str>,
) -> serde_json::Value {
    match error {
        None => serde_json::json!({
            "operation": operation,
            "resource": resource,
            "success": true,
        }),
        Some(error) => serde_json::json!({
            "operation": operation,
            "resource": resource,
            "success": false,
            "error": error,
        }),
    }
}

/// Run a blocking biometric platform call and record its outcome.
///
/// Successes *and* failures are logged: a refused gesture is the more
/// interesting of the two, and probing the IPC surface should leave a trail.
/// The call is moved onto the blocking pool because it can sit on an OS
/// biometric prompt for as long as the user takes to respond.
async fn audited_biometric_op<T, F>(
    storage: &Storage,
    operation: &str,
    resource: String,
    job: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let result = match tauri::async_runtime::spawn_blocking(job).await {
        Ok(result) => result,
        Err(err) => Err(format!("Biometric worker failed: {err}")),
    };
    log_audit(
        storage,
        biometric_audit_entry(
            operation,
            &resource,
            result.as_ref().err().map(String::as_str),
        ),
    )
    .await;
    result
}

/// Sanitize the requested key, then run and audit a keyed biometric operation.
///
/// A key rejected by [`sanitize_biometric_key`] never reaches the keychain, but
/// the attempt is still recorded — that path is only reachable from a caller
/// crafting its own IPC request.
async fn audited_biometric_key_op<T, F>(
    storage: &Storage,
    operation: &str,
    key: &str,
    job: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(String) -> Result<T, String> + Send + 'static,
{
    let safe_key = match sanitize_biometric_key(key) {
        Ok(safe_key) => safe_key,
        Err(err) => {
            log_audit(
                storage,
                biometric_audit_entry(operation, BIOMETRIC_RESOURCE_REJECTED, Some(&err)),
            )
            .await;
            return Err(err);
        }
    };
    let account = safe_key.clone();
    audited_biometric_op(storage, operation, safe_key, move || job(account)).await
}

#[tauri::command]
pub fn biometric_status() -> Result<serde_json::Value, String> {
    serde_json::to_value(bc_biometrics::BiometricAuth::status()).map_err(|e| e.to_string())
}

async fn biometric_authenticate_with(
    storage: &Storage,
    reason: String,
    authenticate: BiometricAuthenticateFn,
) -> Result<(), String> {
    audited_biometric_op(
        storage,
        BIOMETRIC_OP_AUTHENTICATE,
        BIOMETRIC_RESOURCE_DEVICE.to_string(),
        move || authenticate(&reason).map_err(|e| e.to_string()),
    )
    .await
}

#[tauri::command]
pub async fn biometric_authenticate(
    storage: State<'_, Storage>,
    reason: String,
) -> Result<(), String> {
    biometric_authenticate_with(&storage, reason, bc_biometrics::BiometricAuth::authenticate).await
}

async fn biometric_store_secret_with(
    storage: &Storage,
    key: String,
    secret: String,
    store: BiometricStoreFn,
) -> Result<(), String> {
    audited_biometric_key_op(storage, BIOMETRIC_OP_STORE, &key, move |account| {
        store(bc_biometrics::DEFAULT_SERVICE, &account, secret.as_bytes())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn biometric_store_secret(
    storage: State<'_, Storage>,
    key: String,
    secret: String,
) -> Result<(), String> {
    biometric_store_secret_with(
        &storage,
        key,
        secret,
        bc_biometrics::BiometricAuth::store_protected_secret,
    )
    .await
}

async fn biometric_get_secret_with(
    storage: &Storage,
    key: String,
    reason: String,
    get: BiometricGetFn,
) -> Result<String, String> {
    audited_biometric_key_op(storage, BIOMETRIC_OP_GET, &key, move |account| {
        let data =
            get(bc_biometrics::DEFAULT_SERVICE, &account, &reason).map_err(|e| e.to_string())?;
        // Deliberately not `e.to_string()`: `FromUtf8Error` reports the byte
        // offset and length of the offending sequence, which is a (small)
        // disclosure about the stored secret, and this string is now audited.
        String::from_utf8(data)
            .map_err(|_| "Stored biometric secret is not valid UTF-8".to_string())
    })
    .await
}

#[tauri::command]
pub async fn biometric_get_secret(
    storage: State<'_, Storage>,
    key: String,
    reason: String,
) -> Result<String, String> {
    biometric_get_secret_with(
        &storage,
        key,
        reason,
        bc_biometrics::BiometricAuth::get_protected_secret,
    )
    .await
}

async fn biometric_delete_secret_with(
    storage: &Storage,
    key: String,
    delete: BiometricDeleteFn,
) -> Result<(), String> {
    audited_biometric_key_op(storage, BIOMETRIC_OP_DELETE, &key, move |account| {
        delete(bc_biometrics::DEFAULT_SERVICE, &account).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn biometric_delete_secret(
    storage: State<'_, Storage>,
    key: String,
) -> Result<(), String> {
    biometric_delete_secret_with(
        &storage,
        key,
        bc_biometrics::BiometricAuth::delete_protected_secret,
    )
    .await
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
