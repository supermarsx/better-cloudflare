use tauri::State;

use bc_cloudflare_api::{
    CloudflareError, CloudflareHttpError, CloudflareProviderError, CloudflareRequestError,
    CloudflareResourceLimitContext, CloudflareTransportCategory, CloudflareValidationError,
    ResourceLimitError, ResourceLimitKind, VerificationErrorSource, VerificationFailureKind,
    DNS_LIST_OPERATION,
};
use bc_error::{AppError, ProviderErrorDetail, RequestErrorSource, RequestFailureKind};

use crate::cloudflare_api::{CloudflareClient, DNSRecord, DNSRecordInput, Zone};
use crate::storage::Storage;

use super::log_audit;
use crate::notifications::NotificationManager;

const MAX_NATIVE_EXPORT_PAGE: u32 = 10_000;
const MAX_NATIVE_EXPORT_PER_PAGE: u32 = 500;

fn transport_category_name(category: CloudflareTransportCategory) -> &'static str {
    match category {
        CloudflareTransportCategory::Dns => "dns",
        CloudflareTransportCategory::Timeout => "timeout",
        CloudflareTransportCategory::Connect => "connect",
        CloudflareTransportCategory::Other => "other",
    }
}

fn request_failure_kind(kind: &VerificationFailureKind) -> RequestFailureKind {
    match kind {
        VerificationFailureKind::Authentication => RequestFailureKind::Authentication,
        VerificationFailureKind::RateLimited => RequestFailureKind::RateLimited,
        VerificationFailureKind::Provider => RequestFailureKind::Provider,
        VerificationFailureKind::Network => RequestFailureKind::Network,
        VerificationFailureKind::Timeout => RequestFailureKind::Timeout,
        VerificationFailureKind::MalformedResponse => RequestFailureKind::MalformedResponse,
    }
}

fn request_error_source(source: &VerificationErrorSource) -> RequestErrorSource {
    match source {
        VerificationErrorSource::Network => RequestErrorSource::Network,
        VerificationErrorSource::Cloudflare => RequestErrorSource::Cloudflare,
    }
}

fn provider_error_details(errors: Vec<CloudflareProviderError>) -> Vec<ProviderErrorDetail> {
    errors
        .into_iter()
        .map(|error| ProviderErrorDetail {
            code: error.code,
            message: error.message,
        })
        .collect()
}

fn resource_limit_kind_name(kind: &ResourceLimitKind) -> &'static str {
    match kind {
        ResourceLimitKind::ContentLength => "content_length",
        ResourceLimitKind::StreamedBody => "streamed_body",
        ResourceLimitKind::Collection => "collection",
        ResourceLimitKind::Allocation => "allocation",
    }
}

fn resource_limit_details(limit: &ResourceLimitError) -> Vec<ProviderErrorDetail> {
    let mut details = vec![
        ProviderErrorDetail {
            code: Some("resource".to_string()),
            message: limit.resource.to_string(),
        },
        ProviderErrorDetail {
            code: Some("limit_kind".to_string()),
            message: resource_limit_kind_name(&limit.kind).to_string(),
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

fn validation_error_details(error: &CloudflareValidationError) -> Vec<ProviderErrorDetail> {
    let mut details = vec![
        ProviderErrorDetail {
            code: Some("field".to_string()),
            message: error.field.clone(),
        },
        ProviderErrorDetail {
            code: Some("limit".to_string()),
            message: error.limit.to_string(),
        },
    ];
    if let Some(actual) = error.actual {
        details.push(ProviderErrorDetail {
            code: Some("actual".to_string()),
            message: actual.to_string(),
        });
    }
    details
}

fn map_structured_request_error(error: CloudflareRequestError) -> AppError {
    let is_authentication = matches!(&error.kind, VerificationFailureKind::Authentication)
        || matches!(error.status, Some(401 | 403));
    let kind = request_failure_kind(&error.kind);
    let source = request_error_source(&error.source);
    let provider_errors = provider_error_details(error.provider_errors);

    if is_authentication {
        AppError::auth_request_failed(
            RequestFailureKind::Authentication,
            error.message,
            error.status,
            source,
            error.operation,
            error.retryable,
            provider_errors,
            error.retry_after_secs,
            error.remediation,
            error.request_id,
        )
    } else {
        AppError::request_failed(
            kind,
            error.message,
            error.status,
            source,
            error.operation,
            error.retryable,
            provider_errors,
            error.retry_after_secs,
            error.remediation,
            error.request_id,
        )
    }
}

fn map_resource_limit_context(context: CloudflareResourceLimitContext) -> AppError {
    AppError::request_failed(
        RequestFailureKind::Provider,
        context.message,
        context.status,
        request_error_source(&context.source),
        context.operation,
        context.retryable,
        resource_limit_details(&context.limit),
        None,
        context.remediation,
        context.request_id,
    )
}

fn map_validation_error(error: CloudflareValidationError) -> AppError {
    let details = validation_error_details(&error);
    AppError::request_failed(
        RequestFailureKind::Provider,
        error.message,
        None,
        RequestErrorSource::Client,
        error.operation,
        false,
        details,
        None,
        error.remediation,
        None,
    )
}

fn map_legacy_resource_limit(limit: ResourceLimitError) -> AppError {
    AppError::request_failed(
        RequestFailureKind::Provider,
        "Cloudflare DNS records response exceeded a safe resource limit.",
        None,
        RequestErrorSource::Client,
        DNS_LIST_OPERATION,
        false,
        resource_limit_details(&limit),
        None,
        "Reduce the requested DNS records page size and retry.",
        None,
    )
}

fn map_dns_records_error(error: CloudflareError) -> AppError {
    match error {
        CloudflareError::HttpError(CloudflareHttpError::Transport(context)) => {
            let kind = match context.category {
                CloudflareTransportCategory::Timeout => RequestFailureKind::Timeout,
                CloudflareTransportCategory::Dns
                | CloudflareTransportCategory::Connect
                | CloudflareTransportCategory::Other => RequestFailureKind::Network,
            };
            let details = vec![
                ProviderErrorDetail {
                    code: Some("transport_category".to_string()),
                    message: transport_category_name(context.category).to_string(),
                },
                ProviderErrorDetail {
                    code: Some("upstream_host".to_string()),
                    message: context.host.to_string(),
                },
                ProviderErrorDetail {
                    code: Some("attempt".to_string()),
                    message: context.attempt.to_string(),
                },
                ProviderErrorDetail {
                    code: Some("max_attempts".to_string()),
                    message: context.max_attempts.to_string(),
                },
            ];

            AppError::request_failed(
                kind,
                "Cloudflare DNS records request failed before a response was received.",
                None,
                RequestErrorSource::Network,
                context.operation,
                context.retryable,
                details,
                None,
                context.remediation,
                None,
            )
        }
        CloudflareError::HttpError(CloudflareHttpError::ResourceLimit(limit)) => {
            map_legacy_resource_limit(limit)
        }
        CloudflareError::Request(error) | CloudflareError::Verification(error) => {
            map_structured_request_error(*error)
        }
        CloudflareError::ResourceLimit(context) => map_resource_limit_context(*context),
        CloudflareError::Validation(error) => map_validation_error(*error),
        CloudflareError::AuthFailed => AppError::auth_request_failed(
            RequestFailureKind::Authentication,
            "Cloudflare rejected the saved account credentials.",
            None,
            RequestErrorSource::Cloudflare,
            DNS_LIST_OPERATION,
            false,
            Vec::new(),
            None,
            "Verify the saved Cloudflare API token or key and account email.",
            None,
        ),
        CloudflareError::RateLimited(retry_after_secs) => AppError::request_failed(
            RequestFailureKind::RateLimited,
            "Cloudflare rate-limited the DNS records request.",
            Some(429),
            RequestErrorSource::Cloudflare,
            DNS_LIST_OPERATION,
            true,
            Vec::new(),
            Some(u64::from(retry_after_secs)),
            "Wait for the retry interval, then request the DNS records again.",
            None,
        ),
        CloudflareError::ApiError(_) => AppError::request_failed(
            RequestFailureKind::Provider,
            "Cloudflare DNS records request failed.",
            None,
            RequestErrorSource::Cloudflare,
            DNS_LIST_OPERATION,
            false,
            Vec::new(),
            None,
            "Retry the request. If it continues to fail, verify Cloudflare availability and the saved account credentials.",
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bc_cloudflare_api::{CloudflareTransportError, CLOUDFLARE_API_HOST};
    use serde_json::Value;

    fn serialize_mapped_error(error: CloudflareError) -> (String, Value) {
        let serialized: String = map_dns_records_error(error).into();
        let value = serde_json::from_str(&serialized).expect("AppError must serialize as JSON");
        (serialized, value)
    }

    #[test]
    fn dns_transport_error_serializes_safe_structured_context() {
        let error =
            CloudflareError::HttpError(CloudflareHttpError::Transport(CloudflareTransportError {
                category: CloudflareTransportCategory::Dns,
                host: CLOUDFLARE_API_HOST,
                operation: DNS_LIST_OPERATION,
                attempt: 3,
                max_attempts: 4,
                retryable: true,
                remediation: "Check DNS resolution and retry the request.",
            }));

        let (serialized, value) = serialize_mapped_error(error);

        assert_eq!(value["code"], "REQUEST_FAILED");
        assert_eq!(value["kind"], "network");
        assert_eq!(value["source"], "network");
        assert_eq!(value["operation"], DNS_LIST_OPERATION);
        assert_eq!(value["retryable"], true);
        assert_eq!(
            value["details"]["remediation"],
            "Check DNS resolution and retry the request."
        );

        let details = value["details"]["provider_errors"]
            .as_array()
            .expect("transport details must be an array");
        for (code, message) in [
            ("transport_category", "dns"),
            ("upstream_host", CLOUDFLARE_API_HOST),
            ("attempt", "3"),
            ("max_attempts", "4"),
        ] {
            assert!(details
                .iter()
                .any(|detail| detail["code"] == code && detail["message"] == message));
        }

        assert!(!serialized.contains("https://"));
        assert!(!serialized.contains("dns_records"));
        assert!(!serialized.contains("api_token"));
    }

    #[test]
    fn timeout_transport_error_uses_timeout_kind() {
        let error =
            CloudflareError::HttpError(CloudflareHttpError::Transport(CloudflareTransportError {
                category: CloudflareTransportCategory::Timeout,
                host: CLOUDFLARE_API_HOST,
                operation: DNS_LIST_OPERATION,
                attempt: 1,
                max_attempts: 1,
                retryable: false,
                remediation: "Retry when network connectivity is stable.",
            }));

        let (_, value) = serialize_mapped_error(error);

        assert_eq!(value["kind"], "timeout");
        assert_eq!(value["retryable"], false);
    }

    #[test]
    fn provider_error_text_is_not_exposed_at_the_command_boundary() {
        let sensitive =
            "https://proxy.internal/client/v4/zones/zone-secret/dns_records?api_token=token-secret";
        let (serialized, value) =
            serialize_mapped_error(CloudflareError::ApiError(sensitive.to_string()));

        assert_eq!(value["kind"], "provider");
        assert_eq!(value["source"], "cloudflare");
        assert_eq!(value["operation"], DNS_LIST_OPERATION);
        for forbidden in [
            "proxy.internal",
            "zone-secret",
            "token-secret",
            "https://",
            "dns_records",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}

#[cfg(test)]
mod structured_request_tests {
    use super::*;
    use serde_json::Value;

    fn serialize(error: CloudflareError) -> (String, Value) {
        let serialized: String = map_dns_records_error(error).into();
        let value = serde_json::from_str(&serialized).expect("AppError must serialize as JSON");
        (serialized, value)
    }

    fn request_error(
        kind: VerificationFailureKind,
        status: Option<u16>,
        retryable: bool,
        retry_after_secs: Option<u64>,
    ) -> CloudflareError {
        CloudflareError::Request(Box::new(CloudflareRequestError {
            kind,
            message: "Cloudflare DNS request failed safely.".to_string(),
            status,
            source: VerificationErrorSource::Cloudflare,
            operation: DNS_LIST_OPERATION.to_string(),
            retryable,
            provider_errors: vec![CloudflareProviderError {
                code: Some("provider-code".to_string()),
                message: "Safe provider detail.".to_string(),
            }],
            retry_after_secs,
            remediation: "Follow the safe remediation guidance.".to_string(),
            request_id: Some("safe-ray-id".to_string()),
        }))
    }

    #[test]
    fn only_authentication_and_401_403_use_auth_request_failed() {
        for error in [
            request_error(VerificationFailureKind::Authentication, None, false, None),
            CloudflareError::Verification(Box::new(CloudflareRequestError {
                kind: VerificationFailureKind::Provider,
                message: "Cloudflare rejected the request.".to_string(),
                status: Some(401),
                source: VerificationErrorSource::Cloudflare,
                operation: DNS_LIST_OPERATION.to_string(),
                retryable: false,
                provider_errors: Vec::new(),
                retry_after_secs: None,
                remediation: "Verify the saved credentials.".to_string(),
                request_id: None,
            })),
            request_error(VerificationFailureKind::Provider, Some(403), false, None),
            CloudflareError::AuthFailed,
        ] {
            let (_, value) = serialize(error);
            assert_eq!(value["code"], "AUTH_REQUEST_FAILED");
            assert_eq!(value["kind"], "authentication");
            assert_eq!(value["retryable"], false);
        }
    }

    #[test]
    fn status_and_malformed_failures_preserve_generic_semantics() {
        for (error, expected_kind, expected_status, expected_retryable) in [
            (
                request_error(VerificationFailureKind::Timeout, Some(408), true, None),
                "timeout",
                408,
                true,
            ),
            (
                request_error(
                    VerificationFailureKind::RateLimited,
                    Some(429),
                    true,
                    Some(23),
                ),
                "rate_limited",
                429,
                true,
            ),
            (
                request_error(VerificationFailureKind::Provider, Some(400), false, None),
                "provider",
                400,
                false,
            ),
            (
                request_error(VerificationFailureKind::Provider, Some(503), true, None),
                "provider",
                503,
                true,
            ),
            (
                request_error(
                    VerificationFailureKind::MalformedResponse,
                    Some(200),
                    false,
                    None,
                ),
                "malformed_response",
                200,
                false,
            ),
        ] {
            let (_, value) = serialize(error);
            assert_eq!(value["code"], "REQUEST_FAILED");
            assert_eq!(value["kind"], expected_kind);
            assert_eq!(value["status"], expected_status);
            assert_eq!(value["retryable"], expected_retryable);
            assert_eq!(value["details"]["provider_codes"][0], "provider-code");
            assert_eq!(value["request_id"], "safe-ray-id");
            if expected_status == 429 {
                assert_eq!(value["retry_after"], "23");
                assert_eq!(value["details"]["retry_after_secs"], 23);
            }
        }
    }

    #[test]
    fn resource_limit_and_validation_failures_are_structured() {
        let (_, resource) = serialize(CloudflareError::ResourceLimit(Box::new(
            CloudflareResourceLimitContext {
                limit: ResourceLimitError {
                    resource: "dns_records_response",
                    limit: 100,
                    actual: Some(101),
                    kind: ResourceLimitKind::Collection,
                },
                status: Some(200),
                source: VerificationErrorSource::Cloudflare,
                operation: DNS_LIST_OPERATION.to_string(),
                retryable: false,
                message: "DNS response exceeded the safe record limit.".to_string(),
                remediation: "Request a smaller page.".to_string(),
                request_id: Some("safe-ray-id".to_string()),
            },
        )));
        assert_eq!(resource["code"], "REQUEST_FAILED");
        assert_eq!(resource["status"], 200);
        assert_eq!(resource["retryable"], false);
        assert!(resource["details"]["provider_messages"]
            .as_array()
            .expect("resource details")
            .iter()
            .any(|message| message == "dns_records_response"));

        let (_, validation) = serialize(CloudflareError::Validation(Box::new(
            CloudflareValidationError {
                field: "per_page".to_string(),
                limit: 500,
                actual: Some(501),
                operation: DNS_LIST_OPERATION.to_string(),
                message: "DNS page size exceeds the supported limit.".to_string(),
                remediation: "Choose a page size no greater than 500.".to_string(),
            },
        )));
        assert_eq!(validation["code"], "REQUEST_FAILED");
        assert_eq!(validation["source"], "client");
        assert_eq!(validation["retryable"], false);
    }

    #[test]
    fn legacy_rate_limit_and_resource_limit_remain_structured() {
        let (_, rate_limit) = serialize(CloudflareError::RateLimited(31));
        assert_eq!(rate_limit["code"], "REQUEST_FAILED");
        assert_eq!(rate_limit["kind"], "rate_limited");
        assert_eq!(rate_limit["status"], 429);
        assert_eq!(rate_limit["retryable"], true);
        assert_eq!(rate_limit["retry_after"], "31");

        let (_, resource_limit) = serialize(CloudflareError::HttpError(
            CloudflareHttpError::ResourceLimit(ResourceLimitError {
                resource: "dns_records_response",
                limit: 100,
                actual: Some(101),
                kind: ResourceLimitKind::Collection,
            }),
        ));
        assert_eq!(resource_limit["code"], "REQUEST_FAILED");
        assert_eq!(resource_limit["source"], "client");
        assert_eq!(resource_limit["retryable"], false);
    }

    #[test]
    fn raw_legacy_provider_text_remains_redacted() {
        let raw = "https://proxy.internal/zones/zone-secret/dns_records?api_token=token-secret";
        let (serialized, value) = serialize(CloudflareError::ApiError(raw.to_string()));
        assert_eq!(value["code"], "REQUEST_FAILED");
        for forbidden in [
            "proxy.internal",
            "zone-secret",
            "token-secret",
            "https://",
            "dns_records",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }
}

// ─── DNS record validation gate ─────────────────────────────────────────────

/// Close one issue with a full stop unless it already ends a sentence.
fn terminate(issue: &str) -> String {
    let issue = issue.trim();
    if issue.ends_with(['.', '!', '?']) {
        issue.to_string()
    } else {
        format!("{issue}.")
    }
}

/// Render validation issues as one sentence-terminated message.
fn validation_detail(issues: &[String]) -> String {
    issues
        .iter()
        .map(String::as_str)
        .map(terminate)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Terminate one issue as a sentence, optionally naming the record it belongs
/// to. The locator matters for bulk writes: the renderer shows the issue list,
/// not the summary message, so "record 2" has to travel with the issue itself.
fn validation_issue(issue: &str, record: &DNSRecordInput, position: Option<usize>) -> String {
    let sentence = terminate(issue);
    match position {
        Some(index) => format!(
            "Record {} ({} {}): {sentence}",
            index + 1,
            record.r#type,
            record.name
        ),
        None => sentence,
    }
}

/// Reject a record that cannot be a valid DNS record before any HTTP call.
///
/// Every DNS write path — dialog, inline edit, paste, import, and bulk create —
/// funnels through the three commands below, so this is the one gate that
/// cannot be bypassed by a frontend path added later.
///
/// Nothing here has left the machine, so the failure must not read as a
/// Cloudflare or connectivity problem. [`AppError::validation_with_issues`]
/// carries the issue list in the shape the renderer classifies first, which
/// puts the record's actual defect in front of the user unchanged.
fn ensure_record_is_valid(record: &DNSRecordInput, position: Option<usize>) -> Result<(), String> {
    let result = bc_dns_tools::validate_record_input(record);
    if result.ok {
        return Ok(());
    }
    let detail = validation_detail(&result.issues);
    let message = match position {
        Some(index) => format!(
            "DNS record validation failed for record {} ({} {}): {detail}",
            index + 1,
            record.r#type,
            record.name
        ),
        None => format!("DNS record validation failed: {detail}"),
    };

    Err(AppError::validation_with_issues(
        message,
        result
            .issues
            .iter()
            .map(|issue| validation_issue(issue, record, position)),
    )
    .into())
}

/// Reject a bulk batch if any record is invalid, before any HTTP call.
fn ensure_records_are_valid(records: &[DNSRecordInput]) -> Result<(), String> {
    for (index, record) in records.iter().enumerate() {
        ensure_record_is_valid(record, Some(index))?;
    }
    Ok(())
}

#[cfg(test)]
mod validation_gate_tests {
    use super::*;
    use serde_json::Value;

    /// The commands below never reach the network on this path, so any HTTP
    /// attempt would surface as a Cloudflare or transport error instead of the
    /// validation message these tests assert on.
    fn storage() -> Storage {
        Storage::new(false)
    }

    fn record(record_type: &str, name: &str, content: &str) -> DNSRecordInput {
        DNSRecordInput {
            r#type: record_type.to_string(),
            name: name.to_string(),
            content: content.to_string(),
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: None,
        }
    }

    fn valid_record() -> DNSRecordInput {
        record("A", "www.example.com", "1.2.3.4")
    }

    fn invalid_record() -> DNSRecordInput {
        record("A", "www.example.com", "not-an-ip")
    }

    fn parse(error: &str) -> Value {
        serde_json::from_str(error).expect("the gate must return a serialized AppError")
    }

    #[test]
    fn valid_records_pass_the_gate() {
        assert!(ensure_record_is_valid(&valid_record(), None).is_ok());
        assert!(ensure_records_are_valid(&[valid_record(), valid_record()]).is_ok());
    }

    #[test]
    fn the_gate_returns_an_actionable_validation_error() {
        let error = ensure_record_is_valid(&invalid_record(), None)
            .expect_err("an invalid record must be rejected");
        let value = parse(&error);

        assert_eq!(value["code"], "VALIDATION");
        assert!(value.get("status").is_none());
        assert_eq!(
            value["message"],
            "DNS record validation failed: A record content must be a valid IPv4 address."
        );
        assert_eq!(
            value["issues"][0]["message"],
            "A record content must be a valid IPv4 address."
        );
    }

    /// The renderer decides what the user reads. `VALIDATION` plus an `issues`
    /// array is the one shape it classifies as validation before it starts
    /// matching prose — the shape that keeps this failure from being reported
    /// as a Cloudflare failure or a name-resolution failure. `test/`
    /// `request-error.test.ts` asserts the resulting sentence end to end; this
    /// test guards the payload those assertions depend on.
    #[test]
    fn the_validation_failure_carries_the_shape_the_renderer_classifies_first() {
        let error = ensure_record_is_valid(&invalid_record(), None)
            .expect_err("an invalid record must be rejected");
        let value = parse(&error);

        assert_eq!(value["code"], "VALIDATION");
        assert!(value.get("kind").is_none());
        assert!(value.get("source").is_none());
        let issues = value["issues"]
            .as_array()
            .expect("the renderer requires an issues array");
        assert!(!issues.is_empty());
        assert!(issues
            .iter()
            .all(|issue| issue["message"].as_str().is_some_and(|m| !m.is_empty())));
    }

    #[test]
    fn bulk_rejection_identifies_the_offending_record() {
        let error = ensure_records_are_valid(&[valid_record(), invalid_record()])
            .expect_err("an invalid record must fail the batch");
        let value = parse(&error);
        let message = value["message"]
            .as_str()
            .expect("the validation error must carry a message")
            .to_string();

        assert!(
            message.starts_with("DNS record validation failed for record 2 (A www.example.com):"),
            "unexpected message: {message}"
        );
        assert!(message.contains("valid IPv4 address"));

        // The renderer shows the issues, not the summary, so the locator has
        // to be inside the issue for the user to know which record failed.
        assert_eq!(
            value["issues"][0]["message"],
            "Record 2 (A www.example.com): A record content must be a valid IPv4 address."
        );
    }

    #[tokio::test]
    async fn create_dns_record_rejects_before_any_http_call() {
        let error = create_dns_record_impl(
            &storage(),
            "token".to_string(),
            None,
            "zone-id".to_string(),
            invalid_record(),
        )
        .await
        .expect_err("create must reject an invalid record");

        // A request that reached Cloudflare could not produce `VALIDATION`.
        assert_eq!(parse(&error)["code"], "VALIDATION");
    }

    #[tokio::test]
    async fn update_dns_record_rejects_before_any_http_call() {
        let error = update_dns_record_impl(
            &storage(),
            "token".to_string(),
            None,
            "zone-id".to_string(),
            "record-id".to_string(),
            record("MX", "example.com", "mail.example.com"),
        )
        .await
        .expect_err("update must reject a record with no MX priority");

        let value = parse(&error);
        assert_eq!(value["code"], "VALIDATION");
        assert!(value["message"]
            .as_str()
            .expect("message")
            .contains("MX records must include an integer priority"));
        assert_eq!(
            value["issues"][0]["message"],
            "MX records must include an integer priority."
        );
    }

    #[tokio::test]
    async fn create_bulk_dns_records_rejects_before_any_http_call() {
        for dryrun in [None, Some(false), Some(true)] {
            let error = create_bulk_dns_records_impl(
                &storage(),
                "token".to_string(),
                None,
                "zone-id".to_string(),
                vec![valid_record(), invalid_record()],
                dryrun,
            )
            .await
            .expect_err("bulk create must reject a batch containing an invalid record");

            assert_eq!(parse(&error)["code"], "VALIDATION", "dryrun {dryrun:?}");
        }
    }

    #[test]
    fn validation_detail_terminates_every_issue() {
        assert_eq!(
            validation_detail(&["first issue".to_string(), "second issue.".to_string()]),
            "first issue. second issue."
        );
    }
}

// ─── DNS Operations ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_zones(api_key: String, email: Option<String>) -> Result<Vec<Zone>, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_zones().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_dns_records(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<Vec<DNSRecord>, AppError> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_dns_records(&zone_id, page, per_page)
        .await
        .map_err(map_dns_records_error)
}

#[tauri::command]
pub async fn create_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record: DNSRecordInput,
    notifications: State<'_, NotificationManager>,
) -> Result<DNSRecord, String> {
    let created = create_dns_record_impl(&storage, api_key, email, zone_id.clone(), record).await?;
    if let Some(id) = created.id.as_deref() {
        notifications.ledger().note(&zone_id, id, "create");
    }
    Ok(created)
}

async fn create_dns_record_impl(
    storage: &Storage,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    ensure_record_is_valid(&record, None)?;
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = client
        .create_dns_record(&zone_id, record)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        storage,
        serde_json::json!({
            "operation": "dns:create",
            "resource": created.id.clone().unwrap_or_default(),
            "zone_id": zone_id,
            "record_type": created.r#type,
            "record_name": created.name,
        }),
    )
    .await;
    Ok(created)
}

#[tauri::command]
pub async fn update_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    record: DNSRecordInput,
    notifications: State<'_, NotificationManager>,
) -> Result<DNSRecord, String> {
    let updated = update_dns_record_impl(
        &storage,
        api_key,
        email,
        zone_id.clone(),
        record_id.clone(),
        record,
    )
    .await?;
    notifications.ledger().note(&zone_id, &record_id, "update");
    Ok(updated)
}

async fn update_dns_record_impl(
    storage: &Storage,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    record: DNSRecordInput,
) -> Result<DNSRecord, String> {
    ensure_record_is_valid(&record, None)?;
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let updated = client
        .update_dns_record(&zone_id, &record_id, record)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        storage,
        serde_json::json!({
            "operation": "dns:update",
            "resource": record_id,
            "zone_id": zone_id,
            "record_type": updated.r#type,
            "record_name": updated.name,
        }),
    )
    .await;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    notifications: State<'_, NotificationManager>,
) -> Result<(), String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .delete_dns_record(&zone_id, &record_id)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:delete",
            "resource": record_id,
            "zone_id": zone_id,
        }),
    )
    .await;
    notifications.ledger().note(&zone_id, &record_id, "delete");
    Ok(())
}

#[tauri::command]
pub async fn create_bulk_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    records: Vec<DNSRecordInput>,
    dryrun: Option<bool>,
    notifications: State<'_, NotificationManager>,
) -> Result<serde_json::Value, String> {
    let result =
        create_bulk_dns_records_impl(&storage, api_key, email, zone_id.clone(), records, dryrun)
            .await?;
    if !dryrun.unwrap_or(false) {
        for id in result
            .get("created")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|record| record.get("id").and_then(|id| id.as_str()))
        {
            notifications.ledger().note(&zone_id, id, "create");
        }
    }
    Ok(result)
}

async fn create_bulk_dns_records_impl(
    storage: &Storage,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    records: Vec<DNSRecordInput>,
    dryrun: Option<bool>,
) -> Result<serde_json::Value, String> {
    ensure_records_are_valid(&records)?;
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .create_bulk_dns_records(&zone_id, records, dryrun.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        storage,
        serde_json::json!({
            "operation": "dns:bulk_create",
            "resource": zone_id,
            "dry_run": dryrun.unwrap_or(false),
            "created": result.get("created").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
            "skipped": result.get("skipped").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn export_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    format: String,
    page: Option<u32>,
    per_page: Option<u32>,
) -> Result<String, String> {
    if page.unwrap_or(1) == 0 || page.unwrap_or(1) > MAX_NATIVE_EXPORT_PAGE {
        return Err(format!(
            "DNS export page must be between 1 and {MAX_NATIVE_EXPORT_PAGE}"
        ));
    }
    if per_page.unwrap_or(100) == 0 || per_page.unwrap_or(100) > MAX_NATIVE_EXPORT_PER_PAGE {
        return Err(format!(
            "DNS export page size must be between 1 and {MAX_NATIVE_EXPORT_PER_PAGE}"
        ));
    }
    if !matches!(format.as_str(), "json" | "csv" | "bind") {
        return Err("DNS export format must be json, csv, or bind".to_string());
    }
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let data = client
        .export_dns_records(&zone_id, &format, page, per_page)
        .await
        .map_err(|e| e.to_string())?;
    if data.len() > bc_dns_tools::MAX_EXPORT_OUTPUT_BYTES {
        return Err(format!(
            "DNS export output exceeds the safe {} byte limit",
            bc_dns_tools::MAX_EXPORT_OUTPUT_BYTES
        ));
    }
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:export",
            "resource": zone_id,
            "format": format,
            "page": page,
            "per_page": per_page,
        }),
    )
    .await;
    Ok(data)
}

#[tauri::command]
pub async fn purge_cache(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    purge_everything: bool,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .purge_cache(&zone_id, purge_everything, files.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "cache:purge",
            "resource": zone_id,
            "purge_everything": purge_everything,
            "files_count": files.as_ref().map(|v| v.len()).unwrap_or(0),
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_zone_setting(
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client
        .get_zone_setting(&zone_id, &setting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_zone_setting(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .update_zone_setting(&zone_id, &setting_id, value.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "zone_setting:update",
            "resource": setting_id,
            "zone_id": zone_id,
            "value": value,
        }),
    )
    .await;
    Ok(result)
}

#[tauri::command]
pub async fn get_dnssec(
    api_key: String,
    email: Option<String>,
    zone_id: String,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    client.get_dnssec(&zone_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_dnssec(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .update_dnssec(&zone_id, payload.clone())
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dnssec:update",
            "resource": zone_id,
            "payload": payload,
        }),
    )
    .await;
    Ok(result)
}

// ─── Bulk Operations ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn delete_bulk_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_ids: Vec<String>,
    notifications: State<'_, NotificationManager>,
) -> Result<serde_json::Value, String> {
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = client
        .delete_bulk_dns_records(&zone_id, &record_ids)
        .await
        .map_err(|e| e.to_string())?;
    log_audit(
        &storage,
        serde_json::json!({
            "operation": "dns:bulk_delete",
            "resource": zone_id,
            "count": record_ids.len(),
        }),
    )
    .await;
    for record_id in &record_ids {
        notifications.ledger().note(&zone_id, record_id, "delete");
    }
    Ok(result)
}

// ─── SPF ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn simulate_spf(domain: String, ip: String) -> Result<bc_spf::SPFSimulation, String> {
    bc_spf::simulate_spf(&domain, &ip).await
}

#[tauri::command]
pub async fn spf_graph(domain: String) -> Result<bc_spf::SPFGraph, String> {
    bc_spf::build_spf_graph(&domain).await
}

// ─── Topology ───────────────────────────────────────────────────────────────

// Tauri derives these top-level argument names from the command signature.
// Grouping them would break the established `resolve_topology_batch` IPC payload.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn resolve_topology_batch(
    hostnames: Vec<String>,
    max_hops: Option<u8>,
    service_hosts: Option<Vec<String>>,
    doh_provider: Option<String>,
    doh_custom_url: Option<String>,
    resolver_mode: Option<String>,
    dns_server: Option<String>,
    custom_dns_server: Option<String>,
    lookup_timeout_ms: Option<u32>,
    disable_ptr_lookups: Option<bool>,
    disable_geo_lookups: Option<bool>,
    geo_provider: Option<String>,
    scan_resolution_chain: Option<bool>,
    tcp_service_ports: Option<Vec<u16>>,
) -> Result<bc_topology::TopologyBatchResult, String> {
    bc_topology::resolve_topology_batch(
        hostnames,
        max_hops,
        service_hosts,
        doh_provider,
        doh_custom_url,
        resolver_mode,
        dns_server,
        custom_dns_server,
        lookup_timeout_ms,
        disable_ptr_lookups,
        disable_geo_lookups,
        geo_provider,
        scan_resolution_chain,
        tcp_service_ports,
    )
    .await
}

// ─── DNS Tools ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn parse_csv_records(text: String) -> Result<Vec<bc_dns_tools::PartialDNSRecord>, String> {
    bc_dns_tools::try_parse_csv_records(&text).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn parse_bind_zone(text: String) -> Result<Vec<bc_dns_tools::PartialDNSRecord>, String> {
    bc_dns_tools::try_parse_bind_zone(&text).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn validate_dns_record(
    input: bc_dns_tools::DNSRecordValidationInput,
) -> bc_dns_tools::ValidationResult {
    bc_dns_tools::validate_dns_record(&input)
}

#[tauri::command]
pub fn parse_srv(content: String) -> bc_dns_tools::SRVFields {
    bc_dns_tools::parse_srv(&content)
}

#[tauri::command]
pub fn compose_srv(
    priority: Option<u16>,
    weight: Option<u16>,
    port: Option<u16>,
    target: String,
) -> String {
    bc_dns_tools::compose_srv(priority, weight, port, &target)
}

#[tauri::command]
pub fn parse_tlsa(content: String) -> bc_dns_tools::TLSAFields {
    bc_dns_tools::parse_tlsa(&content)
}

#[tauri::command]
pub fn compose_tlsa(
    usage: Option<u8>,
    selector: Option<u8>,
    matching_type: Option<u8>,
    data: String,
) -> String {
    bc_dns_tools::compose_tlsa(usage, selector, matching_type, &data)
}

#[tauri::command]
pub fn parse_sshfp(content: String) -> bc_dns_tools::SSHFPFields {
    bc_dns_tools::parse_sshfp(&content)
}

#[tauri::command]
pub fn compose_sshfp(algorithm: Option<u8>, fptype: Option<u8>, fingerprint: String) -> String {
    bc_dns_tools::compose_sshfp(algorithm, fptype, &fingerprint)
}

#[tauri::command]
pub fn parse_naptr(content: String) -> bc_dns_tools::NAPTRFields {
    bc_dns_tools::parse_naptr(&content)
}

#[tauri::command]
pub fn compose_naptr(
    order: Option<u16>,
    preference: Option<u16>,
    flags: String,
    service: String,
    regexp: String,
    replacement: String,
) -> String {
    bc_dns_tools::compose_naptr(order, preference, &flags, &service, &regexp, &replacement)
}

#[tauri::command]
pub fn records_to_csv(records: Vec<DNSRecord>) -> Result<String, String> {
    bc_dns_tools::try_records_to_csv(&records).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn records_to_bind(records: Vec<DNSRecord>) -> Result<String, String> {
    bc_dns_tools::try_records_to_bind(&records).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn records_to_json(records: Vec<DNSRecord>) -> Result<String, String> {
    bc_dns_tools::try_records_to_json(&records).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn parse_spf(content: String) -> Option<bc_spf::SPFRecord> {
    bc_spf::parse_spf(&content)
}

// ─── Domain Audit ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn run_domain_audit(
    zone_name: String,
    records: Vec<DNSRecord>,
    options: bc_domain_audit::AuditOptions,
) -> Vec<bc_domain_audit::AuditItem> {
    bc_domain_audit::run_domain_audit(&zone_name, &records, &options)
}

// ─── DNS Propagation ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn check_dns_propagation(
    domain: String,
    record_type: String,
    extra_resolvers: Option<Vec<String>>,
    options: Option<bc_topology::PropagationOptions>,
) -> Result<bc_topology::PropagationResult, String> {
    bc_topology::check_propagation_with_options(
        domain,
        record_type,
        extra_resolvers,
        options.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub fn list_propagation_resolvers() -> Vec<bc_topology::PropagationResolverEntry> {
    bc_topology::propagation_resolver_catalogue().to_vec()
}
