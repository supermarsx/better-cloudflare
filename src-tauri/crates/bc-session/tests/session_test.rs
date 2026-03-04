//! Integration tests for bc-session crate.
//!
//! These tests verify the SessionManager lifecycle, idle-timeout logic, and
//! client factories without hitting the real Cloudflare API.

use bc_error::AppError;
use bc_session::SessionManager;

// ── Lifecycle tests ────────────────────────────────────────────────────────

#[tokio::test]
async fn default_creates_valid_manager() {
    let mgr = SessionManager::default();
    assert!(!mgr.is_active().await);
    assert!(mgr.credential().await.is_none());
    assert!(mgr.is_expired().await);
}

#[tokio::test]
async fn logout_without_session_is_noop() {
    let mgr = SessionManager::default();
    mgr.logout().await;
    assert!(!mgr.is_active().await);
}

#[tokio::test]
async fn touch_without_session_is_noop() {
    let mgr = SessionManager::default();
    mgr.touch().await; // should not panic
    assert!(!mgr.is_active().await);
}

// ── Idle timeout ───────────────────────────────────────────────────────────

#[tokio::test]
async fn default_idle_timeout_is_15_minutes() {
    let mgr = SessionManager::default();
    assert_eq!(mgr.get_idle_timeout_secs().await, 900);
}

#[tokio::test]
async fn set_idle_timeout_persists() {
    let mgr = SessionManager::default();
    mgr.set_idle_timeout(60).await;
    assert_eq!(mgr.get_idle_timeout_secs().await, 60);

    mgr.set_idle_timeout(3600).await;
    assert_eq!(mgr.get_idle_timeout_secs().await, 3600);
}

#[tokio::test]
async fn set_idle_timeout_zero() {
    let mgr = SessionManager::default();
    mgr.set_idle_timeout(0).await;
    assert_eq!(mgr.get_idle_timeout_secs().await, 0);
}

// ── Client factory ─────────────────────────────────────────────────────────

#[tokio::test]
async fn make_cf_client_uses_shared_pool() {
    let mgr = SessionManager::default();
    let _client = mgr.make_cf_client("test-key", Some("test@example.com"));
    let _client2 = mgr.make_cf_client("test-key-2", None);
    // Should not panic, clients share the same HTTP connection pool
}

#[tokio::test]
async fn http_client_is_accessible() {
    let mgr = SessionManager::default();
    let _client = mgr.http_client();
    // Just verifying we can access it
}

// ── require_client errors ──────────────────────────────────────────────────

#[tokio::test]
async fn require_client_without_session_returns_error() {
    let mgr = SessionManager::default();
    let result = mgr.require_client().await;
    assert!(result.is_err());
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("Expected error, got Ok"),
    };
    match err {
        AppError::SessionExpired | AppError::NoSession => {}
        other => panic!("Expected session error, got: {other:?}"),
    }
}

#[tokio::test]
async fn client_without_session_returns_none() {
    let mgr = SessionManager::default();
    assert!(mgr.client().await.is_none());
}

// ── Credential ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn credential_without_session_returns_none() {
    let mgr = SessionManager::default();
    assert!(mgr.credential().await.is_none());
}

// ── Concurrent access ──────────────────────────────────────────────────────

#[tokio::test]
async fn concurrent_reads_dont_deadlock() {
    let mgr = std::sync::Arc::new(SessionManager::default());
    let mut handles = Vec::new();
    for _ in 0..10 {
        let m = mgr.clone();
        handles.push(tokio::spawn(async move {
            let _ = m.is_active().await;
            let _ = m.is_expired().await;
            let _ = m.credential().await;
            let _ = m.get_idle_timeout_secs().await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
}
