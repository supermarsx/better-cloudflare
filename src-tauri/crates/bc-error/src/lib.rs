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
    Validation {
        message: String,
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
            Self::Validation { message } => write!(formatter, "Validation error: {message}"),
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
        }
    }

    pub fn not_found(resource: impl Into<String>) -> Self {
        Self::NotFound {
            resource: resource.into(),
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
