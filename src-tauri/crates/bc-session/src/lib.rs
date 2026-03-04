//! # bc-session
//!
//! Manages a single authenticated session:
//!
//! * Holds the decrypted API key in memory so the frontend never re-sends it.
//! * Owns a shared [`reqwest::Client`] with connection pooling (one per app).
//! * Provides a [`CloudflareClient`] factory backed by the pooled client.
//! * Tracks session activity for idle-timeout auto-lock.
//!
//! # Usage
//!
//! Register `SessionManager::default()` as Tauri managed state.  Commands call
//! `session.client()` to get a ready-to-use `CloudflareClient`, or
//! `session.require_client()` to error if no session is active.

use std::time::Duration;

use bc_cloudflare_api::CloudflareClient;
use bc_error::AppError;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 900; // 15 minutes

// ── Session credential ─────────────────────────────────────────────────────

/// The decrypted credential held in memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCredential {
    pub api_key: String,
    pub email: Option<String>,
    pub label: String,
    pub authenticated_at: DateTime<Utc>,
}

// ── Active session ─────────────────────────────────────────────────────────

#[derive(Debug)]
struct ActiveSession {
    credential: SessionCredential,
    last_activity: DateTime<Utc>,
}

// ── SessionManager ─────────────────────────────────────────────────────────

/// Thread-safe session manager registered as Tauri managed state.
pub struct SessionManager {
    http_client: Client,
    session: RwLock<Option<ActiveSession>>,
    idle_timeout: RwLock<Duration>,
}

impl Default for SessionManager {
    fn default() -> Self {
        let http_client = Client::builder()
            .pool_max_idle_per_host(10)
            .pool_idle_timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            http_client,
            session: RwLock::new(None),
            idle_timeout: RwLock::new(Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS)),
        }
    }
}

impl SessionManager {
    // ── Session lifecycle ───────────────────────────────────────────────

    /// Start a new session with decrypted credentials.
    pub async fn login(
        &self,
        api_key: String,
        email: Option<String>,
        label: String,
    ) -> Result<SessionCredential, AppError> {
        let now = Utc::now();
        let credential = SessionCredential {
            api_key,
            email,
            label,
            authenticated_at: now,
        };

        // Verify the token first
        let client = self.make_cf_client(&credential.api_key, credential.email.as_deref());
        client
            .verify_token()
            .await
            .map_err(|e| AppError::AuthFailed {
                message: e.to_string(),
            })?;

        *self.session.write().await = Some(ActiveSession {
            credential: credential.clone(),
            last_activity: now,
        });

        Ok(credential)
    }

    /// End the current session, clearing credentials from memory.
    pub async fn logout(&self) {
        *self.session.write().await = None;
    }

    /// Touch the session to reset the idle timer.
    pub async fn touch(&self) {
        if let Some(session) = self.session.write().await.as_mut() {
            session.last_activity = Utc::now();
        }
    }

    /// Check whether the session has expired due to idle timeout.
    pub async fn is_expired(&self) -> bool {
        let session = self.session.read().await;
        let timeout = *self.idle_timeout.read().await;
        match session.as_ref() {
            None => true,
            Some(s) => {
                let elapsed = Utc::now()
                    .signed_duration_since(s.last_activity)
                    .to_std()
                    .unwrap_or(Duration::ZERO);
                elapsed > timeout
            }
        }
    }

    /// Get the current session credential (without touching).
    pub async fn credential(&self) -> Option<SessionCredential> {
        self.session
            .read()
            .await
            .as_ref()
            .map(|s| s.credential.clone())
    }

    /// Check if a session is active and not expired.
    pub async fn is_active(&self) -> bool {
        self.session.read().await.is_some() && !self.is_expired().await
    }

    // ── Idle timeout configuration ─────────────────────────────────────

    pub async fn set_idle_timeout(&self, secs: u64) {
        *self.idle_timeout.write().await = Duration::from_secs(secs);
    }

    pub async fn get_idle_timeout_secs(&self) -> u64 {
        self.idle_timeout.read().await.as_secs()
    }

    // ── Client factories ───────────────────────────────────────────────

    /// Create a `CloudflareClient` from explicit credentials (backward compat).
    /// Uses the shared connection-pooled `reqwest::Client`.
    pub fn make_cf_client(&self, api_key: &str, email: Option<&str>) -> CloudflareClient {
        CloudflareClient::with_client(self.http_client.clone(), api_key, email)
    }

    /// Get a `CloudflareClient` from the active session.
    /// Touches the session to reset idle timer.
    pub async fn client(&self) -> Option<CloudflareClient> {
        let mut lock = self.session.write().await;
        if let Some(session) = lock.as_mut() {
            session.last_activity = Utc::now();
            Some(self.make_cf_client(
                &session.credential.api_key,
                session.credential.email.as_deref(),
            ))
        } else {
            None
        }
    }

    /// Get a `CloudflareClient` from the active session, or return an error.
    pub async fn require_client(&self) -> Result<CloudflareClient, AppError> {
        if self.is_expired().await {
            self.logout().await;
            return Err(AppError::SessionExpired);
        }
        self.client().await.ok_or(AppError::NoSession)
    }

    /// Get the shared HTTP client for non-Cloudflare requests.
    pub fn http_client(&self) -> &Client {
        &self.http_client
    }
}
