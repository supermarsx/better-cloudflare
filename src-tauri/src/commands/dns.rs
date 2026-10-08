use tauri::State;

use bc_cloudflare_api::{
    CloudflareError, CloudflareHttpError, CloudflareProviderError, CloudflareRequestError,
    CloudflareResourceLimitContext, CloudflareTransportCategory, CloudflareValidationError,
    ResourceLimitError, ResourceLimitKind, VerificationErrorSource, VerificationFailureKind,
    DNS_LIST_OPERATION,
};
use bc_error::{AppError, ProviderErrorDetail, RequestErrorSource, RequestFailureKind};
use bc_storage::{AuditEntry, AuditOutcome, AuditTrail};
use serde_json::Value;

use crate::cloudflare_api::{CloudflareClient, DNSRecord, DNSRecordInput, Zone};
use crate::storage::Storage;

use super::trail::{self, RecordFacts};
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
            None,
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

/// What the trail records for a user's own DNS action, read back out of a
/// store.
///
/// These go through the real command bodies rather than through
/// `commands::trail` directly, so what is asserted is what a user's action
/// actually writes. Only the refusal paths are reachable without a network —
/// the validation gate runs before any HTTP call — which is why they carry the
/// credential assertions: a refusal is the entry built from the most arguments,
/// including both auth fields and the record the user typed. The success and
/// provider-failure shapes are pinned by `commands::trail`'s own tests.
#[cfg(test)]
mod audit_trail_tests {
    use serde_json::{json, Value};

    use super::*;

    /// A token and an account email no entry may ever contain, and content
    /// that is key material — which, for a user's own action, the entry
    /// deliberately does carry. See `commands::trail`'s header.
    const TOKEN: &str = "cf-token-must-never-be-recorded";
    const ACCOUNT_EMAIL: &str = "person@example.com";
    /// Long enough that the bound on a recorded value actually bites — a real
    /// DKIM key is hundreds of characters, and a fixture under the limit would
    /// make the assertion about shortening vacuous.
    const DKIM: &str = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA-secret-key-material-that-keeps-going-well-past-the-recorded-value-limit-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    fn storage() -> Storage {
        Storage::new(false)
    }

    async fn entries(storage: &Storage) -> Vec<Value> {
        storage
            .get_audit_entries()
            .await
            .expect("the memory-backed store must return its log")
    }

    fn invalid_txt() -> DNSRecordInput {
        // An invalid *name* with valid TXT content, so the gate refuses the
        // record while the content is still something worth recording.
        DNSRecordInput {
            r#type: "TXT".to_string(),
            name: String::new(),
            content: DKIM.to_string(),
            comment: Some("rotation note".to_string()),
            ttl: Some(300),
            priority: None,
            proxied: None,
        }
    }

    async fn refused_create(storage: &Storage) -> Vec<Value> {
        create_dns_record_impl(
            storage,
            TOKEN.to_string(),
            Some(ACCOUNT_EMAIL.to_string()),
            "zone-1".to_string(),
            invalid_txt(),
        )
        .await
        .expect_err("the gate must refuse a record with no name");
        entries(storage).await
    }

    #[tokio::test]
    async fn a_refused_create_is_recorded_as_a_refusal_and_names_the_record() {
        let storage = storage();
        let entries = refused_create(&storage).await;

        assert_eq!(entries.len(), 1, "a refusal is one entry: {entries:?}");
        let entry = &entries[0];
        assert_eq!(entry["operation"], json!("dns:create"));
        assert_eq!(entry["actor"], json!("user"));
        assert_eq!(
            entry["outcome"],
            json!("denied"),
            "a log of only successes hides the half a reader came for"
        );
        assert_eq!(entry["denied_by"], json!("record_validation"));
        assert_eq!(entry["zone_id"], json!("zone-1"));
        assert_eq!(entry["record_type"], json!("TXT"));
        assert!(
            entry["timestamp"].as_str().is_some_and(|ts| ts.len() > 10),
            "every entry is timestamped"
        );
    }

    #[tokio::test]
    async fn no_credential_reaches_the_trail_but_the_users_own_content_does() {
        let storage = storage();
        let entries = refused_create(&storage).await;
        let serialized = serde_json::to_string(&entries).expect("serialise the log");

        for forbidden in [TOKEN, ACCOUNT_EMAIL, "api_key", "email"] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} reached the trail: {serialized}"
            );
        }
        // The other half of the decision, asserted just as hard: the user's own
        // record content is recorded, because a change log that will not say
        // what a record holds has not answered the question it was opened for.
        // Shortened, which is also why the whole DKIM value is not here.
        let content = entries[0]["record"]["content"]
            .as_str()
            .expect("a user's own record content is recorded");
        assert!(DKIM.starts_with(&content[..content.len().min(40)]));
        assert!(
            content.len() <= trail::MAX_CHANGE_VALUE_BYTES,
            "content is bounded on the way in: {} bytes",
            content.len()
        );
    }

    #[tokio::test]
    async fn a_refused_update_names_the_record_it_was_refused_for() {
        let storage = storage();
        update_dns_record_impl(
            &storage,
            TOKEN.to_string(),
            Some(ACCOUNT_EMAIL.to_string()),
            "zone-1".to_string(),
            "record-1".to_string(),
            invalid_txt(),
            Some(json!({ "type": "TXT", "name": "old.example.com", "content": "old" })),
        )
        .await
        .expect_err("the gate must refuse a record with no name");
        let entries = entries(&storage).await;

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["operation"], json!("dns:update"));
        assert_eq!(entries[0]["outcome"], json!("denied"));
        assert_eq!(
            entries[0]["resource"],
            json!("record-1"),
            "the record the user was editing, so `own_record_ids_from_audit` \
             still reads this entry the way it always has"
        );
        assert!(
            entries[0].get("changes").is_none(),
            "nothing changed, so there is no change set to claim"
        );
        assert!(!serde_json::to_string(&entries)
            .expect("serialise")
            .contains(TOKEN));
    }

    #[tokio::test]
    async fn a_refused_batch_records_its_scale_rather_than_its_records() {
        let storage = storage();
        let batch = vec![
            DNSRecordInput {
                r#type: "A".to_string(),
                name: "www.example.com".to_string(),
                content: "203.0.113.1".to_string(),
                comment: None,
                ttl: Some(300),
                priority: None,
                proxied: None,
            },
            invalid_txt(),
        ];
        create_bulk_dns_records_impl(
            &storage,
            TOKEN.to_string(),
            Some(ACCOUNT_EMAIL.to_string()),
            "zone-1".to_string(),
            batch,
            Some(false),
        )
        .await
        .expect_err("one invalid record must fail the batch");
        let entries = entries(&storage).await;

        assert_eq!(
            entries.len(),
            1,
            "one entry for the operation, not one per record: {entries:?}"
        );
        let entry = &entries[0];
        assert_eq!(entry["operation"], json!("dns:bulk_create"));
        assert_eq!(entry["outcome"], json!("denied"));
        assert_eq!(entry["resource"], json!("zone-1"));
        assert_eq!(entry["records"], json!(2));
        assert_eq!(entry["record_types"], json!("A, TXT"));
        assert_eq!(entry["dry_run"], json!(false));
        assert!(
            entry.get("record").is_none(),
            "a batch entry describes the batch, not one of its records"
        );
        assert!(
            !serde_json::to_string(&entries)
                .expect("serialise")
                .contains(DKIM),
            "and a batch does not carry every record's content"
        );
    }

    #[test]
    fn a_batch_names_its_distinct_types_once_each_in_a_stable_order() {
        let record = |record_type: &str| DNSRecordInput {
            r#type: record_type.to_string(),
            name: "www.example.com".to_string(),
            content: "203.0.113.1".to_string(),
            comment: None,
            ttl: None,
            priority: None,
            proxied: None,
        };
        assert_eq!(
            batch_types(&[record("MX"), record("A"), record("MX"), record("TXT")]),
            "A, MX, TXT"
        );
        assert_eq!(batch_types(&[]), "");
    }
}

// ─── Recording a DNS action ─────────────────────────────────────────────────
//
// Every mutating command below settles through one of these, so a success, a
// provider refusal and a local refusal are all described the same way and a
// reader filtering the log on `outcome` sees every half of the picture rather
// than only the successes. `commands::trail` holds the vocabulary and the line
// around what an entry may carry.

/// Open an entry for an action on one record, naming the zone and the record.
fn record_entry(operation: &str, outcome: AuditOutcome, zone_id: &str) -> AuditEntry {
    trail::user_action(operation, outcome).detail("zone_id", zone_id)
}

/// Record an action this application refused before any HTTP call.
///
/// The refusal comes first out of the entry's budget, like the tool-call half
/// does: the reason is what a reader of a non-success entry wants first.
fn record_denied(
    storage: &Storage,
    operation: &str,
    zone_id: &str,
    record_id: Option<&str>,
    denied_by: &str,
    facts: Option<&RecordFacts>,
) {
    let entry =
        record_entry(operation, AuditOutcome::Denied, zone_id).detail("denied_by", denied_by);
    storage.record(describe(with_resource(entry, record_id), facts));
}

/// Record an action Cloudflare did not carry out.
///
/// Worth as much as a success: a write that failed may still have landed —
/// that is why `AuditOutcome::Failed` covers a call that left the application
/// and stopped being observable — and a trail of only successes is a trail
/// that cannot explain the zone.
fn record_failed(
    storage: &Storage,
    operation: &str,
    zone_id: &str,
    record_id: Option<&str>,
    error: &CloudflareError,
    facts: Option<&RecordFacts>,
) {
    let entry = trail::attach_failure(
        record_entry(operation, AuditOutcome::Failed, zone_id),
        error,
    );
    storage.record(describe(with_resource(entry, record_id), facts));
}

fn with_resource(entry: AuditEntry, record_id: Option<&str>) -> AuditEntry {
    match record_id {
        Some(record_id) => entry.resource(record_id),
        None => entry,
    }
}

/// Name the record where one is known. A delete whose caller did not say what
/// it was deleting has nothing to name, and an entry that invented a blank
/// name would be worse than one that admits it does not have the record.
fn describe(entry: AuditEntry, facts: Option<&RecordFacts>) -> AuditEntry {
    match facts {
        Some(facts) => trail::describe_record(entry, facts),
        None => entry,
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
    let requested = RecordFacts::of_input(&record);
    if let Err(refusal) = ensure_record_is_valid(&record, None) {
        record_denied(
            storage,
            "dns:create",
            &zone_id,
            None,
            trail::DENIED_BY_RECORD_VALIDATION,
            Some(&requested),
        );
        return Err(refusal);
    }
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let created = match client.create_dns_record(&zone_id, record).await {
        Ok(created) => created,
        Err(error) => {
            record_failed(
                storage,
                "dns:create",
                &zone_id,
                None,
                &error,
                Some(&requested),
            );
            return Err(error.to_string());
        }
    };
    // The created record rather than the requested one: Cloudflare fills in a
    // default TTL, normalises the name, and may refuse to proxy. What the trail
    // should say the user created is what now exists.
    storage.record(trail::describe_record(
        record_entry("dns:create", AuditOutcome::Succeeded, &zone_id)
            .resource(created.id.as_deref().unwrap_or_default()),
        &RecordFacts::of_record(&created),
    ));
    Ok(created)
}

/// Update one record, recording what changed about it.
///
/// `previous` is the record as the caller had it before the edit, and it is
/// what turns `dns:update` from "something happened to this id" into a change
/// set. Optional, and taken as a raw value, for two reasons: a caller that
/// predates it keeps working, and a malformed one must cost the entry its
/// change set rather than cost the user their edit — see
/// [`RecordFacts::of_claim`]. Without it the entry records the record's state
/// *after* the change, which still answers "what is it now" if not "what
/// changed".
///
/// Tauri derives the IPC argument names from this signature, so `previous`
/// travels under that name alongside `record`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    record: DNSRecordInput,
    previous: Option<Value>,
    notifications: State<'_, NotificationManager>,
) -> Result<DNSRecord, String> {
    let updated = update_dns_record_impl(
        &storage,
        api_key,
        email,
        zone_id.clone(),
        record_id.clone(),
        record,
        previous,
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
    previous: Option<Value>,
) -> Result<DNSRecord, String> {
    let requested = RecordFacts::of_input(&record);
    let before = previous.as_ref().and_then(RecordFacts::of_claim);
    if let Err(refusal) = ensure_record_is_valid(&record, None) {
        record_denied(
            storage,
            "dns:update",
            &zone_id,
            Some(&record_id),
            trail::DENIED_BY_RECORD_VALIDATION,
            Some(&requested),
        );
        return Err(refusal);
    }
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let updated = match client.update_dns_record(&zone_id, &record_id, record).await {
        Ok(updated) => updated,
        Err(error) => {
            record_failed(
                storage,
                "dns:update",
                &zone_id,
                Some(&record_id),
                &error,
                Some(&requested),
            );
            return Err(error.to_string());
        }
    };
    let after = RecordFacts::of_record(&updated);
    let entry = record_entry("dns:update", AuditOutcome::Succeeded, &zone_id).resource(&record_id);
    storage.record(match before.as_ref() {
        Some(before) => trail::describe_change(entry, before, &after),
        None => trail::describe_record(entry, &after),
    });
    Ok(updated)
}

/// Delete one record, recording what it was.
///
/// `previous` is the record about to be removed. It matters more here than
/// anywhere else: once the delete lands, the id in `resource` names nothing,
/// so an entry without it says only that *an* unidentifiable record went. The
/// recycle-bin path (`commands::retention::retain_dns_record`) always has the
/// record and always records it; this is the path that deletes outright.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn delete_dns_record(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_id: String,
    previous: Option<Value>,
    notifications: State<'_, NotificationManager>,
) -> Result<(), String> {
    let removed = previous.as_ref().and_then(RecordFacts::of_claim);
    let client = CloudflareClient::new(&api_key, email.as_deref());
    if let Err(error) = client.delete_dns_record(&zone_id, &record_id).await {
        record_failed(
            &storage,
            "dns:delete",
            &zone_id,
            Some(&record_id),
            &error,
            removed.as_ref(),
        );
        return Err(error.to_string());
    }
    storage.record(describe(
        record_entry("dns:delete", AuditOutcome::Succeeded, &zone_id).resource(&record_id),
        removed.as_ref(),
    ));
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

/// The distinct record types in a batch, sorted, as one readable value.
///
/// What a bulk entry can say about its contents without saying it 400 times:
/// "412 records: A, CNAME, MX, TXT" identifies an import, and the records
/// themselves are then in the zone for anyone who wants them individually.
fn batch_types(records: &[DNSRecordInput]) -> String {
    let mut types: Vec<&str> = records
        .iter()
        .map(|record| record.r#type.as_str())
        .collect();
    types.sort_unstable();
    types.dedup();
    types.join(", ")
}

/// Open a bulk entry. One entry per operation, never one per record — see
/// [`create_bulk_dns_records`].
fn batch_entry(
    operation: &str,
    outcome: AuditOutcome,
    zone_id: &str,
    requested: usize,
) -> AuditEntry {
    trail::user_action(operation, outcome)
        .resource(zone_id)
        .detail("zone_id", zone_id)
        .detail("records", requested as u64)
}

async fn create_bulk_dns_records_impl(
    storage: &Storage,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    records: Vec<DNSRecordInput>,
    dryrun: Option<bool>,
) -> Result<serde_json::Value, String> {
    let dry_run = dryrun.unwrap_or(false);
    let requested = records.len();
    let types = batch_types(&records);
    if let Err(refusal) = ensure_records_are_valid(&records) {
        storage.record(
            batch_entry("dns:bulk_create", AuditOutcome::Denied, &zone_id, requested)
                .detail("denied_by", trail::DENIED_BY_RECORD_VALIDATION)
                .detail("dry_run", dry_run)
                .detail("record_types", types.as_str()),
        );
        return Err(refusal);
    }
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = match client
        .create_bulk_dns_records(&zone_id, records, dry_run)
        .await
    {
        Ok(result) => result,
        Err(error) => {
            storage.record(
                trail::attach_failure(
                    batch_entry("dns:bulk_create", AuditOutcome::Failed, &zone_id, requested),
                    &error,
                )
                .detail("dry_run", dry_run)
                .detail("record_types", types.as_str()),
            );
            return Err(error.to_string());
        }
    };
    let counted = |key: &str| {
        result
            .get(key)
            .and_then(|value| value.as_array())
            .map_or(0, Vec::len) as u64
    };
    storage.record(
        batch_entry(
            "dns:bulk_create",
            AuditOutcome::Succeeded,
            &zone_id,
            requested,
        )
        .detail("dry_run", dry_run)
        .detail("created", counted("created"))
        .detail("skipped", counted("skipped"))
        .detail("record_types", types.as_str()),
    );
    Ok(result)
}

/// Open a zone-level entry, naming the zone in both the fields a reader
/// filters on: `resource`, which is what the action was aimed at, and
/// `zone_id`, which is what every other zone-level entry calls it.
fn zone_entry(operation: &str, outcome: AuditOutcome, zone_id: &str) -> AuditEntry {
    trail::user_action(operation, outcome)
        .resource(zone_id)
        .detail("zone_id", zone_id)
}

/// Export a zone's records as text.
///
/// Recorded even though it changes nothing: an export is how a zone's contents
/// leave the machine, and "when did a copy of this zone get made" is a
/// question the log should answer.
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
    let describe_request = |entry: AuditEntry| {
        entry
            .detail("format", format.as_str())
            .optional_detail("page", page)
            .optional_detail("per_page", per_page)
    };
    let refuse = |reason: &'static str, message: String| {
        storage.record(describe_request(
            zone_entry("dns:export", AuditOutcome::Denied, &zone_id)
                .detail("denied_by", trail::DENIED_BY_REQUEST_BOUNDS)
                .detail("refused_field", reason),
        ));
        Err(message)
    };
    if page.unwrap_or(1) == 0 || page.unwrap_or(1) > MAX_NATIVE_EXPORT_PAGE {
        return refuse(
            "page",
            format!("DNS export page must be between 1 and {MAX_NATIVE_EXPORT_PAGE}"),
        );
    }
    if per_page.unwrap_or(100) == 0 || per_page.unwrap_or(100) > MAX_NATIVE_EXPORT_PER_PAGE {
        return refuse(
            "per_page",
            format!("DNS export page size must be between 1 and {MAX_NATIVE_EXPORT_PER_PAGE}"),
        );
    }
    if !matches!(format.as_str(), "json" | "csv" | "bind") {
        return refuse(
            "format",
            "DNS export format must be json, csv, or bind".to_string(),
        );
    }
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let data = match client
        .export_dns_records(&zone_id, &format, page, per_page)
        .await
    {
        Ok(data) => data,
        Err(error) => {
            storage.record(describe_request(trail::attach_failure(
                zone_entry("dns:export", AuditOutcome::Failed, &zone_id),
                &error,
            )));
            return Err(error.to_string());
        }
    };
    if data.len() > bc_dns_tools::MAX_EXPORT_OUTPUT_BYTES {
        // The request was dispatched and answered, so this is a failure rather
        // than a refusal — the same distinction `bc_mcp`'s `ResultTooLarge`
        // draws.
        storage.record(describe_request(
            zone_entry("dns:export", AuditOutcome::Failed, &zone_id)
                .detail("failure", "result_too_large"),
        ));
        return Err(format!(
            "DNS export output exceeds the safe {} byte limit",
            bc_dns_tools::MAX_EXPORT_OUTPUT_BYTES
        ));
    }
    storage.record(describe_request(zone_entry(
        "dns:export",
        AuditOutcome::Succeeded,
        &zone_id,
    )));
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
    // The file list is a payload, not a target: its scale is recorded and its
    // contents are not, exactly as the tool-call half treats it. A
    // purge-everything is recorded as the flag it is, because it is the one
    // cache action with zone-wide consequences.
    let describe_scope = |entry: AuditEntry| {
        entry
            .detail("purge_everything", purge_everything)
            .detail("files_count", files.as_ref().map_or(0, Vec::len) as u64)
    };
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = match client
        .purge_cache(&zone_id, purge_everything, files.clone())
        .await
    {
        Ok(result) => result,
        Err(error) => {
            storage.record(describe_scope(trail::attach_failure(
                zone_entry("cache:purge", AuditOutcome::Failed, &zone_id),
                &error,
            )));
            return Err(error.to_string());
        }
    };
    storage.record(describe_scope(zone_entry(
        "cache:purge",
        AuditOutcome::Succeeded,
        &zone_id,
    )));
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

/// Change one zone setting — SSL/TLS mode, minimum TLS version, Always Use
/// HTTPS, and every other switch on the settings screen.
///
/// `previous` is the setting's current value as the caller had it, and makes
/// the entry a before-and-after the way a record edit is. Optional: without it
/// the entry says what the setting was changed *to*, which is where it has
/// always been and under the key it has always used.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_zone_setting(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    setting_id: String,
    value: serde_json::Value,
    previous: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let describe_setting = |entry: AuditEntry| {
        trail::describe_value_change(
            entry
                .resource(&setting_id)
                .detail("zone_id", zone_id.as_str()),
            "value",
            previous.as_ref(),
            &value,
        )
    };
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = match client
        .update_zone_setting(&zone_id, &setting_id, value.clone())
        .await
    {
        Ok(result) => result,
        Err(error) => {
            storage.record(describe_setting(trail::attach_failure(
                trail::user_action("zone_setting:update", AuditOutcome::Failed),
                &error,
            )));
            return Err(error.to_string());
        }
    };
    storage.record(describe_setting(trail::user_action(
        "zone_setting:update",
        AuditOutcome::Succeeded,
    )));
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
    // `dnssec_status` is lifted out of the payload because turning DNSSEC on
    // or off is the whole action, and a reader should not have to parse a JSON
    // string to see which way it went. `payload` keeps the key it has always
    // had, now bounded.
    let describe_payload = |entry: AuditEntry| {
        entry
            .optional_detail(
                "dnssec_status",
                payload
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string),
            )
            .detail("payload", trail::setting_value(&payload))
    };
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = match client.update_dnssec(&zone_id, payload.clone()).await {
        Ok(result) => result,
        Err(error) => {
            storage.record(describe_payload(trail::attach_failure(
                zone_entry("dnssec:update", AuditOutcome::Failed, &zone_id),
                &error,
            )));
            return Err(error.to_string());
        }
    };
    storage.record(describe_payload(zone_entry(
        "dnssec:update",
        AuditOutcome::Succeeded,
        &zone_id,
    )));
    Ok(result)
}

// ─── Bulk Operations ────────────────────────────────────────────────────────

/// Delete several records by id in one call.
///
/// The entry is a summary, and that is all it can be: this command is handed
/// ids and nothing else, and an id names nothing once its record is gone. The
/// path the UI actually deletes a selection through is
/// `commands::retention::retain_dns_record`, one record at a time, which has
/// the whole record and both records it *and* keeps a restorable copy. So the
/// per-record detail a reader wants from a multi-record deletion exists — it
/// is just written by the command that has the records.
#[tauri::command]
pub async fn delete_bulk_dns_records(
    storage: State<'_, Storage>,
    api_key: String,
    email: Option<String>,
    zone_id: String,
    record_ids: Vec<String>,
    notifications: State<'_, NotificationManager>,
) -> Result<serde_json::Value, String> {
    let requested = record_ids.len();
    let client = CloudflareClient::new(&api_key, email.as_deref());
    let result = match client.delete_bulk_dns_records(&zone_id, &record_ids).await {
        Ok(result) => result,
        Err(error) => {
            storage.record(trail::attach_failure(
                batch_entry("dns:bulk_delete", AuditOutcome::Failed, &zone_id, requested),
                &error,
            ));
            return Err(error.to_string());
        }
    };
    storage.record(
        batch_entry(
            "dns:bulk_delete",
            AuditOutcome::Succeeded,
            &zone_id,
            requested,
        )
        // `count` is where this entry has always put the scale. `records`, from
        // `batch_entry`, is where every other bulk entry puts it; both are
        // written so a reader of either generation finds it.
        .detail("count", requested as u64),
    );
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

/// Look up a domain's registry record.
///
/// The audit's `domain-expiry` finding needs an expiry date and the registry is
/// the only authority for one, so the audit had to tell the user to go and run
/// a lookup by hand. This makes the lookup available to it directly.
///
/// It runs in the host rather than the web view for two reasons. The outbound
/// request stays off the renderer, which is the same reason the rest of this
/// app's network calls live here. And it reuses the RDAP implementation the
/// notification service already uses, so the audit and the expiry notification
/// cannot disagree about when one domain expires -- `bc_notify::rdap` is
/// explicit that it holds the single definition of expiry for that reason.
///
/// That module also does the hardening: it validates and percent-encodes the
/// hostname, follows only HTTPS redirects and only to a bounded depth, stops
/// reading the body at a byte ceiling whether or not a length was declared,
/// and caps how many statuses, nameservers and fields one answer may
/// contribute. The record it returns is a deliberate projection that omits
/// registrant, admin and technical contact vCards, so a lookup cannot pull
/// personal data into the app.
/// The registry monitoring switch is enforced here, first, before anything
/// else in the body: this is a registry request, and the renderer declining to
/// call it is a promise the renderer makes rather than one the host keeps.
/// The audit reaches RDAP from the host, so the host is where "nothing leaves
/// for a registry" has to be true.
#[tauri::command]
pub async fn lookup_domain_registry(domain: String) -> Result<bc_notify::RdapRegistration, String> {
    crate::registrar_commands::ensure_registry_monitoring()?;
    bc_notify::fetch_rdap_registration(bc_notify::rdap::shared_client(), &domain)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod registry_lookup_gate_tests {
    use super::*;
    use crate::registrar_commands::{registry_monitoring_for_test, REGISTRY_MONITORING_DISABLED};

    /// A hostname `bc_notify::rdap` rejects locally, so neither half of the
    /// test below can reach the network whichever way the switch is set.
    const UNRESOLVABLE: &str = "not a hostname";

    /// The gate runs before the lookup, not instead of its error.
    ///
    /// Both halves are needed, and the second is the one that makes this a
    /// measurement rather than a message comparison: with the switch on, the
    /// very same call gets *past* the gate and fails on the domain instead. So
    /// the refusal in the first half can only have come from the gate, which
    /// stands before the only statement in this function that opens a socket.
    #[tokio::test]
    async fn a_disabled_feature_refuses_before_the_registry_is_contacted() {
        let refused = {
            let _guard = registry_monitoring_for_test(false);
            lookup_domain_registry(UNRESOLVABLE.to_string())
                .await
                .expect_err("a disabled feature must not look anything up")
        };
        assert_eq!(refused, REGISTRY_MONITORING_DISABLED);

        let _guard = registry_monitoring_for_test(true);
        let reached_the_lookup = lookup_domain_registry(UNRESOLVABLE.to_string())
            .await
            .expect_err("there is no such domain");
        assert_ne!(
            reached_the_lookup, REGISTRY_MONITORING_DISABLED,
            "with the switch on the call has to get past the gate and fail on the domain"
        );
    }
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
