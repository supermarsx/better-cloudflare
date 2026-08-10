//! # bc-error
//!
//! Structured, serialisable error types shared across all Better Cloudflare
//! backend crates and the Tauri IPC boundary.
//!
//! Commands that adopt `AppError` serialise it to the frontend as a JSON object
//! with `code`, `message`, and optional `details`. Some legacy commands still
//! return string errors while their IPC contracts are migrated incrementally.

use serde::{Deserialize, Serialize};

const MAX_ERROR_TEXT_LENGTH: usize = 512;
const MAX_PROVIDER_ERRORS: usize = 5;
const MAX_VALIDATION_ISSUES: usize = 5;

/// High-level failure class for a structured authentication request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestFailureKind {
    Authentication,
    RateLimited,
    Provider,
    Network,
    Timeout,
    MalformedResponse,
}

/// Origin of a structured request failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestErrorSource {
    Client,
    Network,
    Cloudflare,
}

/// One safe provider error returned by Cloudflare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderErrorDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

/// One thing that is wrong with the submitted input.
///
/// The field name is deliberate: the renderer's `normalizeRequestError`
/// recognises an `issues` array of `{ message }` records and renders it as
/// `Invalid input: <message>` with `kind = "validation"`, before any of its
/// text-matching heuristics run. Carrying the issues here is therefore what
/// keeps a local validation failure from being re-diagnosed as a network or
/// provider failure on the way to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub message: String,
}

impl ValidationIssue {
    pub fn new(message: impl AsRef<str>) -> Self {
        Self {
            message: sanitize_error_text(message.as_ref()),
        }
    }
}

/// Additional structured context for a request failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RequestErrorDetails {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_errors: Vec<ProviderErrorDetail>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_codes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_messages: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
    pub remediation: String,
}

/// Top-level error kind.  Each variant maps to a stable string `code`
/// that the frontend can match on deterministically.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppError {
    // ── Authentication ──────────────────────────────────────────────────
    AuthFailed {
        message: String,
    },

    SessionExpired,

    NoSession,

    // ── Validation ──────────────────────────────────────────────────────
    /// Input the app rejected locally, before any request left the machine.
    ///
    /// `message` is the log/`Display` form. `issues` is the user-facing form:
    /// one entry per thing that is wrong, each stating what to correct.
    Validation {
        message: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        issues: Vec<ValidationIssue>,
    },

    MissingField {
        field: String,
    },

    // ── Cloudflare API ──────────────────────────────────────────────────
    CloudflareApi {
        message: String,
        status: Option<u16>,
    },

    RateLimited {
        retry_after_secs: u64,
    },

    /// Structured authentication/provider failure returned across Tauri IPC.
    AuthRequestFailed {
        kind: RequestFailureKind,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        source: RequestErrorSource,
        operation: String,
        retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after: Option<String>,
        details: RequestErrorDetails,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },

    /// Structured non-authentication request failure returned across Tauri IPC.
    RequestFailed {
        kind: RequestFailureKind,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        source: RequestErrorSource,
        operation: String,
        retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after: Option<String>,
        details: RequestErrorDetails,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },

    // ── Storage ─────────────────────────────────────────────────────────
    Storage {
        message: String,
    },

    NotFound {
        resource: String,
    },

    // ── Crypto ──────────────────────────────────────────────────────────
    Crypto {
        message: String,
    },

    // ── Platform ────────────────────────────────────────────────────────
    Biometric {
        message: String,
    },

    PlatformNotSupported,

    // ── Generic ─────────────────────────────────────────────────────────
    Internal {
        message: String,
    },

    Other {
        message: String,
    },
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AuthFailed { message } => write!(formatter, "Authentication failed: {message}"),
            Self::SessionExpired => formatter.write_str("Session expired"),
            Self::NoSession => formatter.write_str("No active session"),
            Self::Validation { message, .. } => write!(formatter, "Validation error: {message}"),
            Self::MissingField { field } => {
                write!(formatter, "Missing required field: {field}")
            }
            Self::CloudflareApi { message, .. } => {
                write!(formatter, "Cloudflare API error: {message}")
            }
            Self::RateLimited { retry_after_secs } => {
                write!(formatter, "Rate limited — try again in {retry_after_secs}s")
            }
            Self::AuthRequestFailed { message, .. } => formatter.write_str(message),
            Self::RequestFailed { message, .. } => formatter.write_str(message),
            Self::Storage { message } => write!(formatter, "Storage error: {message}"),
            Self::NotFound { resource } => write!(formatter, "Resource not found: {resource}"),
            Self::Crypto { message } => {
                write!(formatter, "Encryption/decryption error: {message}")
            }
            Self::Biometric { message } => write!(formatter, "Biometric error: {message}"),
            Self::PlatformNotSupported => formatter.write_str("Platform not supported"),
            Self::Internal { message } => write!(formatter, "Internal error: {message}"),
            Self::Other { message } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for AppError {}

impl AppError {
    /// Stable string code for frontend matching.
    pub fn code(&self) -> &'static str {
        match self {
            Self::AuthFailed { .. } => "AUTH_FAILED",
            Self::SessionExpired => "SESSION_EXPIRED",
            Self::NoSession => "NO_SESSION",
            Self::Validation { .. } => "VALIDATION",
            Self::MissingField { .. } => "MISSING_FIELD",
            Self::CloudflareApi { .. } => "CLOUDFLARE_API",
            Self::RateLimited { .. } => "RATE_LIMITED",
            Self::AuthRequestFailed { .. } => "AUTH_REQUEST_FAILED",
            Self::RequestFailed { .. } => "REQUEST_FAILED",
            Self::Storage { .. } => "STORAGE",
            Self::NotFound { .. } => "NOT_FOUND",
            Self::Crypto { .. } => "CRYPTO",
            Self::Biometric { .. } => "BIOMETRIC",
            Self::PlatformNotSupported => "PLATFORM_NOT_SUPPORTED",
            Self::Internal { .. } => "INTERNAL",
            Self::Other { .. } => "OTHER",
        }
    }

    /// Convenience: create from any std::error::Error.
    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self::Internal {
            message: err.to_string(),
        }
    }

    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other {
            message: msg.into(),
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation {
            message: msg.into(),
            issues: Vec::new(),
        }
    }

    /// Reject input and say, item by item, what has to change.
    ///
    /// Prefer this over [`Self::validation`] whenever the caller knows the
    /// individual problems: the issue list is what the user actually reads.
    pub fn validation_with_issues(
        msg: impl Into<String>,
        issues: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Self {
        Self::Validation {
            message: msg.into(),
            issues: issues
                .into_iter()
                .take(MAX_VALIDATION_ISSUES)
                .map(ValidationIssue::new)
                .collect(),
        }
    }

    pub fn not_found(resource: impl Into<String>) -> Self {
        Self::NotFound {
            resource: resource.into(),
        }
    }

    /// Construct a secret-safe non-authentication request error.
    #[allow(clippy::too_many_arguments)]
    pub fn request_failed(
        kind: RequestFailureKind,
        message: impl AsRef<str>,
        status: Option<u16>,
        source: RequestErrorSource,
        operation: impl AsRef<str>,
        retryable: bool,
        provider_errors: Vec<ProviderErrorDetail>,
        retry_after_secs: Option<u64>,
        remediation: impl AsRef<str>,
        request_id: Option<String>,
    ) -> Self {
        match Self::auth_request_failed(
            kind,
            message,
            status,
            source,
            operation,
            retryable,
            provider_errors,
            retry_after_secs,
            remediation,
            request_id,
        ) {
            Self::AuthRequestFailed {
                kind,
                message,
                status,
                source,
                operation,
                retryable,
                retry_after,
                details,
                request_id,
            } => Self::RequestFailed {
                kind,
                message,
                status,
                source,
                operation,
                retryable,
                retry_after,
                details,
                request_id,
            },
            _ => unreachable!("authentication request constructor returned an unexpected variant"),
        }
    }

    /// Construct a secret-safe authentication/provider request error.
    #[allow(clippy::too_many_arguments)]
    pub fn auth_request_failed(
        kind: RequestFailureKind,
        message: impl AsRef<str>,
        status: Option<u16>,
        source: RequestErrorSource,
        operation: impl AsRef<str>,
        retryable: bool,
        provider_errors: Vec<ProviderErrorDetail>,
        retry_after_secs: Option<u64>,
        remediation: impl AsRef<str>,
        request_id: Option<String>,
    ) -> Self {
        let provider_errors = provider_errors
            .into_iter()
            .take(MAX_PROVIDER_ERRORS)
            .map(|detail| ProviderErrorDetail {
                code: detail.code.and_then(sanitize_code),
                message: sanitize_error_text(&detail.message),
            })
            .collect::<Vec<_>>();
        let provider_codes = provider_errors
            .iter()
            .filter_map(|detail| detail.code.clone())
            .collect();
        let provider_messages = provider_errors
            .iter()
            .map(|detail| detail.message.clone())
            .collect();

        Self::AuthRequestFailed {
            kind,
            message: sanitize_error_text(message.as_ref()),
            status,
            source,
            operation: sanitize_operation(operation.as_ref()),
            retryable,
            retry_after: retry_after_secs.map(|seconds| seconds.to_string()),
            details: RequestErrorDetails {
                provider_errors,
                provider_codes,
                provider_messages,
                retry_after_secs,
                remediation: sanitize_error_text(remediation.as_ref()),
            },
            request_id: request_id.and_then(sanitize_request_id),
        }
    }
}

fn sanitize_code(code: String) -> Option<String> {
    let code = code.trim();
    if code.is_empty()
        || code.len() > 32
        || !code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return None;
    }
    Some(code.to_string())
}

fn sanitize_operation(operation: &str) -> String {
    operation
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ':' | '-' | '_' | '.')
        })
        .take(80)
        .collect()
}

fn sanitize_request_id(request_id: String) -> Option<String> {
    let request_id = request_id.trim();
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return None;
    }
    Some(request_id.to_string())
}

/// Redact common credential forms before an error crosses an IPC or log boundary.
pub fn sanitize_error_text(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut words = collapsed.split(' ').peekable();
    let mut sanitized = Vec::new();
    let sensitive_names = [
        "authorization",
        "api_key",
        "api-key",
        "apikey",
        "api_token",
        "api-token",
        "token",
        "secret",
        "password",
        "cookie",
        "set-cookie",
        "x-auth-key",
    ];

    while let Some(word) = words.next() {
        let lowercase = word.to_ascii_lowercase();
        if lowercase == "bearer" {
            sanitized.push("Bearer".to_string());
            if words.peek().is_some() {
                let _ = words.next();
                sanitized.push("[redacted]".to_string());
            }
            continue;
        }

        let sensitive_assignment = sensitive_names.iter().any(|name| {
            lowercase == *name
                || lowercase.starts_with(&format!("{name}="))
                || lowercase.starts_with(&format!("{name}:"))
        });
        if sensitive_assignment {
            if let Some((name, _)) = word.split_once('=') {
                sanitized.push(format!("{name}=[redacted]"));
            } else if let Some((name, _)) = word.split_once(':') {
                sanitized.push(format!("{name}=[redacted]"));
            } else {
                sanitized.push(word.to_string());
                if words.peek().is_some() {
                    let _ = words.next();
                    sanitized.push("[redacted]".to_string());
                }
            }
            continue;
        }
        sanitized.push(word.to_string());
    }

    sanitized
        .join(" ")
        .chars()
        .take(MAX_ERROR_TEXT_LENGTH)
        .collect()
}

/// Implement `Into<String>` so existing `.map_err(|e| e.to_string())`
/// patterns still compile during incremental migration.
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        serde_json::to_string(&err).unwrap_or_else(|_| err.to_string())
    }
}

/// Allow converting a plain string into an `Other` error.
impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self::Other { message: s }
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        Self::Other {
            message: s.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_request_failure_serializes_safe_structured_fields() {
        let error = AppError::request_failed(
            RequestFailureKind::Provider,
            "provider request failed token=message-secret",
            Some(503),
            RequestErrorSource::Cloudflare,
            "dns:list",
            true,
            vec![ProviderErrorDetail {
                code: Some("provider-code".to_string()),
                message: "password=provider-secret".to_string(),
            }],
            Some(7),
            "retry without api_key=remediation-secret",
            Some("cookie=request-secret".to_string()),
        );

        assert_eq!(error.code(), "REQUEST_FAILED");
        let serialized = serde_json::to_string(&error).expect("serialize request failure");
        let value: serde_json::Value =
            serde_json::from_str(&serialized).expect("parse request failure");

        assert_eq!(value["code"], "REQUEST_FAILED");
        assert_eq!(value["kind"], "provider");
        assert_eq!(value["status"], 503);
        assert_eq!(value["source"], "cloudflare");
        assert_eq!(value["operation"], "dns:list");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["retry_after"], "7");
        assert_eq!(value["details"]["retry_after_secs"], 7);
        assert_eq!(value["details"]["provider_codes"][0], "provider-code");
        assert!(value.get("request_id").is_none());
        for secret in [
            "message-secret",
            "provider-secret",
            "remediation-secret",
            "request-secret",
        ] {
            assert!(!serialized.contains(secret));
        }
    }

    #[test]
    fn authentication_request_code_remains_distinct() {
        let error = AppError::auth_request_failed(
            RequestFailureKind::Authentication,
            "Cloudflare rejected the credentials.",
            Some(401),
            RequestErrorSource::Cloudflare,
            "dns:list",
            false,
            Vec::new(),
            None,
            "Verify the saved credentials.",
            None,
        );

        assert_eq!(error.code(), "AUTH_REQUEST_FAILED");
        let serialized = serde_json::to_value(error).expect("serialize authentication failure");
        assert_eq!(serialized["code"], "AUTH_REQUEST_FAILED");
    }
}
