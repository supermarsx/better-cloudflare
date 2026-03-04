//! Integration tests for bc-error crate.
//!
//! Verifies error codes, serialisation round-trips, Display impls, and
//! conversion traits without any external dependencies.

use bc_error::AppError;

// ── Error codes ────────────────────────────────────────────────────────────

#[test]
fn error_codes_are_stable() {
    assert_eq!(AppError::SessionExpired.code(), "SESSION_EXPIRED");
    assert_eq!(AppError::NoSession.code(), "NO_SESSION");
    assert_eq!(AppError::PlatformNotSupported.code(), "PLATFORM_NOT_SUPPORTED");
    assert_eq!(
        AppError::CloudflareApi {
            message: "x".into(),
            status: Some(403),
        }
        .code(),
        "CLOUDFLARE_API",
    );
    assert_eq!(
        AppError::RateLimited {
            retry_after_secs: 10,
        }
        .code(),
        "RATE_LIMITED",
    );
    assert_eq!(
        AppError::AuthFailed {
            message: "bad".into(),
        }
        .code(),
        "AUTH_FAILED",
    );
}

#[test]
fn all_variants_have_unique_codes() {
    let variants: Vec<AppError> = vec![
        AppError::AuthFailed { message: "a".into() },
        AppError::SessionExpired,
        AppError::NoSession,
        AppError::Validation { message: "b".into() },
        AppError::MissingField { field: "c".into() },
        AppError::CloudflareApi { message: "d".into(), status: None },
        AppError::RateLimited { retry_after_secs: 1 },
        AppError::Storage { message: "e".into() },
        AppError::NotFound { resource: "f".into() },
        AppError::Crypto { message: "g".into() },
        AppError::Biometric { message: "h".into() },
        AppError::PlatformNotSupported,
        AppError::Internal { message: "i".into() },
        AppError::Other { message: "j".into() },
    ];
    let codes: Vec<&str> = variants.iter().map(|v| v.code()).collect();
    let unique: std::collections::HashSet<&&str> = codes.iter().collect();
    assert_eq!(codes.len(), unique.len(), "Duplicate error codes detected");
}

// ── Serialisation ──────────────────────────────────────────────────────────

#[test]
fn serializes_to_json_with_code_tag() {
    let err = AppError::RateLimited {
        retry_after_secs: 30,
    };
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["code"], "RateLimited");
    assert_eq!(json["details"]["retry_after_secs"], 30);
}

#[test]
fn cloudflare_api_error_serialises_status() {
    let err = AppError::CloudflareApi {
        message: "forbidden".into(),
        status: Some(403),
    };
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["code"], "CloudflareApi");
    assert_eq!(json["details"]["message"], "forbidden");
    assert_eq!(json["details"]["status"], 403);
}

#[test]
fn session_expired_serialises_without_details() {
    let err = AppError::SessionExpired;
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["code"], "SessionExpired");
}

#[test]
fn round_trip_serde() {
    let original = AppError::Validation {
        message: "TTL must be > 0".into(),
    };
    let json = serde_json::to_string(&original).unwrap();
    let restored: AppError = serde_json::from_str(&json).unwrap();
    assert_eq!(original.code(), restored.code());
    assert_eq!(original.to_string(), restored.to_string());
}

// ── Display impl ───────────────────────────────────────────────────────────

#[test]
fn display_impl_validation() {
    let err = AppError::Validation {
        message: "bad TTL".into(),
    };
    assert_eq!(err.to_string(), "Validation error: bad TTL");
}

#[test]
fn display_impl_rate_limited() {
    let err = AppError::RateLimited {
        retry_after_secs: 60,
    };
    assert_eq!(err.to_string(), "Rate limited — try again in 60s");
}

#[test]
fn display_impl_session_expired() {
    assert_eq!(AppError::SessionExpired.to_string(), "Session expired");
}

// ── Conversion traits ──────────────────────────────────────────────────────

#[test]
fn from_string_conversion() {
    let err: AppError = "something failed".into();
    assert!(matches!(err, AppError::Other { .. }));
    assert_eq!(err.code(), "OTHER");
}

#[test]
fn from_owned_string_conversion() {
    let err: AppError = String::from("owned error").into();
    assert!(matches!(err, AppError::Other { .. }));
    assert_eq!(err.to_string(), "owned error");
}

#[test]
fn into_string_returns_json() {
    let err = AppError::NotFound {
        resource: "zone/123".into(),
    };
    let s: String = err.into();
    // Should be JSON (starts with {)
    assert!(s.starts_with('{'), "Expected JSON, got: {s}");
    let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert_eq!(parsed["code"], "NotFound");
}

// ── Convenience constructors ───────────────────────────────────────────────

#[test]
fn internal_constructor() {
    let err = AppError::internal("oops");
    assert_eq!(err.code(), "INTERNAL");
    assert_eq!(err.to_string(), "Internal error: oops");
}

#[test]
fn other_constructor() {
    let err = AppError::other("misc");
    assert_eq!(err.code(), "OTHER");
    assert_eq!(err.to_string(), "misc");
}

#[test]
fn validation_constructor() {
    let err = AppError::validation("bad input");
    assert_eq!(err.code(), "VALIDATION");
}

#[test]
fn not_found_constructor() {
    let err = AppError::not_found("dns_record/abc");
    assert_eq!(err.code(), "NOT_FOUND");
    assert_eq!(err.to_string(), "Resource not found: dns_record/abc");
}
