//! # bc-error
//!
//! Structured, serialisable error types shared across all Better Cloudflare
//! backend crates and the Tauri IPC boundary.
//!
//! Every command returns `Result<T, AppError>`, which is serialised to the
//! frontend as a JSON object with `code`, `message`, and optional `details`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Top-level error kind.  Each variant maps to a stable string `code`
/// that the frontend can match on deterministically.
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "code", content = "details")]
pub enum AppError {
    // ── Authentication ──────────────────────────────────────────────────
    #[error("Authentication failed: {message}")]
    AuthFailed { message: String },

    #[error("Session expired")]
    SessionExpired,

    #[error("No active session")]
    NoSession,

    // ── Validation ──────────────────────────────────────────────────────
    #[error("Validation error: {message}")]
    Validation { message: String },

    #[error("Missing required field: {field}")]
    MissingField { field: String },

    // ── Cloudflare API ──────────────────────────────────────────────────
    #[error("Cloudflare API error: {message}")]
    CloudflareApi { message: String, status: Option<u16> },

    #[error("Rate limited — try again in {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },

    // ── Storage ─────────────────────────────────────────────────────────
    #[error("Storage error: {message}")]
    Storage { message: String },

    #[error("Resource not found: {resource}")]
    NotFound { resource: String },

    // ── Crypto ──────────────────────────────────────────────────────────
    #[error("Encryption/decryption error: {message}")]
    Crypto { message: String },

    // ── Platform ────────────────────────────────────────────────────────
    #[error("Biometric error: {message}")]
    Biometric { message: String },

    #[error("Platform not supported")]
    PlatformNotSupported,

    // ── Generic ─────────────────────────────────────────────────────────
    #[error("Internal error: {message}")]
    Internal { message: String },

    #[error("{message}")]
    Other { message: String },
}

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
